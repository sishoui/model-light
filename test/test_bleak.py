# -*- coding: utf-8 -*-
"""
验证 Python + bleak 在 Windows 上与 ESP32-C3 BLE 通信的可行性
"""
import asyncio
import sys
from bleak import BleakScanner, BleakClient
from bleak.backends.characteristic import BleakGATTCharacteristic

# 设置输出编码为 UTF-8
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# 目标服务 UUID
SERVICE_UUID = "7c9f0000-1b2a-4c3d-9e8f-000000000000"
CHAR_STATUS = "7c9f0004-1b2a-4c3d-9e8f-000000000000"
CHAR_INFO = "7c9f0005-1b2a-4c3d-9e8f-000000000000"

async def scan_and_connect():
    print("=== Step 1: Scan BLE devices ===")
    try:
        scanner = BleakScanner()
        discovered = await scanner.discover(timeout=10.0)
        for d in discovered:
            print(f"  Device: {d.name}, Address: {d.address}")
            # Check if service UUID is in advertisement data
            service_uuids = d.metadata.get('uuids', []) if hasattr(d, 'metadata') else []
            print(f"    Service UUIDs: {service_uuids}")
    except Exception as e:
        print(f"  [FAIL] Scan failed: {e}")
        return

    # 按广播名 ML-XXXX 过滤
    ml_devices = [d for d in discovered if d.name and d.name.startswith('ML-')]
    if not ml_devices:
        print("  [FAIL] No ML-XXXX device found")
        return

    device = ml_devices[0]
    print(f"  [OK] Found ML-XXXX device: {device.name} ({device.address})")
    print(f"\n=== Step 2: Connect to device {device.address} ===")
    try:
        async with BleakClient(device.address) as client:
            print(f"  [OK] Connected")
            connected = client.is_connected
            print(f"  Connection status: {connected}")

            print(f"\n=== Step 3: Discover services ===")
            services = client.services
            count = 0
            for service in services:
                count += 1
                print(f"  Service: {service.uuid}")
                for char in service.characteristics:
                    print(f"    Characteristic: {char.uuid}, Properties: {char.properties}")
            print(f"  Service count: {count}")

            print(f"\n=== Step 4: Read device info characteristic {CHAR_INFO} ===")
            try:
                info_value = await client.read_gatt_char(CHAR_INFO)
                print(f"  [OK] Read success: {info_value.hex()}")
            except Exception as e:
                print(f"  [FAIL] Read failed: {e}")

            print(f"\n=== Step 5: Subscribe to status frame notification {CHAR_STATUS} ===")
            def notification_handler(characteristic: BleakGATTCharacteristic, data: bytearray):
                print(f"  Notification received: {data.hex()}")

            try:
                await client.start_notify(CHAR_STATUS, notification_handler)
                print(f"  [OK] Subscribe success, waiting 5 seconds...")
                await asyncio.sleep(5)
                await client.stop_notify(CHAR_STATUS)
                print(f"  [OK] Stop subscribe")
            except Exception as e:
                print(f"  [FAIL] Subscribe failed: {e}")

            print(f"\n=== Step 6: Try to read status frame {CHAR_STATUS} ===")
            try:
                status_value = await client.read_gatt_char(CHAR_STATUS)
                print(f"  [OK] Read success: {status_value.hex()}")
            except Exception as e:
                print(f"  [FAIL] Read failed: {e}")

    except Exception as e:
        print(f"  [FAIL] Connection failed: {e}")

    print(f"\n=== Verification complete ===")

if __name__ == "__main__":
    asyncio.run(scan_and_connect())
