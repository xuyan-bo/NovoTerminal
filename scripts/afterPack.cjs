const fs = require('fs');
const path = require('path');

// Chromium ships 50+ localized string packs (~40 MB); the app only offers zh/en UI.
const KEEP = new Set(['en-US.pak', 'zh-CN.pak']);

module.exports = async (context) => {
  // macOS keeps per-language .lproj folders (a few KB each) and enforces signed resources.
  if (context.electronPlatformName === 'darwin') return;
  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;
  let freed = 0;
  for (const entry of fs.readdirSync(localesDir)) {
    if (!entry.endsWith('.pak') || KEEP.has(entry)) continue;
    const file = path.join(localesDir, entry);
    freed += fs.statSync(file).size;
    fs.rmSync(file);
  }
  console.log(`afterPack: pruned ${context.electronPlatformName} locales, ${(freed / 1048576).toFixed(1)} MB freed`);
};
