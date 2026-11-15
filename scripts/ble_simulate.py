"""
模拟手机侧 BLE Central（L4 自动化），连 ESP32-C3 设备（广播名 ML-XXXX），
验证 BLE 协议交互：扫描 -> 连接 -> 发现服务/特征 -> 读状态帧 -> 发送实时帧/编排帧。

前置条件：
1. Windows / Linux / macOS 蓝牙已开启，ESP32-C3 正在广播（广播名 ML-XXXX）
2. 已安装 Python 3.9+
3. pip install bleak  （Windows 上若报错，请改用：pip install bleak winrt）

运行示例：
  python scripts/ble_simulate.py --name ML-A3F2 --timeout 15

注意：本脚本在电脑上扮演手机 Central，不依赖微信小程序，适合在 CI 或本地
做 BLE 协议回归。若需验证真实微信小程序 + 手机 BLE 栈，仍需人工真机测试。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Optional

try:
    from bleak import BleakClient, BleakScanner
    from bleak.backends.device import BLEDevice
except ImportError as exc:
    print(f"[ble_simulate] 缺少依赖 bleak: {exc}")
    print("请先安装：pip install bleak  （Windows 上可选：pip install bleak winrt）")
    sys.exit(1)

# Service / Characteristic UUIDs（与 firmware/main/ble.c 一致）
# 标准形式：7c9f0000-1b2a-4c3d-9e8f-00000000000N
# 低 16 位最后一位区分特征：01=command, 02=realtime, 03=seqblock, 04=status, 05=devinfo, 06=ota
SERVICE_UUID = "7c9f0000-1b2a-4c3d-9e8f-000000000000"

CHR_COMMAND = "7c9f0001-1b2a-4c3d-9e8f-000000000000"  # 写：命令通道
CHR_REALTIME = "7c9f0002-1b2a-4c3d-9e8f-000000000000"  # 写：实时参数
CHR_SEQBLOCK = "7c9f0003-1b2a-4c3d-9e8f-000000000000"  # 写/notify：编排分块
CHR_STATUS = "7c9f0004-1b2a-4c3d-9e8f-000000000000"    # 读/notify：设备状态帧（12 B）
CHR_DEVINFO = "7c9f0005-1b2a-4c3d-9e8f-000000000000"    # 读：设备信息（10 B）
CHR_OTA = "7c9f0006-1b2a-4c3d-9e8f-000000000000"        # 写/notify：OTA


def crc32_ieee(data: bytes) -> int:
    """与固件 / 小程序一致的 CRC32（IEEE 0xEDB88320）。"""
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ (0xEDB88320 if (crc & 1) else 0)
    return crc ^ 0xFFFFFFFF


def build_status_frame() -> bytes:
    """构造一个空读请求（读状态帧特征）。"""
    return b""


def build_realtime_frame(
    pin: int = 0,
    group_index: int = 0,
    stage_index: int = 0,
    layer: int = 0,
    param_index: int = 0,
    value: int | list[int] | None = None,
) -> bytes:
    """
    构造实时参数帧（与 miniprogram/lib/realtime-frame.js 一致）：
    pin(1) + groupIndex(1) + stageIndex(1) + layer(1) + paramIdx(1) + valueLen(1) + value(valueLen)
    最短 6 B，颜色 9 B，整数/枚举 7 B。
    """
    if not 0 <= pin <= 7:
        raise ValueError("pin 必须在 0-7")
    if layer not in (0, 1):
        raise ValueError("layer 必须是 0(背景) 或 1(动态)")

    value_bytes: list[int] = []
    if value is None:
        value_bytes = []
    elif isinstance(value, list):
        if len(value) > 3:
            raise ValueError("value 数组长度不能超过 3")
        value_bytes = [max(0, min(255, int(v))) for v in value]
    elif isinstance(value, bool):
        value_bytes = [1 if value else 0]
    elif isinstance(value, (int, float)):
        value_bytes = [max(0, min(255, int(value)))]
    else:
        raise TypeError("value 必须为数字/布尔/长度 0-3 的数组/None")

    frame = bytes([pin, group_index, stage_index, layer, param_index, len(value_bytes)]) + bytes(
        value_bytes
    )
    return frame


def build_seqblock_start(total_len: int, payload_version: int = 1, proto_major: int = 0, proto_minor: int = 0, crc32: int = 0) -> bytes:
    """编排 START 帧（cmd 0x01）：cmd(1) + seq(2 LE) + payload(10 B)"""
    seq = 0
    payload = bytes([
        total_len & 0xFF, (total_len >> 8) & 0xFF,   # totalLen(2 LE)
        payload_version & 0xFF, (payload_version >> 8) & 0xFF,  # payloadVersion(2 LE)
        proto_major, proto_minor,                     # protoMajor/Minor(1+1)
        crc32 & 0xFF, (crc32 >> 8) & 0xFF, (crc32 >> 16) & 0xFF, (crc32 >> 24) & 0xFF,  # crc32(4 LE)
    ])
    return bytes([0x01, seq & 0xFF, (seq >> 8) & 0xFF]) + payload


def build_seqblock_data(seq: int, payload: bytes) -> bytes:
    """编排 DATA 帧（cmd 0x02）：cmd(1) + seq(2 LE) + payload(n)"""
    return bytes([0x02, seq & 0xFF, (seq >> 8) & 0xFF]) + payload


def build_seqblock_fin() -> bytes:
    """编排 FIN 帧（cmd 0x03）"""
    return bytes([0x03])


def parse_status_frame(data: bytes) -> dict:
    """解析 12 字节设备状态帧（与 test/device-protocol.test.js 一致）。"""
    if len(data) != 12:
        return {"raw": data.hex(), "error": f"expected 12 B, got {len(data)}"}
    return {
        "mode": data[0],
        "tokenHolder": data[1],
        "errorCode": data[2],
        "flags": data[3],
        "fwMajor": data[4],
        "fwMinor": data[5],
        "protoMajor": data[6],
        "protoMinor": data[7],
        "deviceIdHi": data[8],
        "deviceIdLo": data[9],
        "crcOrReserved": data[10],
        "reserved": data[11],
    }


def parse_devinfo(data: bytes) -> dict:
    """解析设备信息帧（10 B）：fw/proto version, capability bitmap, device id"""
    if len(data) < 10:
        return {"raw": data.hex(), "error": f"expected >=10 B, got {len(data)}"}
    return {
        "fwMajor": data[0],
        "fwMinor": data[1],
        "protoMajor": data[2],
        "protoMinor": data[3],
        "capabilityBitmap": int.from_bytes(data[4:8], "little"),
        "deviceId": data[8:10].hex(),
    }


async def scan_device(name_substring: str, timeout: float = 10.0) -> Optional[BLEDevice]:
    """扫描包含 name_substring 的 BLE 设备。"""
    print(f"[ble_simulate] 扫描设备（包含 '{name_substring}'），超时 {timeout}s ...")
    devices = await BleakScanner.discover(timeout=timeout)
    for d in devices:
        name = d.name or ""
        if name_substring in name:
            print(f"[ble_simulate] 发现：{name} @ {d.address}")
            return d
    print("[ble_simulate] 未发现匹配设备")
    return None


async def run(
    name: str,
    timeout: float,
    read_status: bool,
    read_devinfo: bool,
    send_realtime: bool,
    send_seqblock: bool,
) -> None:
    device = await scan_device(name, timeout)
    if not device:
        return

    print(f"[ble_simulate] 连接 {device.name or 'unknown'} ({device.address}) ...")
    async with BleakClient(device, timeout=timeout) as client:
        print(f"[ble_simulate] 已连接：{client.is_connected}")

        # 发现服务
        svc = client.services.get_service(SERVICE_UUID)
        if svc is None:
            print(f"[ble_simulate] 未发现服务 {SERVICE_UUID}")
            return
        print(f"[ble_simulate] 发现服务 {SERVICE_UUID}，特征数：{len(svc.characteristics)}")

        # 读设备信息
        if read_devinfo:
            try:
                devinfo = await client.read_gatt_char(CHR_DEVINFO)
                print(f"[ble_simulate] 设备信息：{parse_devinfo(devinfo)} (原始 {devinfo.hex()})")
            except Exception as exc:
                print(f"[ble_simulate] 读设备信息失败：{exc}")

        # 读状态帧
        if read_status:
            try:
                status = await client.read_gatt_char(CHR_STATUS)
                print(f"[ble_simulate] 状态帧：{parse_status_frame(status)} (原始 {status.hex()})")
            except Exception as exc:
                print(f"[ble_simulate] 读状态帧失败：{exc}")

        # 发送实时帧
        if send_realtime:
            frame = build_realtime_frame(pin=0, layer=0, param_index=0, value=[200, 60, 30])
            try:
                await client.write_gatt_char(CHR_REALTIME, frame)
                print(f"[ble_simulate] 发送实时帧：{frame.hex()} (长度 {len(frame)} B)")
            except Exception as exc:
                print(f"[ble_simulate] 发送实时帧失败：{exc}")

        # 发送编排 START/DATA/FIN（空编排，仅做格式校验）
        if send_seqblock:
            try:
                start = build_seqblock_start(total_len=0, crc32=crc32_ieee(b""))
                await client.write_gatt_char(CHR_SEQBLOCK, start)
                print(f"[ble_simulate] 发送 SEQBLOCK START：{start.hex()}")
                fin = build_seqblock_fin()
                await client.write_gatt_char(CHR_SEQBLOCK, fin)
                print(f"[ble_simulate] 发送 SEQBLOCK FIN：{fin.hex()}")
            except Exception as exc:
                print(f"[ble_simulate] 发送 SEQBLOCK 失败：{exc}")

        # 订阅状态通知（示例：监听 5 秒）
        notifications: list[bytes] = []

        def on_notify(sender, data: bytearray):
            notifications.append(bytes(data))
            print(f"[ble_simulate] 收到通知 @ {sender}: {bytes(data).hex()}")

        try:
            await client.start_notify(CHR_STATUS, on_notify)
            print("[ble_simulate] 已订阅状态通知，等待 5s ...")
            await asyncio.sleep(5)
            await client.stop_notify(CHR_STATUS)
        except Exception as exc:
            print(f"[ble_simulate] 订阅通知失败（可能特征不支持 notify）：{exc}")

        print(f"[ble_simulate] 共收到 {len(notifications)} 条通知")
        print("[ble_simulate] 断开连接")


def main() -> None:
    parser = argparse.ArgumentParser(description="模拟手机 BLE Central 连 ML-XXXX 设备")
    parser.add_argument("--name", default="ML-", help="设备广播名子串（默认 ML-）")
    parser.add_argument("--timeout", type=float, default=15.0, help="扫描/连接超时秒数")
    parser.add_argument("--no-status", action="store_true", help="不读取状态帧")
    parser.add_argument("--no-devinfo", action="store_true", help="不读取设备信息")
    parser.add_argument("--realtime", action="store_true", help="发送一条实时参数帧")
    parser.add_argument("--seqblock", action="store_true", help="发送编排 START/FIN 帧")
    args = parser.parse_args()

    asyncio.run(
        run(
            name=args.name,
            timeout=args.timeout,
            read_status=not args.no_status,
            read_devinfo=not args.no_devinfo,
            send_realtime=args.realtime,
            send_seqblock=args.seqblock,
        )
    )


if __name__ == "__main__":
    main()
