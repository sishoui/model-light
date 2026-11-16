const { defineConfig } = require('vitest/config');

// wayfinder #67: 协议帧基础与 CRC32 的单元测试。
// 纯函数协议层位于 miniprogram/lib/，无 wx 依赖，Node/vitest 可运行。
module.exports = defineConfig({
  test: {
    globals: true,
    // lib 纯模块用例 + 页面级「模拟人为点击」用例（test/pages，见 #108）
    include: ['miniprogram/lib/**/*.test.js', 'test/pages/**/*.test.js'],
  },
});
