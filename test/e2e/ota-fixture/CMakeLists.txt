# E2E OTA fixture（ticket #86）——最小合法 ESP-IDF app
#
# 用途：作为 OTA 协议状态机 E2E 的目标镜像。随机/截断的 dummy 不是合法
# ESP32 镜像，COMMIT 会在 esp_ota_end 失败（只能测到回滚）；本 fixture 是
# 真实编译出的最小 app，能走完整 BEGUN → SENDING → COMMITTING → DONE →
# 重启进新镜像的路径（issue #86 验收口径）。
#
# 刻意不含 BLE：刷入并重启后设备失联是预期行为，E2E 断言到重启后的
# 横幅日志即止，随后必须重刷正式固件（见本目录 README.md）。
#
# 版本号高于正式固件：min_ver 为空时版本门直接放行，设高版本号是双保险
# （§5.1 只会拒绝低于 NVS min_ver 的镜像）。
set(PROJECT_VER "2.0.0-e2e86")
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(ml-ota-fixture)