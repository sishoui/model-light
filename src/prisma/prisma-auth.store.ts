import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  AuthStore,
  RefreshTokenRow,
  UserRow,
} from '../auth/auth.service';

@Injectable()
export class PrismaAuthStore implements AuthStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByOpenid(openid: string): Promise<UserRow | null> {
    const row = await this.prisma.user.findUnique({ where: { openid } });
    return row ? toUserRow(row) : null;
  }

  async createUser(openid: string, now: Date): Promise<UserRow> {
    const row = await this.prisma.user.create({
      data: { openid, createdAt: now, lastLoginAt: now },
    });
    return toUserRow(row);
  }

  async touchLogin(userId: bigint, now: Date): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: now } });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return row
      ? {
          id: row.id,
          userId: row.userId,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        }
      : null;
  }

  async findActiveRefreshToken(userId: bigint): Promise<RefreshTokenRow | null> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { id: 'desc' },
    });
    return row
      ? {
          id: row.id,
          userId: row.userId,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        }
      : null;
  }

  async createRefreshToken(userId: bigint, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
  }

  async revokeRefreshToken(id: bigint, now: Date): Promise<void> {
    await this.prisma.refreshToken.update({ where: { id }, data: { revokedAt: now } });
  }

  async findUserById(id: bigint): Promise<UserRow | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toUserRow(row) : null;
  }

  async updateProfile(id: bigint, nickname: string | null, avatarUrl: string | null): Promise<UserRow> {
    const row = await this.prisma.user.update({ where: { id }, data: { nickname, avatarUrl } });
    return toUserRow(row);
  }
}

function toUserRow(row: {
  id: bigint;
  nickname: string | null;
  avatarUrl: string | null;
  lastLoginAt: Date;
}): UserRow {
  return { id: row.id, nickname: row.nickname, avatarUrl: row.avatarUrl, lastLoginAt: row.lastLoginAt };
}
