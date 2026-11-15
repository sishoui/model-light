/* 场景槽 NVS 持久层（0x22/0x23/0x24 命令的存储部分）。
 *
 * mlarr 组件保持纯 C（host 可测），NVS 读写落在这里：namespace "mlarr"
 * （与 store.c 的活动编排 key "arr" 共存），槽 key "slot0".."slot3"，
 * blob 布局 len(2 LE)+version(2 LE)+编排字节（mlarr_scene_blob_encode
 * 负责编码与校验）。掉电持久化——场景槽是唯一持久的控制面状态；
 * 电源/亮度不持久化（frame_task 内 volatile，重启默认开/100%）。
 *
 * 写串行：小程序侧写串行（spec §2.1），本模块用静态 blob 缓冲即可，
 * 无需加锁。 */
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 保存场景槽 slot（0–3）的编排：校验（len ≥ 4、mlarr_validate 通过、
 * len ≤ MLARR_ARR_MAX_BYTES）后整体写 NVS。成功 0，失败 -1
 * （slot 越界 / 校验失败 / NVS 写失败）。 */
int scene_store_save(uint8_t slot, const uint8_t *buf, uint16_t len,
                     uint16_t version);

/* 读取场景槽 slot 的编排字节：拷入 buf（最多 cap B，超长截断），
 * *len 返回槽内声明的完整长度（可 > cap，供调用方判断截断），
 * *version 返回 blob 头部版本。槽不存在/损坏返回 -1。 */
int scene_store_load(uint8_t slot, uint8_t *buf, uint16_t cap,
                     uint16_t *len, uint16_t *version);

#ifdef __cplusplus
}
#endif