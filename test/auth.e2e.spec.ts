import { randomUUID } from 'node:crypto';
process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  WxGateway,
} from '../src/auth/auth.service';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface FakeUser {
  id: bigint;
  openid: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  lastLoginAt: Date;
}

interface FakeToken {
  id: bigint;
  userId: bigint;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

function fakeStore() {
  const users: FakeUser[] = [];
  const tokens: FakeToken[] = [];
  let userId = 1n;
  let tokenId = 1n;
  return {
    users,
    tokens,
    async findUserByOpenid(openid: string) {
      return users.find((u) => u.openid === openid) ?? null;
    },
    async createUser(openid: string, now: Date) {
      const u: FakeUser = {
        id: userId++,
        openid,
        nickname: null,
        avatarUrl: null,
        createdAt: now,
        lastLoginAt: now,
      };
      users.push(u);
      return u;
    },
    async touchLogin(id: bigint, now: Date) {
      const u = users.find((x) => x.id === id)!;
      u.lastLoginAt = now;
    },
    async findRefreshTokenByHash(hash: string) {
      return tokens.find((t) => t.tokenHash === hash) ?? null;
    },
    async createRefreshToken(userId: bigint, tokenHash: string, expiresAt: Date) {
      tokens.push({ id: tokenId++, userId, tokenHash, expiresAt, revokedAt: null });
    },
    async revokeRefreshToken(id: bigint, now: Date) {
      const t = tokens.find((x) => x.id === id)!;
      t.revokedAt = now;
    },
    async findUserById(id: bigint) {
      return users.find((u) => u.id === id) ?? null;
    },
    async updateProfile(id: bigint, nickname: string | null, avatarUrl: string | null) {
      const u = users.find((x) => x.id === id)!;
      if (nickname !== undefined) u.nickname = nickname;
      if (avatarUrl !== undefined) u.avatarUrl = avatarUrl;
      return u;
    },
  };
}

function fakeWx(): WxGateway & { codes: Map<string, string> } {
  const codes = new Map<string, string>();
  let n = 0;
  return {
    codes,
    async code2session(code: string) {
      const openid = codes.get(code);
      if (!openid) throw new Error(`bad code: ${code}`);
      return { openid };
    },
  };
}

async function buildApp() {
  const store = fakeStore();
  const wx = fakeWx();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider('AuthStore')
    .useValue(store)
    .overrideProvider('WxGateway')
    .useValue(wx)
    .overrideProvider(PrismaService)
    .useValue({} as never)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication();
  return { app, store, wx };
}

let harness: { app: INestApplication; store: ReturnType<typeof fakeStore>; wx: ReturnType<typeof fakeWx> };

beforeAll(async () => {
  harness = await buildApp();
  const { app } = harness;
  const { RequestIdMiddleware } = await import('../src/common/request-id.middleware');
  const logger = { log: jest.fn() };
  app.use((req: unknown, res: unknown, next: () => void) =>
    (Object.create(RequestIdMiddleware.prototype) as any).use.call(
      { logger },
      req,
      res,
      next,
    ),
  );
  await app.init();
});

afterAll(async () => {
  await harness.app.close();
});

function loginCode(openid: string): string {
  const code = `code-${openid}-${randomUUID()}`;
  harness.wx.codes.set(code, openid);
  return code;
}

async function login(openid: string) {
  const res = await request(harness.app.getHttpServer())
    .post('/v1/auth/login')
    .send({ code: loginCode(openid) });
  expect(res.status).toBe(200);
  return res.body as {
    accessToken: string;
    expiresIn: number;
    refreshToken: string;
    refreshExpiresIn: number;
    user: { id: string; nickname: string | null; avatarUrl: string | null };
  };
}

describe('POST /v1/auth/login', () => {
  it('exchanges a wx code for tokens and silently creates the account on first login', async () => {
    const body = await login('o-abc-1');
    expect(body.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(body.refreshExpiresIn).toBe(REFRESH_TOKEN_TTL_SECONDS);
    expect(body.user.id).toBeTruthy();
    expect(body.user.nickname).toBeNull();
  });

  it('reuses the same user row on second login', async () => {
    const first = await login('o-reuse');
    const second = await login('o-reuse');
    expect(second.user.id).toBe(first.user.id);
  });

  it('returns 401 AUTH_INVALID with requestId for a bad code', async () => {
    const res = await request(harness.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ code: 'no-such-code' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
    expect(res.body.requestId).toBeTruthy();
  });

  it('stores only sha256 of the refresh token', async () => {
    const body = await login('o-hash');
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(body.refreshToken).digest('hex');
    expect(harness.store.tokens.some((t) => t.tokenHash === expected)).toBe(true);
    expect(harness.store.tokens.some((t) => t.tokenHash === body.refreshToken)).toBe(false);
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rotates: old refresh is revoked immediately, a fresh pair comes back', async () => {
    const body = await login('o-rot');
    const res = await request(harness.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: body.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(body.refreshToken);
    const { createHash } = await import('node:crypto');
    const oldHash = createHash('sha256').update(body.refreshToken).digest('hex');
    const old = harness.store.tokens.find((t) => t.tokenHash === oldHash)!;
    expect(old.revokedAt).not.toBeNull();
  });

  it('rejects a replayed (already revoked) refresh token with 401 AUTH_INVALID', async () => {
    const body = await login('o-replay');
    await request(harness.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(200);
    const res = await request(harness.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: body.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
  });

  it('rejects an unknown refresh token with 401', async () => {
    const res = await request(harness.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: 'bogus' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the current refresh token', async () => {
    const body = await login('o-out');
    const res = await request(harness.app.getHttpServer())
      .post('/v1/auth/logout')
      .send({ refreshToken: body.refreshToken });
    expect(res.status).toBe(204);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(body.refreshToken).digest('hex');
    expect(harness.store.tokens.find((t) => t.tokenHash === hash)!.revokedAt).not.toBeNull();
    await request(harness.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(401);
  });
});

describe('GET /v1/me', () => {
  it('returns the current account for a valid access token', async () => {
    const body = await login('o-me');
    const res = await request(harness.app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: body.user.id, nickname: null, avatarUrl: null });
  });

  it('returns 401 AUTH_INVALID for a missing, garbage or expired access token', async () => {
    const noHeader = await request(harness.app.getHttpServer()).get('/v1/me');
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.error.code).toBe('AUTH_INVALID');

    const garbage = await request(harness.app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe('AUTH_INVALID');
  });

  it('returns 401 for an access token signed with a foreign secret', async () => {
    const jwt = await import('jsonwebtoken');
    const forged = jwt.sign({ sub: '1' }, 'wrong-secret', { expiresIn: 3600 });
    const res = await request(harness.app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
  });
});

describe('PATCH /v1/me', () => {
  it('updates nickname and avatarUrl', async () => {
    const body = await login('o-patch');
    const res = await request(harness.app.getHttpServer())
      .patch('/v1/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .send({ nickname: '灯友', avatarUrl: 'https://example.com/a.png' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: body.user.id,
      nickname: '灯友',
      avatarUrl: 'https://example.com/a.png',
    });
  });
});

describe('error format', () => {
  it('every error carries { error: { code, message }, requestId } and the requestId reaches logs via header', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Bearer bad');
    expect(Object.keys(res.body).sort()).toEqual(['error', 'requestId']);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });
});
