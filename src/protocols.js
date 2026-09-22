export const PROTOCOLS = {
  rdp: {
    label: 'RDP',
    defaultPort: 3389,
    pillClass: 'rd',
    icon: '\u{1F5A5}',
    // 内嵌会话仅用于 IronRDP-WASM 引擎；external 引擎由 store.connectAsset 走外部 mstsc 流程
    component: () => import('./components/RdpView.vue'),
  },
  ssh: {
    label: 'SSH',
    defaultPort: 22,
    pillClass: 'ssh',
    icon: '⌘',
    component: () => import('./components/TerminalView.vue'),
  },
  vnc: {
    label: 'VNC',
    defaultPort: 5900,
    pillClass: 'vnc',
    icon: '\u{1F5A5}',
    component: () => import('./components/VncView.vue'),
  },
};

export function getProtocol(id) {
  return Object.prototype.hasOwnProperty.call(PROTOCOLS, id) ? PROTOCOLS[id] : null;
}

export function protocolLabel(id) {
  const protocol = getProtocol(id);
  return protocol ? protocol.label : String(id || '').toUpperCase();
}
