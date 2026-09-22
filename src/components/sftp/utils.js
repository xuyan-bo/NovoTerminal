export const PARENT_ROW = { name: '..', isDir: true, isParent: true, sizeText: '—', mtime: '' };

export function formatSize(n) {
  const num = Number(n) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
  return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function joinRemote(dir, name) {
  const clean = String(name != null ? name : '').replace(/[\\/]+$/, '');
  // Windows OpenSSH lists drives (C:, D:) under the POSIX root '/' without a
  // leading slash, e.g. C:/Users. A drive-letter root must not get '/' prepended.
  if (!dir || dir === '/') return /^[A-Za-z]:$/.test(clean) ? clean : '/' + clean;
  return String(dir).replace(/\/+$/, '') + '/' + clean;
}
export function parentRemote(p) {
  if (!p || p === '/') return '/';
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i) || '/';
}

/** Normalize a Windows drive path the server reports (e.g. /C:/Users -> C:/Users). */
export function normalizeRemotePath(p) {
  if (typeof p !== 'string') return p;
  return /^\/[A-Za-z]:(?=[\\/]|$)/.test(p) ? p.slice(1) : p;
}
export function joinLocal(dir, name) {
  if (!dir) return name;
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name;
  const sep = /^[A-Za-z]:\\/.test(dir) || (dir.includes('\\') && !dir.startsWith('/')) ? '\\' : dir.startsWith('/') ? '/' : '\\';
  return dir + sep + name;
}
export function parentLocal(p) {
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return p;
  const normalized = String(p).replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (idx <= 0) return normalized;
  let next = normalized.slice(0, idx);
  if (/^[A-Za-z]:$/.test(next)) next += '\\';
  return next || normalized;
}

export function isTaskFinished(row) {
  return row.status === 'done' || row.status === 'error' || row.status === 'canceled';
}
