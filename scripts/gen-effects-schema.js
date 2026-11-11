// 从 miniprogram/lib/effect-schema.js 生成权威 schema/effects.json（spec-backend §11）。
// 用法：node scripts/gen-effects-schema.js

const fs = require('node:fs');
const path = require('node:path');
const { EFFECTS, SCHEMA_VERSION } = require('../miniprogram/lib/effect-schema');

const out = path.join(__dirname, '..', 'schema', 'effects.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, effects: EFFECTS }, null, 2)}\n`);
console.log(`wrote ${out} (${EFFECTS.length} effects, schemaVersion ${SCHEMA_VERSION})`);
