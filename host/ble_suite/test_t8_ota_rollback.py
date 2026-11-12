# -*- coding: utf-8 -*-
"""
T8 验收测试：OTA 失败与回滚路径（spec §3.4 / §5.1 / issue #46）。

触发各类提交失败（坏 CRC/镜像无效/版本被拒/set_boot 失败），验证任一步
失败均 esp_ota_abort，不改 boot 分区；错误码 0x08-0x0B 映射正确；主机按
COMMIT 应答 status 判定 commit-failed。

设备侧由 _OtaDeviceSim 模拟：回答 OTA_BEGIN(status=0)、逐片累计 ACK(DATA)、
回答 COMMIT(status=1 提交失败 / 0 成功 / 暗默超时)。主机驱动 OtaSession.run()
走同一传输层。纯 stdlib + pytest，无 bleak、无真实设备，headless 可运行。

断言只覆盖外部行为（COMMIT 应答 status、result.reason/state/bytes_written、
设备端 abort/set_boot 记录、错误码映射），不碰内部结构体字段。
"""

from __future__ import annotations

import hashlib
import struct
from typing import Callable, List, Optional, Tuple

import pytest

from ble_suite.transport import FakeBleakTransport
from ota_session import (
    OtaCmd,
    OtaProgress,
    OtaResult,
    OtaSession,
    OtaState,
)
from shard_frame import build_ack_frame, crc32, parse_frame
from status_frame import StatusErrorCode, error_code_message, parse_status_frame

CHUNK_PAYLOAD = 1024  # OtaSession 默认 chunk_size(1027) - DATA_HEADER(3) = 1024


# --------------------------------------------------------------------------- #
# 传输层转发器：把主机的 write 同步送到设备模拟器，设备应答经 inject 回主机   #
# --------------------------------------------------------------------------- #

class _ForwardingTransport:
    """把 write(frame) 同步转发给 on_write，其余委托给内部传输层。"""

    def __init__(self, transport: FakeBleakTransport,
                 on_write: Callable[[bytes], None]) -> None:
        self._transport = transport
        self._on_write = on_write

    async def write(self, frame: bytes) -> None:
        await self._transport.write(frame)
        self._on_write(bytes(frame))

    def register_on_frame(self, cb: Callable[[bytes], None]):
        return self._transport.register_on_frame(cb)

    def register_on_status(self, cb: Callable[[object], None]):
        return self._transport.register_on_status(cb)

    @property
    def writes(self) -> List[bytes]:
        return self._transport.writes

    async def close(self) -> None:
        await self._transport.close()


# --------------------------------------------------------------------------- #
# 设备侧 OTA 模拟（spec §3.4）                                                 #
# --------------------------------------------------------------------------- #

class _OtaDeviceSim:
    """模拟设备侧 OTA 会话，运行在同一 FakeBleakTransport 上。

    主机写入经 forwarder 转发到 on_host_frame；设备应答通过 transport.inject
    回给 OtaSession。只响应主机命令帧（0x20..0x25），忽略自己注入的 ACK
    (0x05/0x06) 与其它帧。

    外部记录（供断言）：begin_requests、data_seqs、frames_from_host、
    commit_count、device_abort_calls（esp_ota_abort 被调用）、
    set_boot_count（esp_ota_set_boot_partition 被调用）、query_count。
    """

    def __init__(
        self,
        transport: FakeBleakTransport,
        device_image: bytes,
        *,
        commit_status: int = 0,
        commit_silent: bool = False,
        reply_begin: bool = True,
        fail_reason: Optional[int] = None,
    ) -> None:
        # 设备侧已存固件（指纹参考）；主机会话的镜像与之对比判定是否匹配。
        self._transport = transport
        self._device_image = bytes(device_image)
        self._sha256 = hashlib.sha256(self._device_image).digest()
        self._crc = crc32(self._device_image)
        self._total_len = len(self._device_image)
        self._commit_status = commit_status
        self._commit_silent = commit_silent
        self._reply_begin = reply_begin
        self.commit_fail_reason = fail_reason  # 0x08/0x09/0x0A/0x0B 等

        self.begin_requests: List[dict] = []
        self.data_seqs: List[int] = []
        self.data_payloads: List[bytes] = []
        self.frames_from_host: List[bytes] = []
        self.commit_count = 0
        self.device_abort_calls = 0   # 设备侧 esp_ota_abort 被调用次数
        self.set_boot_count = 0       # 设备侧 esp_ota_set_boot_partition 被调用次数
        self.query_count = 0
        self.acks_sent: List[int] = []  # 每次发出的 ack_up_to
        self._received_seqs: set[int] = set()

    # -- 供 forwarder 调用：主机写入一帧 -----------------------------------

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
        elif cmd == OtaCmd.ABORT:
            # 主机发出的 ABORT 帧；提交失败路径下主机不应自行发出
            pass
        elif cmd == OtaCmd.QUERY:
            self.query_count += 1
        # 忽略 0x05/0x06（自己注入的应答）与其它帧

    # -- 设备应答 ----------------------------------------------------------

    def _on_begin(self, p) -> None:
        payload = p["payload"]
        matched = False
        if len(payload) >= 44:
            image_size, sha256, app_version, crc_value = struct.unpack(
                "<I32sII", payload[:44]
            )
            self.begin_requests.append(
                dict(
                    image_size=image_size,
                    sha256=sha256,
                    app_version=app_version,
                    crc32=crc_value,
                )
            )
            matched = (
                image_size == self._total_len
                and sha256 == self._sha256
                and crc_value == self._crc
            )
        # 指纹不符：静默作废旧会话（esp_ota_abort + 清 NVS），回 status=1
        status = 0 if matched else 1
        if self._reply_begin:
            self._transport.inject(build_ack_frame(0, 0, 0, status))

    def _on_data(self, p) -> None:
        seq = p["seq"]
        payload = p["payload"]
        self.data_seqs.append(seq)
        self.data_payloads.append(bytes(payload))
        self._received_seqs.add(seq)
        # 累计 ACK：ackUpTo = 迄今收到的最大连续片（按序到达）
        ack_up_to = -1
        while (ack_up_to + 1) in self._received_seqs:
            ack_up_to += 1
        self.acks_sent.append(ack_up_to)
        self._transport.inject(build_ack_frame(0, ack_up_to, 0, 0))

    def _on_commit(self) -> None:
        self.commit_count += 1
        if self._commit_silent:
            # 设备收到 COMMIT 后沉默，不回应答 -> 主机侧 commit-timeout
            return
        if self._commit_status != 0:
            # 提交失败：整份 CRC32/esp_ota_end/版本校验/set_boot 任一环节失败，
            # 设备已 esp_ota_abort，未触及 esp_ota_set_boot_partition。
            self.device_abort_calls += 1
        else:
            # 提交成功：整份 CRC32 -> esp_ota_end -> 版本校验 ->
            # esp_ota_set_boot_partition -> 重启
            self.set_boot_count += 1
        self._transport.inject(build_ack_frame(0, 0, 0, self._commit_status))


# --------------------------------------------------------------------------- #
# 测试辅助                                                                    #
# --------------------------------------------------------------------------- #

def make_image(size: int) -> bytes:
    """确定性伪随机固件镜像，便于复现与校验指纹。"""
    return bytes((i * 31 + 7) % 256 for i in range(size))


async def run_session(
    transport: FakeBleakTransport,
    device: _OtaDeviceSim,
    image: bytes,
    app_version: int,
    *,
    on_progress: Optional[Callable[[OtaProgress], None]] = None,
    per_ack_timeout_ms: int = 100,
    begin_timeout_ms: int = 50,
    commit_timeout_ms: int = 100,
) -> Tuple[OtaResult, OtaSession]:
    """跑完一次 OTA 会话，返回 (result, session) 以便断言 state。"""
    forwarder = _ForwardingTransport(transport, device.on_host_frame)
    session = OtaSession(
        forwarder,
        on_progress=on_progress,
        per_ack_timeout_ms=per_ack_timeout_ms,
        begin_timeout_ms=begin_timeout_ms,
        commit_timeout_ms=commit_timeout_ms,
    )
    result = await session.run(image, app_version)
    return result, session


# --------------------------------------------------------------------------- #
# 状态帧错误码映射（spec §2.9 / §5.2 0x08-0x0B）                              #
# --------------------------------------------------------------------------- #

def build_status_frame(
    *,
    mode: int = 0,
    arrangement_version: int = 0,
    arrangement_crc32: int = 0,
    brightness_limit: int = 30,
    token_holder: int = 0,
    error_code: int = 0,
    temperature: int = 0,
    flags: int = 0,
) -> bytes:
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


@pytest.mark.parametrize("code,expected", [
    (0x08, "flash 失败（OTA）"),
    (0x09, "镜像无效（OTA）"),
    (0x0A, "CRC 不符（OTA）"),
    (0x0B, "版本被拒（OTA）"),
])
@pytest.mark.spec_section("§2.9")
@pytest.mark.error_code("0x08-0x0B")
def test_status_error_code_mapping_0x08_to_0x0b(code, expected):
    """spec §2.9 / §5.2：0x08-0x0B 错误码与人类可读消息映射。"""
    assert StatusErrorCode(code).name in (
        "OTA_FLASH_FAIL", "OTA_IMAGE_INVALID", "OTA_CRC_MISMATCH",
        "OTA_VERSION_REJECTED",
    )
    assert error_code_message(code) == expected

    frame = build_status_frame(error_code=code)
    assert len(frame) == 12
    parsed = parse_status_frame(frame)
    assert parsed is not None
    assert parsed.error_code == code
    assert parsed.error_message == expected
    assert not parsed.is_ok  # 非 0 错误码 -> is_ok 为 False


# =========================================================================== #
# OTA 提交失败与回滚用例                                                      #
# =========================================================================== #

@pytest.mark.asyncio
@pytest.mark.error_code("0x08")
async def test_commit_failed_device_already_aborted(fake_transport):
    """(1) COMMIT 应答 status=1（设备已 esp_ota_abort）：
    result commit-failed / FAILED，bytes_written==len(img)；
    设备未触及 set_boot_partition（boot 分区未改）；主机不再发 ABORT。"""
    image = make_image(3 * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(fake_transport, image,
                           commit_status=1,
                           fail_reason=StatusErrorCode.OTA_FLASH_FAIL)

    result, session = await run_session(fake_transport, device, image, 1)

    assert not result.ok
    assert result.reason == "commit-failed"
    assert result.bytes_written == len(image)
    assert result.total_len == len(image)
    assert result.app_version == 1
    assert session.state == OtaState.FAILED

    cmds = [f[0] for f in device.frames_from_host]
    assert OtaCmd.BEGIN in cmds
    assert OtaCmd.DATA in cmds
    assert OtaCmd.COMMIT in cmds
    assert OtaCmd.ABORT not in cmds  # 主机不自行发 ABORT，设备已 abort

    assert device.commit_count == 1
    assert device.device_abort_calls >= 1   # esp_ota_abort 已被调用
    assert device.set_boot_count == 0       # esp_ota_set_boot_partition 未达 -> boot 分区未改


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_reason", [
    StatusErrorCode.OTA_FLASH_FAIL,        # 0x08 坏 CRC / flash 失败
    StatusErrorCode.OTA_IMAGE_INVALID,     # 0x09 镜像无效
    StatusErrorCode.OTA_CRC_MISMATCH,      # 0x0A CRC 不符
    StatusErrorCode.OTA_VERSION_REJECTED,  # 0x0B 版本被拒
])
@pytest.mark.error_code("0x08-0x0B")
async def test_commit_failed_each_error_code_aborts_not_set_boot(
    fake_transport, fail_reason
):
    """(2) 各类提交失败均表现为 COMMIT status=1 -> commit-failed；
    设备 esp_ota_abort，不改 boot 分区。"""
    image = make_image(2 * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(fake_transport, image,
                           commit_status=1,
                           fail_reason=fail_reason)

    result, session = await run_session(fake_transport, device, image, 1)

    assert not result.ok
    assert result.reason == "commit-failed"
    assert result.bytes_written == len(image)
    assert session.state == OtaState.FAILED

    assert device.commit_count == 1
    assert device.device_abort_calls >= 1
    assert device.set_boot_count == 0
    assert OtaCmd.ABORT not in [f[0] for f in device.frames_from_host]


@pytest.mark.asyncio
async def test_commit_timeout_device_silent(fake_transport):
    """(3) 设备收到 COMMIT 后沉默不应答 -> commit-timeout, FAILED。"""
    image = make_image(1 * CHUNK_PAYLOAD)
    device = _OtaDeviceSim(fake_transport, image,
                           commit_status=0,
                           commit_silent=True)

    result, session = await run_session(
        fake_transport, device, image, 1, commit_timeout_ms=50)

    assert not result.ok
    assert result.reason == "commit-timeout"
    assert result.bytes_written == len(image)
    assert session.state == OtaState.FAILED

    assert device.commit_count == 1
    assert device.device_abort_calls == 0   # 未收到应答，未 esp_ota_abort
    assert device.set_boot_count == 0       # 未提交，boot 分区未改
    assert OtaCmd.ABORT not in [f[0] for f in device.frames_from_host]
