import { t } from '../../i18n';

export const PARENT_ROW = { name: '..', isDir: true, isParent: true, sizeText: '—', mtime: '' };

/** 传输行的失败原因由主进程给错误码，界面按 err.<CODE> 取译文；英文原文只作兜底显示。 */
export function transferErrorText(row) {
  const code = row && row.errorCode ? 'err.' + row.errorCode : '';
  const mapped = code ? t(code) : '';
  return (code && mapped !== code ? mapped : (row && row.error)) || t('sftp.transferFailed');
}

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

/** 本机面板一行的真实路径：Windows「此电脑」视图里的盘符行自带绝对 path，不能按名拼接。 */
export function localPathOf(dir, item) {
  if (!item) return '';
  return item.isDrive ? item.path : joinLocal(dir, item.name);
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

/*
 * 文件图标：按扩展名归类到 public/icons/file-*.svg，未命中的回落到通用 file。
 * 少数后缀两类都要用（.obj 三维模型 / 编译产物、.vhd 虚拟硬盘 / VHDL、.mm 思维导图 / Objective-C++、
 * .mts TypeScript 模块 / AVCHD 视频、.key Keynote / 私钥），只能按日常出现频率二选一，
 * 这里分别给了模型、虚拟硬盘、导图、代码、私钥。
 */
const EXT_ICON_GROUPS = [
  [
    'file-code',
    'js jsx mjs cjs ts tsx mts cts vue svelte astro coffee c h cc cpp cxx hpp hxx hh cs java kt kts scala groovy go rs py pyw pyi rb php swift lua pl pm r dart ex exs erl hrl hs clj cljs cljc fs fsx jl nim zig v sv svh vhdl asm s css scss sass less styl html htm xhtml xml xsl xslt proto graphql gql sol tf hcl ipynb',
  ],
  ['file-terminal', 'sh bash zsh fish ksh csh bat cmd ps1 psm1'],
  ['file-markdown', 'md markdown mdx mdown'],
  ['file-text', 'txt text log rst tex nfo srt ass ssa vtt sub idx mht mhtml webarchive pid lock sock'],
  ['file-config', 'toml ini cfg conf config properties env tfvars plist inf reg vmx vbox service socket timer target'],
  ['file-json', 'json jsonc json5 jsonl ndjson geojson'],
  ['file-yaml', 'yaml yml'],
  ['file-pdf', 'pdf'],
  ['file-word', 'doc docx docm dot dotx rtf odt pages wps'],
  ['file-sheet', 'xls xlsx xlsm xlsb csv tsv ods numbers et'],
  ['file-slides', 'ppt pptx pps ppsx odp dps'],
  [
    'file-image',
    'png jpg jpeg jpe gif bmp webp ico svg avif tif tiff heic heif jfif psd psb ai eps xcf sketch fig raw cr2 cr3 nef arw dng orf rw2 raf sr2 indd xd afdesign procreate cdr',
  ],
  ['file-audio', 'mp3 wav flac aac ogg oga m4a wma opus aiff aif mid midi amr ape'],
  // mts 归代码（TypeScript 模块），摄像机那套只留 m2ts
  ['file-video', 'mp4 mkv avi mov wmv flv webm m4v mpg mpeg m2ts 3gp ogv rmvb'],
  ['file-archive', 'zip tar gz tgz bz2 tbz2 xz txz 7z rar zst lz lz4 cab lzh arj zipx bak backup old'],
  ['file-package', 'msi msix appx apk aab xapk ipa deb rpm appimage pkg snap flatpak run whl egg gem crate nupkg vsix'],
  ['file-jar', 'jar war ear'],
  ['file-disk', 'iso img dmg vhd vhdx vmdk qcow2 ova ovf wim esd vdi nrg cue toast'],
  ['file-ebook', 'epub mobi azw azw3 fb2 djvu cbz cbr lit'],
  ['file-cad', 'dwg dxf dwf step stp iges igs skp rvt'],
  ['file-model', 'obj stl fbx gltf glb 3ds blend max c4d 3mf ply dae usdz'],
  ['file-project', 'aep prproj veg drp flp als logicx cpr sesx'],
  ['file-mail', 'eml msg mbox pst ost emlx ics vcf'],
  ['file-link', 'lnk url webloc desktop appref-ms torrent'],
  ['file-notes', 'xmind mm opml one onetoc2 enex'],
  ['file-db', 'sql sqlite sqlite3 db db3 mdb accdb dbf parquet mdf ldf dump sav dta rdata hdf5 mat nc'],
  ['file-key', 'pem key crt cer pfx p12 pub ppk gpg pgp asc keystore jks der csr'],
  ['file-font', 'ttf otf woff woff2 eot ttc'],
  ['file-binary', 'exe dll so dylib bin o a lib class pyc pyo wasm app elf ko sys drv ocx mui cpl scr evtx'],
  ['file-git', 'diff patch'],
];

const EXT_ICONS = EXT_ICON_GROUPS.reduce((map, [icon, exts]) => {
  exts.split(' ').forEach((ext) => {
    map[ext] = icon;
  });
  return map;
}, {});

const NAME_ICONS = {
  dockerfile: 'file-config',
  containerfile: 'file-config',
  'cmakelists.txt': 'file-config',
  gemfile: 'file-config',
  rakefile: 'file-config',
  procfile: 'file-config',
  vagrantfile: 'file-config',
  brewfile: 'file-config',
  justfile: 'file-terminal',
  makefile: 'file-terminal',
  '.dockerignore': 'file-config',
  '.bashrc': 'file-terminal',
  '.bash_profile': 'file-terminal',
  '.bash_aliases': 'file-terminal',
  '.zshrc': 'file-terminal',
  '.zprofile': 'file-terminal',
  '.profile': 'file-terminal',
  '.gitignore': 'file-git',
  '.gitattributes': 'file-git',
  '.gitmodules': 'file-git',
  '.gitconfig': 'file-git',
  license: 'file-text',
  licence: 'file-text',
  copying: 'file-text',
  readme: 'file-text',
  changelog: 'file-text',
  notice: 'file-text',
  authors: 'file-text',
};

/** 列表行图标名：先看完整文件名（Makefile、.gitignore），再看最后一段扩展名。 */
export function fileIcon(name) {
  const file = String(name || '')
    .trim()
    .toLowerCase();
  if (!file) return 'file';
  if (NAME_ICONS[file]) return NAME_ICONS[file];
  if (file === '.env' || file.startsWith('.env.')) return 'file-config';
  const dot = file.lastIndexOf('.');
  if (dot > 0) return EXT_ICONS[file.slice(dot + 1)] || 'file';
  // 不带扩展名的点文件（.npmrc、.htaccess）基本都是配置。
  return file.charAt(0) === '.' ? 'file-config' : 'file';
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
