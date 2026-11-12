const { defineConfig } = require('vitest/config');

// wayfinder #67: 协议帧基础与 CRC32 的单元测试。
// 纯函数协议层位于 miniprogram/lib/，无 wx 依赖，Node/vitest 可运行。
module.exports = defineConfig({
  test: {
    globals: true,
    include: ['miniprogram/lib/**/*.test.js'],
  },
});
