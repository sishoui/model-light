import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { BackupRow, BackupStore, BackupWriteResult, crc32 } from '../devices/devices.service';

@Injectable()
export class PrismaBackupStore implements BackupStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  async findBackup(mlId: string): Promise<BackupRow | null> {
    const row = await this.prisma.deviceBackup.findUnique({ where: { mlId } });
    return row ? toRow(row) : null;
  }

  async putBackup(
    mlId: string,
    arrangement: Buffer,
    crc32: number,
    pushedBy: bigint,
    fwVersion: string | null,
    payloadVersion: number,
    now: Date,
  ): Promise<BackupWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.device.findUnique({ where: { mlId } });
      const previousRev = device?.rev ?? 0;
      const prev = await tx.deviceBackup.findUnique({ where: { mlId } });

      await tx.device.upsert({
        where: { mlId },
        create: {
          mlId,
          fwVersion,
          payloadVersion,
          lastPushedBy: pushedBy,
          pushedAt: now,
          rev: previousRev + 1,
          createdAt: now,
        },
        update: {
          fwVersion,
          payloadVersion,
          lastPushedBy: pushedBy,
          pushedAt: now,
          rev: previousRev + 1,
        },
      });

      const data = {
        arrangement,
        arrangementCrc32: crc32,
        arrangementLen: arrangement.length,
        // Current value moves into last_good only when a backup already exists.
        lastGood: prev ? prev.arrangement : null,
        lastGoodRev: prev ? previousRev : null,
        updatedAt: now,
      };
      await tx.deviceBackup.upsert({ where: { mlId }, create: { mlId, ...data }, update: data });

      return { rev: previousRev + 1, pushedAt: now, previousRev };
    });
  }

  async restoreLastGood(mlId: string, now: Date): Promise<BackupWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const backup = await tx.deviceBackup.findUnique({ where: { mlId } });
      if (!backup || backup.lastGood === null || backup.lastGoodRev === null) {
        throw new Error('NOT_FOUND');
      }
      const device = await tx.device.findUnique({ where: { mlId } });
      const previousRev = device?.rev ?? backup.lastGoodRev;
      const currentArrangement = backup.arrangement;
      await tx.deviceBackup.update({
        where: { mlId },
        data: {
          arrangement: backup.lastGood,
          arrangementCrc32: crc32(backup.lastGood),
          arrangementLen: backup.lastGood.length,
          lastGood: currentArrangement,
          lastGoodRev: previousRev,
          updatedAt: now,
        },
      });
      if (device) {
        await tx.device.update({
          where: { mlId },
          data: { rev: previousRev + 1, pushedAt: now },
        });
      }
      return { rev: previousRev + 1, pushedAt: now, previousRev };
    });
  }
}

function toRow(row: {
  mlId: string;
  arrangement: Uint8Array;
  arrangementCrc32: number;
  arrangementLen: number;
  lastGood: Uint8Array | null;
  lastGoodRev: number | null;
  updatedAt: Date;
}): BackupRow {
  return {
    mlId: row.mlId,
    arrangement: Buffer.from(row.arrangement),
    arrangementCrc32: row.arrangementCrc32,
    arrangementLen: row.arrangementLen,
    lastGood: row.lastGood ? Buffer.from(row.lastGood) : null,
    lastGoodRev: row.lastGoodRev,
    updatedAt: row.updatedAt,
  };
}
