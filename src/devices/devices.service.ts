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

/** Backup row shape over device_backups (arrangement stays opaque bytes). */
export interface BackupRow {
  mlId: string;
  arrangement: Buffer;
  arrangementCrc32: number;
  arrangementLen: number;
  lastGood: Buffer | null;
  lastGoodRev: number | null;
  updatedAt: Date;
}

/** Result of overwriting a backup (or restoring last_good). */
export interface BackupWriteResult {
  rev: number;
  pushedAt: Date;
  previousRev: number;
}

export const ACCEPTED_PAYLOAD_VERSIONS = [1] as const;
export const MAX_ARRANGEMENT_BYTES = 65536;

/** Data access over device_backups. Prisma-backed in prod; faked in tests. */
export interface BackupStore {
  findBackup(mlId: string): Promise<BackupRow | null>;
  /** Overwrite: current arrangement moves into last_good; rev = rev + 1. Creates the row on first push. */
  putBackup(
    mlId: string,
    arrangement: Buffer,
    crc32: number,
    pushedBy: bigint,
    fwVersion: string | null,
    payloadVersion: number,
    now: Date,
  ): Promise<BackupWriteResult>;
  /** Swap current arrangement/rev with last_good; rev = rev + 1. Throws NOT_FOUND (409) when no last_good. */
  restoreLastGood(mlId: string, now: Date): Promise<BackupWriteResult>;
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
  constructor(public readonly code: string, public readonly status?: number) {
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
  constructor(
    @Inject('DeviceStore') private readonly store: DeviceStore,
    @Inject('BackupStore') private readonly backups: BackupStore,
    @Inject('RateLimiter') private readonly rateLimiter: RateLimiter,
  ) {}

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

  async getBackup(mlId: string, fwVersionParam: string | undefined): Promise<ReturnType<typeof toBackupDto>> {
    requireValidMlId(mlId);
    const row = await this.backups.findBackup(mlId);
    if (!row) throw new DeviceError('NOT_FOUND');
    const device = await this.store.findDevice(mlId);
    const stale = fwVersionParam !== undefined && device?.fwVersion !== fwVersionParam;
    return toBackupDto(row, device, stale);
  }

  /** Body is decoded once; CRC32 and size are the only content checks. TLV is never parsed. */
  async putBackup(mlId: string, userId: bigint, body: BackupBody, contentLength?: number, now = new Date()) {
    requireValidMlId(mlId);
    if (body.baseRev !== undefined && typeof body.baseRev !== 'number') throw new DeviceError('DEVICE_ID_INVALID');

    // Content-Length pre-check before decoding (base64 inflates 33%).
    if (typeof contentLength === 'number' && contentLength > PUT_BODY_LIMIT_BYTES) {
      throw new DeviceError('PAYLOAD_TOO_LARGE');
    }

    const limiterKey = `put-backup:${userId}`;
    const verdict = this.rateLimiter.consume(limiterKey, PUT_BACKUP_RATE_LIMIT, 60_000);
    if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

    if (typeof body.arrangement !== 'string' || typeof body.crc32 !== 'number' || !Number.isInteger(body.crc32)) {
      throw new DeviceError('DEVICE_ID_INVALID');
    }
    if (body.payloadVersion !== 1) throw new DeviceError('SCHEMA_VERSION_UNSUPPORTED');
    if (typeof body.fwVersion !== 'string' || body.fwVersion.length > 16) throw new DeviceError('DEVICE_ID_INVALID');

    const decoded = Buffer.from(body.arrangement, 'base64');
    if (decoded.length > MAX_ARRANGEMENT_BYTES) throw new DeviceError('PAYLOAD_TOO_LARGE');

    const actual = crc32(decoded);
    if ((body.crc32 >>> 0) !== actual) throw new DeviceError('BACKUP_CRC_MISMATCH');

    const result = await this.backups.putBackup(
      mlId,
      decoded,
      actual,
      userId,
      body.fwVersion ?? null,
      body.payloadVersion,
      now,
    );
    return {
      rev: result.rev,
      pushedAt: result.pushedAt.toISOString(),
      previousRev: result.previousRev,
      ...(body.baseRev !== undefined && body.baseRev < result.rev ? { behind: true } : {}),
    };
  }

  async restoreLastGood(mlId: string, now = new Date()) {
    requireValidMlId(mlId);
    const row = await this.backups.findBackup(mlId);
    if (!row) throw new DeviceError('NOT_FOUND'); // device / backup row absent
    if (row.lastGood === null) throw new DeviceError('NOT_FOUND', 409);
    const result = await this.backups.restoreLastGood(mlId, now);
    return { rev: result.rev, pushedAt: result.pushedAt.toISOString(), previousRev: result.previousRev };
  }
}

/** Content-Length pre-decode limit: JSON body of a 64 KiB base64 payload stays well below 96 KiB. */
export const PUT_BODY_LIMIT_BYTES = 64 * 1024 + 32 * 1024 + 1024;
export const PUT_BACKUP_RATE_LIMIT = 10;

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number };
}

export class RateLimitedError extends DeviceError {
  constructor(public readonly retryAfterSeconds: number) {
    super('RATE_LIMITED');
  }
}

export interface BackupBody {
  arrangement?: string;
  crc32?: number;
  payloadVersion?: number;
  fwVersion?: string;
  baseRev?: number;
}

function requireValidMlId(mlId: string): void {
  if (!ML_ID_PATTERN.test(mlId)) throw new DeviceError('DEVICE_ID_INVALID');
}

/** CRC32 (IEEE, reflected, standard zlib checksum) over the raw arrangement bytes. */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBackupDto(row: BackupRow, device: DeviceRow | null, stale: boolean) {
  return {
    mlId: row.mlId,
    rev: device?.rev ?? 0,
    payloadVersion: device?.payloadVersion ?? null,
    fwVersion: device?.fwVersion ?? null,
    arrangement: row.arrangement.toString('base64'),
    crc32: row.arrangementCrc32,
    byteLength: row.arrangementLen,
    pushedAt: row.updatedAt.toISOString(),
    stale,
  };
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
