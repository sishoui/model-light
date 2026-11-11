import { randomUUID } from 'node:crypto';
import { WxGateway } from '../src/auth/auth.service';

export interface FakeUser {
  id: bigint;
  openid: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  lastLoginAt: Date;
}

export interface FakeToken {
  id: bigint;
  userId: bigint;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export function fakeStore() {
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
      (users.find((x) => x.id === id) as FakeUser).lastLoginAt = now;
    },
    async findRefreshTokenByHash(hash: string) {
      return tokens.find((t) => t.tokenHash === hash) ?? null;
    },
    async createRefreshToken(userId: bigint, tokenHash: string, expiresAt: Date) {
      tokens.push({ id: tokenId++, userId, tokenHash, expiresAt, revokedAt: null });
    },
    async revokeRefreshToken(id: bigint, now: Date) {
      (tokens.find((x) => x.id === id) as FakeToken).revokedAt = now;
    },
    async findUserById(id: bigint) {
      return users.find((u) => u.id === id) ?? null;
    },
    async updateProfile(id: bigint, nickname: string | null, avatarUrl: string | null) {
      const u = users.find((x) => x.id === id) as FakeUser;
      u.nickname = nickname ?? u.nickname;
      u.avatarUrl = avatarUrl ?? u.avatarUrl;
      return u;
    },
  };
}

export interface FakeDevice {
  mlId: string;
  displayName: string | null;
  fwVersion: string | null;
  payloadVersion: number | null;
  pinsJson: Array<{ index: number; name: string; len: number }> | null;
  previewJson: unknown | null;
  rev: number;
  lastPushedBy: bigint | null;
  pushedAt: Date | null;
  createdAt: Date;
  hasBackup: boolean;
}

export function fakeDeviceStore() {
  const devices: FakeDevice[] = [];
  return {
    devices,
    async listDevices(
      userId: bigint,
      cursor: { pushedAt: Date; mlId: string } | null,
      limit: number,
    ): Promise<{ rows: FakeDevice[]; hasMore: boolean }> {
      const mine = devices
        .filter((d) => d.lastPushedBy === userId && d.pushedAt !== null)
        .sort((a, b) => {
          const t = b.pushedAt!.getTime() - a.pushedAt!.getTime();
          if (t !== 0) return t;
          return a.mlId < b.mlId ? 1 : a.mlId > b.mlId ? -1 : 0;
        });
      let start = 0;
      if (cursor) {
        start = mine.findIndex(
          (d) =>
            d.pushedAt!.getTime() < cursor.pushedAt.getTime() ||
            (d.pushedAt!.getTime() === cursor.pushedAt.getTime() && d.mlId < cursor.mlId),
        );
        if (start === -1) return { rows: [], hasMore: false };
      }
      const rows = mine.slice(start, start + limit);
      return { rows, hasMore: start + limit < mine.length };
    },
    async findDevice(mlId: string): Promise<FakeDevice | null> {
      return devices.find((d) => d.mlId === mlId) ?? null;
    },
    async updateMeta(mlId: string, meta: {
      displayName: string | null;
      fwVersion: string | null;
      payloadVersion: number | null;
      pinsJson: Array<{ index: number; name: string; len: number }> | null;
      previewJson: unknown | null;
    }): Promise<FakeDevice> {
      let d = devices.find((x) => x.mlId === mlId);
      if (!d) {
        d = { mlId, rev: 0, lastPushedBy: null, pushedAt: null, createdAt: new Date(), hasBackup: false, ...meta };
        devices.push(d);
        return d;
      }
      Object.assign(d, meta);
      return d;
    },
    async deleteDevice(mlId: string): Promise<void> {
      const i = devices.findIndex((d) => d.mlId === mlId);
      if (i !== -1) devices.splice(i, 1);
    },
  };
}

export function fakeWx(): WxGateway & { codes: Map<string, string> } {
  const codes = new Map<string, string>();
  return {
    codes,
    async code2session(code: string) {
      const openid = codes.get(code);
      if (!openid) throw new Error(`bad code: ${code}`);
      return { openid };
    },
  };
}
