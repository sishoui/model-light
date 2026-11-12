# -*- coding: utf-8 -*-
"""
T1/T11 conftest：host/ble_suite 共享 fixture 与失败报告。

- 提供可在所有票据中复用的假传输层工厂（headless，无 bleak 依赖）。
- 注册 `spec_section` / `error_code` 自定义标记，并在测试失败时把失败
  映射到 spec 章节 + 错误码，输出终端摘要并写入 JSON 报告
  （`--report-file`，默认 host/ble_suite/ble_suite_report.json，仅失败时写入）。
  供 CI 合并门禁使用：`python -m pytest host/ble_suite/ -q` 任一失败
  非零退出，报告即可定位到具体章节与错误码，无需人工翻日志。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ble_suite.transport import FakeBleakTransport

# 测试文件名 -> spec 章节的回退推断（当测试未打 spec_section 标记时使用）。
_SECTION_BY_FILE_PREFIX = {
    "test_t1": "transport",
    "test_t2": "§2.2",
    "test_t3": "§6/§2.5",
    "test_t4": "§2.9",
    "test_t5": "§2.10/§2.2",
    "test_t6": "§3.4",
    "test_t7": "§3.4/§6",
    "test_t8": "§5.1/§2.9",
    "test_t9": "§6/§7.3",
    "test_t10": "§7.2",
}


def pytest_addoption(parser):
    parser.addoption(
        "--report-file",
        action="store",
        default=None,
        help="BLE 套件失败报告 JSON 写入路径；默认 host/ble_suite/ble_suite_report.json，"
        "仅在有失败时写入",
    )


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "spec_section(section): 失败所属 spec 章节，如 §2.2 / §3.4 / §5.1 / §6 / §7",
    )
    config.addinivalue_line(
        "markers",
        "error_code(code): 失败对应的错误码，如 0x0A / 0x01 / 0x05 / 0x08-0x0B",
    )
    report_file = config.getoption("--report-file")
    config._ble_suite_report_path = (
        Path(report_file) if report_file else config.rootdir / "host" / "ble_suite" / "ble_suite_report.json"
    )
    config._ble_suite_failures: list[dict] = []


def _infer_section(test_path) -> str:
    """从测试文件名推断 spec 章节（未打标记时的回退）。"""
    stem = Path(test_path).stem
    for prefix, section in _SECTION_BY_FILE_PREFIX.items():
        if stem == prefix or stem.startswith(prefix + "_"):
            return section
    return "unknown"


def _marker_values(item, name: str) -> list[str]:
    """收集某名称标记的所有位置参数（含 module-level pytestmark）。"""
    values: list[str] = []
    for marker in item.iter_markers(name):
        values.extend(str(arg) for arg in marker.args)
    return values


def _record_failure(item, call, report) -> None:
    """把一次失败记录到 config._ble_suite_failures（供终端摘要与 JSON 报告用）。"""
    if call.when != "call" or call.excinfo is None:
        return
    try:
        excinfo = call.excinfo
        message = str(excinfo.value) if excinfo is not None else ""
        sections = _marker_values(item, "spec_section")
        codes = _marker_values(item, "error_code")
        if not sections:
            sections = [_infer_section(item.path)]
        entry = {
            "nodeid": item.nodeid,
            "spec_section": "/".join(sections) or "unknown",
            "error_code": "/".join(codes),
            "error_message": message,
        }
        failures = getattr(item.config, "_ble_suite_failures", None)
        if failures is not None:
            failures.append(entry)
    except Exception:
        # 报告器必须对未标记/通过的测试鲁棒，绝不把自身异常抛给会话。
        pass


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    try:
        _record_failure(item, call, report)
    except Exception:
        pass


def _write_report(config) -> None:
    failures = getattr(config, "_ble_suite_failures", None) or []
    if not failures:
        return
    report_path = getattr(config, "_ble_suite_report_path", None)
    if not report_path:
        return
    try:
        report_path = Path(report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        by_section: dict[str, dict[str, list[str]]] = {}
        for failure in failures:
            by_section.setdefault(failure["spec_section"], {}).setdefault(
                failure["error_code"] or "(none)", []
            ).append(failure["nodeid"])
        payload = {
            "suite": "ble_suite",
            "count": len(failures),
            "failures": failures,
            "failure_map": by_section,
        }
        report_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception:
        pass


def pytest_terminal_summary(terminalreporter, exitstatus, config) -> None:
    try:
        failures = getattr(config, "_ble_suite_failures", None) or []
        if failures:
            terminalreporter.write_line("")
            terminalreporter.write_line("=== Spec-section failure map (ble_suite) ===")
            by_section: dict[str, dict[str, list[tuple[str, str]]]] = {}
            for failure in failures:
                by_section.setdefault(failure["spec_section"], {}).setdefault(
                    failure["error_code"] or "(none)", []
                ).append((failure["nodeid"], failure["error_message"]))
            for section, codes in by_section.items():
                terminalreporter.write_line(f"{section}:")
                for code, items in codes.items():
                    terminalreporter.write_line(f"  {code}:")
                    for nodeid, message in items:
                        terminalreporter.write_line(f"    - {nodeid} :: {message}")
            terminalreporter.write_line("=== end Spec-section failure map ===")
        _write_report(config)
    except Exception:
        pass


@pytest.fixture
def fake_transport():
    """新建一个假 BLE 传输层（每个测试一个干净实例）。"""
    return FakeBleakTransport()


@pytest.fixture
def transport(fake_transport):
    """fake_transport 的别名，便于与现有 host/ 测试风格保持一致。"""
    return fake_transport
