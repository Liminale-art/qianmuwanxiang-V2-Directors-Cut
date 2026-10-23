import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ST reads this value while its chat endpoint module is initialized. Changing
// the file therefore takes effect after the next ST process restart.
export const ST_NATIVE_BACKUP_POLICY = Object.freeze({
  key: 'backups.common.numberOfBackups',
  envKey: 'SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS',
  defaultValue: 50,
  min: 1,
  // A tenfold increase over ST's default 50 is useful for long-running
  // chats without making an accidental multi-role setting turn into an
  // unbounded disk-retention policy. Higher values remain possible through
  // ST's own config surface when an administrator explicitly needs them.
  max: 500,
});

const BACKUP_PATH = ['backups', 'common', 'numberOfBackups'];
const COMMON_PATH = ['backups', 'common'];
const BACKUPS_PATH = ['backups'];
const error = (code, message, status = 503) => Object.assign(new Error(message), {
  code: `st_backup_policy_${code}`,
  status,
});

function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^(['"])(.*)\1$/u, '$2');
  if (!/^[+-]?\d+$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validateNativeBackupCount(value) {
  const parsed = integer(value);
  if (!Number.isSafeInteger(parsed) || parsed < ST_NATIVE_BACKUP_POLICY.min || parsed > ST_NATIVE_BACKUP_POLICY.max) {
    throw error('value', `ST 原生每聊天备份数须为 ${ST_NATIVE_BACKUP_POLICY.min}–${ST_NATIVE_BACKUP_POLICY.max} 的整数`, 400);
  }
  return parsed;
}

function stripComment(value) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '#' && (index === 0 || /\s/u.test(value[index - 1]))) return value.slice(0, index).trimEnd();
  }
  return value.trimEnd();
}

function keyLine(line) {
  const match = /^(?<indent> *)(?<key>[A-Za-z0-9_-]+)\s*:\s*(?<value>.*)$/u.exec(line);
  if (!match) return null;
  return { indent: match.groups.indent.length, key: match.groups.key, value: match.groups.value };
}

function locateKeys(text, wantedPath) {
  const lines = text.split(/\r?\n/u);
  const stack = [];
  const found = [];
  for (const [index, line] of lines.entries()) {
    const parsed = keyLine(line);
    if (!parsed) continue;
    while (stack.length && parsed.indent <= stack.at(-1).indent) stack.pop();
    const currentPath = [...stack.map(item => item.key), parsed.key];
    if (currentPath.length === wantedPath.length && currentPath.every((item, position) => item === wantedPath[position])) {
      found.push({ index, ...parsed });
    }
    const value = stripComment(parsed.value).trim();
    if (!value || value === '|' || value === '>') stack.push({ key: parsed.key, indent: parsed.indent });
  }
  return { lines, found };
}

function parsedValue(found) {
  const value = integer(stripComment(found.value));
  if (!Number.isSafeInteger(value)) throw error('config_format', 'ST 配置中的原生备份数量无效，请先修正 config.yaml', 503);
  return value;
}

function validateStoredBackupCount(value) {
  const parsed = integer(value);
  if (!Number.isSafeInteger(parsed) || parsed < ST_NATIVE_BACKUP_POLICY.min) {
    throw error('config_format', 'ST 配置中的原生备份数量无效，请先修正 config.yaml', 503);
  }
  return parsed;
}

export function readNativeBackupCountConfig(text) {
  if (typeof text !== 'string') throw error('config_format', 'ST 配置内容不可读取', 503);
  const { found } = locateKeys(text, BACKUP_PATH);
  if (found.length > 1) throw error('config_format', 'ST 配置中的原生备份数量存在重复项', 503);
  if (!found.length) return { value: ST_NATIVE_BACKUP_POLICY.defaultValue, configuredValue: null, source: 'default' };
  const value = validateStoredBackupCount(parsedValue(found[0]));
  return { value, configuredValue: value, source: 'config' };
}

function replaceValue(line, value) {
  const match = /^(?<prefix> *[A-Za-z0-9_-]+\s*:\s*)(?<rest>.*)$/u.exec(line);
  if (!match) throw error('config_format', 'ST 配置结构无法安全修改', 503);
  const rest = match.groups.rest;
  let quote = '';
  let escaped = false;
  let commentAt = -1;
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '#' && (index === 0 || /\s/u.test(rest[index - 1]))) { commentAt = index; break; }
  }
  return `${match.groups.prefix}${value}${commentAt >= 0 ? rest.slice(commentAt - (commentAt > 0 && /\s/u.test(rest[commentAt - 1]) ? 1 : 0)) : ''}`;
}

export function patchNativeBackupCountConfig(text, value) {
  const nextValue = validateNativeBackupCount(value);
  if (typeof text !== 'string') throw error('config_format', 'ST 配置内容不可读取', 503);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/u.test(text);
  const { lines, found } = locateKeys(text, BACKUP_PATH);
  if (found.length > 1) throw error('config_format', 'ST 配置中的原生备份数量存在重复项', 503);
  if (found.length === 1) {
    lines[found[0].index] = replaceValue(lines[found[0].index], nextValue);
  } else {
    const common = locateKeys(text, COMMON_PATH).found;
    const backups = locateKeys(text, BACKUPS_PATH).found;
    if (common.length > 1 || backups.length > 1) throw error('config_format', 'ST 配置结构存在重复项，未修改', 503);
    if (common.length === 1 && !stripComment(common[0].value).trim()) {
      let insertAt = common[0].index + 1;
      while (insertAt < lines.length) {
        if (!lines[insertAt].trim()) break;
        const parsed = keyLine(lines[insertAt]);
        if (parsed && parsed.indent <= common[0].indent) break;
        insertAt += 1;
      }
      lines.splice(insertAt, 0, `${' '.repeat(common[0].indent + 2)}numberOfBackups: ${nextValue}`);
    } else if (backups.length === 1 && !stripComment(backups[0].value).trim()) {
      lines.splice(backups[0].index + 1, 0,
        `${' '.repeat(backups[0].indent + 2)}common:`,
        `${' '.repeat(backups[0].indent + 4)}numberOfBackups: ${nextValue}`);
    } else if (!backups.length && !text.trim()) {
      lines.push('backups:', '  common:', `    numberOfBackups: ${nextValue}`);
    } else {
      throw error('config_format', 'ST 配置中未找到可安全修改的 backups.common 区块', 503);
    }
  }
  let result = lines.join(newline);
  if (trailingNewline && !result.endsWith(newline)) result += newline;
  return result;
}

function resolveConfigPath({ configPath, commandLineArgs = globalThis.COMMAND_LINE_ARGS, env = process.env, cwd = process.cwd() } = {}) {
  const candidate = configPath || commandLineArgs?.configPath || env.SILLYTAVERN_CONFIG_PATH || path.join(cwd, 'config.yaml');
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) throw error('path', 'ST 配置路径不可用', 503);
  return path.resolve(cwd, candidate);
}

function response(value, extra = {}) {
  return {
    ok: true,
    available: true,
    min: ST_NATIVE_BACKUP_POLICY.min,
    max: ST_NATIVE_BACKUP_POLICY.max,
    defaultValue: ST_NATIVE_BACKUP_POLICY.defaultValue,
    requiresRestart: true,
    ...value,
    ...extra,
  };
}

async function atomicWrite(filePath, text, fsApi) {
  const temporary = path.join(path.dirname(filePath), `.qianmu-st-config-${process.pid}-${randomUUID()}.tmp`);
  const stat = await fsApi.stat(filePath);
  let movedOriginal = '';
  try {
    await fsApi.writeFile(temporary, text, { encoding: 'utf8', mode: stat.mode & 0o777 });
    try {
      await fsApi.rename(temporary, filePath);
    } catch (cause) {
      // Windows may refuse to replace an existing file with rename. Keep a
      // same-directory recovery copy for the short replacement window. Some
      // sandboxed hosts reject rename entirely, so copy the fully written
      // temporary file as the portable fallback before moving the old file.
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(cause?.code)) throw cause;
      try {
        await fsApi.copyFile(temporary, filePath);
      } catch (_) {
        movedOriginal = `${filePath}.qianmu-old-${randomUUID()}.tmp`;
        await fsApi.rename(filePath, movedOriginal);
        try {
          await fsApi.rename(temporary, filePath);
          await fsApi.unlink(movedOriginal);
          movedOriginal = '';
        } catch (replacementError) {
          try { await fsApi.rename(movedOriginal, filePath); } catch (_) {}
          movedOriginal = '';
          throw replacementError;
        }
      }
    }
  } finally {
    try { await fsApi.unlink(temporary); } catch (_) {}
    if (movedOriginal) { try { await fsApi.rename(movedOriginal, filePath); } catch (_) {} }
  }
}

export function createNativeBackupPolicyService({ fsApi = fs, configPath, commandLineArgs, env = process.env, cwd = process.cwd() } = {}) {
  const resolvedPath = resolveConfigPath({ configPath, commandLineArgs, env, cwd });
  let queue = Promise.resolve();
  const serial = work => {
    const task = queue.then(work, work);
    queue = task.catch(() => {});
    return task;
  };
  const environmentValue = () => {
    if (!(ST_NATIVE_BACKUP_POLICY.envKey in env)) return null;
    return validateStoredBackupCount(env[ST_NATIVE_BACKUP_POLICY.envKey]);
  };
  const read = () => serial(async () => {
    const overridden = environmentValue();
    if (overridden !== null) {
      const writable = overridden <= ST_NATIVE_BACKUP_POLICY.max;
      return response({ value: overridden, configuredValue: null, source: 'environment', writable: false,
        message: writable ? '当前由 ST 环境变量控制，请修改部署环境变量并重启 ST' : `当前值 ${overridden} 超过千幕界面上限 ${ST_NATIVE_BACKUP_POLICY.max}，请修改部署环境变量` });
    }
    let text;
    try { text = await fsApi.readFile(resolvedPath, 'utf8'); }
    catch (cause) { throw error('unavailable', '当前部署未找到可写入的 ST config.yaml', 503); }
    const current = readNativeBackupCountConfig(text);
    const writable = current.value <= ST_NATIVE_BACKUP_POLICY.max;
    return response({ ...current, writable,
      message: writable ? '' : `当前值 ${current.value} 超过千幕界面上限 ${ST_NATIVE_BACKUP_POLICY.max}，请先在 ST config.yaml 手动调整` });
  });
  const write = value => serial(async () => {
    const nextValue = validateNativeBackupCount(value);
    if (environmentValue() !== null) throw error('environment_override', '当前由 ST 环境变量控制，请修改部署环境变量并重启 ST', 409);
    let text;
    try { text = await fsApi.readFile(resolvedPath, 'utf8'); }
    catch (cause) { throw error('unavailable', '当前部署未找到可写入的 ST config.yaml', 503); }
    const current = readNativeBackupCountConfig(text);
    if (current.configuredValue === nextValue) return response({ ...current, writable: true, changed: false, requiresRestart: false });
    const patched = patchNativeBackupCountConfig(text, nextValue);
    try { await atomicWrite(resolvedPath, patched, fsApi); }
    catch (cause) { throw error('write', 'ST config.yaml 写入失败，原配置未确认改变', 503); }
    let verified;
    try { verified = readNativeBackupCountConfig(await fsApi.readFile(resolvedPath, 'utf8')); }
    catch (cause) { throw error('verify', 'ST config.yaml 写入后无法回读确认', 503); }
    if (verified.value !== nextValue || verified.configuredValue !== nextValue) throw error('verify', 'ST 原生备份数量写入后未确认', 503);
    return response({ ...verified, writable: true, changed: true, requiresRestart: true,
      message: '已写入 ST 配置，重启 ST 后生效' });
  });
  return Object.freeze({ read, write, configPath: resolvedPath });
}

export function nativeBackupPolicyErrorPayload(cause) {
  const known = typeof cause?.code === 'string' && cause.code.startsWith('st_backup_policy_');
  const status = known && Number.isInteger(cause.status) ? cause.status : 503;
  return { status, body: { ok: false, code: known ? cause.code.replace(/^st_backup_policy_/, '') : 'service', message: known ? cause.message : 'ST 原生备份设置暂不可用' } };
}
