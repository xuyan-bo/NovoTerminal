const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');

const ADVANCED_SSH_DEFAULTS = {
  charset: 'UTF-8',
  term: 'xterm-256color',
  keepAlive: 30,
  compression: false,
  authType: 'password',
  privateKeyPath: '',
  proxyJump: '',
  x11Forward: false,
  hostKeyPolicy: 'ask',
};

function resolveAdvanced(saved) {
  const base = { ...ADVANCED_SSH_DEFAULTS };
  if (!saved || typeof saved !== 'object') return base;
  Object.keys(base).forEach((k) => {
    const v = saved[k];
    if (v === undefined || v === null) return;
    if (typeof base[k] === 'string' && String(v).trim() === '') return;
    if (typeof base[k] === 'number') {
      const n = Number(v);
      if (Number.isNaN(n) || String(v).trim() === '') return;
      base[k] = n;
      return;
    }
    if (typeof base[k] === 'boolean') {
      base[k] = !!v;
      return;
    }
    if (v !== '') base[k] = v;
  });
  return base;
}

function hostKeyFile() {
  const dir = path.join(os.homedir(), '.omnidesk');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ssh_known_hosts.json');
}

function loadHostKeys() {
  try {
    const p = hostKeyFile();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function saveHostKey(host, port, key) {
  try {
    const map = loadHostKeys();
    map[`${host}:${port}`] = key;
    fs.writeFileSync(hostKeyFile(), JSON.stringify(map, null, 2), 'utf8');
  } catch (_) {}
}

function fingerprint(keyBuf) {
  return crypto.createHash('sha256').update(keyBuf).digest('base64');
}

function expandHome(p) {
  return String(p || '').replace(/^~(?=[/\\])/, os.homedir());
}

function parseJump(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const m = s.match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  return {
    username: m[1] || '',
    host: m[2],
    port: m[3] ? Number(m[3]) : 22,
  };
}

function buildAuthOptions(adv, password, username) {
  const opts = { username };
  if (adv.authType === 'publickey' && adv.privateKeyPath) {
    const keyPath = expandHome(adv.privateKeyPath);
    opts.privateKey = fs.readFileSync(keyPath);
  } else if (password) {
    opts.password = password;
  }
  return opts;
}

/**
 * Xshell-style SSH sessions: ssh2 in main + stream over IPC to xterm.js.
 */
class SshSessionManager {
  constructor({ send }) {
    this.send = send || (() => {});
    this.sessions = new Map();
    this._seq = 0;
  }

  _channel(sessionId) {
    return 'ssh:data:' + sessionId;
  }

  _emit(sessionId, type, payload) {
    this.send('ssh:state', { sessionId, type, ...(payload || {}) });
  }

  _write(sessionId, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.send(this._channel(sessionId), buf);
  }

  _hostVerifier(sessionId, adv) {
    return (key, callback) => {
      // ssh2 may call with (key, cb) or sync returning boolean
      const done = typeof callback === 'function' ? callback : null;
      try {
        const keyBuf = key || Buffer.alloc(0);
        const keyType = (key && key.type) || 'unknown';
        const fp = fingerprint(keyBuf);
        const host = (this.sessions.get(sessionId) && this.sessions.get(sessionId).host) || '';
        const port = (this.sessions.get(sessionId) && this.sessions.get(sessionId).port) || 22;
        const hostKeyId = `${host}:${port}`;
        const known = loadHostKeys();
        const prev = known[hostKeyId];
        const policy = adv.hostKeyPolicy || 'ask';

        if (prev && prev.fp === fp) {
          if (done) done(true);
          return true;
        }
        if (prev && prev.fp !== fp) {
          this._emit(sessionId, 'hostkey-mismatch', {
            host,
            port,
            prev: prev.fp,
            current: fp,
            type: keyType,
          });
          if (done) done(false);
          return false;
        }
        if (policy === 'strict') {
          this._emit(sessionId, 'hostkey-unknown', {
            host,
            port,
            fp,
            type: keyType,
            policy,
          });
          if (done) done(false);
          return false;
        }
        saveHostKey(host, port, { fp, type: keyType, savedAt: Date.now() });
        this._emit(sessionId, 'hostkey-saved', { host, port, fp, type: keyType });
        if (done) done(true);
        return true;
      } catch (e) {
        if (done) done(false);
        return false;
      }
    };
  }

  connect(req) {
    const sessionId = 'ssh-' + Date.now() + '-' + (++this._seq).toString(36);
    const asset = req.asset || {};
    const method = req.method || {};
    const adv = resolveAdvanced(method.advanced || req.advanced);
    const host = asset.host;
    const port = Number(method.port) || 22;
    const username = asset.user || '';
    const password = req.password != null ? req.password : asset.pass;
    const cols = Number(req.cols) || 120;
    const rows = Number(req.rows) || 32;

    // Pre-register metadata so hostVerifier can resolve host:port
    this.sessions.set(sessionId, {
      conn: null,
      stream: null,
      assetId: req.assetId,
      host,
      port,
      adv,
      cols,
      rows,
      jumpConn: null,
    });

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanupAll = () => {
        const s = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        if (!s) return;
        try {
          if (s.stream) s.stream.close();
        } catch (_) {}
        try {
          if (s.conn) s.conn.end();
        } catch (_) {}
        try {
          if (s.jumpConn) s.jumpConn.end();
        } catch (_) {}
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanupAll();
        const e = Object.assign(new Error(err && err.message ? err.message : String(err)), {
          code: (err && err.code) || 'SSH_ERROR',
        });
        this._emit(sessionId, 'error', { code: e.code, message: e.message });
        reject(e);
      };

      const attachShell = (conn) => {
        conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
          finish(password ? prompts.map(() => password) : []);
        });
        conn.on('ready', () => {
          conn.shell(
            { term: adv.term || 'xterm-256color', cols, rows },
            (err, stream) => {
              if (err) return fail(err);
              const s = this.sessions.get(sessionId);
              if (!s) return fail(new Error('session gone'));
              s.conn = conn;
              s.stream = stream;

              stream.on('data', (d) => this._write(sessionId, d));
              if (stream.stderr) {
                stream.stderr.on('data', (d) => this._write(sessionId, d));
              }
              stream.on('close', () => {
                if (this.sessions.has(sessionId)) {
                  cleanupAll();
                  this._emit(sessionId, 'ended', {});
                }
              });

              settled = true;
              this._emit(sessionId, 'ready', {
                sessionId,
                host,
                port,
                username,
                term: adv.term,
              });
              resolve({
                sessionId,
                host,
                port,
                username,
                term: adv.term,
                charset: adv.charset,
              });
            }
          );
        });
        conn.on('error', (err) => fail(err));
        conn.on('end', () => {
          if (!settled) {
            fail(Object.assign(new Error('SSH connection ended'), { code: 'SSH_ENDED' }));
          } else if (this.sessions.has(sessionId)) {
            cleanupAll();
            this._emit(sessionId, 'ended', {});
          }
        });
      };

      const targetConnect = (sock) => {
        const conn = new Client();
        attachShell(conn);
        const opts = {
          sock,
          host,
          port,
          username,
          readyTimeout: 20000,
          keepaliveInterval: Number(adv.keepAlive) > 0 ? Number(adv.keepAlive) * 1000 : 0,
          keepaliveCountMax: 3,
          compress: !!adv.compression,
          hostVerifier: this._hostVerifier(sessionId, adv),
        };
        try {
          const auth = buildAuthOptions(adv, password, username);
          Object.assign(opts, auth);
        } catch (e) {
          return fail(
            Object.assign(new Error('无法读取私钥: ' + adv.privateKeyPath), {
              code: 'SSH_KEY_READ',
            })
          );
        }
        // when sock is provided, host/port used for logging; ssh2 uses sock
        if (!sock) {
          delete opts.sock;
        } else {
          delete opts.host;
          delete opts.port;
        }
        try {
          conn.connect(opts);
        } catch (e) {
          fail(e);
        }
      };

      const jump = parseJump(adv.proxyJump);
      if (jump) {
        const jumpConn = new Client();
        const s = this.sessions.get(sessionId);
        if (s) s.jumpConn = jumpConn;
        jumpConn.on('ready', () => {
          jumpConn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
            if (err) return fail(err);
            targetConnect(stream);
          });
        });
        jumpConn.on('error', (err) => fail(err));
        try {
          const jumpUser = jump.username || username;
          let jumpAuth;
          try {
            jumpAuth = buildAuthOptions(
              { ...adv, username: jumpUser },
              password,
              jumpUser
            );
          } catch (e) {
            return fail(e);
          }
          jumpConn.connect({
            host: jump.host,
            port: jump.port,
            username: jumpUser,
            ...jumpAuth,
            readyTimeout: 20000,
            keepaliveInterval: Number(adv.keepAlive) > 0 ? Number(adv.keepAlive) * 1000 : 0,
          });
        } catch (e) {
          fail(e);
        }
      } else {
        // direct TCP — pass host/port so hostVerifier id is correct
        const conn = new Client();
        attachShell(conn);
        const s = this.sessions.get(sessionId);
        if (s) s.conn = conn;
        const opts = {
          host,
          port,
          username,
          readyTimeout: 20000,
          keepaliveInterval: Number(adv.keepAlive) > 0 ? Number(adv.keepAlive) * 1000 : 0,
          keepaliveCountMax: 3,
          compress: !!adv.compression,
          hostVerifier: this._hostVerifier(sessionId, adv),
        };
        try {
          Object.assign(opts, buildAuthOptions(adv, password, username));
        } catch (e) {
          return fail(
            Object.assign(new Error('无法读取私钥: ' + adv.privateKeyPath), {
              code: 'SSH_KEY_READ',
            })
          );
        }
        try {
          conn.connect(opts);
        } catch (e) {
          fail(e);
        }
      }
    });
  }

  write(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.stream) return false;
    try {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      return s.stream.write(buf);
    } catch (_) {
      return false;
    }
  }

  resize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.stream) return false;
    const c = Number(cols) || s.cols;
    const r = Number(rows) || s.rows;
    // Skip identical winsize — repeated setWindow reprints the prompt and
    // interrupts in-progress command lines.
    if (c === s.cols && r === s.rows) return true;
    try {
      s.stream.setWindow(r, c, 0, 0);
      s.cols = c;
      s.rows = r;
      return true;
    } catch (_) {
      return false;
    }
  }

  cleanup(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    try {
      if (s.stream) {
        try {
          s.stream.write('exit\n');
        } catch (_) {}
        try {
          if (s.stream.signal) s.stream.signal('TERM');
        } catch (_) {}
        try {
          s.stream.close();
        } catch (_) {}
        try {
          s.stream.end();
        } catch (_) {}
      }
    } catch (_) {}
    try {
      if (s.conn) s.conn.end();
    } catch (_) {}
    try {
      if (s.jumpConn) s.jumpConn.end();
    } catch (_) {}
  }

  disconnect(sessionId) {
    const existed = this.sessions.has(sessionId);
    this.cleanup(sessionId);
    this._emit(sessionId, 'ended', {});
    return { ok: true, existed };
  }

  list() {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      assetId: s.assetId,
      host: s.host,
      port: s.port,
    }));
  }
}

module.exports = { SshSessionManager, resolveAdvanced };
