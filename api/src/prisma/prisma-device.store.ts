import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { DevicePin, DeviceRow, DeviceStore, DeviceMetaPatch } from '../devices/devices.service';

@Injectable()
export class PrismaDeviceStore implements DeviceStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  async listDevices(
    userId: bigint,
    cursor: { pushedAt: Date; mlId: string } | null,
    limit: number,
  ): Promise<{ rows: DeviceRow[]; hasMore: boolean }> {
    const rows = await this.prisma.device.findMany({
      where: { lastPushedBy: userId, pushedAt: { not: null } },
      orderBy: [{ pushedAt: 'desc' }, { mlId: 'desc' }],
      take: limit + (cursor ? 0 : 0),
      ...(cursor
        ? {
            where: {
              lastPushedBy: userId,
              pushedAt: { not: null },
              OR: [
                { pushedAt: { lt: cursor.pushedAt } },
                { pushedAt: cursor.pushedAt, mlId: { lt: cursor.mlId } },
              ],
            },
          }
        : {}),
      include: { backup: { select: { mlId: true } } },
    });
    return { rows: rows.slice(0, limit).map(toRow), hasMore: rows.length > limit };
  }

  async findDevice(mlId: string): Promise<DeviceRow | null> {
    const row = await this.prisma.device.findUnique({
      where: { mlId },
      include: { backup: { select: { mlId: true } } },
    });
    return row ? toRow(row) : null;
  }

  async updateMeta(mlId: string, meta: DeviceMetaPatch): Promise<DeviceRow> {
    const data = {
      displayName: meta.displayName,
      fwVersion: meta.fwVersion,
      payloadVersion: meta.payloadVersion,
      pinsJson: (meta.pinsJson ?? []) as object[],
      previewJson: (meta.previewJson ?? PrismaDbNull) as object,
    };
    const row = await this.prisma.device.upsert({
      where: { mlId },
      create: { mlId, ...data, createdAt: new Date() },
      update: data,
      include: { backup: { select: { mlId: true } } },
    });
    return toRow(row);
  }

  async deleteDevice(mlId: string): Promise<void> {
    // device_backups has no cascade in the schema; delete the child first if present.
    await this.prisma.deviceBackup.deleteMany({ where: { mlId } });
    await this.prisma.device.deleteMany({ where: { mlId } });
  }
}

// Prisma: JSON null must be Prisma.DbNull, not JS null.
const PrismaDbNull = Prisma.DbNull;

function toRow(row: {
  mlId: string;
  displayName: string | null;
  fwVersion: string | null;
  payloadVersion: number | null;
  pinsJson: unknown;
  previewJson: unknown;
  rev: number;
  lastPushedBy: bigint | null;
  pushedAt: Date | null;
  createdAt: Date;
  backup: { mlId: string } | null;
}): DeviceRow {
  return {
    mlId: row.mlId,
    displayName: row.displayName,
    fwVersion: row.fwVersion,
    payloadVersion: row.payloadVersion,
    pinsJson: (row.pinsJson as DevicePin[] | null) ?? null,
    previewJson: row.previewJson ?? null,
    rev: row.rev,
    lastPushedBy: row.lastPushedBy,
    pushedAt: row.pushedAt,
    createdAt: row.createdAt,
    hasBackup: row.backup !== null,
  };
}
