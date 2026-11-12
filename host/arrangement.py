# -*- coding: utf-8 -*-
"""
编排序列编解码 — spec.md §2.10
-----------------------------

PC 端（代替手机侧）的编排 TLV 编解码、CRC32、版本兼容检查与像素归属校验。
纯 Python，不依赖 bleak。与固件 mlarr.c、小程序 arrangement.js 保持 wire 兼容。

线格式（全部小端）：
    Arrangement := version(u16) payloadVersion(u16) pinCount(u8) Pin[pinCount]
    Pin         := length(u8) name(16B) groupCount(u8) Group[groupCount]
    Group       := rangeCount(u8) stageCount(u8) Range[...] Stage[...]
    Range       := start(u8) end(u8) reverse(u8)
    Stage       := durationMs(u16) fadeInMs(u8) layerCount(u8) Layer[...]
    Layer       := role(u8) effectId(u16) paramLen(u8) paramBytes[...]

规则（spec.md §2.10）：
- 固定 8 个引脚，引脚长度由编排写入，设备不做推断。
- 灯组 = 引脚内一个或多个 [start, end) 区间 + 可选 reverse。
- 像素归属：一颗灯珠只能属于一个灯组，重叠则拒绝整份编排。
- 未被覆盖的像素渲染为黑色（不留残影）。
- 阶段硬切，可选 fadeInMs（0 = 硬切）。
- 时钟：单任务驱动全局帧时钟，每灯组用 clockMs % groupTotalMs 定位阶段。
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

__all__ = [
    "PIN_COUNT",
    "NAME_BYTES",
    "MAX_RANGES",
    "MAX_GROUPS",
    "MAX_STAGES",
    "MAX_LAYERS",
    "MAX_PARAMS",
    "PAYLOAD_VERSION",
    "ROLE_BG",
    "ROLE_DY",
    "ArrangementError",
    "Range",
    "Layer",
    "Stage",
    "Group",
    "Pin",
    "Arrangement",
    "crc32",
    "encode",
    "decode",
    "validate",
    "validate_structure",
    "get_occupied_pixels",
    "get_uncovered_pixels",
    "is_pixel_covered",
    "group_total_duration_ms",
    "total_duration_ms",
]


# ---- 常量（spec.md §2.10 / §2.11）----

PIN_COUNT = 8
NAME_BYTES = 16
MAX_RANGES = 4
MAX_GROUPS = 8
MAX_STAGES = 8
MAX_LAYERS = 2
MAX_PARAMS = 16
PAYLOAD_VERSION = 1

ROLE_BG = 0
ROLE_DY = 1


# ---- 错误 ----


class ArrangementError(Exception):
    """编排编解码错误（结构越界、像素重叠、版本不符等）。"""

    def __init__(self, message: str, *, code: str = "INVALID") -> None:
        super().__init__(message)
        self.code = code


# ---- 数据结构 ----


@dataclass
class Range:
    """区间 [start, end)，可选反向。"""

    start: int
    end: int
    reverse: bool = False

    def length(self) -> int:
        return max(0, self.end - self.start)


@dataclass
class Layer:
    """层：role + effectId + 参数字节。"""

    role: int = ROLE_BG
    effect_id: int = 0
    params: bytes = b""

    def __post_init__(self) -> None:
        if self.role not in (ROLE_BG, ROLE_DY):
            raise ArrangementError(f"role 非法: {self.role}", code="ROLE")
        if self.effect_id < 0 or self.effect_id > 0xFFFF:
            raise ArrangementError(f"effectId 越界: {self.effect_id}", code="EFFECT")
        if len(self.params) > MAX_PARAMS:
            raise ArrangementError(
                f"参数字节超上限 {MAX_PARAMS}: {len(self.params)}",
                code="LIMITS",
            )
        if isinstance(self.params, list):
            self.params = bytes(self.params)


@dataclass
class Stage:
    """阶段：时长 + 淡入 + 层列表。"""

    duration_ms: int = 1000
    fade_in_ms: int = 0
    layers: List[Layer] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.duration_ms < 0 or self.duration_ms > 0xFFFF:
            raise ArrangementError(f"durationMs 越界: {self.duration_ms}", code="DURATION")
        if self.fade_in_ms < 0 or self.fade_in_ms > 0xFF:
            raise ArrangementError(f"fadeInMs 越界: {self.fade_in_ms}", code="FADE")
        if not (1 <= len(self.layers) <= MAX_LAYERS):
            raise ArrangementError(
                f"层数越界 1..{MAX_LAYERS}: {len(self.layers)}", code="LIMITS"
            )


@dataclass
class Group:
    """灯组：区间列表 + 阶段列表。"""

    ranges: List[Range] = field(default_factory=list)
    stages: List[Stage] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.ranges:
            raise ArrangementError("灯组无区间", code="RANGE")
        if len(self.ranges) > MAX_RANGES:
            raise ArrangementError(
                f"区间数超上限 {MAX_RANGES}: {len(self.ranges)}", code="LIMITS"
            )
        if not self.stages:
            raise ArrangementError("灯组无阶段", code="STAGE")
        if len(self.stages) > MAX_STAGES:
            raise ArrangementError(
                f"阶段数超上限 {MAX_STAGES}: {len(self.stages)}", code="LIMITS"
            )

    def total_duration_ms(self) -> int:
        return sum(s.duration_ms for s in self.stages)

    def length(self) -> int:
        """灯组逻辑长度 = 各区间长度之和。"""
        return sum(r.length() for r in self.ranges)

    def pixel_at(self, i: int) -> int:
        """逻辑像素 i → 物理像素索引（考虑 reverse）。"""
        for r in self.ranges:
            rl = r.length()
            if i < rl:
                return r.end - 1 - i if r.reverse else r.start + i
            i -= rl
        raise IndexError(f"逻辑像素越界: {i}")


@dataclass
class Pin:
    """引脚：长度 + 名称 + 灯组列表。"""

    length: int = 0
    name: str = ""
    groups: List[Group] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.length < 0 or self.length > 0xFF:
            raise ArrangementError(f"pin length 越界: {self.length}", code="LENGTH")
        if len(self.name.encode("utf-8")) > NAME_BYTES:
            raise ArrangementError(
                f"pin name 超 {NAME_BYTES} 字节（UTF-8）", code="NAME"
            )
        if len(self.groups) > MAX_GROUPS:
            raise ArrangementError(
                f"灯组数超上限 {MAX_GROUPS}: {len(self.groups)}", code="LIMITS"
            )


@dataclass
class Arrangement:
    """完整编排：版本 + 引脚列表。"""

    version: int = 1
    payload_version: int = PAYLOAD_VERSION
    pins: List[Pin] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.version < 0 or self.version > 0xFFFF:
            raise ArrangementError(f"version 越界: {self.version}", code="VERSION")
        if len(self.pins) != PIN_COUNT:
            raise ArrangementError(
                f"pins 必须是 {PIN_COUNT} 支: {len(self.pins)}", code="PIN_COUNT"
            )

    def total_duration_ms(self) -> int:
        """所有灯组总时长之和（用于调试/测试）。"""
        return sum(g.total_duration_ms() for p in self.pins for g in p.groups)


# ---- CRC32（IEEE 802.3, 反射多项式 0xEDB88320）----


def crc32(data: bytes) -> int:
    """CRC-32 (IEEE 802.3)，返回无符号 32 位值。"""
    return zlib.crc32(data) & 0xFFFFFFFF


# ---- 校验 ----


def validate_structure(arr: Arrangement) -> None:
    """结构校验：长度、名称、区间边界、像素互斥。失败抛 ArrangementError。"""
    if len(arr.pins) != PIN_COUNT:
        raise ArrangementError(f"pins 必须是 {PIN_COUNT} 支", code="PIN_COUNT")
    if arr.version < 0 or arr.version > 0xFFFF:
        raise ArrangementError(f"version 越界: {arr.version}", code="VERSION")

    for pi, pin in enumerate(arr.pins):
        if pin.length > 0xFF:
            raise ArrangementError(f"pin[{pi}] length 越界", code="LENGTH")
        if len(pin.name.encode("utf-8")) > NAME_BYTES:
            raise ArrangementError(
                f"pin[{pi}] name 超 {NAME_BYTES} 字节（UTF-8）", code="NAME"
            )
        if len(pin.groups) > MAX_GROUPS:
            raise ArrangementError(f"pin[{pi}] 灯组数超上限", code="LIMITS")

        # 像素互斥：一颗灯珠只属于一个灯组（灯组内与灯组间都算）
        used = set()
        for gi, g in enumerate(pin.groups):
            if not g.ranges:
                raise ArrangementError(f"pin[{pi}].group[{gi}] 无区间", code="RANGE")
            if len(g.ranges) > MAX_RANGES:
                raise ArrangementError(
                    f"pin[{pi}].group[{gi}] 区间数超上限", code="LIMITS"
                )
            if not g.stages:
                raise ArrangementError(f"pin[{pi}].group[{gi}] 无阶段", code="STAGE")
            if len(g.stages) > MAX_STAGES:
                raise ArrangementError(
                    f"pin[{pi}].group[{gi}] 阶段数超上限", code="LIMITS"
                )

            for ri, r in enumerate(g.ranges):
                if r.start is None or r.end is None:
                    raise ArrangementError(
                        f"pin[{pi}].group[{gi}].range[{ri}] 缺少 start/end",
                        code="RANGE",
                    )
                if r.end < r.start or r.end > pin.length:
                    raise ArrangementError(
                        f"pin[{pi}].group[{gi}].range[{ri}] 越界: [{r.start}, {r.end})",
                        code="RANGE",
                    )
                for px in range(r.start, r.end):
                    if px in used:
                        raise ArrangementError(
                            f"pin[{pi}] 像素重叠: 灯珠 {px} 已被占用（group {gi}）",
                            code="OVERLAP",
                        )
                    used.add(px)

            for si, st in enumerate(g.stages):
                if st.duration_ms > 0xFFFF:
                    raise ArrangementError(
                        f"pin[{pi}].group[{gi}].stage[{si}] durationMs 越界",
                        code="DURATION",
                    )
                if not (1 <= len(st.layers) <= MAX_LAYERS):
                    raise ArrangementError(
                        f"pin[{pi}].group[{gi}].stage[{si}] 层数越界",
                        code="LIMITS",
                    )
                for li, l in enumerate(st.layers):
                    if l.role not in (ROLE_BG, ROLE_DY):
                        raise ArrangementError(
                            f"pin[{pi}].group[{gi}].stage[{si}].layer[{li}] role 非法: {l.role}",
                            code="ROLE",
                        )
                    if len(l.params) > MAX_PARAMS:
                        raise ArrangementError(
                            f"pin[{pi}].group[{gi}].stage[{si}].layer[{li}] 参数字节超上限",
                            code="LIMITS",
                        )


def validate(arr: Arrangement, *, check_version: bool = True) -> None:
    """完整校验：结构 + 版本兼容。

    - check_version=True 且 payload_version != PAYLOAD_VERSION 时抛错。
    - 像素互斥由 validate_structure 完成。
    """
    validate_structure(arr)
    if check_version and arr.payload_version != PAYLOAD_VERSION:
        raise ArrangementError(
            f"payloadVersion 不兼容: {arr.payload_version} != {PAYLOAD_VERSION}",
            code="VERSION",
        )


# ---- 编码 ----


def encode(arr: Arrangement) -> bytes:
    """编码编排为 TLV 字节（含结构校验，校验失败抛 ArrangementError）。"""
    validate(arr)
    out = bytearray()

    def u16(v: int) -> None:
        out.extend(struct.pack("<H", v))

    def u8(v: int) -> None:
        out.append(v & 0xFF)

    u16(arr.version)
    u16(arr.payload_version)
    u8(PIN_COUNT)

    for pin in arr.pins:
        u8(pin.length)
        name_bytes = pin.name.encode("utf-8")[:NAME_BYTES]
        name_bytes = name_bytes + b"\x00" * (NAME_BYTES - len(name_bytes))
        out.extend(name_bytes)
        u8(len(pin.groups))
        for g in pin.groups:
            u8(len(g.ranges))
            u8(len(g.stages))
            for r in g.ranges:
                u8(r.start)
                u8(r.end)
                u8(1 if r.reverse else 0)
            for st in g.stages:
                u16(st.duration_ms)
                u8(st.fade_in_ms)
                u8(len(st.layers))
                for l in st.layers:
                    u8(l.role)
                    u16(l.effect_id)
                    u8(len(l.params))
                    out.extend(l.params)

    return bytes(out)


# ---- 解码 ----


def decode(data: bytes) -> Arrangement:
    """解码 TLV 字节为 Arrangement 对象。截断或越界抛 ArrangementError。"""
    if not isinstance(data, (bytes, bytearray)):
        raise ArrangementError("data 必须是 bytes", code="TYPE")

    o = 0

    def rd_u8() -> int:
        nonlocal o
        if o + 1 > len(data):
            raise ArrangementError("截断: 需要 1 字节", code="TRUNCATED")
        v = data[o]
        o += 1
        return v

    def rd_u16() -> int:
        nonlocal o
        if o + 2 > len(data):
            raise ArrangementError("截断: 需要 2 字节", code="TRUNCATED")
        v = data[o] | (data[o + 1] << 8)
        o += 2
        return v

    def take(n: int) -> bytes:
        nonlocal o
        if o + n > len(data):
            raise ArrangementError(f"截断: 需要 {n} 字节", code="TRUNCATED")
        s = data[o : o + n]
        o += n
        return s

    version = rd_u16()
    payload_version = rd_u16()
    pin_count = rd_u8()
    if pin_count > PIN_COUNT:
        raise ArrangementError(f"pinCount 超上限: {pin_count}", code="PIN_COUNT")

    pins = []
    for p in range(pin_count):
        length = rd_u8()
        name_raw = take(NAME_BYTES)
        name_end = name_raw.find(b"\x00")
        name = name_raw[:name_end].decode("utf-8", errors="replace") if name_end >= 0 else name_raw.decode("utf-8", errors="replace")
        group_count = rd_u8()
        if group_count > MAX_GROUPS:
            raise ArrangementError(f"groupCount 超上限: {group_count}", code="LIMITS")

        groups = []
        for gi in range(group_count):
            range_count = rd_u8()
            stage_count = rd_u8()
            if range_count > MAX_RANGES or stage_count > MAX_STAGES:
                raise ArrangementError(
                    f"range/stage 计数超上限: {range_count}/{stage_count}",
                    code="LIMITS",
                )

            ranges = []
            for ri in range(range_count):
                start = rd_u8()
                end = rd_u8()
                reverse = rd_u8() != 0
                if end < start or end > length:
                    raise ArrangementError(
                        f"range 越界: pin {p} [{start}, {end})", code="RANGE"
                    )
                ranges.append(Range(start=start, end=end, reverse=reverse))

            stages = []
            for si in range(stage_count):
                duration_ms = rd_u16()
                fade_in_ms = rd_u8()
                layer_count = rd_u8()
                if layer_count > MAX_LAYERS:
                    raise ArrangementError(
                        f"layerCount 超上限: {layer_count}", code="LIMITS"
                    )
                layers = []
                for li in range(layer_count):
                    role = rd_u8()
                    effect_id = rd_u16()
                    param_len = rd_u8()
                    if param_len > MAX_PARAMS:
                        raise ArrangementError(
                            f"paramLen 超上限: {param_len}", code="LIMITS"
                        )
                    params = take(param_len)
                    layers.append(
                        Layer(role=role, effect_id=effect_id, params=params)
                    )
                stages.append(
                    Stage(duration_ms=duration_ms, fade_in_ms=fade_in_ms, layers=layers)
                )

            groups.append(Group(ranges=ranges, stages=stages))

        pins.append(Pin(length=length, name=name, groups=groups))

    if o != len(data):
        raise ArrangementError(
            f"尾部多余字节: {len(data) - o}", code="TRAILING"
        )

    return Arrangement(
        version=version, payload_version=payload_version, pins=pins
    )


# ---- 覆盖查询 ----


def get_occupied_pixels(arr: Arrangement, pin_index: int) -> set[int]:
    """该引脚已被灯组占用的像素索引集合，供 UI 置灰。"""
    if pin_index < 0 or pin_index >= len(arr.pins):
        return set()
    pin = arr.pins[pin_index]
    used = set()
    for g in pin.groups:
        for r in g.ranges:
            used.update(range(r.start, r.end))
    return used


def get_uncovered_pixels(arr: Arrangement, pin_index: int) -> list[int]:
    """未被任何灯组覆盖的像素索引数组（默认黑色）。"""
    if pin_index < 0 or pin_index >= len(arr.pins):
        return []
    pin = arr.pins[pin_index]
    covered = get_occupied_pixels(arr, pin_index)
    return [i for i in range(pin.length) if i not in covered]


def is_pixel_covered(arr: Arrangement, pin_index: int, pixel_index: int) -> bool:
    return pixel_index in get_occupied_pixels(arr, pin_index)


# ---- 时长计算 ----


def group_total_duration_ms(group: Group) -> int:
    """灯组总时长 = 各阶段时长之和。"""
    return sum(s.duration_ms for s in group.stages)


def total_duration_ms(arr: Arrangement) -> int:
    """所有灯组总时长之和（用于调试/测试）。"""
    return sum(
        group_total_duration_ms(g) for p in arr.pins for g in p.groups
    )
