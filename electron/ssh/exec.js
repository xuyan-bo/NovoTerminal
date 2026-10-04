const iconv = require('iconv-lite');

const DEFAULT_TIMEOUT_CODE = 'SSH_EXEC_TIMEOUT';

function execError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Run one command over an ssh2 client and collect its decoded output. */
function exec(client, command, charset, timeoutMs, timeoutCode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let channel;
    let stdout = '';
    let stderr = '';
    let decoder;
    try {
      decoder = iconv.getDecoder(charset || 'UTF-8');
    } catch (_) {
      decoder = iconv.getDecoder('UTF-8');
    }
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { if (channel) channel.close(); } catch (_) {}
      try { if (channel) channel.destroy(); } catch (_) {}
      // 超时也带上已收到的输出：调用方要靠它判断命令跑到哪一步
      finish(reject, Object.assign(execError(timeoutCode || DEFAULT_TIMEOUT_CODE, 'remote command timed out'), { stdout, stderr }));
    }, timeoutMs);
    try {
      client.exec(command, (err, chan) => {
        if (err) return finish(reject, err);
        if (settled) {
          try { chan.destroy(); } catch (_) {}
          return;
        }
        channel = chan;
        chan.on('data', (data) => { stdout += decoder.write(Buffer.from(data)); });
        if (chan.stderr) chan.stderr.on('data', (data) => { stderr += decoder.write(Buffer.from(data)); });
        chan.on('close', () => {
          if (settled) return;
          try {
            stdout += decoder.end();
            stderr += decoder.end();
          } catch (_) {}
          finish(resolve, { stdout, stderr });
        });
        chan.on('error', (e) => finish(reject, e));
      });
    } catch (e) {
      finish(reject, e);
    }
  });
}

/** `ver` is localized ("[Version …]" / "[版本 …]") and the label can be mojibake across codepages,
 *  so match only the stable ASCII parts: the "Microsoft Windows" prefix and a dotted version. */
function looksWindowsVer(text) {
  return /Microsoft Windows.*\d+\.\d+\.\d+/i.test(String(text == null ? '' : text));
}

/** 'linux' | 'darwin' | 'windows' | null，附带原始输出供调用方记日志。 */
async function detectPlatform(client, charset, timeoutMs) {
  let uname = '';
  try {
    uname = (await exec(client, 'uname -s', charset, timeoutMs)).stdout.trim();
  } catch (_) { /* no uname outside unix-ish shells */ }
  if (/linux/i.test(uname)) return { platform: 'linux', uname, ver: '' };
  if (/darwin/i.test(uname)) return { platform: 'darwin', uname, ver: '' };
  // Git-for-Windows uname prints e.g. MINGW64_NT-10.0 — that also means a Windows host.
  if (/NT-|MINGW|CYGWIN/i.test(uname)) return { platform: 'windows', uname, ver: '' };
  let ver = '';
  try {
    // `cmd /c` works whether sshd's DefaultShell is cmd.exe or PowerShell; plain `ver` covers cmd only.
    ver = (await exec(client, 'cmd /c ver', charset, timeoutMs)).stdout;
  } catch (_) { /* fall back to plain ver */ }
  if (!looksWindowsVer(ver)) {
    try {
      ver = (await exec(client, 'ver', charset, timeoutMs)).stdout;
    } catch (_) { /* not windows either */ }
  }
  if (looksWindowsVer(ver)) return { platform: 'windows', uname, ver };
  return { platform: null, uname, ver };
}

/** 同一条会话只探测一次平台，结果挂在 execTarget 给出的 cache 上，随会话一起销毁。 */
async function platformOf(target, timeoutMs) {
  const cache = target && target.cache;
  if (cache && cache.platformInfo) return cache.platformInfo;
  const info = await detectPlatform(target.client, target.charset, timeoutMs);
  if (cache) cache.platformInfo = info;
  return info;
}

module.exports = { exec, platformOf };
