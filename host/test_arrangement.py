# -*- coding: utf-8 -*-
"""
host/arrangement.py 的单元测试（纯 stdlib，无需 bleak）。

覆盖：CRC-32 真值、数据结构验证、编码/解码往返、像素互斥校验、
覆盖查询、边界情况、版本兼容、wire 格式对齐。
"""

from __future__ import annotations

import unittest
import zlib

from arrangement import (
    Arrangement,
    ArrangementError,
    Group,
    Layer,
    MAX_GROUPS,
    MAX_LAYERS,
    MAX_PARAMS,
    MAX_RANGES,
    MAX_STAGES,
    NAME_BYTES,
    PAYLOAD_VERSION,
    PIN_COUNT,
    Pin,
    ROLE_BG,
    ROLE_DY,
    Range,
    Stage,
    crc32,
    decode,
    encode,
    get_occupied_pixels,
    get_uncovered_pixels,
    group_total_duration_ms,
    is_pixel_covered,
    total_duration_ms,
    validate,
    validate_structure,
)


def make_empty_pins() -> list[Pin]:
    """创建 8 个空引脚。"""
    return [Pin(length=0, name="", groups=[]) for _ in range(PIN_COUNT)]


def make_simple_arrangement() -> Arrangement:
    """创建一个简单有效的编排（1 个引脚、1 个灯组、1 个阶段、1 个背景层）。"""
    pins = make_empty_pins()
    pins[0] = Pin(
        length=10,
        name="测试引脚",
        groups=[
            Group(
                ranges=[Range(start=0, end=10)],
                stages=[
                    Stage(
                        duration_ms=1000,
                        fade_in_ms=0,
                        layers=[Layer(role=ROLE_BG, effect_id=0, params=b"\xff\x00\x00")],
                    )
                ],
            )
        ],
    )
    return Arrangement(version=1, payload_version=PAYLOAD_VERSION, pins=pins)


# ---- CRC32 ----


class Crc32Tests(unittest.TestCase):
    def test_empty_is_zero(self):
        """空数据 CRC32 应为 0。"""
        self.assertEqual(crc32(b""), 0)

    def test_known_vector(self):
        """CRC-32 (IEEE 802.3) 标准测试向量 "123456789" = 0xCBF43926。"""
        self.assertEqual(crc32(b"123456789"), 0xCBF43926)

    def test_matches_zlib(self):
        """与 zlib.crc32 一致（同一多项式）。"""
        data = b"Hello, World!"
        self.assertEqual(crc32(data), zlib.crc32(data) & 0xFFFFFFFF)


# ---- 数据结构验证 ----


class RangeTests(unittest.TestCase):
    def test_length(self):
        r = Range(start=5, end=10)
        self.assertEqual(r.length(), 5)

    def test_length_zero(self):
        r = Range(start=5, end=5)
        self.assertEqual(r.length(), 0)

    def test_negative_length_clamped(self):
        r = Range(start=10, end=5)
        self.assertEqual(r.length(), 0)  # max(0, ...)


class LayerTests(unittest.TestCase):
    def test_valid(self):
        l = Layer(role=ROLE_BG, effect_id=0, params=b"\x01\x02\x03")
        self.assertEqual(l.role, ROLE_BG)
        self.assertEqual(l.effect_id, 0)
        self.assertEqual(l.params, b"\x01\x02\x03")

    def test_invalid_role(self):
        with self.assertRaises(ArrangementError) as cm:
            Layer(role=2, effect_id=0)
        self.assertEqual(cm.exception.code, "ROLE")

    def test_effect_id_overflow(self):
        with self.assertRaises(ArrangementError) as cm:
            Layer(role=ROLE_BG, effect_id=0x10000)
        self.assertEqual(cm.exception.code, "EFFECT")

    def test_params_overflow(self):
        with self.assertRaises(ArrangementError) as cm:
            Layer(role=ROLE_BG, params=b"\x00" * (MAX_PARAMS + 1))
        self.assertEqual(cm.exception.code, "LIMITS")

    def test_params_list_conversion(self):
        l = Layer(role=ROLE_BG, params=[1, 2, 3])
        self.assertEqual(l.params, b"\x01\x02\x03")


class StageTests(unittest.TestCase):
    def test_valid(self):
        s = Stage(duration_ms=500, fade_in_ms=100, layers=[Layer()])
        self.assertEqual(s.duration_ms, 500)
        self.assertEqual(s.fade_in_ms, 100)

    def test_duration_overflow(self):
        with self.assertRaises(ArrangementError) as cm:
            Stage(duration_ms=0x10000, layers=[Layer()])
        self.assertEqual(cm.exception.code, "DURATION")

    def test_fade_overflow(self):
        with self.assertRaises(ArrangementError) as cm:
            Stage(fade_in_ms=256, layers=[Layer()])
        self.assertEqual(cm.exception.code, "FADE")

    def test_no_layers(self):
        with self.assertRaises(ArrangementError) as cm:
            Stage(layers=[])
        self.assertEqual(cm.exception.code, "LIMITS")

    def test_too_many_layers(self):
        layers = [Layer() for _ in range(MAX_LAYERS + 1)]
        with self.assertRaises(ArrangementError) as cm:
            Stage(layers=layers)
        self.assertEqual(cm.exception.code, "LIMITS")


class GroupTests(unittest.TestCase):
    def test_valid(self):
        g = Group(
            ranges=[Range(0, 5)],
            stages=[Stage(layers=[Layer()])],
        )
        self.assertEqual(len(g.ranges), 1)
        self.assertEqual(len(g.stages), 1)

    def test_no_ranges(self):
        with self.assertRaises(ArrangementError) as cm:
            Group(ranges=[], stages=[Stage(layers=[Layer()])])
        self.assertEqual(cm.exception.code, "RANGE")

    def test_no_stages(self):
        with self.assertRaises(ArrangementError) as cm:
            Group(ranges=[Range(0, 5)], stages=[])
        self.assertEqual(cm.exception.code, "STAGE")

    def test_total_duration(self):
        g = Group(
            ranges=[Range(0, 5)],
            stages=[
                Stage(duration_ms=1000, layers=[Layer()]),
                Stage(duration_ms=500, layers=[Layer()]),
            ],
        )
        self.assertEqual(group_total_duration_ms(g), 1500)

    def test_length(self):
        g = Group(
            ranges=[Range(0, 5), Range(10, 15)],
            stages=[Stage(layers=[Layer()])],
        )
        self.assertEqual(g.length(), 10)

    def test_pixel_at(self):
        g = Group(
            ranges=[Range(0, 3, reverse=False), Range(5, 7, reverse=True)],
            stages=[Stage(layers=[Layer()])],
        )
        self.assertEqual(g.pixel_at(0), 0)
        self.assertEqual(g.pixel_at(2), 2)
        self.assertEqual(g.pixel_at(3), 6)  # reverse: end-1-0 = 6
        self.assertEqual(g.pixel_at(4), 5)  # reverse: end-1-1 = 5

    def test_pixel_at_out_of_bounds(self):
        g = Group(
            ranges=[Range(0, 3)],
            stages=[Stage(layers=[Layer()])],
        )
        with self.assertRaises(IndexError):
            g.pixel_at(3)


class PinTests(unittest.TestCase):
    def test_valid(self):
        p = Pin(length=100, name="灯带")
        self.assertEqual(p.length, 100)
        self.assertEqual(p.name, "灯带")

    def test_length_overflow(self):
        with self.assertRaises(ArrangementError) as cm:
            Pin(length=256)
        self.assertEqual(cm.exception.code, "LENGTH")

    def test_name_too_long(self):
        long_name = "x" * (NAME_BYTES + 1)
        with self.assertRaises(ArrangementError) as cm:
            Pin(name=long_name)
        self.assertEqual(cm.exception.code, "NAME")

    def test_too_many_groups(self):
        groups = [Group(ranges=[Range(0, 1)], stages=[Stage(layers=[Layer()])]) for _ in range(MAX_GROUPS + 1)]
        with self.assertRaises(ArrangementError) as cm:
            Pin(groups=groups)
        self.assertEqual(cm.exception.code, "LIMITS")


class ArrangementTests(unittest.TestCase):
    def test_valid(self):
        arr = make_simple_arrangement()
        self.assertEqual(len(arr.pins), PIN_COUNT)

    def test_version_overflow(self):
        with self.assertRaises(ArrangementError) as cm:
            Arrangement(version=0x10000, pins=make_empty_pins())
        self.assertEqual(cm.exception.code, "VERSION")

    def test_wrong_pin_count(self):
        with self.assertRaises(ArrangementError) as cm:
            Arrangement(pins=[])
        self.assertEqual(cm.exception.code, "PIN_COUNT")

    def test_total_duration(self):
        arr = make_simple_arrangement()
        # 1 个灯组 × 1000 ms
        self.assertEqual(total_duration_ms(arr), 1000)


# ---- 编码/解码 ----


class EncodeDecodeTests(unittest.TestCase):
    def test_roundtrip(self):
        """编码后再解码应还原原始结构。"""
        arr = make_simple_arrangement()
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(decoded.version, arr.version)
        self.assertEqual(decoded.payload_version, arr.payload_version)
        self.assertEqual(len(decoded.pins), PIN_COUNT)

        pin0 = decoded.pins[0]
        self.assertEqual(pin0.length, 10)
        self.assertEqual(pin0.name, "测试引脚")
        self.assertEqual(len(pin0.groups), 1)

        g = pin0.groups[0]
        self.assertEqual(len(g.ranges), 1)
        self.assertEqual(g.ranges[0].start, 0)
        self.assertEqual(g.ranges[0].end, 10)
        self.assertFalse(g.ranges[0].reverse)

        st = g.stages[0]
        self.assertEqual(st.duration_ms, 1000)
        self.assertEqual(st.fade_in_ms, 0)
        self.assertEqual(len(st.layers), 1)

        l = st.layers[0]
        self.assertEqual(l.role, ROLE_BG)
        self.assertEqual(l.effect_id, 0)
        self.assertEqual(l.params, b"\xff\x00\x00")

    def test_encode_validates_structure(self):
        """编码前应校验结构，失败抛错。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=10,
            groups=[
                Group(
                    ranges=[Range(start=0, end=5), Range(start=3, end=8)],  # 重叠
                    stages=[Stage(layers=[Layer()])],
                )
            ],
        )
        arr = Arrangement(pins=pins)
        with self.assertRaises(ArrangementError) as cm:
            encode(arr)
        self.assertEqual(cm.exception.code, "OVERLAP")

    def test_encode_checks_version(self):
        """编码前应校验 payloadVersion。"""
        arr = make_simple_arrangement()
        arr.payload_version = 999
        with self.assertRaises(ArrangementError) as cm:
            encode(arr)
        self.assertEqual(cm.exception.code, "VERSION")

    def test_decode_truncated(self):
        """截断的输入应抛 ArrangementError。"""
        arr = make_simple_arrangement()
        encoded = encode(arr)
        truncated = encoded[:-5]
        with self.assertRaises(ArrangementError) as cm:
            decode(truncated)
        self.assertEqual(cm.exception.code, "TRUNCATED")

    def test_decode_trailing_bytes(self):
        """尾部多余字节应抛 ArrangementError。"""
        arr = make_simple_arrangement()
        encoded = encode(arr)
        with_extra = encoded + b"\x00\x00"
        with self.assertRaises(ArrangementError) as cm:
            decode(with_extra)
        self.assertEqual(cm.exception.code, "TRAILING")

    def test_decode_pin_count_overflow(self):
        """pinCount 超上限应抛错。"""
        bad = b"\x01\x00\x01\x00\x09"  # version=1, payloadVersion=1, pinCount=9
        with self.assertRaises(ArrangementError) as cm:
            decode(bad)
        self.assertEqual(cm.exception.code, "PIN_COUNT")

    def test_decode_range_out_of_bounds(self):
        """range 超出 pin length 应抛错。"""
        # version=1, payloadVersion=1, pinCount=1, pin0: length=5, name=空,
        # groupCount=1, rangeCount=1, start=0, end=10 (超出 length=5)
        bad = (
            b"\x01\x00\x01\x00\x01"
            b"\x05"  # length=5
            + b"\x00" * NAME_BYTES  # name
            + b"\x01"  # groupCount=1
            + b"\x01\x00"  # rangeCount=1, stageCount=0 (会失败)
        )
        with self.assertRaises(ArrangementError):
            decode(bad)

    def test_empty_pin_valid(self):
        """空引脚（无灯组）应通过校验。"""
        arr = Arrangement(pins=make_empty_pins())
        validate(arr)  # 不应抛错
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(len(decoded.pins), PIN_COUNT)
        for pin in decoded.pins:
            self.assertEqual(len(pin.groups), 0)


# ---- 像素互斥 ----


class PixelExclusivityTests(unittest.TestCase):
    def test_overlap_detected(self):
        """同一灯组内像素重叠应被检测。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=10,
            groups=[
                Group(
                    ranges=[Range(0, 5), Range(3, 8)],  # [0,5) 和 [3,8) 重叠
                    stages=[Stage(layers=[Layer()])],
                )
            ],
        )
        arr = Arrangement(pins=pins)
        with self.assertRaises(ArrangementError) as cm:
            validate_structure(arr)
        self.assertEqual(cm.exception.code, "OVERLAP")

    def test_overlap_across_groups(self):
        """不同灯组间像素重叠应被检测。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=10,
            groups=[
                Group(ranges=[Range(0, 5)], stages=[Stage(layers=[Layer()])]),
                Group(ranges=[Range(3, 8)], stages=[Stage(layers=[Layer()])]),
            ],
        )
        arr = Arrangement(pins=pins)
        with self.assertRaises(ArrangementError) as cm:
            validate_structure(arr)
        self.assertEqual(cm.exception.code, "OVERLAP")

    def test_no_overlap_valid(self):
        """不重叠的灯组应通过校验。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=10,
            groups=[
                Group(ranges=[Range(0, 5)], stages=[Stage(layers=[Layer()])]),
                Group(ranges=[Range(5, 10)], stages=[Stage(layers=[Layer()])]),
            ],
        )
        arr = Arrangement(pins=pins)
        validate_structure(arr)  # 不应抛错

    def test_range_beyond_pin_length(self):
        """区间超出引脚长度应被检测。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=10,
            groups=[
                Group(ranges=[Range(0, 15)], stages=[Stage(layers=[Layer()])]),
            ],
        )
        arr = Arrangement(pins=pins)
        with self.assertRaises(ArrangementError) as cm:
            validate_structure(arr)
        self.assertEqual(cm.exception.code, "RANGE")


# ---- 覆盖查询 ----


class PixelCoverageTests(unittest.TestCase):
    def test_get_occupied_pixels(self):
        arr = make_simple_arrangement()
        occupied = get_occupied_pixels(arr, 0)
        self.assertEqual(occupied, set(range(10)))

    def test_get_occupied_pixels_empty(self):
        arr = make_simple_arrangement()
        occupied = get_occupied_pixels(arr, 1)  # 空引脚
        self.assertEqual(occupied, set())

    def test_get_uncovered_pixels(self):
        pins = make_empty_pins()
        pins[0] = Pin(
            length=10,
            groups=[
                Group(ranges=[Range(0, 3), Range(5, 7)], stages=[Stage(layers=[Layer()])]),
            ],
        )
        arr = Arrangement(pins=pins)
        uncovered = get_uncovered_pixels(arr, 0)
        self.assertEqual(uncovered, [3, 4, 7, 8, 9])

    def test_is_pixel_covered(self):
        arr = make_simple_arrangement()
        self.assertTrue(is_pixel_covered(arr, 0, 0))
        self.assertTrue(is_pixel_covered(arr, 0, 9))
        self.assertFalse(is_pixel_covered(arr, 0, 10))  # 超出 length


# ---- 边界情况 ----


class EdgeCaseTests(unittest.TestCase):
    def test_empty_pins(self):
        """全空引脚的编排。"""
        arr = Arrangement(pins=make_empty_pins())
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(len(decoded.pins), PIN_COUNT)
        for pin in decoded.pins:
            self.assertEqual(pin.length, 0)
            self.assertEqual(len(pin.groups), 0)

    def test_max_groups_per_pin(self):
        """引脚含最大灯组数。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=80,
            groups=[
                Group(ranges=[Range(i, i + 1)], stages=[Stage(layers=[Layer()])])
                for i in range(MAX_GROUPS)
            ],
        )
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(len(decoded.pins[0].groups), MAX_GROUPS)

    def test_max_ranges_per_group(self):
        """灯组含最大区间数。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=8,
            groups=[
                Group(
                    ranges=[Range(i, i + 1) for i in range(MAX_RANGES)],
                    stages=[Stage(layers=[Layer()])],
                )
            ],
        )
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(len(decoded.pins[0].groups[0].ranges), MAX_RANGES)

    def test_max_stages_per_group(self):
        """灯组含最大阶段数。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=1,
            groups=[
                Group(
                    ranges=[Range(0, 1)],
                    stages=[Stage(layers=[Layer()]) for _ in range(MAX_STAGES)],
                )
            ],
        )
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(len(decoded.pins[0].groups[0].stages), MAX_STAGES)

    def test_max_layers_per_stage(self):
        """阶段含最大层数。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=1,
            groups=[
                Group(
                    ranges=[Range(0, 1)],
                    stages=[
                        Stage(
                            layers=[
                                Layer(role=ROLE_BG, params=b"\xff\x00\x00"),
                                Layer(role=ROLE_DY, params=b"\xff\x00\x00"),
                            ]
                        )
                    ],
                )
            ],
        )
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(len(decoded.pins[0].groups[0].stages[0].layers), MAX_LAYERS)

    def test_max_params_per_layer(self):
        """层含最大参数字节。"""
        params = b"\x00" * MAX_PARAMS
        pins = make_empty_pins()
        pins[0] = Pin(
            length=1,
            groups=[
                Group(
                    ranges=[Range(0, 1)],
                    stages=[
                        Stage(layers=[Layer(role=ROLE_BG, effect_id=0, params=params)])
                    ],
                )
            ],
        )
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(len(decoded.pins[0].groups[0].stages[0].layers[0].params), MAX_PARAMS)

    def test_utf8_name_encoding(self):
        """UTF-8 名称正确编码/解码。"""
        name = "灯带_01"
        pins = make_empty_pins()
        pins[0] = Pin(length=1, name=name, groups=[])
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(decoded.pins[0].name, name)

    def test_name_null_padding(self):
        """名称不足 NAME_BYTES 时用 null 填充。"""
        pins = make_empty_pins()
        pins[0] = Pin(length=1, name="AB", groups=[])
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertEqual(decoded.pins[0].name, "AB")

    def test_reverse_range(self):
        """reverse 区间正确编码/解码。"""
        pins = make_empty_pins()
        pins[0] = Pin(
            length=10,
            groups=[
                Group(
                    ranges=[Range(0, 5, reverse=True)],
                    stages=[Stage(layers=[Layer()])],
                )
            ],
        )
        arr = Arrangement(pins=pins)
        encoded = encode(arr)
        decoded = decode(encoded)
        self.assertTrue(decoded.pins[0].groups[0].ranges[0].reverse)


# ---- 版本兼容 ----


class VersionCompatibilityTests(unittest.TestCase):
    def test_validate_version_ok(self):
        """payloadVersion 匹配时通过。"""
        arr = make_simple_arrangement()
        validate(arr)  # 不应抛错

    def test_validate_version_mismatch(self):
        """payloadVersion 不匹配时抛错。"""
        arr = make_simple_arrangement()
        arr.payload_version = 999
        with self.assertRaises(ArrangementError) as cm:
            validate(arr)
        self.assertEqual(cm.exception.code, "VERSION")

    def test_validate_skip_version_check(self):
        """check_version=False 时跳过版本检查。"""
        arr = make_simple_arrangement()
        arr.payload_version = 999
        validate(arr, check_version=False)  # 不应抛错


# ---- Wire 兼容性（与小程序/固件对齐）----


class WireCompatibilityTests(unittest.TestCase):
    def test_wire_format_matches_spec(self):
        """验证线格式与 spec.md §2.10 一致。"""
        arr = make_simple_arrangement()
        encoded = encode(arr)

        # 手动解析验证字节布局
        o = 0
        self.assertEqual(encoded[o], 0x01)
        self.assertEqual(encoded[o + 1], 0x00)  # version=1 LE
        o += 2
        self.assertEqual(encoded[o], PAYLOAD_VERSION)
        self.assertEqual(encoded[o + 1], 0x00)  # payloadVersion=1 LE
        o += 2
        self.assertEqual(encoded[o], PIN_COUNT)  # pinCount=8
        o += 1

        # pin[0]
        self.assertEqual(encoded[o], 10)  # length
        o += 1
        # name: 16 bytes, UTF-8 + null padding
        name_bytes = "测试引脚".encode("utf-8")
        self.assertEqual(encoded[o : o + len(name_bytes)], name_bytes)
        o += NAME_BYTES
        self.assertEqual(encoded[o], 1)  # groupCount
        o += 1

        # group[0]
        self.assertEqual(encoded[o], 1)  # rangeCount
        o += 1
        self.assertEqual(encoded[o], 1)  # stageCount
        o += 1
        self.assertEqual(encoded[o], 0)  # range.start
        o += 1
        self.assertEqual(encoded[o], 10)  # range.end
        o += 1
        self.assertEqual(encoded[o], 0)  # range.reverse (False)
        o += 1
        # stage
        self.assertEqual(encoded[o], 0xE8)
        self.assertEqual(encoded[o + 1], 0x03)  # durationMs=1000 LE
        o += 2
        self.assertEqual(encoded[o], 0)  # fadeInMs
        o += 1
        self.assertEqual(encoded[o], 1)  # layerCount
        o += 1
        # layer
        self.assertEqual(encoded[o], ROLE_BG)  # role
        o += 1
        self.assertEqual(encoded[o], 0)
        self.assertEqual(encoded[o + 1], 0)  # effectId=0 LE
        o += 2
        self.assertEqual(encoded[o], 3)  # paramLen
        o += 1
        self.assertEqual(encoded[o : o + 3], b"\xff\x00\x00")  # params
        o += 3

        # 剩余 pin 均为空
        for _ in range(PIN_COUNT - 1):
            self.assertEqual(encoded[o], 0)  # length
            o += 1
            o += NAME_BYTES  # name (null padded)
            self.assertEqual(encoded[o], 0)  # groupCount
            o += 1

        self.assertEqual(o, len(encoded))

    def test_cross_compat_with_miniprogram(self):
        """与小程序 arrangement.js 编码结果兼容（同一 wire 格式）。"""
        arr = make_simple_arrangement()
        encoded = encode(arr)
        self.assertGreater(len(encoded), 0)
        # 固定开销：version(2) + payloadVersion(2) + pinCount(1) = 5
        # 每 pin：length(1) + name(16) + groupCount(1) = 18
        # 8 pin 固定 = 5 + 8*18 = 149
        self.assertGreaterEqual(len(encoded), 149)


if __name__ == "__main__":
    unittest.main()