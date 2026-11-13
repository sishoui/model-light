"""Partition-table invariants (issue #92).

The firmware must build with the custom partition table from
firmware/partitions.csv: dual OTA slots, no factory. With the ESP-IDF default
single-app table esp_ota_get_next_update_partition() returns NULL and OTA
BEGIN fails with MLOTA_ERR_FLASH (issue #79).
"""

import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = ROOT / "firmware" / "sdkconfig.defaults"
CSV = ROOT / "firmware" / "partitions.csv"


def _defaults():
    text = DEFAULTS.read_text(encoding="utf-8")
    return dict(re.findall(r"^([A-Z0-9_]+)=(.*)$", text, re.M))


def _rows():
    lines = [
        line
        for line in CSV.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    return [[field.strip() for field in row] for row in csv.reader(lines)]


def test_custom_partition_table_enabled():
    cfg = _defaults()
    assert cfg.get("CONFIG_PARTITION_TABLE_CUSTOM") == "y"
    assert cfg.get("CONFIG_PARTITION_TABLE_CUSTOM_FILENAME") == '"partitions.csv"'


def test_dual_ota_slots_without_factory():
    rows = _rows()
    by_name = {r[0]: r for r in rows}
    assert "factory" not in by_name
    for name in ("ota_0", "ota_1"):
        row = by_name[name]
        assert row[1] == "app" and row[2] == name
        assert int(row[4], 16) == 0x190000  # 1.5 MiB slots, MLOTA_SLOT_SIZE_MAX
    # app offsets must not overlap
    spans = sorted((int(r[3], 16), int(r[4], 16)) for r in rows if r[1] == "app")
    for (_, size), (next_off, _) in zip(spans, spans[1:]):
        assert size <= next_off


def test_otadata_present():
    # esp_ota_set_boot_partition() needs an otadata partition (2 sectors).
    row = {r[0]: r for r in _rows()}["otadata"]
    assert row[1] == "data" and row[2] == "ota"
    assert int(row[4], 16) == 0x2000


def test_flash_size_fits_partition_table():
    end = max(int(r[3], 16) + int(r[4], 16) for r in _rows())
    assert end <= 4 * 1024 * 1024
    cfg = _defaults()
    assert cfg.get("CONFIG_ESPTOOLPY_FLASHSIZE_4MB") == "y"
    assert cfg.get("CONFIG_ESPTOOLPY_FLASHSIZE") == '"4MB"'