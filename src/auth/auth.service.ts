import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { JwtService } from './jwt.service';

export const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 days

export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

export interface AuthedUser {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
}

/** OAuth code -> openid. Production impl calls wx auth.code2session. */
export interface WxGateway {
  code2session(code: string): Promise<{ openid: string }>;
}

/** Rows we need from refresh_tokens, scoped to what the service touches. */
export interface RefreshTokenRow {
  id: bigint;
  userId: bigint;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface UserRow {
  id: bigint;
  nickname: string | null;
  avatarUrl: string | null;
  lastLoginAt: Date;
}

/** Data access over users + refresh_tokens. Prisma-backed in prod; faked in tests. */
export interface AuthStore {
  findUserByOpenid(openid: string): Promise<UserRow | null>;
  createUser(openid: string, now: Date): Promise<UserRow>;
  touchLogin(userId: bigint, now: Date): Promise<void>;
  findRefreshTokenByHash(hash: string): Promise<RefreshTokenRow | null>;
  createRefreshToken(userId: bigint, tokenHash: string, expiresAt: Date): Promise<void>;
  revokeRefreshToken(id: bigint, now: Date): Promise<void>;
  findUserById(id: bigint): Promise<UserRow | null>;
  updateProfile(id: bigint, nickname: string | null, avatarUrl: string | null): Promise<UserRow>;
}

export class AuthService {
  constructor(
    @Inject('AuthStore') private readonly store: AuthStore,
    @Inject('WxGateway') private readonly wx: WxGateway,
    private readonly jwt: JwtService,
  ) {}

  async login(code: string, now = new Date()): Promise<{ tokens: TokenPair; user: AuthedUser }> {
    let openid: string;
    try {
      openid = (await this.wx.code2session(code)).openid;
    } catch {
      throw new AuthError('AUTH_INVALID');
    }
    let user = await this.store.findUserByOpenid(openid);
    if (!user) {
      user = await this.store.createUser(openid, now);
    } else {
      await this.store.touchLogin(user.id, now);
    }
    const tokens = await this.issueTokens(user.id, now);
    return { tokens, user: toAuthedUser(user) };
  }

  /**
   * Rotate: consume the given refresh token (revoke it immediately) and issue a
   * fresh pair. Throws AuthError('AUTH_INVALID') when expired or already revoked.
   */
  async refresh(refreshToken: string, now = new Date()): Promise<TokenPair> {
    const row = await this.store.findRefreshTokenByHash(hashToken(refreshToken));
    if (!row) throw new AuthError('AUTH_INVALID');
    if (row.revokedAt || row.expiresAt.getTime() <= now.getTime()) {
      throw new AuthError('AUTH_INVALID');
    }
    await this.store.revokeRefreshToken(row.id, now);
    return this.issueTokens(row.userId, now);
  }

  async logout(refreshToken: string, now = new Date()): Promise<void> {
    const row = await this.store.findRefreshTokenByHash(hashToken(refreshToken));
    if (row && !row.revokedAt) {
      await this.store.revokeRefreshToken(row.id, now);
    }
  }

  async getUser(userId: bigint): Promise<UserRow> {
    const user = await this.store.findUserById(userId);
    if (!user) throw new AuthError('AUTH_INVALID');
    return user;
  }

  async updateProfile(
    userId: bigint,
    nickname?: string,
    avatarUrl?: string,
  ): Promise<UserRow> {
    const current = await this.getUser(userId);
    return this.store.updateProfile(
      current.id,
      nickname !== undefined ? nickname : current.nickname,
      avatarUrl !== undefined ? avatarUrl : current.avatarUrl,
    );
  }

  private async issueTokens(userId: bigint, now: Date): Promise<TokenPair> {
    const accessToken = this.jwt.signAccessToken(userId);
    const refreshToken = randomUUID().replace(/-/g, '');
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    await this.store.createRefreshToken(userId, hashToken(refreshToken), expiresAt);
    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    };
  }
}

export class AuthError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toAuthedUser(row: UserRow): AuthedUser {
  return { id: row.id.toString(), nickname: row.nickname, avatarUrl: row.avatarUrl };
}
