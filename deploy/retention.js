/**
 * Backup retention: delete *.sql.gz dump files older than keepDays.
 * Called by deploy/backup.sh daily; keeps 14 days by default (spec §10).
 * Public seam: runRetention(dir, keepDays, now?) -> { deleted: string[], kept: number }
 */
const fs = require('node:fs');
const path = require('node:path');

const DUMP_SUFFIX = '.sql.gz';

function runRetention(dir, keepDays = 14, now = new Date()) {
  const cutoff = now.getTime() - keepDays * 86400_000;
  const deleted = [];
  let kept = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(DUMP_SUFFIX)) continue;
    const full = path.join(dir, entry.name);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      deleted.push(full);
    } else {
      kept += 1;
    }
  }
  return { deleted, kept };
}

module.exports = { runRetention, DUMP_SUFFIX };

if (require.main === module) {
  const dir = process.argv[2];
  const keepDays = Number(process.argv[3] || 14);
  if (!dir) {
    console.error('usage: node retention.js <backup-dir> [keepDays=14]');
    process.exit(2);
  }
  const result = runRetention(dir, keepDays);
  console.log(`retention: deleted=${result.deleted.length} kept=${result.kept}`);
}
