import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PIN_COUNT, DEFAULT_LEDS_PER_PIN,
  createPixelOccupancy, isPixelOccupied, occupyPixel, releasePixel,
  allocatePixels, pixelSelectable, occupiedPixels, conflictsFor,
} from './pixel-occupancy';

// 决策 #5：选灯组像素时已占用 LED 置灰、不可选
describe('像素占用判定（已占用像素置灰、不可选）', () => {
  it('初始状态下所有像素均未占用且可选', () => {
    const occ = createPixelOccupancy();
    expect(isPixelOccupied(occ, 0, 0)).toBe(false);
    expect(pixelSelectable(occ, 0, 0)).toBe(true);
    expect(occupiedPixels(occ)).toEqual([]);
  });

  it('默认 8 引脚，每引脚 60 个 LED', () => {
    expect(DEFAULT_PIN_COUNT).toBe(8);
    expect(DEFAULT_LEDS_PER_PIN).toBe(60);
    const occ = createPixelOccupancy();
    expect(occ.pinCount).toBe(8);
    expect(occ.ledsPerPin).toBe(60);
  });

  it('占用一个像素后，该像素已占用且不可选', () => {
    const occ = createPixelOccupancy();
    const ok = occupyPixel(occ, 0, 5, 'group-a');
    expect(ok).toBe(true);
    expect(isPixelOccupied(occ, 0, 5)).toBe(true);
    expect(pixelSelectable(occ, 0, 5)).toBe(false);
    expect(occupiedPixels(occ)).toEqual([{ pin: 0, led: 5 }]);
  });

  it('已占用像素不可重复占用：allocatePixels 返回冲突且不占用未冲突像素', () => {
    const occ = createPixelOccupancy();
    occupyPixel(occ, 1, 3, 'group-a');
    const r = allocatePixels(occ, 1, [3, 4, 5], 'group-b');
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([3]);
    expect(isPixelOccupied(occ, 1, 4)).toBe(false);
    expect(isPixelOccupied(occ, 1, 5)).toBe(false);
  });

  it('allocatePixels 全部可用时占用所有像素并返回 ok', () => {
    const occ = createPixelOccupancy();
    const r = allocatePixels(occ, 2, [0, 1, 2], 'group-a');
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(isPixelOccupied(occ, 2, 0)).toBe(true);
    expect(isPixelOccupied(occ, 2, 1)).toBe(true);
    expect(isPixelOccupied(occ, 2, 2)).toBe(true);
    expect(pixelSelectable(occ, 2, 1)).toBe(false);
  });

  it('释放像素后可再次选中', () => {
    const occ = createPixelOccupancy();
    occupyPixel(occ, 0, 7, 'group-a');
    releasePixel(occ, 0, 7);
    expect(isPixelOccupied(occ, 0, 7)).toBe(false);
    expect(pixelSelectable(occ, 0, 7)).toBe(true);
    expect(occupiedPixels(occ)).toEqual([]);
  });

  it('不同引脚的相同 led 索引互不影响', () => {
    const occ = createPixelOccupancy();
    occupyPixel(occ, 0, 3, 'group-a');
    expect(isPixelOccupied(occ, 1, 3)).toBe(false);
    expect(pixelSelectable(occ, 1, 3)).toBe(true);
    occupyPixel(occ, 1, 3, 'group-b');
    expect(isPixelOccupied(occ, 1, 3)).toBe(true);
  });

  it('引脚数与每引脚 LED 数可配置', () => {
    const occ = createPixelOccupancy({ pinCount: 4, ledsPerPin: 10 });
    occupyPixel(occ, 3, 9, 'group-a');
    expect(isPixelOccupied(occ, 3, 9)).toBe(true);
    expect(pixelSelectable(occ, 3, 9)).toBe(false);
  });

  it('conflictsFor 返回指定像素中已占用的子集', () => {
    const occ = createPixelOccupancy();
    occupyPixel(occ, 0, 1, 'group-a');
    occupyPixel(occ, 0, 4, 'group-a');
    expect(conflictsFor(occ, 0, [0, 1, 2, 3, 4])).toEqual([1, 4]);
    expect(conflictsFor(occ, 0, [5, 6])).toEqual([]);
  });

  it('occupiedPixels 返回所有已占用的 {pin, led}', () => {
    const occ = createPixelOccupancy();
    occupyPixel(occ, 0, 1, 'group-a');
    occupyPixel(occ, 2, 9, 'group-b');
    occupyPixel(occ, 0, 3, 'group-a');
    expect(occupiedPixels(occ)).toEqual([
      { pin: 0, led: 1 },
      { pin: 0, led: 3 },
      { pin: 2, led: 9 },
    ]);
  });
});
