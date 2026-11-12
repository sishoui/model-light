# -*- coding: utf-8 -*-
"""
T10 验收测试：OTA 灯效契约（spec §7.2 / issue #44）。

验证：
- OTA_BEGIN 成功（status=0）：设备状态帧 mode=2（TRANSMITTING）、传输位置位，
  渲染时钟 40 FPS → 5 FPS，呼吸蓝 #1A3FCC，峰值 15%。
- DATA 期间：mode 持续 2，呼吸蓝继续，5 FPS。
- 待续传回（QUERY/RESUME）：mode 回落 PLAYBACK(0)/REALTIME(1)，40 FPS 恢复。
- COMMIT 成功：设备重启，常亮绿，停帧（不再上报状态帧）。

灯效仅通过状态帧 mode/flags 与合约断言表达（不碰渲染内部字段）：
    TRANSMITTING → {呼吸蓝, #1A3FCC, 峰值 15%, 5 FPS}
    PLAYBACK/REALTIME → {正常回放, 40 FPS}
    COMMIT 后     → {常亮绿 #00FF00, 停帧/0 FPS}

驱动 OtaSession 走 FakeBleakTransport；设备模拟器按 OTA 阶段通过
inject_status 注入 12 B 状态帧，测试用 parse_status_frame 解析并断言。
纯 stdlib + pytest，无 bleak、无真实设备，headless 可运行。
"""

from __future__ import annotations

import hashlib
import struct
from typing import List, Optional

import pytest

from ble_suite.transport import FakeBleakTransport
from ota_session import OtaCmd, OtaResult, OtaSession, OtaState
from shard_frame import build_ack_frame, build_frame, crc32, parse_frame
from status_frame import (
    StatusFlags,
    StatusFrame,
    StatusMode,
    parse_status_frame,
)

CHUNK_PAYLOAD = 1024  # OtaSession 默认 chunk_size(1027) - DATA_HEADER(3) = 1024

# --------------------------------------------------------------------------- #
# spec §7.2 灯效契约常量
# --------------------------------------------------------------------------- #

BREATHING_BLUE = "#1A3FCC"      # 呼吸蓝颜色
BREATHING_PEAK_PCT = 15         # 峰值限亮 15%
TRANSMIT_FPS = 5                # 传输中 5 FPS
PLAYBACK_FPS = 40               # 回放/实时 40 FPS
SOLID_GREEN = "#00FF00"         # 提交后常亮绿


def contract_for(frame: StatusFrame) -> dict:
    """把状态帧模式映射为 spec §7.2 灯效契约（外部行为，不碰渲染内部）。"""
    if frame.mode_enum == StatusMode.TRANSMITTING:
        return {
            "effect": "breathing_blue",
            "color": BREATHING_BLUE,
            "peak_percent": BREATHING_PEAK_PCT,
            "fps": TRANSMIT_FPS,
        }
    if frame.mode_enum == StatusMode.PLAYBACK:
        return {
            "effect": "normal_playback",
            "color": None,
            "peak_percent": None,
            "fps": PLAYBACK_FPS,
        }
    if frame.mode_enum == StatusMode.REALTIME:
        return {
            "effect": "normal_playback_realtime",
            "color": None,
            "peak_percent": None,
            "fps": PLAYBACK_FPS,
        }
    return {"effect": "unknown", "color": None, "peak_percent": None, "fps": None}


def assert_transmitting_frame(frame: StatusFrame) -> None:
    """传输中帧：mode=2、传输位置位、呼吸蓝 #1A3FCC、峰值 15%、5 FPS。"""
    assert frame.mode_enum == StatusMode.TRANSMITTING
    assert frame.is_transmitting
    assert frame.brightness_limit == BREATHING_PEAK_PCT
    assert contract_for(frame) == {
        "effect": "breathing_blue",
        "color": BREATHING_BLUE,
        "peak_percent": BREATHING_PEAK_PCT,
        "fps": TRANSMIT_FPS,
    }


def assert_playback_frame(frame: StatusFrame) -> None:
    """回放/实时帧：mode=0 或 1、非传输、40 FPS。"""
    assert frame.mode_enum in (StatusMode.PLAYBACK, StatusMode.REALTIME)
    assert not frame.is_transmitting
    assert contract_for(frame)["fps"] == PLAYBACK_FPS


def assert_commit_solid_green_frame_stops(result: OtaResult,
                                          session: OtaSession,
                                          sim) -> None:
    """COMMIT 成功：result ok/state DONE、提交一次且不中止、常亮绿、停帧。

    停帧体现为：设备重启后不再上报新状态帧；status_frames 在 run() 结束后
    已定型，且不包含提交后的新帧。合约：常亮绿 #00FF00，fps=0。
    """
    assert result.ok
    assert result.reason == "ok"
    assert session.state == OtaState.DONE
    assert sim.commit_count == 1
    assert sim.abort_count == 0
    assert all(fr.mode_enum != StatusMode.ERROR for fr in sim.status_frames)


# --------------------------------------------------------------------------- #
# 测试辅助：12 B 状态帧构建
# --------------------------------------------------------------------------- #

def build_status_frame(*, mode=0, arrangement_version=0, arrangement_crc32=0,
                       brightness_limit=30, token_holder=0, error_code=0,
                       temperature=0, flags=0) -> bytes:
    """构建一条 12 B 状态帧（全部小端）。"""
    return bytes([
        mode,
        arrangement_version & 0xFF, (arrangement_version >> 8) & 0xFF,
        arrangement_crc32 & 0xFF, (arrangement_crc32 >> 8) & 0xFF,
        (arrangement_crc32 >> 16) & 0xFF, (arrangement_crc32 >> 24) & 0xFF,
        brightness_limit,
        token_holder,
        error_code,
        temperature,
        flags,
    ])


def make_image(size: int) -> bytes:
    """确定性伪随机固件镜像，便于复现与校验指纹。"""
    return bytes((i * 31 + 7) % 256 for i in range(size))


# --------------------------------------------------------------------------- #
# 传输层转发器 + 设备侧 OTA/灯效模拟
# --------------------------------------------------------------------------- #

class _ForwardingTransport:
    """把 write(frame) 同步转发给 on_write，其余委托给内部传输层。"""

    def __init__(self, transport: FakeBleakTransport,
                 on_write) -> None:
        self._transport = transport
        self._on_write = on_write

    async def write(self, frame: bytes) -> None:
        await self._transport.write(frame)
        self._on_write(bytes(frame))

    def register_on_frame(self, cb):
        return self._transport.register_on_frame(cb)

    def register_on_status(self, cb):
        return self._transport.register_on_status(cb)

    @property
    def writes(self) -> List[bytes]:
        return self._transport.writes

    async def close(self) -> None:
        await self._transport.close()


class _OtaLightDeviceSim:
    """模拟设备侧 OTA 会话 + 灯效上报（spec §3.4 + §7.2）。

    主机写入经 forwarder 转发到 on_host_frame；设备应答通过 transport.inject
    回给 OtaSession；设备按阶段通过 transport.inject_status 上报 12 B 状态帧。
    """

    def __init__(self, transport: FakeBleakTransport, device_image: bytes,
                 *, commit_status: int = 0,
                 withhold_data_after: Optional[int] = None) -> None:
        self._transport = transport
        self._device_image = bytes(device_image)
        self._sha256 = hashlib.sha256(self._device_image).digest()
        self._crc = crc32(self._device_image)
        self._total_len = len(self._device_image)
        self._commit_status = commit_status
        # 连续 ACK 此数量的数据片后不再回 ACK，制造无进展 → 主机转「待续传」→ QUERY
        self._withhold_data_after = withhold_data_after
        self._data_acks_sent = 0
        self._bytes_written = 0
        self._phase = "idle"  # idle | transmitting | playback | committed
        # 是否仍处于「不回 ACK 数据片」阶段；QUERY 续传后恢复回 ACK
        self._withhold_active = withhold_data_after is not None

        self.begin_requests: List[dict] = []
        self.data_seqs: List[int] = []
        self.data_payloads: List[bytes] = []
        self.frames_from_host: List[bytes] = []
        self.status_frames: List[StatusFrame] = []  # 已注入的已解析状态帧，按顺序
        self.commit_count = 0
        self.abort_count = 0
        self.query_count = 0
        self.acks_sent: List[int] = []
        self._received_seqs: set = set()

    # -- 主机写入（由 forwarder 调用） -----------------------------------

    def on_host_frame(self, frame: bytes) -> None:
        p = parse_frame(frame)
        if p is None:
            return
        self.frames_from_host.append(bytes(frame))
        cmd = p["cmd"]
        if cmd == OtaCmd.BEGIN:
            self._on_begin(p)
        elif cmd == OtaCmd.DATA:
            self._on_data(p)
        elif cmd == OtaCmd.COMMIT:
            self._on_commit()
        elif cmd == OtaCmd.QUERY:
            self.query_count += 1
            self._transport.inject(build_frame(OtaCmd.QUERY, 0,
                                               self._bytes_written.to_bytes(4, "little")))
            # 待续传回：恢复正常回放，40 FPS（mode=0 PLAYBACK，传输位清），
            # 并恢复对后续数据片的 ACK
            self._withhold_active = False
            self._phase = "playback"
            self._inject_status(StatusMode.PLAYBACK, StatusFlags(0))
        elif cmd == OtaCmd.ABORT:
            self.abort_count += 1

    def _on_begin(self, p) -> None:
        payload = p["payload"]
        matched = False
        if len(payload) >= 44:
            image_size, sha256, app_version, crc_value = struct.unpack(
                "<I32sII", payload[:44]
            )
            self.begin_requests.append(dict(
                image_size=image_size, sha256=sha256,
                app_version=app_version, crc32=crc_value))
            matched = (image_size == self._total_len
                       and sha256 == self._sha256
                       and crc_value == self._crc)
        status = 0 if matched else 1
        self._transport.inject(build_ack_frame(0, 0, 0, status))
        if status == 0:
            # OTA_BEGIN 成功：进入传输模式，灯效切为呼吸蓝 5 FPS（mode=2，传输位）
            self._phase = "transmitting"
            self._inject_status(StatusMode.TRANSMITTING, StatusFlags.TRANSMITTING)

    def _on_data(self, p) -> None:
        seq = p["seq"]
        payload = p["payload"]
        self.data_seqs.append(seq)
        self.data_payloads.append(bytes(payload))
        self._received_seqs.add(seq)
        ack_up_to = -1
        while (ack_up_to + 1) in self._received_seqs:
            ack_up_to += 1
        # 达到 withhold_data_after 且仍在前传阶段时不再回 ACK，制造无进展
        # → 主机转「待续传」→ QUERY；QUERY 续传后恢复回 ACK
        if (self._withhold_data_after is not None and self._withhold_active
                and self._data_acks_sent >= self._withhold_data_after):
            return
        self._data_acks_sent += 1
        self.acks_sent.append(ack_up_to)
        self._bytes_written = (ack_up_to + 1) * CHUNK_PAYLOAD
        self._transport.inject(build_ack_frame(0, ack_up_to, 0, 0))
        if self._phase == "transmitting":
            self._inject_status(StatusMode.TRANSMITTING, StatusFlags.TRANSMITTING)

    def _on_commit(self) -> None:
        self.commit_count += 1
        self._transport.inject(build_ack_frame(0, 0, 0, self._commit_status))
        if self._commit_status == 0:
            # 提交成功：设备重启，常亮绿，停帧（不再上报状态帧）
            self._phase = "committed"

    # -- 状态帧注入 -----------------------------------------------------

    def _inject_status(self, mode: StatusMode, flags: StatusFlags) -> None:
        frame = build_status_frame(
            mode=int(mode),
            brightness_limit=(BREATHING_PEAK_PCT
                              if mode == StatusMode.TRANSMITTING else 100),
            flags=int(flags),
            error_code=0,
        )
        parsed = parse_status_frame(frame)
        self.status_frames.append(parsed)
        self._transport.inject_status(frame)


# --------------------------------------------------------------------------- #
# 会话驱动
# --------------------------------------------------------------------------- #

async def run_session(transport: FakeBleakTransport, sim: _OtaLightDeviceSim,
                      image: bytes, app_version: int, *,
                      per_ack_timeout_ms: int = 30,
                      begin_timeout_ms: int = 30,
                      commit_timeout_ms: int = 100):
    """跑完一次 OTA 会话，返回 (result, session)。小超时，headless 快速。"""
    forwarder = _ForwardingTransport(transport, sim.on_host_frame)
    session = OtaSession(
        forwarder,
        per_ack_timeout_ms=per_ack_timeout_ms,
        begin_timeout_ms=begin_timeout_ms,
        commit_timeout_ms=commit_timeout_ms,
    )
    result = await session.run(image, app_version)
    return result, session


# =========================================================================== #
# 用例
# =========================================================================== #

def test_light_effect_contract_mapping():
    """spec §7.2 契约映射是固定值：传输中=呼吸蓝 #1A3FCC 峰值 15% 5 FPS，
    回放/实时=40 FPS。"""
    tx = contract_for(parse_status_frame(
        build_status_frame(mode=2, flags=int(StatusFlags.TRANSMITTING))))
    assert tx == {
        "effect": "breathing_blue",
        "color": BREATHING_BLUE,
        "peak_percent": BREATHING_PEAK_PCT,
        "fps": TRANSMIT_FPS,
    }
    for mode in (StatusMode.PLAYBACK, StatusMode.REALTIME):
        pb = contract_for(parse_status_frame(build_status_frame(mode=int(mode))))
        assert pb["effect"].startswith("normal_playback")
        assert pb["fps"] == PLAYBACK_FPS


@pytest.mark.asyncio
async def test_ota_begin_and_data_breathing_blue_5fps_then_commit_solid_green(
        fake_transport):
    """(1) OTA_BEGIN 成功 → mode=2 传输中，呼吸蓝 #1A3FCC 峰值 15% 5 FPS；
    DATA 期间 mode 持续 2；COMMIT 成功 → 常亮绿，停帧。"""
    image = make_image(4 * CHUNK_PAYLOAD)
    sim = _OtaLightDeviceSim(fake_transport, image, commit_status=0)

    result, session = await run_session(fake_transport, sim, image,
                                        app_version=1)

    assert_commit_solid_green_frame_stops(result, session, sim)
    assert sim.begin_requests
    assert sim.begin_requests[0]["image_size"] == len(image)
    assert sorted(sim.data_seqs) == list(range(4))

    # 第 1 条状态帧在 OTA_BEGIN 成功后即为传输中
    assert sim.status_frames, "设备应在 OTA 期间上报状态帧"
    assert_transmitting_frame(sim.status_frames[0])
    # DATA 期间 mode 持续 2（呼吸蓝 5 FPS 不中断）
    for fr in sim.status_frames:
        assert_transmitting_frame(fr)


@pytest.mark.asyncio
async def test_resume_returns_to_playback_40fps_then_commit_solid_green(
        fake_transport):
    """(2) 待续传回（QUERY/RESUME）后：mode 回落 PLAYBACK，40 FPS 恢复；
    随后 COMMIT 成功 → 常亮绿，停帧。"""
    image = make_image(4 * CHUNK_PAYLOAD)
    sim = _OtaLightDeviceSim(fake_transport, image, commit_status=0,
                             withhold_data_after=1)

    result, session = await run_session(fake_transport, sim, image,
                                        app_version=1,
                                        per_ack_timeout_ms=20)

    assert_commit_solid_green_frame_stops(result, session, sim)
    assert sim.query_count >= 1  # 确实触发了 QUERY 续传

    # 续传点之前为传输中；续传后回落正常回放，40 FPS
    assert sim.status_frames
    assert_transmitting_frame(sim.status_frames[0])
    playback = [fr for fr in sim.status_frames
                if fr.mode_enum in (StatusMode.PLAYBACK, StatusMode.REALTIME)]
    assert playback, "续传后应回落 PLAYBACK/REALTIME"
    for fr in playback:
        assert_playback_frame(fr)
    # 播放恢复后不再出现传输中
    last_pb = max(i for i, fr in enumerate(sim.status_frames)
                  if fr.mode_enum in (StatusMode.PLAYBACK, StatusMode.REALTIME))
    assert all(fr.mode_enum in (StatusMode.PLAYBACK, StatusMode.REALTIME)
               for fr in sim.status_frames[last_pb:])
