const net = require('net');
const crypto = require('crypto');
const { createSshConnection } = require('../ssh/connection');

/** ssh2 的子系统请求没有自带超时，服务器接受请求却不响应时不能让探测一直挂着。 */
const SFTP_TIMEOUT_DEFAULT_S = 20;

/** 探测与 SftpManager 的真实会话共用同一条超时，设置缺失或越界都回落到默认值。 */
function sftpTimeoutMs(advanced) {
  const n = Number(advanced && advanced.connectTimeout);
  const sec = Number.isFinite(n) ? Math.min(300, Math.max(5, Math.floor(n))) : SFTP_TIMEOUT_DEFAULT_S;
  return sec * 1000;
}

/** Plain TCP reachability probe. */
function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const t0 = Date.now();
    let done = false;
    const finish = (ok, error, latencyMs) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result(ok, error, error, latencyMs));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, undefined, Date.now() - t0));
    socket.once('timeout', () => finish(false, 'TCP_TIMEOUT'));
    socket.once('error', (e) => {
      const code = e.code || 'TCP_ERROR';
      finish(false, code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ? 'TCP_TIMEOUT' : code);
    });
    socket.connect(Number(port) || 0, host);
  });
}

function result(ok, code, message, latencyMs, extra) {
  return {
    ok,
    code: ok ? undefined : code,
    error: ok ? undefined : message,
    latencyMs: ok ? latencyMs : undefined,
    ...(extra || {}),
  };
}

// ---------- SSH: real authentication handshake ----------

async function testSsh({ host, port, username, password, privateKey, passphrase, advanced, verifyHostKey, promptKeyboard, log, onConnection }) {
  const started = Date.now();
  let connection;
  try {
    connection = createSshConnection({ host, port: Number(port) || 22, username, password, privateKey, passphrase, advanced, verifyHostKey, promptKeyboard, log });
    if (onConnection) onConnection(connection);
    await connection.ready;
    log && log.info('ssh', 'ssh authentication test succeeded', { host, port: Number(port) || 22, durationMs: Date.now() - started });
    return result(true, undefined, undefined, Date.now() - started, { auth: 'ok', scope: 'authentication' });
  } catch (error) {
    const code = error.code || (/authentication methods failed/i.test(error.message) ? 'AUTH_FAILED' : 'SSH_ERROR');
    log && log.warn('ssh', 'ssh authentication test failed', { host, port: Number(port) || 22, code, durationMs: Date.now() - started });
    return result(false, code, error.message);
  } finally {
    if (connection) {
      connection.close();
      await connection.ready.catch(() => {});
    }
  }
}

// ---------- SFTP: SSH authentication + sftp subsystem handshake ----------

/**
 * SFTP 复用 SSH 认证，因此探测必须在认证之上真正打开 sftp 子系统并完成版本协商：
 * 只有 TCP 可达或 SSH 认证成功都不代表服务器装了 sftp-server。
 */
async function testSftp({ host, port, username, password, privateKey, passphrase, advanced, verifyHostKey, promptKeyboard, log, onConnection }) {
  const started = Date.now();
  const probePort = Number(port) || 22;
  const timeoutMs = sftpTimeoutMs(advanced);
  let connection;
  try {
    connection = createSshConnection({ host, port: probePort, username, password, privateKey, passphrase, advanced, verifyHostKey, promptKeyboard, log, readyTimeout: timeoutMs });
    if (onConnection) onConnection(connection);
    const client = await connection.ready;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error('SFTP subsystem handshake timed out'), { code: 'SFTP_UNAVAILABLE' }));
      }, timeoutMs);
      client.sftp((error, sftp) => {
        clearTimeout(timer);
        if (sftp) {
          try {
            sftp.end();
          } catch (_) {}
        }
        if (error) {
          // ssh2 在子系统启动失败时把退出码写进 error.code（数字），统一收敛为稳定字符串码
          return reject(Object.assign(error, {
            code: typeof error.code === 'string' ? error.code : 'SFTP_UNAVAILABLE',
            message: error.message || 'SFTP subsystem unavailable',
          }));
        }
        resolve();
      });
    });
    log && log.info('sftp', 'sftp subsystem test succeeded', { host, port: probePort, durationMs: Date.now() - started });
    return result(true, undefined, undefined, Date.now() - started, { auth: 'ok', scope: 'subsystem' });
  } catch (error) {
    const code = error.code || (/authentication methods failed/i.test(error.message) ? 'AUTH_FAILED' : 'SFTP_ERROR');
    log && log.warn('sftp', 'sftp subsystem test failed', { host, port: probePort, code, durationMs: Date.now() - started });
    return result(false, code, error.message);
  } finally {
    if (connection) {
      connection.close();
      await connection.ready.catch(() => {});
    }
  }
}

// ---------- VNC: RFB handshake + VNC password (DES) ----------

function vncDesKey(password) {
  const pass = String(password || '').slice(0, 8);
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    const ch = i < pass.length ? pass.charCodeAt(i) : 0;
    let b = ch & 0xff;
    let r = 0;
    for (let j = 0; j < 8; j++) {
      r = (r << 1) | (b & 1);
      b >>= 1;
    }
    key[i] = r & 0xff;
  }
  return key;
}

function vncEncrypt(challenge, password) {
  const key = vncDesKey(password);
  const cipher = crypto.createCipheriv('des-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

function testVnc({ host, port, password, timeoutMs = 8000, lang }) {
  const en = lang === 'en';
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    let stage = 'version';
    let buf = Buffer.alloc(0);
    let modern = true;

    const finish = (ok, code, message, extra) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch (_) {}
      resolve(result(ok, code, message, Date.now() - t0, extra));
    };

    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(false, 'TCP_TIMEOUT', 'TCP_TIMEOUT'));
    sock.on('error', (e) => {
      const c = e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' ? 'TCP_TIMEOUT' : (e.code || 'TCP_ERROR');
      finish(false, c, e.message);
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        step();
      } catch (e) {
        finish(false, 'VNC_ERROR', e.message);
      }
    });

    // noVNC-supported security type codes
    const NOVNC_TYPES = {
      1: 'None', 2: 'VNCAuth', 6: 'RA2ne', 16: 'Tight',
      19: 'VeNCrypt', 22: 'XVP', 30: 'ARD', 113: 'MSLogonII', 256: 'Plain',
    };

    function step() {
      if (stage === 'version') {
        if (buf.length < 12) return;
        const ver = buf.slice(0, 12).toString('ascii');
        buf = buf.slice(12);
        const m = ver.match(/RFB (\d{3})\.(\d{3})/);
        modern = m ? Number(m[2]) >= 7 : true;
        sock.write('RFB 003.008\n');
        stage = modern ? 'sec-list' : 'sec-single';
        step();
        return;
      }

      if (stage === 'sec-list') {
        if (buf.length < 1) return;
        const count = buf[0];
        if (count === 0) {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(1);
          if (buf.length < 5 + len) return;
          const reason = buf.slice(5, 5 + len).toString('utf8');
          return finish(false, 'VNC_REJECTED', reason || (en ? 'VNC connection rejected' : 'VNC 拒绝连接'));
        }
        if (buf.length < 1 + count) return;
        const types = [...buf.slice(1, 1 + count)];
        buf = buf.slice(1 + count);
        if (types.includes(2)) {
          sock.write(Buffer.from([2]));
          stage = 'challenge';
        } else if (types.includes(1)) {
          sock.write(Buffer.from([1]));
          stage = 'sec-result';
        } else {
          const supported = types.filter((t) => t in NOVNC_TYPES);
          if (supported.length > 0) {
            const names = supported.map((t) => NOVNC_TYPES[t] + '(' + t + ')').join(', ');
            return finish(true, undefined, undefined, {
              auth: 'ok',
              note: en
                ? 'Server auth type: ' + names + ' (supported by noVNC)'
                : '服务器认证类型: ' + names + '（noVNC 可处理）',
            });
          }
          return finish(false, 'VNC_NO_AUTH', en
            ? 'Server auth types not supported by noVNC (offered: ' + types.join(',') + ')'
            : '服务器认证类型 noVNC 不支持（支持: ' + types.join(',') + '）');
        }
        step();
        return;
      }

      if (stage === 'sec-single') {
        if (buf.length < 4) return;
        const type = buf.readUInt32BE(0);
        buf = buf.slice(4);
        if (type === 2) {
          stage = 'challenge';
        } else if (type === 1) {
          stage = 'sec-result';
        } else if (type in NOVNC_TYPES) {
          return finish(true, undefined, undefined, {
            auth: 'ok',
            note: en
              ? 'Server auth type: ' + NOVNC_TYPES[type] + ' (supported by noVNC)'
              : '服务器认证类型: ' + NOVNC_TYPES[type] + '（noVNC 可处理）',
          });
        } else {
          return finish(false, 'VNC_NO_AUTH', en
            ? 'Server auth type not supported by noVNC (type: ' + type + ')'
            : '服务器认证类型 noVNC 不支持（类型: ' + type + '）');
        }
        step();
        return;
      }

      if (stage === 'challenge') {
        if (buf.length < 16) return;
        const challenge = buf.slice(0, 16);
        buf = buf.slice(16);
        sock.write(vncEncrypt(challenge, password));
        stage = 'sec-result';
        step();
        return;
      }

      if (stage === 'sec-result') {
        if (buf.length < 4) return;
        const r = buf.readUInt32BE(0);
        buf = buf.slice(4);
        if (r === 0) finish(true, undefined, undefined, { auth: 'ok' });
        else finish(false, 'AUTH_FAILED', en ? 'VNC password is incorrect' : 'VNC 密码错误');
      }
    }

    sock.connect(Number(port) || 5900, host);
  });
}

// ---------- RDP: TPKT + X.224 connection request + negotiation ----------

function buildRdpRequest() {
  // RDP Negotiation Request: type=0x01, flags=0x00, length=8, requestedProtocols=0x0000000B (TLS|CredSSP)
  const neg = Buffer.from([0x01, 0x00, 0x08, 0x00, 0x0b, 0x00, 0x00, 0x00]);
  const x224 = Buffer.alloc(7 + neg.length);
  x224.writeUInt8(7 + neg.length - 1, 0); // LI = total(X224+neg) - 1
  x224.writeUInt8(0xe0, 1); // CR TPDU
  x224.writeUInt16BE(0x0000, 2); // dst-ref
  x224.writeUInt16BE(0x0000, 4); // src-ref
  x224.writeUInt8(0x00, 6); // class
  neg.copy(x224, 7);

  const tpkt = Buffer.alloc(4);
  tpkt.writeUInt8(0x03, 0);
  tpkt.writeUInt8(0x00, 1);
  tpkt.writeUInt16BE(4 + x224.length, 2);
  return Buffer.concat([tpkt, x224]);
}

function testRdp({ host, port, timeoutMs = 5000, lang }) {
  const en = lang === 'en';
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (ok, code, message, extra) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch (_) {}
      resolve(result(ok, code, message, Date.now() - t0, extra));
    };

    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(false, 'TCP_TIMEOUT', 'TCP_TIMEOUT'));
    sock.on('error', (e) => {
      const c = e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' ? 'TCP_TIMEOUT' : (e.code || 'TCP_ERROR');
      finish(false, c, e.message);
    });
    sock.on('connect', () => sock.write(buildRdpRequest()));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 11) return;
      // TPKT(4) + X.224 Connection Confirm (CC = 0xd0 at offset 5)
      if (buf[5] !== 0xd0) {
        return finish(false, 'RDP_BAD_RESPONSE', en ? 'Not a valid RDP response' : '不是有效的 RDP 响应');
      }
      let selected = 0;
      const negOffset = 11; // TPKT(4) + fixed X.224 header(7)
      if (buf.length >= negOffset + 8 && buf[negOffset] === 0x02) {
        selected = buf.readUInt32LE(negOffset + 4);
      }
      const nla = (selected & 0x02) !== 0 || (selected & 0x08) !== 0;
      finish(true, undefined, undefined, { protocol: selected, nla });
    });
    sock.connect(Number(port) || 3389, host);
  });
}

module.exports = { tcpProbe, testSsh, testSftp, testVnc, testRdp };
