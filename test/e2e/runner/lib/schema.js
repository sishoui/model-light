// 用例 JSON schema 校验（test/e2e/cases/*.json）。
//
// Case := { id, name, setup[], steps[], assertions[], teardown[] }
// Step := { action: navigate | tap | input | evaluate | waitForSerial | waitMs, ... }
// Assertion := { type: serial | console | statusFrame | bleWrite, ... }
//
// 校验只做结构检查，不执行；runner 启动时先校验，任何一条不合法即环境错误
// （退出码 2），避免半跑一条坏用例。

const ACTIONS = new Set(['navigate', 'tap', 'input', 'evaluate', 'waitForSerial', 'waitForStatus', 'waitForBle', 'waitMs', 'daemonWrite']);
const ASSERTION_TYPES = new Set(['serial', 'console', 'statusFrame', 'bleWrite', 'mockState']);
const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function validateStep(step, where, errors) {
  if (step == null || typeof step !== 'object' || Array.isArray(step)) {
    errors.push(`${where}: 必须是对象`);
    return;
  }
  if (!ACTIONS.has(step.action)) {
    errors.push(`${where}: 未知 action '${step.action}'（允许 ${[...ACTIONS].join(', ')}）`);
    return;
  }
  switch (step.action) {
    case 'navigate':
      if (!isNonEmptyString(step.url)) errors.push(`${where}: navigate 需要非空 url`);
      break;
    case 'tap':
      if (!isNonEmptyString(step.selector)) errors.push(`${where}: tap 需要非空 selector`);
      if (step.timeoutMs != null && !isPositiveNumber(step.timeoutMs)) {
        errors.push(`${where}: timeoutMs 必须是正数`);
      }
      break;
    case 'input':
      if (!isNonEmptyString(step.selector)) errors.push(`${where}: input 需要非空 selector`);
      if (typeof step.value !== 'string' && typeof step.value !== 'number') {
        errors.push(`${where}: input 需要 string/number 类型的 value`);
      }
      break;
    case 'evaluate':
      if (!isNonEmptyString(step.code)) errors.push(`${where}: evaluate 需要非空 code`);
      break;
    case 'waitForSerial':
      if (!isNonEmptyString(step.pattern)) errors.push(`${where}: waitForSerial 需要非空 pattern`);
      if (step.timeoutMs != null && !isPositiveNumber(step.timeoutMs)) {
        errors.push(`${where}: timeoutMs 必须是正数`);
      }
      if (step.minCount != null && !isPositiveNumber(step.minCount)) {
        errors.push(`${where}: minCount 必须是正数`);
      }
      break;
    case 'waitForStatus':
      if (step.fields == null || typeof step.fields !== 'object' || Array.isArray(step.fields)) {
        errors.push(`${where}: waitForStatus 需要 fields 对象`);
      }
      if (step.timeoutMs != null && !isPositiveNumber(step.timeoutMs)) {
        errors.push(`${where}: timeoutMs 必须是正数`);
      }
      if (step.daemon != null && !isNonEmptyString(step.daemon)) {
        errors.push(`${where}: daemon 必须是非空字符串`);
      }
      break;
    case 'waitForBle':
      if (step.timeoutMs != null && !isPositiveNumber(step.timeoutMs)) {
        errors.push(`${where}: timeoutMs 必须是正数`);
      }
      if (step.daemon != null && !isNonEmptyString(step.daemon)) {
        errors.push(`${where}: daemon 必须是非空字符串`);
      }
      break;
    case 'daemonWrite':
      if (!isNonEmptyString(step.characteristic)) {
        errors.push(`${where}: daemonWrite 需要非空 characteristic`);
      }
      if (!isNonEmptyString(step.data) || !/^[0-9a-fA-F]+$/.test(step.data) || step.data.length % 2 !== 0) {
        errors.push(`${where}: daemonWrite 需要偶数长度的 hex data`);
      }
      if (step.daemon != null && !isNonEmptyString(step.daemon)) {
        errors.push(`${where}: daemon 必须是非空字符串`);
      }
      break;
    case 'waitMs':
      if (!isPositiveNumber(step.ms)) errors.push(`${where}: waitMs 需要正数 ms`);
      break;
    default:
      break;
  }
}

function validateAssertion(assertion, where, errors) {
  if (assertion == null || typeof assertion !== 'object' || Array.isArray(assertion)) {
    errors.push(`${where}: 必须是对象`);
    return;
  }
  if (!ASSERTION_TYPES.has(assertion.type)) {
    errors.push(`${where}: 未知 type '${assertion.type}'（允许 ${[...ASSERTION_TYPES].join(', ')}）`);
    return;
  }
  switch (assertion.type) {
    case 'serial':
      if (!isNonEmptyString(assertion.pattern)) errors.push(`${where}: serial 需要非空 pattern`);
      if (assertion.minCount != null && !isPositiveNumber(assertion.minCount)) {
        errors.push(`${where}: minCount 必须是正数`);
      }
      if (assertion.maxCount != null && !isPositiveNumber(assertion.maxCount)) {
        errors.push(`${where}: maxCount 必须是正数`);
      }
      break;
    case 'console':
      if (assertion.level != null && !CONSOLE_LEVELS.has(assertion.level)) {
        errors.push(`${where}: 未知 level '${assertion.level}'`);
      }
      if (assertion.pattern != null && !isNonEmptyString(assertion.pattern)) {
        errors.push(`${where}: pattern 必须是非空字符串`);
      }
      break;
    case 'statusFrame':
      if (assertion.hexLength != null && !isPositiveNumber(assertion.hexLength)) {
        errors.push(`${where}: hexLength 必须是正数（字节数）`);
      }
      if (assertion.fields != null && (typeof assertion.fields !== 'object' || Array.isArray(assertion.fields))) {
        errors.push(`${where}: fields 必须是对象`);
      }
      if (assertion.timeoutMs != null && !isPositiveNumber(assertion.timeoutMs)) {
        errors.push(`${where}: timeoutMs 必须是正数`);
      }
      if (assertion.daemon != null && !isNonEmptyString(assertion.daemon)) {
        errors.push(`${where}: daemon 必须是非空字符串`);
      }
      break;
    case 'bleWrite':
      if (!isNonEmptyString(assertion.short) && !isNonEmptyString(assertion.characteristic)) {
        errors.push(`${where}: bleWrite 需要 short 或 characteristic`);
      }
      if (assertion.data != null && !isNonEmptyString(assertion.data)) {
        errors.push(`${where}: data 必须是非空 hex 字符串`);
      }
      break;
    case 'mockState':
      if (assertion.fields != null && (typeof assertion.fields !== 'object' || Array.isArray(assertion.fields))) {
        errors.push(`${where}: mockState fields 必须是对象`);
      }
      break;
    default:
      break;
  }
}

function validateStepList(list, where, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${where}: 必须是数组`);
    return;
  }
  list.forEach((step, i) => validateStep(step, `${where}[${i}]`, errors));
}

/**
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateCase(caseDef) {
  const errors = [];
  if (caseDef == null || typeof caseDef !== 'object' || Array.isArray(caseDef)) {
    return { ok: false, errors: ['用例必须是 JSON 对象'] };
  }
  if (!isNonEmptyString(caseDef.id)) errors.push('缺少非空 id');
  if (!isNonEmptyString(caseDef.name)) errors.push('缺少非空 name');
  if (caseDef.daemons != null) {
    if (!Array.isArray(caseDef.daemons)) {
      errors.push('daemons: 必须是字符串数组');
    } else {
      const ids = caseDef.daemons;
      if (ids.length === 0) errors.push('daemons: 至少需要一个实例');
      if (new Set(ids).size !== ids.length) errors.push('daemons: 实例 id 不能重复');
      ids.forEach((id, i) => {
        if (!isNonEmptyString(id)) errors.push(`daemons[${i}]: 必须是非空字符串`);
      });
      if (!ids.includes('A')) errors.push('daemons: 必须包含主实例 A（串口断言与 mock 链路）');
    }
  }
  validateStepList(caseDef.setup, 'setup', errors);
  validateStepList(caseDef.steps, 'steps', errors);
  validateStepList(caseDef.teardown, 'teardown', errors);
  if (!Array.isArray(caseDef.assertions)) {
    errors.push('assertions: 必须是数组');
  } else {
    caseDef.assertions.forEach((a, i) => validateAssertion(a, `assertions[${i}]`, errors));
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateCase, ACTIONS, ASSERTION_TYPES };