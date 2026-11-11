import { randomUUID } from 'node:crypto';
process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { fakeDeviceStore, fakeStore, fakeWx, FakeDevice } from './fakes';

const FIXED_PINS = (entries: Array<[number, string, number]>) =>
  Array.from({ length: 8 }, (_, index) => {
    const found = entries.find(([i]) => i === index);
    return { index, name: found ? found[1] : '', len: found ? found[2] : 0 };
  });

describe('device metadata endpoints (B2)', () => {
  let app: INestApplication;
  let wx: ReturnType<typeof fakeWx>;
  let devices: FakeDevice[];

  async function login(openid: string): Promise<{ token: string; userId: bigint }> {
    const code = `code-${openid}-${randomUUID()}`;
    wx.codes.set(code, openid);
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ code });
    const token = res.body.accessToken as string;
    const jwt = await import('jsonwebtoken');
    const payload = jwt.decode(token) as { sub: string };
    return { token, userId: BigInt(payload.sub) };
  }

  beforeAll(async () => {
    const store = fakeStore();
    const devStore = fakeDeviceStore();
    wx = fakeWx();
    devices = devStore.devices;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider('AuthStore')
      .useValue(store)
      .overrideProvider('DeviceStore')
      .useValue(devStore)
      .overrideProvider('WxGateway')
      .useValue(wx)
      .overrideProvider(PrismaService)
      .useValue({} as never)
      .compile();
    app = moduleRef.createNestApplication();
    const { RequestIdMiddleware } = await import('../src/common/request-id.middleware');
    const logger = { log: jest.fn() };
    app.use((req: unknown, res: unknown, next: () => void) =>
      (Object.create(RequestIdMiddleware.prototype) as any).use.call({ logger }, req, res, next),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function putMeta(token: string, mlId: string, body: object) {
    return request(app.getHttpServer())
      .put(`/v1/devices/${mlId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function seedDevice(partial: Partial<FakeDevice> & { mlId: string; lastPushedBy: bigint }): FakeDevice {
    const d: FakeDevice = {
      displayName: null,
      fwVersion: null,
      payloadVersion: null,
      pinsJson: null,
      previewJson: null,
      rev: 0,
      pushedAt: null,
      createdAt: new Date(),
      hasBackup: false,
      ...partial,
    };
    devices.push(d);
    return d;
  }

  describe('PUT /v1/devices/:mlId', () => {
    it('creates the row on first call with rev=0, hasBackup=false, and stores pins padded to 8', async () => {
      const { token } = await login('o-put-first');
      const res = await putMeta(token, 'ML-A3F2', {
        displayName: '客厅柜底',
        fwVersion: '0.5.0',
        payloadVersion: 1,
        pins: [{ index: 0, name: '头部', len: 60 }],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        mlId: 'ML-A3F2',
        displayName: '客厅柜底',
        fwVersion: '0.5.0',
        payloadVersion: 1,
        rev: 0,
        hasBackup: false,
      });
      expect(res.body.pins).toEqual(FIXED_PINS([[0, '头部', 60]]));
      const row = devices.find((d) => d.mlId === 'ML-A3F2')!;
      expect(row.rev).toBe(0);
      expect(row.hasBackup).toBe(false);
      expect(row.pushedAt).toBeNull();
    });

    it('merges: only updates present keys, null clears, partial pins keep other indexes', async () => {
      const { token } = await login('o-put-merge');
      await putMeta(token, 'ML-B111', {
        displayName: '旧名',
        fwVersion: '0.4.0',
        pins: [
          { index: 0, name: 'a', len: 10 },
          { index: 3, name: 'b', len: 20 },
        ],
      });
      const res = await putMeta(token, 'ML-B111', {
        displayName: null,
        payloadVersion: 2,
        pins: [{ index: 3, name: 'c', len: 30 }],
      });
      expect(res.status).toBe(200);
      const row = devices.find((d) => d.mlId === 'ML-B111')!;
      expect(row.displayName).toBeNull(); // null clears
      expect(row.fwVersion).toBe('0.4.0'); // absent key untouched
      expect(row.payloadVersion).toBe(2);
      expect(row.pinsJson).toEqual([
        { index: 0, name: 'a', len: 10 },
        { index: 3, name: 'c', len: 30 },
      ]);
    });

    it('returns 422 DEVICE_ID_INVALID for a malformed mlId', async () => {
      const { token } = await login('o-put-bad');
      const res = await putMeta(token, 'ML-GGGG', { displayName: 'x' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DEVICE_ID_INVALID');
      const res2 = await putMeta(token, 'garbage', {});
      expect(res2.status).toBe(422);
    });

    it('requires an access token', async () => {
      const res = await request(app.getHttpServer()).put('/v1/devices/ML-A3F2').send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_INVALID');
    });
  });

  describe('GET /v1/devices', () => {
    it('lists devices by whitelisted fields, excluding lastPushedBy and preview', async () => {
      const { token, userId } = await login('o-list-me');
      seedDevice({
        mlId: 'ML-C001',
        lastPushedBy: userId,
        displayName: 'mine1',
        rev: 3,
        pushedAt: new Date(Date.UTC(2026, 0, 1, 0, 0)),
        pinsJson: Array.from({ length: 8 }, (_, i) => ({ index: i, name: '', len: 1 })),
        previewJson: { layout: 'snake' },
      });
      seedDevice({
        mlId: 'ML-C003',
        lastPushedBy: 7778n,
        displayName: 'not-mine',
        pushedAt: new Date(Date.UTC(2026, 0, 2, 0, 0)),
      });

      const res = await request(app.getHttpServer())
        .get('/v1/devices')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(1);
      const mine1 = res.body.items[0];
      expect(Object.keys(mine1).sort()).toEqual(
        ['displayName', 'hasBackup', 'mlId', 'pinCount', 'pushedAt', 'rev'].sort(),
      );
      expect(mine1).toEqual({
        mlId: 'ML-C001',
        displayName: 'mine1',
        hasBackup: false,
        rev: 3,
        pushedAt: '2026-01-01T00:00:00.000Z',
        pinCount: 8,
      });
    });

    it('orders by pushed_at DESC and paginates with ?cursor= at page size 20', async () => {
      const { token, userId } = await login('o-list-page');
      for (let i = 0; i < 23; i++) {
        const mlId = `ML-${i.toString(16).toUpperCase().padStart(4, '0')}`;
        const d = seedDevice({ mlId, lastPushedBy: userId });
        d.pushedAt = new Date(Date.UTC(2026, 0, 1, 0, i));
      }
      const page1 = await request(app.getHttpServer())
        .get('/v1/devices')
        .set('Authorization', `Bearer ${token}`);
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(20);
      expect(page1.body.nextCursor).toBeTruthy();
      const times = page1.body.items.map((i: any) => i.pushedAt);
      expect(new Date(times[0]).getTime()).toBeGreaterThan(new Date(times[1]).getTime());

      const page2 = await request(app.getHttpServer())
        .get(`/v1/devices?cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .set('Authorization', `Bearer ${token}`);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(3);
      expect(page2.body.nextCursor).toBeNull();
    });
  });

  describe('GET /v1/devices/:mlId', () => {
    it('returns full metadata with pins as 8 items and preview null when absent', async () => {
      const { token } = await login('o-get-one');
      const d = seedDevice({
        mlId: 'ML-D001',
        lastPushedBy: 888n,
        displayName: '床头',
        fwVersion: '1.0.0',
        payloadVersion: 1,
        pinsJson: [{ index: 1, name: '底座', len: 30 }],
        previewJson: { ledCount: 60, rowWidth: 10, layout: 'snake' },
        rev: 7,
        pushedAt: new Date('2026-11-08T12:33:04.120Z'),
        hasBackup: true,
      });
      const res = await request(app.getHttpServer())
        .get('/v1/devices/ML-D001')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        mlId: 'ML-D001',
        displayName: '床头',
        fwVersion: '1.0.0',
        payloadVersion: 1,
        pins: FIXED_PINS([[1, '底座', 30]]),
        preview: { ledCount: 60, rowWidth: 10, layout: 'snake' },
        rev: 7,
        pushedAt: '2026-11-08T12:33:04.120Z',
        hasBackup: true,
      });
      expect(res.body.pins).toHaveLength(8);
    });

    it('returns 404 NOT_FOUND for a missing device and 422 for an invalid mlId', async () => {
      const { token } = await login('o-get-miss');
      const miss = await request(app.getHttpServer())
        .get('/v1/devices/ML-9999')
        .set('Authorization', `Bearer ${token}`);
      expect(miss.status).toBe(404);
      expect(miss.body.error.code).toBe('NOT_FOUND');

      const bad = await request(app.getHttpServer())
        .get('/v1/devices/ML-XX')
        .set('Authorization', `Bearer ${token}`);
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('DEVICE_ID_INVALID');
    });
  });

  describe('DELETE /v1/devices/:mlId', () => {
    it('deletes the device row and returns 204; second call is idempotent', async () => {
      const { token } = await login('o-del');
      await putMeta(token, 'ML-E001', { displayName: 'x' });
      const res = await request(app.getHttpServer())
        .delete('/v1/devices/ML-E001')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(204);
      expect(devices.find((d) => d.mlId === 'ML-E001')).toBeUndefined();

      const again = await request(app.getHttpServer())
        .delete('/v1/devices/ML-E001')
        .set('Authorization', `Bearer ${token}`);
      expect(again.status).toBe(204);
    });

    it('returns 422 for an invalid mlId', async () => {
      const { token } = await login('o-del-bad');
      const res = await request(app.getHttpServer())
        .delete('/v1/devices/nope')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DEVICE_ID_INVALID');
    });
  });
});
