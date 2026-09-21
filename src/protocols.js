export const PROTOCOLS = {
  rdp: { label: 'RDP', defaultPort: 3389, pillClass: 'rd' },
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
