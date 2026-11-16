// 色环纯逻辑模块单测 - spec §6。
// HSV↔RGB、RGB↔hex、hex↔HSV、clamp/wrap。无 wx 依赖。
import { describe, it, expect } from 'vitest';
const cw = require('../color-wheel');

describe('color-wheel (纯逻辑模块)', () => {
  describe('clamp/wrap', () => {
    it('clamp01 夹到 [0,1]', () => {
      expect(cw.clamp01(-0.5)).toBe(0);
      expect(cw.clamp01(1.5)).toBe(1);
      expect(cw.clamp01(0.5)).toBe(0.5);
    });
    it('wrapHue 归一到 [0,360)', () => {
      expect(cw.wrapHue(360)).toBe(0);
      expect(cw.wrapHue(370)).toBe(10);
      expect(cw.wrapHue(-10)).toBe(350);
      expect(cw.wrapHue(-370)).toBe(350);
      expect(cw.wrapHue(720)).toBe(0);
      expect(cw.wrapHue(0)).toBe(0);
      expect(cw.wrapHue(359.9)).toBeCloseTo(359.9);
    });
    it('clampByte 归一到 [0,255]', () => {
      expect(cw.clampByte(-10)).toBe(0);
      expect(cw.clampByte(300)).toBe(255);
      expect(cw.clampByte(127.7)).toBe(128);
    });
  });

  describe('HSV↔RGB 双向', () => {
    it('纯色角点 RGB 全黑/全白', () => {
      expect(cw.hsvToRgb(0, 0, 0)).toEqual([0, 0, 0]);
      expect(cw.hsvToRgb(0, 0, 1)).toEqual([255, 255, 255]);
      expect(cw.hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
      expect(cw.hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
      expect(cw.hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
    });
    it('hue wrap 越界输入仍给出对应颜色', () => {
      expect(cw.hsvToRgb(360, 1, 1)).toEqual(cw.hsvToRgb(0, 1, 1));
      expect(cw.hsvToRgb(390, 1, 1)).toEqual(cw.hsvToRgb(30, 1, 1));
    });
    it('s=0 时 h 不影响结果（灰度）', () => {
      expect(cw.hsvToRgb(100, 0, 0.5)).toEqual(cw.hsvToRgb(250, 0, 0.5));
    });
    it('rgbToHsv 给出 h∈[0,360)、s/v∈[0,1]', () => {
      const red = cw.rgbToHsv(255, 0, 0);
      expect(red.h).toBe(0);
      expect(red.s).toBe(1);
      expect(red.v).toBe(1);
      const gray = cw.rgbToHsv(128, 128, 128);
      expect(gray.s).toBe(0);
      expect(gray.v).toBeCloseTo(128 / 255);
      const white = cw.rgbToHsv(255, 255, 255);
      expect(white.s).toBe(0);
      expect(white.v).toBe(1);
    });
    it('HSV→RGB→HSV 往返（色相保持，饱和度明度粗略）', () => {
      const hsv = cw.rgbToHsv(30, 140, 200);
      const rgb = cw.hsvToRgb(hsv.h, hsv.s, hsv.v);
      const back = cw.rgbToHsv(rgb[0], rgb[1], rgb[2]);
      expect(back.h).toBeCloseTo(hsv.h, 5);
    });
    it('RGB→hsv→hsvToRgb 原样还原（经 clampByte 四舍五入）', () => {
      const hsv = cw.rgbToHsv(10, 200, 240);
      const rgb = cw.hsvToRgb(hsv.h, hsv.s, hsv.v);
      expect([...rgb]).toEqual([10, 200, 240]);
    });
  });

  describe('RGB↔hex 双向', () => {
    it('rgbToHex 产生小写 #rrggbb，不足补零', () => {
      expect(cw.rgbToHex(0, 0, 0)).toBe('#000000');
      expect(cw.rgbToHex(255, 255, 255)).toBe('#ffffff');
      expect(cw.rgbToHex(255, 128, 0)).toBe('#ff8000');
      expect(cw.rgbToHex(10, 200, 240)).toBe('#0ac8f0');
    });
    it('hexToRgb 接受大小写、可带或不带 #', () => {
      expect(cw.hexToRgb('#ff8000')).toEqual([255, 128, 0]);
      expect(cw.hexToRgb('FF8000')).toEqual([255, 128, 0]);
      expect(cw.hexToRgb('#000000')).toEqual([0, 0, 0]);
    });
    it('hex↔rgb 往返', () => {
      const rgb = [213, 87, 45];
      const back = cw.hexToRgb(cw.rgbToHex(rgb[0], rgb[1], rgb[2]));
      expect([...back]).toEqual(rgb);
    });
    it('非法 hex 返回 null', () => {
      expect(cw.hexToRgb(null)).toBeNull();
      expect(cw.hexToRgb(undefined)).toBeNull();
      expect(cw.hexToRgb(123)).toBeNull();
      expect(cw.hexToRgb('#ggg000')).toBeNull();
      expect(cw.hexToRgb('#fff')).toBeNull(); // 短拒绝，只支持 6 位
      expect(cw.hexToRgb('#ff8000xx')).toBeNull();
      expect(cw.hexToRgb('')).toBeNull();
    });
  });

  describe('hex↔HSV', () => {
    it('hexToHsv 非法 hex 返回 null', () => {
      expect(cw.hexToHsv('#ggg000')).toBeNull();
      expect(cw.hexToHsv(null)).toBeNull();
    });
    it('hsvToHex → hexToHsv 往返', () => {
      const hsv = { h: 200, s: 0.6, v: 0.8 };
      const hex = cw.hsvToHex(hsv.h, hsv.s, hsv.v);
      expect(/^#[0-9a-f]{6}$/.test(hex)).toBe(true);
      const back = cw.hexToHsv(hex);
      expect(back.h).toBeCloseTo(hsv.h, 0);
      // 参数字节量化到 1/255，四舍五入到 2 位小数
      expect(back.s).toBeCloseTo(hsv.s, 2);
      expect(back.v).toBeCloseTo(hsv.v, 2);
    });
    it('纯白 hex→HSV s=0,v=1', () => {
      const hsv = cw.hexToHsv('#ffffff');
      expect(hsv.s).toBe(0);
      expect(hsv.v).toBe(1);
    });
  });
});