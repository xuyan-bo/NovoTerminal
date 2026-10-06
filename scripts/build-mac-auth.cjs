const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function buildMacAuth() {
  if (process.platform !== 'darwin') {
    throw new Error('The macOS authentication helper must be built on macOS with Xcode Command Line Tools');
  }
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'build', 'auth', 'novoterminal-auth');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('/usr/bin/xcrun', [
    'clang', '-O2', '-fobjc-arc', '-fblocks',
    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0',
    '-framework', 'Foundation', '-framework', 'LocalAuthentication',
    path.join(root, 'electron', 'auth', 'macosAuth.m'), '-o', output,
  ], { stdio: 'inherit' });
}

module.exports = (context) => {
  if (context.electronPlatformName === 'darwin') buildMacAuth();
};

if (require.main === module && process.platform === 'darwin') buildMacAuth();
