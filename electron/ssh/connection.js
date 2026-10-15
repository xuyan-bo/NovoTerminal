const net = require('net');
const { EventEmitter } = require('events');
const { Client, utils } = require('ssh2');

const SSH_DEFAULTS = Object.freeze({
  charset: 'UTF-8',
  term: 'xterm-256color',
  keepAlive: 30,
  compression: false,
  proxyJump: '',
  x11Forward: false,
  hostKeyPolicy: 'ask',
  x11Display: '',
});

const ENUMS = {
  charset: ['UTF-8', 'GBK', 'GB2312', 'Big5', 'ISO-8859-1', 'ASCII'],
  term: ['xterm-256color', 'xterm', 'vt100', 'linux', 'ansi'],
  hostKeyPolicy: ['ask', 'accept-new', 'strict'],
};
const INTERACTION_TIMEOUT = 120000;

function sshError(code, message) {
  return Object.assign(new Error(message), { code });
}

function configError(field) {
  return sshError('SSH_CONFIG', `Invalid SSH configuration: ${field}`);
}

function resolveAdvanced(saved) {
  if (saved != null && (typeof saved !== 'object' || Array.isArray(saved))) {
    throw configError('advanced');
  }
  const advanced = { ...SSH_DEFAULTS };
  for (const field of Object.keys(SSH_DEFAULTS)) {
    if (!saved || !Object.prototype.hasOwnProperty.call(saved, field)) continue;
    let value = saved[field];
    if (value == null) continue;
    if (typeof SSH_DEFAULTS[field] === 'boolean') {
      if (typeof value !== 'boolean') throw configError(field);
    } else if (field === 'keepAlive') {
      if (typeof value === 'string') {
        value = value.trim();
        if (!value) continue;
        if (!/^\d+$/.test(value)) throw configError(field);
        value = Number(value);
      }
      if (!Number.isInteger(value) || value < 0 || value > 3600) throw configError(field);
    } else {
      if (typeof value !== 'string') throw configError(field);
      value = value.trim();
      if (!value) continue;
      if (/[\x00-\x1f\x7f]/.test(value)) throw configError(field);
      if (ENUMS[field] && !ENUMS[field].includes(value)) throw configError(field);
    }
    advanced[field] = value;
  }
  parseProxyJump(advanced.proxyJump);
  return advanced;
}

function parsePort(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw configError('port');
    value = Number(value);
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw configError('port');
  return value;
}

function parseProxyJump(value) {
  if (value == null || value === '') return [];
  if (typeof value !== 'string') throw configError('proxyJump');
  if (!value.trim()) return [];
  return value.split(',').map((part) => {
    let authority = part.trim();
    const uri = authority.startsWith('ssh://');
    if (uri) authority = authority.slice(6);
    if (!authority || /[\s\x00-\x1f\x7f/?#\\]/.test(authority)) throw configError('proxyJump');
    const pieces = authority.split('@');
    if (pieces.length > 2) throw configError('proxyJump');
    let username = '';
    if (pieces.length === 2) {
      username = pieces.shift();
      if (uri) {
        try {
          username = decodeURIComponent(username);
        } catch (_) {
          throw configError('proxyJump');
        }
      }
      if (!username || /[\s\x00-\x1f\x7f:@/?#\[\]\\%]/.test(username)) throw configError('proxyJump');
    }
    const match = pieces[0].match(/^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d+))?$/);
    if (!match) throw configError('proxyJump');
    const host = match[1] || match[2];
    if (match[1] ? net.isIP(host) !== 6 : !/^[\p{L}\p{N}_.-]+$/u.test(host)) {
      throw configError('proxyJump');
    }
    return { host, port: match[3] === undefined ? 22 : parsePort(match[3]), username };
  });
}

function createSshConnection({ host, port = 22, username = '', password = '', privateKey = '', passphrase = '',
  advanced,
  verifyHostKey, promptKeyboard, log, readyTimeout = 20000 }) {
  const normalized = resolveAdvanced(advanced);
  if (typeof host !== 'string' || !host.trim() || /[\s\x00-\x1f\x7f/?#@\\]/.test(host.trim())) {
    throw configError('host');
  }
  host = host.trim();
  if (host.startsWith('[') && host.endsWith(']') && net.isIP(host.slice(1, -1)) === 6) {
    host = host.slice(1, -1);
  }
  port = parsePort(port);
  if (typeof username !== 'string') throw configError('username');
  if (password != null && typeof password !== 'string') throw configError('password');
  if (typeof privateKey !== 'string') throw configError('privateKey');
  if (passphrase != null && typeof passphrase !== 'string') throw configError('passphrase');
  // 认证方式不再有独立开关：拿到私钥内容就是 publickey，否则走口令 / 键盘交互
  const keyAuth = privateKey.trim() !== '';
  if (!Number.isInteger(readyTimeout) || readyTimeout <= 0 || readyTimeout > 2147483647) {
    throw configError('readyTimeout');
  }
  if (typeof verifyHostKey !== 'function') throw configError('verifyHostKey');
  const endpoints = parseProxyJump(normalized.proxyJump).map((jump) => ({
    ...jump, username: jump.username || username,
  }));
  endpoints.push({ host, port, username });

  const connection = new EventEmitter();
  connection.advanced = normalized;
  const clients = new Set();
  const channels = new Set();
  const timers = new Set();
  const controller = new AbortController();
  let active = true;
  let authenticated = false;
  let resolveReady;
  let rejectReady;
  const startedAt = Date.now();
  connection.ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function writeLog(level, message, meta) {
    try {
      if (log && typeof log[level] === 'function') log[level]('ssh', message, meta);
    } catch (_) {
      // Logging must not interrupt transport cleanup or settle authentication.
    }
  }

  function destroy(resource) {
    try {
      resource.destroy();
    } catch (_) {
      // Continue releasing the other links if a broken transport cannot close.
    }
  }

  function stop(error) {
    if (!active) return;
    active = false;
    controller.abort();
    if (error && !(error instanceof Error)) error = sshError('SSH_ERROR', 'SSH connection failed');
    if (error && error.code == null) {
      error.code = error.level === 'client-authentication' ? 'SSH_AUTH_FAILED' : 'SSH_ERROR';
    }
    if (!authenticated && !error) error = sshError('SSH_ENDED', 'SSH connection ended before authentication');
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const channel of [...channels].reverse()) destroy(channel);
    for (const client of [...clients].reverse()) destroy(client);
    channels.clear();
    clients.clear();
    if (!authenticated) rejectReady(error);
    writeLog(error ? 'warn' : 'info', error ? 'ssh connection failed' : 'ssh connection closed', {
      host, port, code: error ? error.code : undefined, elapsedMs: Date.now() - startedAt,
    });
    connection.emit('closed', error || null);
  }

  connection.close = () => stop(authenticated ? null : sshError('SSH_CANCELED', 'SSH connection canceled'));

  function connectEndpoint(index, sock, auth) {
    if (!active) return;
    const endpoint = endpoints[index];
    const client = new Client();
    clients.add(client);
    let timer;
    let deadline = 0;
    let remaining = readyTimeout;
    let interactionRemaining = INTERACTION_TIMEOUT;
    let interactionStarted = 0;
    const interactions = new Set();
    let ready = false;

    function clearTimer() {
      clearTimeout(timer);
      timers.delete(timer);
      timer = undefined;
    }

    function armTimeout(duration, code = 'SSH_TIMEOUT') {
      clearTimer();
      deadline = Date.now() + duration;
      timer = setTimeout(() => stop(sshError(code, 'SSH connection timed out')), duration);
      timers.add(timer);
    }

    async function interact(kind, action) {
      if (!active) throw sshError('SSH_CANCELED', 'SSH connection canceled');
      if (interactions.has(kind)) throw sshError('SSH_INTERACTION', 'Overlapping SSH authentication requests');
      if (!interactions.size) {
        if (!ready) remaining = Math.max(1, deadline - Date.now());
        interactionStarted = Date.now();
        armTimeout(Math.max(1, interactionRemaining), 'SSH_INTERACTION_TIMEOUT');
      }
      interactions.add(kind);
      try {
        return await action();
      } finally {
        interactions.delete(kind);
        // Rekey verification can overlap OTP; charge their shared UI time only once.
        if (!interactions.size) {
          interactionRemaining -= Date.now() - interactionStarted;
          clearTimer();
          if (active && !ready) armTimeout(remaining);
        }
      }
    }

    client.on('error', stop);
    client.on('end', () => stop(null));
    client.on('close', () => stop(null));
    client.on('keyboard-interactive', (name, instructions, language, prompts, finish) => {
      if (!active) return;
      if (keyAuth || typeof promptKeyboard !== 'function') {
        stop(sshError('SSH_KEYBOARD_REQUIRED', 'Interactive SSH authentication requires a prompt handler'));
        return;
      }
      interact('keyboard', () => promptKeyboard({
        name, instructions, prompts, host: endpoint.host, port: endpoint.port,
        isActive: () => active,
        signal: controller.signal,
      })).then((answers) => {
        if (!active) return;
        if (answers === null) throw sshError('SSH_CANCELED', 'SSH authentication canceled');
        if (!Array.isArray(answers) || answers.length !== prompts.length
          || answers.some((answer) => typeof answer !== 'string')) {
          throw sshError('SSH_KEYBOARD_RESPONSE', 'Invalid SSH authentication response');
        }
        finish(answers);
      }).catch(stop);
    });
    client.once('ready', () => {
      if (!active) return;
      ready = true;
      if (!interactions.size) clearTimer();
      writeLog('info', index === endpoints.length - 1 ? 'ssh connected' : 'ssh jump connected', {
        host: endpoint.host, port: endpoint.port, elapsedMs: Date.now() - startedAt,
      });
      if (index === endpoints.length - 1) {
        authenticated = true;
        resolveReady(client);
        return;
      }
      const next = endpoints[index + 1];
      const forwardingTimer = setTimeout(() => stop(sshError('SSH_TIMEOUT', 'SSH forwarding timed out')), readyTimeout);
      timers.add(forwardingTimer);
      try {
        client.forwardOut('127.0.0.1', 0, next.host, next.port, (error, channel) => {
          clearTimeout(forwardingTimer);
          timers.delete(forwardingTimer);
          if (channel) {
            channel.on('error', stop);
            channel.on('end', () => stop(null));
            channel.on('close', () => stop(null));
            if (!active) {
              destroy(channel);
              return;
            }
            channels.add(channel);
          }
          if (!active) return;
          if (error) return stop(error);
          if (!channel) return stop(sshError('SSH_FORWARD', 'SSH jump did not provide a forwarding channel'));
          try {
            connectEndpoint(index + 1, channel, auth);
          } catch (err) {
            stop(err);
          }
        });
      } catch (error) {
        stop(error);
      }
    });

    const options = {
      ...endpoint,
      ...auth,
      tryKeyboard: true,
      authHandler: keyAuth ? ['publickey'] : ['password', 'keyboard-interactive'],
      // Own the deadline so UI prompts can pause it without ssh2 private fields.
      readyTimeout: 0,
      keepaliveInterval: normalized.keepAlive * 1000,
      keepaliveCountMax: 3,
      algorithms: { compress: normalized.compression ? ['zlib@openssh.com', 'zlib', 'none'] : ['none'] },
      hostVerifier: (key, callback) => {
        interact('host-key', () => verifyHostKey({
          host: endpoint.host,
          port: endpoint.port,
          key,
          policy: normalized.hostKeyPolicy,
          isActive: () => active,
          signal: controller.signal,
        })).then((accepted) => {
          if (!active) return;
          if (accepted !== true) throw sshError('SSH_HOST_KEY_REJECTED', 'SSH host key was rejected');
          callback(true);
        }).catch(stop);
      },
    };
    if (sock) options.sock = sock;
    armTimeout(readyTimeout);
    try {
      client.connect(options);
    } catch (error) {
      stop(error);
    }
  }

  queueMicrotask(() => {
    try {
      if (!active) return;
      let auth = { password: password == null ? '' : password };
      if (keyAuth) {
        const parsed = utils.parseKey(privateKey, passphrase);
        if (parsed instanceof Error || !parsed.isPrivateKey()) {
          throw sshError('SSH_KEY_PARSE', 'Unable to decrypt or parse SSH private key');
        }
        auth = { privateKey, passphrase };
      }
      if (active) connectEndpoint(0, undefined, auth);
    } catch (error) {
      stop(error);
    }
  });
  return connection;
}

module.exports = { SSH_DEFAULTS, resolveAdvanced, parseProxyJump, createSshConnection };
