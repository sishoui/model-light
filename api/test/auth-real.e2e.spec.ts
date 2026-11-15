/**
 * 后端真实登录 E2E（L2 自动化）
 *
 * 使用真实的 WxHttpGateway 调用微信 auth.code2session，验证登录 / 刷新 / 备份
 * 主流程与真实微信服务器交互。
 *
 * 前置条件：
 * 1. 后端已部署并能访问微信服务器（或本地用 docker compose 启动 MySQL + API）
 * 2. 环境变量 WX_APPID / WX_SECRET 已配置
 * 3. 环境变量 REAL_WX_CODE 已填入一个真实的、未使用的 wx.login code
 *    （从微信开发者工具真机调试或手机小程序获取，code 一次性，每次测试需更新）
 *
 * 若未设置 REAL_WX_CODE，本套用例自动跳过，不会导致 CI 失败。
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const REAL_WX_CODE = process.env.REAL_WX_CODE ?? '';

function skipIfNoRealCode() {
  if (!REAL_WX_CODE) {
    console.log('[auth-real] 跳过：未设置 REAL_WX_CODE，需从真实手机/开发者工具获取一次性 code');
  }
}

describe('Auth real wx login (L2)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    skipIfNoRealCode();
    if (!REAL_WX_CODE) return;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('exchanges a real wx code for access + refresh tokens', async () => {
    if (!REAL_WX_CODE) return;

    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ code: REAL_WX_CODE });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.expiresIn).toBe(604800); // 7 days
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshExpiresIn).toBe(2592000); // 30 days
    expect(res.body.user.id).toBeTruthy();
  });

  it('refresh rotates the token pair', async () => {
    if (!REAL_WX_CODE) return;

    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ code: REAL_WX_CODE });
    expect(loginRes.status).toBe(200);
    const { refreshToken } = loginRes.body;

    const res = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(refreshToken);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('authenticated GET /v1/me works with the real token', async () => {
    if (!REAL_WX_CODE) return;

    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ code: REAL_WX_CODE });
    expect(loginRes.status).toBe(200);
    const { accessToken } = loginRes.body;

    const res = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
  });

  it('PUT /v1/devices/:mlId/backup requires auth (401 without token)', async () => {
    if (!REAL_WX_CODE) return;

    const res = await request(app.getHttpServer())
      .put('/v1/devices/ML-A3F2/backup')
      .send({ arrangement: 'AAAA', crc32: 0, payloadVersion: 1 });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
  });
});
