export const PROTOCOLS = {
  rdp: {
    label: 'RDP',
    defaultPort: 3389,
    pillClass: 'rd',
    icon: 'el-icon-monitor',
    // 内嵌会话仅用于 IronRDP-WASM 引擎；external 引擎由 store.connectAsset 走外部 mstsc 流程
    component: () => import('./components/RdpView.vue'),
  },
  ssh: {
    label: 'SSH',
    defaultPort: 22,
    pillClass: 'ssh',
    icon: 'ssh',
    component: () => import('./components/TerminalView.vue'),
  },
  vnc: {
    label: 'VNC',
    defaultPort: 5900,
    pillClass: 'vnc',
    icon: 'el-icon-monitor',
    component: () => import('./components/VncView.vue'),
  },
  // SFTP 没有内嵌视图：由独立的单实例控制面板窗口承载多会话，故不注册 component
  sftp: {
    label: 'SFTP',
    defaultPort: 22,
    pillClass: 'sftp',
    icon: 'el-icon-files',
  },
};

export function getProtocol(id) {
  return Object.prototype.hasOwnProperty.call(PROTOCOLS, id) ? PROTOCOLS[id] : null;
}

export function protocolLabel(id) {
  const protocol = getProtocol(id);
  return protocol ? protocol.label : String(id || '').toUpperCase();
}
