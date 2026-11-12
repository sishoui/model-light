// wayfinder 纯函数协议层 vitest 配置
// 测试位于 test/vitest/，与 miniprogram/lib/ 纯函数一一对应，无 wx 依赖，Node/vitest 可运行。
module.exports = {
  test: {
    include: ['test/vitest/**/*.test.js'],
  },
};
