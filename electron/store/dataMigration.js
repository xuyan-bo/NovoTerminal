const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/** 附带数据目录名：与 AssetStore.dataDir()/logsDir() 同级约定保持一致 */
const AI_DIR = 'ai-sessions';
const LOG_DIR = 'logs';

/** 递归列出文件（相对路径 + 字节数），目录本身不参与搬运统计 */
async function listFiles(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const next = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, next)));
    else if (e.isFile()) {
      try {
        out.push({ rel: next, size: (await fsp.stat(path.join(root, next))).size });
      } catch (_) {}
    }
  }
  return out;
}

/** 复制并逐文件校验字节数；只有校验通过的才算搬成功 */
async function copyVerified(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
  const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)]);
  if (a.size !== b.size) {
    try {
      await fsp.rm(dst, { force: true });
    } catch (_) {}
    return false;
  }
  return true;
}

/** 删掉搬运后留下的空目录（自底向上），有剩余文件的目录保留 */
async function pruneEmptyDirs(root, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyDirs(root, rel ? path.join(rel, e.name) : e.name);
  }
  if (!rel) return;
  try {
    if ((await fsp.readdir(path.join(root, rel))).length === 0) await fsp.rmdir(path.join(root, rel));
  } catch (_) {}
}

/** 目录搬空后把目录本身也清掉；还有文件留下就保持原样 */
async function removeIfEmpty(dir) {
  try {
    if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
  } catch (_) {}
}

/** AI 会话记录：整树搬运，目标已有同名文件时跳过并保留源文件 */
async function moveTree(srcDir, dstDir, errors) {
  const stat = { files: 0, bytes: 0, skipped: 0 };
  const todo = await listFiles(srcDir);
  if (!todo.length) return stat;
  await fsp.mkdir(dstDir, { recursive: true });
  const copied = [];
  for (const item of todo) {
    const from = path.join(srcDir, item.rel);
    const to = path.join(dstDir, item.rel);
    try {
      if (fs.existsSync(to)) {
        stat.skipped++;
        continue;
      }
      if (!(await copyVerified(from, to))) {
        errors.push({ file: item.rel, reason: 'size-mismatch' });
        continue;
      }
      copied.push(item);
      stat.files++;
      stat.bytes += item.size;
    } catch (e) {
      errors.push({ file: item.rel, reason: e.message });
    }
  }
  for (const item of copied) {
    try {
      await fsp.rm(path.join(srcDir, item.rel), { force: true });
    } catch (_) {}
  }
  await pruneEmptyDirs(srcDir);
  await removeIfEmpty(srcDir);
  return stat;
}

/** 日志文件链（新→旧）：app.log、app.log.1 …，只取窗口内的名字 */
function logChain(dir, window) {
  const out = [];
  const first = path.join(dir, 'app.log');
  if (fs.existsSync(first)) out.push(first);
  for (let i = 1; i < window; i++) {
    const f = path.join(dir, 'app.log.' + i);
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return 0;
  }
}

/**
 * 日志：两条链按「新在前」拼接后只保留窗口内的文件，其余留在原处并上报，
 * 不做删除——超出保留策略的文件该由用户自己处置。
 */
async function moveLogs(srcDir, dstDir, window, errors) {
  const stat = { files: 0, bytes: 0, dropped: 0, merged: false };
  const src = logChain(srcDir, window);
  if (!src.length) return stat;
  const dst = logChain(dstDir, window);

  if (!dst.length) {
    await fsp.mkdir(dstDir, { recursive: true });
    for (let i = 0; i < src.length; i++) {
      const from = src[i];
      const name = i === 0 ? 'app.log' : 'app.log.' + i;
      try {
        const size = (await fsp.stat(from)).size;
        if (!(await copyVerified(from, path.join(dstDir, name)))) {
          errors.push({ file: path.basename(from), reason: 'size-mismatch' });
          continue;
        }
        await fsp.rm(from, { force: true });
        stat.files++;
        stat.bytes += size;
      } catch (e) {
        errors.push({ file: path.basename(from), reason: e.message });
      }
    }
    await pruneEmptyDirs(srcDir);
    await removeIfEmpty(srcDir);
    return stat;
  }

  stat.merged = true;
  const srcFirst = mtimeOf(src[0]) > mtimeOf(dst[0]);
  const entries = (srcFirst ? src : dst).concat(srcFirst ? dst : src);
  const keep = entries.slice(0, window);
  stat.dropped = entries.length - keep.length;

  // 两阶段改名：参与拼接的文件先挪到中转名，最终名才不会被旧文件占着
  const staged = [];
  for (let i = 0; i < keep.length; i++) {
    const tmp = path.join(dstDir, '.mig-' + i);
    const fromSrc = src.includes(keep[i]);
    try {
      if (fromSrc) {
        if (!(await copyVerified(keep[i], tmp))) {
          errors.push({ file: path.basename(keep[i]), reason: 'size-mismatch' });
          continue;
        }
      } else {
        await fsp.rename(keep[i], tmp);
      }
      staged.push({ tmp, index: i, src: fromSrc ? keep[i] : '', size: (await fsp.stat(tmp)).size });
    } catch (e) {
      errors.push({ file: path.basename(keep[i]), reason: e.message });
    }
  }
  for (const item of staged) {
    const name = item.index === 0 ? 'app.log' : 'app.log.' + item.index;
    try {
      await fsp.rename(item.tmp, path.join(dstDir, name));
      stat.files++;
      stat.bytes += item.size;
      // 校验通过的那份才删源；源里超出窗口的文件原地保留，交给用户处置
      if (item.src) await fsp.rm(item.src, { force: true });
    } catch (e) {
      errors.push({ file: name, reason: e.message });
    }
  }
  await pruneEmptyDirs(srcDir);
  await removeIfEmpty(srcDir);
  return stat;
}

/**
 * 「存储位置」变更后把附带数据搬到新目录：AI 会话记录整树、日志链按窗口拼接。
 * 只在数据真的换了目录时调用；目标目录原本已有数据文件时由调用方决定是否调用。
 */
async function migrateSideData({ fromDir, toDir, logFiles = 4, log } = {}) {
  const result = { aiSessions: null, logs: null, errors: [] };
  if (!fromDir || !toDir) return result;
  if (path.resolve(fromDir) === path.resolve(toDir)) return result;
  result.aiSessions = await moveTree(path.join(fromDir, AI_DIR), path.join(toDir, AI_DIR), result.errors);
  result.logs = await moveLogs(path.join(fromDir, LOG_DIR), path.join(toDir, LOG_DIR), Math.max(1, logFiles), result.errors);
  if (log) {
    log.info('settings', 'side data migrated', {
      from: fromDir,
      to: toDir,
      aiFiles: result.aiSessions.files,
      aiBytes: result.aiSessions.bytes,
      aiSkipped: result.aiSessions.skipped,
      logFiles: result.logs.files,
      logBytes: result.logs.bytes,
      logDropped: result.logs.dropped,
      errors: result.errors.length,
    });
  }
  return result;
}

module.exports = { migrateSideData };