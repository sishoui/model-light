# -*- coding: utf-8 -*-
"""
T11 验收测试：CI 单命令入口 + 失败报告（spec §2.2/§2.9/§3.4/§5.1/§6/§7）。

验证：
1. `python -m pytest host/ble_suite/ -q`：任一用例失败时非零退出（pytest 默认行为）。
   通过子进程对一个临时失败用例文件演示，测试结束后删除临时文件，
   永不在套件中留下一个恒失败的用例。
2. 失败报告：conftest 的 pytest_runtest_makereport / pytest_terminal_summary
   把失败映射到 spec 章节 + 错误码，终端打印“Spec-section failure map”并
   写入 JSON 报告（--report-file 指定路径；默认 host/ble_suite/ble_suite_report.json）。
   报告条目：nodeid + spec_section + error_code + error_message，CI 可直接定位。
3. 探针文件含两个带标记的失败用例（§3.4/0x0A、§2.9/0x01），子进程跑完后断言
   JSON 报告存在并包含对应的章节/错误码/错误消息。

全部 headless，无需 bleak、无需真实 BLE 设备。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

BLE_SUITE = Path(__file__).resolve().parent  # host/ble_suite
ROOT = BLE_SUITE.parent.parent  # 仓库 worktree 根目录

# 临时探针文件：单个失败用例，用于演示“任一失败非零退出”。
TMP_NONZERO_TEST = '''# -*- coding: utf-8 -*-
"""T11 非零退出探针（临时，测试结束即删除）。"""


def test_tmp_probe_fails_for_nonzero_exit():
    raise AssertionError("tmp probe failure for nonzero-exit check")
'''

# 临时探针文件：两个带 spec_section/error_code 标记的失败用例，用于验证报告。
TMP_REPORT_PROBE = '''# -*- coding: utf-8 -*-
"""T11 失败报告探针（临时，测试结束即删除）：两个标记失败用例。"""

import pytest


@pytest.mark.spec_section("§3.4")
@pytest.mark.error_code("0x0A")
def test_tmp_report_section_3_4_code_0x0a():
    raise AssertionError("commit-failed: 图像 CRC 不符（0x0A）")


@pytest.mark.spec_section("§2.9")
@pytest.mark.error_code("0x01")
def test_tmp_report_section_2_9_code_0x01():
    raise AssertionError("no token: 设备未持有令牌（0x01）")
'''


def _run_pytest(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pytest"] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )


def _write(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def _cleanup(*paths: Path) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def test_pytest_exits_nonzero_on_any_failure():
    """单命令入口：任一失败非零退出；临时探针文件随测试删除。"""
    tmp_test = BLE_SUITE / "test_t11_tmp_nonzero_probe.py"
    tmp_report = Path(tempfile.gettempdir()) / "t11_nonzero_exit_report.json"
    try:
        _write(tmp_test, TMP_NONZERO_TEST)
        result = _run_pytest(
            [str(tmp_test), "-q", f"--report-file={tmp_report}"],
            cwd=ROOT,
        )
        assert result.returncode != 0, (
            f"expected non-zero exit, got {result.returncode}\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    finally:
        _cleanup(tmp_test, tmp_report)


def test_failure_report_maps_section_error_code_and_message():
    """失败报告把失败映射到 spec 章节 + 错误码 + 错误消息（JSON 可动作化）。"""
    tmp_test = BLE_SUITE / "test_t11_tmp_report_probe.py"
    tmp_report = Path(tempfile.gettempdir()) / "t11_failure_report.json"
    try:
        _write(tmp_test, TMP_REPORT_PROBE)
        result = _run_pytest(
            [str(tmp_test), "-q", f"--report-file={tmp_report}"],
            cwd=ROOT,
        )
        # (a) 任一失败 -> 非零退出
        assert result.returncode != 0, (
            f"expected non-zero exit, got {result.returncode}\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        # (b) JSON 报告存在
        assert tmp_report.exists(), (
            f"report not written: {tmp_report}\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        payload = json.loads(tmp_report.read_text(encoding="utf-8"))
        failures = payload.get("failures", [])
        assert len(failures) == 2, failures
        # 每条失败携带 nodeid/spec_section/error_code/error_message
        by_key = {
            (failure["spec_section"], failure["error_code"]): failure
            for failure in failures
        }
        assert ("§3.4", "0x0A") in by_key, by_key
        assert ("§2.9", "0x01") in by_key, by_key
        for section, code in (("§3.4", "0x0A"), ("§2.9", "0x01")):
            failure = by_key[(section, code)]
            assert failure["nodeid"], f"missing nodeid for {section}/{code}"
            message = failure["error_message"]
            assert message, f"empty error_message for {section}/{code}"
    finally:
        _cleanup(tmp_test, tmp_report)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
