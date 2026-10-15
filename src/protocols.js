/**
 * 访问方式注册表：名称、描述、默认端口与可消费的凭证类型都以此处为唯一来源。
 * authKinds 决定「引用凭证」下拉能选到哪些类型，也是主凭证类型校验的依据。
 */
export const PROTOCOLS = {
  ssh: {
    label: 'SSH',
    defaultPort: 22,
    pillClass: 'ssh',
    icon: 'ssh',
    nameKey: 'cat.name.ssh',
    descKey: 'cat.desc.sshTerm',
    authKinds: ['password', 'key'],
    component: () => import('./components/views/TerminalView.vue'),
  },
  // SFTP 没有内嵌视图：由独立的单实例控制面板窗口承载多会话，故不注册 component
  sftp: {
    label: 'SFTP',
    defaultPort: 22,
    pillClass: 'sftp',
    icon: 'el-icon-files',
    nameKey: 'cat.name.sftp',
    descKey: 'cat.desc.sftp',
    authKinds: ['password', 'key'],
  },
  rdp: {
    label: 'RDP',
    defaultPort: 3389,
    pillClass: 'rd',
    icon: 'el-icon-monitor',
    nameKey: 'cat.name.rdp',
    descKey: 'cat.desc.rdp',
    // 两条引擎路径都只吃口令：IronRDP 的 SessionBuilder 没有证书 setter，外部客户端传的是 /u /p
    authKinds: ['password'],
    // 内嵌会话仅用于 IronRDP-WASM 引擎；external 引擎由 store.connectAsset 走外部 mstsc 流程
    component: () => import('./components/views/RdpView.vue'),
  },
  vnc: {
    label: 'VNC',
    defaultPort: 5900,
    pillClass: 'vnc',
    icon: 'el-icon-monitor',
    nameKey: 'cat.name.vnc',
    descKey: 'cat.desc.vnc',
    authKinds: ['password'],
    component: () => import('./components/views/VncView.vue'),
  },
};

/** 「添加访问方式」菜单的顺序 */
export const METHOD_ORDER = ['ssh', 'sftp', 'rdp', 'vnc'];

export function getProtocol(id) {
  return Object.prototype.hasOwnProperty.call(PROTOCOLS, id) ? PROTOCOLS[id] : null;
}

export function protocolLabel(id) {
  const protocol = getProtocol(id);
  return protocol ? protocol.label : String(id || '').toUpperCase();
}
