// 灯效 schema 权威文件校验 — spec-backend.md §11
// schema/effects.json 由 miniprogram/lib/effect-schema.js 生成（生成脚本见 scripts/gen-effects-schema.js），
// 是「小程序 / 固件 / 后端」三方对齐的锚点。两端必须逐字节一致。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EFFECTS, SCHEMA_VERSION } = require('../miniprogram/lib/effect-schema');

const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'effects.json');

function expectedSchema() {
  return {
    schemaVersion: SCHEMA_VERSION,
    effects: EFFECTS,
  };
}

test('schema/effects.json exists and matches effect-schema.js byte-for-byte (§11)', () => {
  assert.ok(fs.existsSync(SCHEMA_PATH), `缺少 ${SCHEMA_PATH}——运行 node scripts/gen-effects-schema.js 重新生成`);
  const onDisk = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  assert.deepEqual(onDisk, expectedSchema());
});

test('effects.json anchors exactly 12 effects (§2.11) in capability-bit order', () => {
  const onDisk = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  assert.equal(onDisk.effects.length, 12);
  onDisk.effects.forEach((e, i) => assert.equal(e.role, i < 5 ? 0 : 1));
});
