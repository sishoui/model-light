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
