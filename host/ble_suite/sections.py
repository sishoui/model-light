# -*- coding: utf-8 -*-
"""spec_section 标记的允许值：必须是真实存在的 spec 章节。

- `docs/spec.md`：§2.1 / §2.2 / §2.9 / §3.4 / §5.1 / §6 / §7；
- `docs/spec-ota-wire-format.md`：§7.1 / §7.2 / §7.3。

OTA 章节带文档名前缀，避免与 `spec.md` 的 §7（风险与前置）混淆。
"""

SPEC_SECTIONS = frozenset({
    "transport",
    "§2.1",
    "§2.2",
    "§2.9",
    "§3.4",
    "§5.1",
    "§6",
    "§7",
    "spec-ota-wire-format §7.1",
    "spec-ota-wire-format §7.2",
    "spec-ota-wire-format §7.3",
})

# 测试文件名 -> spec 章节的回退推断（当测试未打 spec_section 标记时使用）。
SECTION_BY_FILE_PREFIX = {
    "test_t1": "transport",
    "test_t2": "§2.2",
    "test_t3": "§6",
    "test_t4": "§2.9",
    "test_t5": "§2.2",
    "test_t6": "§3.4",
    "test_t7": "§3.4",
    "test_t8": "§5.1",
    "test_t9": "§6 / spec-ota-wire-format §7.3",
    "test_t10": "spec-ota-wire-format §7.2",
}

__all__ = ["SPEC_SECTIONS", "SECTION_BY_FILE_PREFIX"]