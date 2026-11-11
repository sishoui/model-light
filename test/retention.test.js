// Backup retention: files older than KEEP_DAYS are deleted, newer files kept.
// Public seam: runRetention(dir, keepDays, now) -> { deleted: string[], kept: number }
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runRetention } = require('../deploy/retention');

const NOW = new Date('2026-01-20T00:00:00Z');

function makeFile(dir, name, ageDays) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'dump');
  const t = new Date(NOW.getTime() - ageDays * 86400_000);
  fs.utimesSync(p, t, t);
  return p;
}

test('deletes dump files older than 14 days, keeps newer ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-ret-'));
  try {
    const old1 = makeFile(dir, 'ml-2026-01-01.sql.gz', 20);
    const old2 = makeFile(dir, 'ml-2026-01-04.sql.gz', 16);
    const fresh = makeFile(dir, 'ml-2026-01-19.sql.gz', 1);

    const result = runRetention(dir, 14, NOW);

    assert.deepStrictEqual(result.deleted.sort(), [old1, old2].sort());
    assert.strictEqual(fs.existsSync(old1), false);
    assert.strictEqual(fs.existsSync(old2), false);
    assert.strictEqual(fs.existsSync(fresh), true);
    assert.strictEqual(result.kept, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps a file exactly 14 days old (boundary)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-ret-'));
  try {
    const boundary = makeFile(dir, 'boundary.sql.gz', 14);
    const result = runRetention(dir, 14, NOW);
    assert.strictEqual(fs.existsSync(boundary), true);
    assert.deepStrictEqual(result.deleted, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores non-dump files and subdirectories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-ret-'));
  try {
    const readme = makeFile(dir, 'README.md', 60);
    fs.mkdirSync(path.join(dir, 'subdir'));

    const result = runRetention(dir, 14, NOW);

    assert.deepStrictEqual(result.deleted, []);
    assert.strictEqual(fs.existsSync(readme), true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'subdir')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
