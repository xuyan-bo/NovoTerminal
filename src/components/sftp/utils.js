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

/** Local separator: drive letters and backslash paths are Windows, everything else is POSIX. */
function localSep(dir) {
  return /^[A-Za-z]:/.test(dir) || (dir.includes('\\') && !dir.startsWith('/')) ? '\\' : '/';
}

/** Absolute filesystem path on any supported OS: POSIX root, Windows drive, or UNC share. */
export function isAbsLocalPath(p) {
  const s = String(p || '');
  if (/^[A-Za-z]:[\\/]/.test(s) || s.indexOf('\\\\') === 0) return true;
  return s.charAt(0) === '/' && s.length > 1;
}

export function joinLocal(dir, name) {
  if (!dir) return name;
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name;
  return dir + localSep(dir) + name;
}
export function parentLocal(p) {
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return p;
  const normalized = String(p).replace(/[\\/]+$/, '');
  if (!normalized || normalized === '/') return '/';
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (idx < 0) return normalized;
  if (idx === 0) return normalized.charAt(0) === '/' ? '/' : normalized;
  let next = normalized.slice(0, idx);
  if (/^[A-Za-z]:$/.test(next)) next += '\\';
  return next || normalized;
}

export function isTaskFinished(row) {
  return row.status === 'done' || row.status === 'error' || row.status === 'canceled';
}

/** Order a listing for display: '..' first, then folders, then files, each group by the chosen column. */
export function sortItems(items, sort) {
  const key = (sort && sort.key) || 'name';
  const dir = sort && sort.dir === 'desc' ? -1 : 1;
  const rank = (x) => (x.isParent ? 0 : x.isDir ? 1 : 2);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  return [...(items || [])].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return 0;
    if (key === 'size') return (Number(a.size) - Number(b.size)) * dir || byName(a, b);
    if (key === 'time') return (Number(a.mtimeMs) - Number(b.mtimeMs)) * dir || byName(a, b);
    return byName(a, b) * dir;
  });
}
