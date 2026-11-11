import { randomUUID } from 'node:crypto';
process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { fakeStore, fakeWx, fakeDeviceStore, FakeBackupRow } from './fakes';

const crc32 = (buf: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

describe('backup endpoints (B3)', () => {
  let app: INestApplication;
  let wx: ReturnType<typeof fakeWx>;
  let backups: Map<string, FakeBackupRow>;

  async function login(openid: string): Promise<{ token: string; userId: bigint }> {
    const code = `code-${openid}-${randomUUID()}`;
    wx.codes.set(code, openid);
    // §7 login 10/min per IP：每个用例用独立 IP，避免用例间登录预算互相挤占
    loginIpCounter += 1;
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('x-forwarded-for', `10.99.${Math.floor(loginIpCounter / 250)}.${loginIpCounter % 250}`)
      .send({ code });
    const token = res.body.accessToken as string;
    const jwt = await import('jsonwebtoken');
    const payload = jwt.decode(token) as { sub: string };
    return { token, userId: BigInt(payload.sub) };
  }
  let loginIpCounter = 0;

  beforeAll(async () => {
    const devStore = fakeDeviceStore();
    wx = fakeWx();
    backups = devStore.backups;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider('AuthStore')
      .useValue(fakeStore())
      .overrideProvider('DeviceStore')
      .useValue(devStore)
      .overrideProvider('BackupStore')
      .useValue(devStore)
      .overrideProvider('RateLimiter')
      .useValue(devStore.rateLimiter())
      .overrideProvider('WxGateway')
      .useValue(wx)
      .overrideProvider(PrismaService)
      .useValue({} as never)
      .compile();
    app = moduleRef.createNestApplication();
    const express = await import('express');
    app.use(express.default.json({ limit: '1mb' }));
    const { RequestIdMiddleware } = await import('../src/common/request-id.middleware');
    app.use((req: unknown, res: unknown, next: () => void) =>
      (Object.create(RequestIdMiddleware.prototype) as any).use.call({ logger: { log: jest.fn() } }, req, res, next),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const arrangement = (bytes: number[] | number, fill = 0xab): Buffer => {
    const buf = Buffer.alloc(typeof bytes === 'number' ? bytes : bytes.length);
    if (typeof bytes === 'number') buf.fill(fill);
    else buf.set(bytes);
    return buf;
  };

  function putBackup(token: string, mlId: string, body: object) {
    return request(app.getHttpServer())
      .put(`/v1/devices/${mlId}/backup`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function validBody(buf: Buffer, extra: object = {}) {
    return { arrangement: buf.toString('base64'), crc32: crc32(buf), payloadVersion: 1, fwVersion: '0.5.0', ...extra };
  }

  it('PUT stores the backup, bumps rev, moves previous into last_good, and upserts device meta', async () => {
    const { token, userId } = await login('o-b3-push');
    const first = await putBackup(token, 'ML-A3F2', validBody(arrangement([1, 2, 3])));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ rev: 1, pushedAt: expect.any(String), previousRev: 0 });
    expect(first.body.behind).toBeUndefined();

    expect(backups.get('ML-A3F2')).toMatchObject({
      arrangement: Buffer.from([1, 2, 3]),
      arrangementCrc32: crc32(Buffer.from([1, 2, 3])),
      arrangementLen: 3,
      lastGood: null,
      lastGoodRev: null,
    });

    const second = await putBackup(token, 'ML-A3F2', validBody(arrangement([4, 5])));
    expect(second.status).toBe(200);
    expect(second.body.rev).toBe(2);
    expect(second.body.previousRev).toBe(1);
    const row = backups.get('ML-A3F2')!;
    expect(row.lastGood).toEqual(Buffer.from([1, 2, 3]));
    expect(row.lastGoodRev).toBe(1);
    expect(row.arrangement).toEqual(Buffer.from([4, 5]));
  });

  it('PUT rejects a crc32 mismatch with 422 BACKUP_CRC_MISMATCH', async () => {
    const { token } = await login('o-b3-crc');
    const buf = arrangement([9, 9]);
    const res = await putBackup(token, 'ML-C111', validBody(buf, { crc32: crc32(buf) ^ 1 }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BACKUP_CRC_MISMATCH');
    expect(backups.has('ML-C111')).toBe(false);
  });

  it('PUT rejects decoded size > 65536 with 413 PAYLOAD_TOO_LARGE (also pre-decode via Content-Length)', async () => {
    const { token } = await login('o-b3-big');
    const big = arrangement(65537);
    const res = await putBackup(token, 'ML-C222', validBody(big));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    // Content-Length pre-check: a >64 KiB base64 body is rejected without decoding.
    const huge = arrangement(300000);
    const res2 = await putBackup(token, 'ML-C223', validBody(huge));
    expect(res2.status).toBe(413);
    expect(backups.has('ML-C223')).toBe(false);

    // 65536 exactly is accepted.
    const edge = await putBackup(token, 'ML-C224', validBody(arrangement(65536)));
    expect(edge.status).toBe(200);
    expect(edge.body.rev).toBe(1);
  });

  it('PUT rejects unsupported payloadVersion with 422 SCHEMA_VERSION_UNSUPPORTED', async () => {
    const { token } = await login('o-b3-ver');
    const res = await putBackup(token, 'ML-C333', validBody(arrangement([1]), { payloadVersion: 2 }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
  });

  it('baseRev never causes rejection; behind=true only when baseRev < rev', async () => {
    const { token } = await login('o-b3-behind');
    await putBackup(token, 'ML-C444', validBody(arrangement([1]), { baseRev: 0 }));
    // baseRev >= rev: no behind flag
    const fresh = await putBackup(token, 'ML-C444', validBody(arrangement([2]), { baseRev: 2 }));
    expect(fresh.status).toBe(200);
    expect(fresh.body.behind).toBeUndefined();
    // baseRev < new rev: behind=true
    const stale = await putBackup(token, 'ML-C444', validBody(arrangement([3]), { baseRev: 1 }));
    expect(stale.status).toBe(200);
    expect(stale.body.behind).toBe(true);
  });

  it('PUT returns 422 DEVICE_ID_INVALID for malformed mlId and 401 without token', async () => {
    const { token } = await login('o-b3-badid');
    const bad = await putBackup(token, 'ML-ZZZZ', validBody(arrangement([1])));
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('DEVICE_ID_INVALID');
    const noAuth = await request(app.getHttpServer()).put('/v1/devices/ML-A3F2/backup').send({});
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error.code).toBe('AUTH_INVALID');
  });

  it('PUT backup is rate limited to 10 requests/min per userId with 429 RATE_LIMITED + Retry-After', async () => {
    const { token } = await login('o-b3-ratelimit');
    for (let i = 0; i < 10; i++) {
      const res = await putBackup(token, `ML-0${i.toString(16).toUpperCase().padStart(3, '0')}`, validBody(arrangement([1])));
      expect(res.status).toBe(200);
    }
    const over = await putBackup(token, 'ML-0F00', validBody(arrangement([1])));
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    // other users are unaffected
    const other = await login('o-b3-ratelimit-other');
    const ok = await putBackup(other.token, 'ML-0F01', validBody(arrangement([1])));
    expect(ok.status).toBe(200);
  });

  describe('GET /v1/devices/:mlId/backup', () => {
    it('returns base64 + crc32 + byteLength + rev + pushedAt', async () => {
      const { token } = await login('o-b3-get');
      const buf = arrangement([7, 8, 9, 10]);
      await putBackup(token, 'ML-D111', validBody(buf, { fwVersion: '0.6.0' }));
      const res = await request(app.getHttpServer())
        .get('/v1/devices/ML-D111/backup')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        mlId: 'ML-D111',
        rev: 1,
        payloadVersion: 1,
        fwVersion: '0.6.0',
        arrangement: buf.toString('base64'),
        crc32: crc32(buf),
        byteLength: 4,
        pushedAt: expect.any(String),
        stale: false,
      });
    });

    it('marks stale=true when ?fwVersion= differs from the backup; no param means stale=false', async () => {
      const { token } = await login('o-b3-stale');
      const buf = arrangement([1]);
      await putBackup(token, 'ML-D222', validBody(buf, { fwVersion: '0.5.0' }));
      const same = await request(app.getHttpServer())
        .get('/v1/devices/ML-D222/backup?fwVersion=0.5.0')
        .set('Authorization', `Bearer ${token}`);
      expect(same.body.stale).toBe(false);
      const diff = await request(app.getHttpServer())
        .get('/v1/devices/ML-D222/backup?fwVersion=0.4.0')
        .set('Authorization', `Bearer ${token}`);
      expect(diff.body.stale).toBe(true);
    });

    it('returns 404 NOT_FOUND when no backup exists', async () => {
      const { token } = await login('o-b3-get404');
      const res = await request(app.getHttpServer())
        .get('/v1/devices/ML-D999/backup')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /v1/devices/:mlId/backup/restore-last-good', () => {
    it('swaps current and last_good, rev + 1', async () => {
      const { token } = await login('o-b3-restore');
      await putBackup(token, 'ML-E111', validBody(arrangement([1, 1])));
      await putBackup(token, 'ML-E111', validBody(arrangement([2, 2])));
      const res = await request(app.getHttpServer())
        .post('/v1/devices/ML-E111/backup/restore-last-good')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.rev).toBe(3);
      expect(res.body.previousRev).toBe(2);
      const row = backups.get('ML-E111')!;
      expect(row.arrangement).toEqual(Buffer.from([1, 1]));
      expect(row.lastGood).toEqual(Buffer.from([2, 2]));
      expect(row.lastGoodRev).toBe(2);
    });

    it('returns 409 when there is no last_good', async () => {
      const { token } = await login('o-b3-restore409');
      await putBackup(token, 'ML-E222', validBody(arrangement([1])));
      const res = await request(app.getHttpServer())
        .post('/v1/devices/ML-E222/backup/restore-last-good')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_FOUND');

      const missing = await request(app.getHttpServer())
        .post('/v1/devices/ML-E999/backup/restore-last-good')
        .set('Authorization', `Bearer ${token}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');
    });
  });
});
