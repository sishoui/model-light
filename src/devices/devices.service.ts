import { Inject, Injectable } from '@nestjs/common';

export const ML_ID_PATTERN = /^ML-[0-9A-F]{4}$/;
export const DEVICE_PAGE_SIZE = 20;

/** Logical pin as stored in pins_json / returned by the API. Absent indexes default to { name: '', len: 0 }. */
export interface DevicePin {
  index: number;
  name: string;
  len: number;
}

/** Row shape over devices (+ hasBackup derived from device_backups). */
export interface DeviceRow {
  mlId: string;
  displayName: string | null;
  fwVersion: string | null;
  payloadVersion: number | null;
  pinsJson: DevicePin[] | null;
  previewJson: unknown | null;
  rev: number;
  lastPushedBy: bigint | null;
  pushedAt: Date | null;
  createdAt: Date;
  hasBackup: boolean;
}

export interface DeviceMetaPatch {
  displayName: string | null;
  fwVersion: string | null;
  payloadVersion: number | null;
  pinsJson: DevicePin[] | null;
  previewJson: unknown | null;
}

/** Data access over devices + device_backups. Prisma-backed in prod; faked in tests. */
export interface DeviceStore {
  listDevices(
    userId: bigint,
    cursor: { pushedAt: Date; mlId: string } | null,
    limit: number,
  ): Promise<{ rows: DeviceRow[]; hasMore: boolean }>;
  findDevice(mlId: string): Promise<DeviceRow | null>;
  updateMeta(mlId: string, meta: DeviceMetaPatch): Promise<DeviceRow>;
  deleteDevice(mlId: string): Promise<void>;
}

export class DeviceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Keys allowed in a PUT body; presence (not value) decides whether a key is merged. */
export interface DeviceMetaBody {
  displayName?: string | null;
  fwVersion?: string | null;
  payloadVersion?: number | null;
  pins?: Array<{ index?: unknown; name?: unknown; len?: unknown }> | null;
  preview?: unknown | null;
}

@Injectable()
export class DevicesService {
  constructor(@Inject('DeviceStore') private readonly store: DeviceStore) {}

  async list(
    userId: bigint,
    cursorParam: string | undefined,
  ): Promise<{
    items: Array<{
      mlId: string;
      displayName: string | null;
      hasBackup: boolean;
      rev: number;
      pushedAt: string | null;
      pinCount: number;
    }>;
    nextCursor: string | null;
  }> {
    const cursor = decodeCursor(cursorParam);
    const { rows, hasMore } = await this.store.listDevices(userId, cursor, DEVICE_PAGE_SIZE);
    return {
      items: rows.map(toListItem),
      nextCursor: hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]) : null,
    };
  }

  async getOne(mlId: string): Promise<ReturnType<typeof toDetailDto>> {
    requireValidMlId(mlId);
    const row = await this.store.findDevice(mlId);
    if (!row) throw new DeviceError('NOT_FOUND');
    return toDetailDto(row);
  }

  /**
   * Merge semantics: only keys present in the body are updated; null clears.
   * Partial pins keep the untouched indexes of the stored value. First call creates
   * the row with rev = 0, hasBackup = false.
   */
  async putMeta(mlId: string, body: DeviceMetaBody, now = new Date()): Promise<ReturnType<typeof toDetailDto>> {
    requireValidMlId(mlId);
    const existing = await this.store.findDevice(mlId);
    const meta: DeviceMetaPatch = {
      displayName: existing?.displayName ?? null,
      fwVersion: existing?.fwVersion ?? null,
      payloadVersion: existing?.payloadVersion ?? null,
      pinsJson: existing?.pinsJson ?? null,
      previewJson: existing?.previewJson ?? null,
    };
    if ('displayName' in body) meta.displayName = body.displayName ?? null;
    if ('fwVersion' in body) meta.fwVersion = body.fwVersion ?? null;
    if ('payloadVersion' in body) meta.payloadVersion = body.payloadVersion ?? null;
    if ('pins' in body) meta.pinsJson = mergePins(meta.pinsJson, body.pins ?? null);
    if ('preview' in body) meta.previewJson = body.preview ?? null;
    const row = await this.store.updateMeta(mlId, meta);
    return toDetailDto(row);
  }

  async remove(mlId: string): Promise<void> {
    requireValidMlId(mlId);
    await this.store.deleteDevice(mlId);
  }
}

function requireValidMlId(mlId: string): void {
  if (!ML_ID_PATTERN.test(mlId)) throw new DeviceError('DEVICE_ID_INVALID');
}

function decodeCursor(cursorParam: string | undefined): { pushedAt: Date; mlId: string } | null {
  if (!cursorParam) return null;
  let raw: string;
  try {
    raw = Buffer.from(cursorParam, 'base64').toString('utf8');
  } catch {
    throw new DeviceError('NOT_FOUND');
  }
  const sep = raw.lastIndexOf('|');
  if (sep === -1) throw new DeviceError('NOT_FOUND');
  const pushedAt = new Date(raw.slice(0, sep));
  const mlId = raw.slice(sep + 1);
  if (Number.isNaN(pushedAt.getTime()) || !ML_ID_PATTERN.test(mlId)) {
    throw new DeviceError('NOT_FOUND');
  }
  return { pushedAt, mlId };
}

function encodeCursor(row: DeviceRow): string {
  return Buffer.from(`${row.pushedAt!.toISOString()}|${row.mlId}`, 'utf8').toString('base64');
}

/** Merge partial pins onto stored pins; result is a sparse list of non-default pins. */
function mergePins(
  stored: DevicePin[] | null,
  incoming: Array<{ index?: unknown; name?: unknown; len?: unknown }> | null,
): DevicePin[] | null {
  if (incoming === null) return null;
  const result = new Map<number, DevicePin>(
    (stored ?? []).map((p) => [p.index, { index: p.index, name: p.name, len: p.len }]),
  );
  for (const raw of incoming) {
    const index = raw.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 7) {
      throw new DeviceError('DEVICE_ID_INVALID');
    }
    const name = typeof raw.name === 'string' ? raw.name : '';
    const len = typeof raw.len === 'number' && Number.isFinite(raw.len) ? raw.len : 0;
    result.set(index, { index, name, len });
  }
  return [...result.values()].sort((a, b) => a.index - b.index);
}

function toListItem(row: DeviceRow) {
  return {
    mlId: row.mlId,
    displayName: row.displayName,
    hasBackup: row.hasBackup,
    rev: row.rev,
    pushedAt: row.pushedAt ? row.pushedAt.toISOString() : null,
    pinCount: row.pinsJson?.length ?? 0,
  };
}

function toDetailDto(row: DeviceRow) {
  const pins: DevicePin[] = Array.from({ length: 8 }, (_, index) => {
    const found = (row.pinsJson ?? []).find((p) => p.index === index);
    return { index, name: found?.name ?? '', len: found?.len ?? 0 };
  });
  return {
    mlId: row.mlId,
    displayName: row.displayName,
    fwVersion: row.fwVersion,
    payloadVersion: row.payloadVersion,
    pins,
    preview: row.previewJson ?? null,
    rev: row.rev,
    pushedAt: row.pushedAt ? row.pushedAt.toISOString() : null,
    hasBackup: row.hasBackup,
  };
}
