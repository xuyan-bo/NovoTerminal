const { FreeRdpAdapterBase } = require('./FreeRdpAdapterBase');
const { tcpProbe } = require('../testers');

// 常见安装位置：brew（Apple Silicon / Intel）、apt/dnf 系统路径；FreeRDP 3 的可执行文件叫 xfreerdp3。
const XFREEERDP_CANDIDATES = [
  '/opt/homebrew/bin/xfreerdp3',
  '/opt/homebrew/bin/xfreerdp',
  '/usr/local/bin/xfreerdp3',
  '/usr/local/bin/xfreerdp',
  '/usr/bin/xfreerdp3',
  '/usr/bin/xfreerdp',
  'xfreerdp3',
  'xfreerdp',
];

class RdpXfreerdpAdapter extends FreeRdpAdapterBase {
  constructor(onEvent) {
    super({
      id: 'rdp-xfreerdp',
      candidates: XFREEERDP_CANDIDATES,
      notFoundCode: 'XFREERDP_NOT_FOUND',
      platformError: 'xfreerdp is only supported on macOS / Linux',
      isPlatformSupported: () => process.platform !== 'win32',
      onEvent,
    });
  }
}

module.exports = { RdpXfreerdpAdapter, tcpProbe };
