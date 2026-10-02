const path = require('path');
const { FreeRdpAdapterBase } = require('./FreeRdpAdapterBase');

// FreeRDP MSI 默认落到 %ProgramFiles%\FreeRDP\bin\wfreerdp.exe；也允许用户 PATH 上直接放一个。
function wfreerdpCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env.ProgramFilesX86 || 'C:\\Program Files (x86)';
  return [
    path.join(pf, 'FreeRDP', 'bin', 'wfreerdp.exe'),
    path.join(pf86, 'FreeRDP', 'bin', 'wfreerdp.exe'),
    'wfreerdp.exe',
    'wfreerdp',
  ];
}

class RdpWfreerdpAdapter extends FreeRdpAdapterBase {
  constructor(onEvent) {
    super({
      id: 'rdp-wfreerdp',
      candidates: wfreerdpCandidates(),
      notFoundCode: 'WFREERDP_NOT_FOUND',
      platformError: 'wfreerdp is only supported on Windows',
      isPlatformSupported: () => process.platform === 'win32',
      onEvent,
    });
  }
}

module.exports = { RdpWfreerdpAdapter };
