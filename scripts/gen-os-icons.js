const fs = require('fs');
const path = require('path');

function extract(p) {
  const s = fs.readFileSync(p, 'utf8');
  const m = s.match(/<svg[\s\S]*<\/svg>/i);
  if (!m) throw new Error('no svg in ' + p);
  let svg = m[0];
  svg = svg.replace(/\s(width|height)="[^"]*"/gi, '');
  svg = svg.replace(/\s(t|class|p-id|version)="[^"]*"/gi, '');
  return svg.trim();
}

const win = extract('C:/Users/xuyanbo/Downloads/windows.svg');
let mac = extract('C:/Users/xuyanbo/Downloads/apple.svg');
const linux = extract('C:/Users/xuyanbo/Downloads/linux.svg');
// dark UI: near-black apple is invisible — currentColor picks up .os-mac theme color
mac = mac.replace(/fill="#2c2c2c"/i, 'fill="currentColor"');

const rest = `
export const OS_NAME = { win: 'Windows', mac: 'macOS', linux: 'Linux' };

export const CATALOG = {
  win: [
    { id: 'rdp', name: 'RDP', desc: 'Windows 远程桌面', defaultPort: 3389, rec: true },
    { id: 'vnc', name: 'VNC', desc: 'VNC Server 兼容', defaultPort: 5900, rec: false },
  ],
  mac: [
    { id: 'vnc', name: 'VNC 屏幕共享', desc: 'macOS 自带共享', defaultPort: 5900, rec: true },
    { id: 'ssh', name: 'SSH', desc: '终端 / SFTP', defaultPort: 22, rec: false },
  ],
  linux: [
    { id: 'vnc', name: 'VNC', desc: 'x11vnc / TurboVNC', defaultPort: 5900, rec: true },
    { id: 'ssh', name: 'SSH', desc: '终端 / SFTP', defaultPort: 22, rec: false },
    { id: 'rdp', name: 'RDP (xrdp)', desc: '需安装 xrdp', defaultPort: 3389, rec: false },
  ],
};

export function methodPillClass(id) {
  return id === 'rdp' ? 'rd' : id === 'ssh' ? 'ssh' : 'vnc';
}

export function formatTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return '更早';
}

/** Element async-validator: required with i18n at validate time */
export function requiredRule(t, key, trigger = 'blur') {
  return {
    validator(rule, value, cb) {
      const empty =
        value == null ||
        (typeof value === 'string' && !value.trim()) ||
        (Array.isArray(value) && !value.length);
      if (empty) cb(new Error(t(key)));
      else cb();
    },
    trigger,
  };
}

export function patternRule(t, key, re, trigger = 'blur') {
  return {
    validator(rule, value, cb) {
      const v = String(value == null ? '' : value).trim();
      if (!v) cb(); // required handled separately
      else if (!re.test(v)) cb(new Error(t(key)));
      else cb();
    },
    trigger,
  };
}
`;

const out = [
  '// OS marks — windows/apple/linux icon sources',
  'export const OS_SVG = {',
  `  win: \`${win}\`,`,
  `  mac: \`${mac}\`,`,
  `  linux: \`${linux}\`,`,
  '};',
  rest,
].join('\n');

fs.writeFileSync(path.join(__dirname, '..', 'src', 'constants.js'), out, 'utf8');
console.log('ok', { win: win.length, mac: mac.length, linux: linux.length });
