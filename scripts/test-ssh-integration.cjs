const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Duplex, PassThrough } = require('node:stream');
const iconv = require('iconv-lite');

const root = path.resolve(__dirname, '..');
const sources = new Map([
  'electron/ssh/connection.js', 'electron/ssh/SshSessionManager.js',
  'electron/ssh/SshPrompts.js', 'electron/sftp/SftpManager.js', 'electron/session/testers.js',
].map((relative) => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]));
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const turn = () => new Promise((resolve) => setImmediate(resolve));
const failure = (code) => Object.assign(new Error('Synthetic ' + code), { code });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function observe(promise) {
  const state = { status: 'pending' };
  promise.then((value) => Object.assign(state, { status: 'fulfilled', value }),
    (error) => Object.assign(state, { status: 'rejected', error }));
  return state;
}

async function rejected(state, codes) {
  await flush();
  assert.equal(state.status, 'rejected', 'operation must settle without waiting for a real timeout');
  assert.ok([].concat(codes).includes(state.error.code), 'unexpected error: ' + state.error.code);
}

function clock() {
  const pending = new Map();
  const add = (repeat) => (fn, delay) => {
    const token = {};
    pending.set(token, { fn, delay, repeat });
    return token;
  };
  return {
    pending,
    setTimeout: add(false), setInterval: add(true),
    clearTimeout: (token) => pending.delete(token), clearInterval: (token) => pending.delete(token),
    fire(delay) {
      const due = [...pending].filter(([, timer]) => timer.delay === delay);
      assert.ok(due.length, 'expected a timer with delay ' + delay);
      for (const [token, timer] of due) {
        if (!pending.has(token)) continue;
        if (!timer.repeat) pending.delete(token);
        timer.fn();
      }
    },
  };
}

function load(relative, dependencies, timers) {
  const filename = path.join(root, relative);
  assert.ok(sources.has(relative), 'unexpected source: ' + relative);
  const source = sources.get(relative);
  const module = { exports: {} };
  const controlledRequire = (id) => {
    assert.ok(Object.hasOwn(dependencies, id), 'unexpected dependency in ' + relative + ': ' + id);
    return dependencies[id];
  };
  const wrapper = new vm.Script('(function(require, module, exports, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate) {\n' + source + '\n})', { filename }).runInThisContext();
  wrapper(controlledRequire, module, module.exports, timers.setTimeout, timers.clearTimeout,
    timers.setInterval, timers.clearInterval, setImmediate);
  return module.exports;
}

function blocked(name) {
  return new Proxy({}, { get: (_, key) => { throw new Error('Unexpected ' + name + ' access: ' + String(key)); } });
}

class Shell extends Duplex {
  constructor() {
    super();
    this.stderr = new PassThrough();
    this.writes = [];
    this.windows = [];
    this.destroyCount = 0;
  }
  _read() {}
  _write(bytes, encoding, done) { this.writes.push(Buffer.from(bytes)); done(); }
  setWindow(...args) { this.windows.push(args); }
  destroy() {
    if (!this.destroyed) this.destroyCount++;
    this.stderr.destroy();
    return super.destroy();
  }
}

function fixture(t, options = {}) {
  const timers = clock();
  const clients = [];
  const connections = [];
  const calls = [];
  const events = [];
  const logs = [];
  const x11 = [];
  const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level,
    (...args) => logs.push({ level, args })]));
  class Sftp extends EventEmitter {
    constructor() { super(); this.endCount = 0; }
    realpath(remote, callback) {
      assert.equal(remote, '.');
      this.homeCallback = callback;
      if (!options.homePending) queueMicrotask(() => callback(null, '/home/fixture'));
    }
    end() {
      if (this.endCount) return;
      this.endCount++;
      this.emit('close');
    }
  }
  class Client extends EventEmitter {
    constructor() {
      super();
      this.shellCalls = [];
      this.sftpCalls = [];
      this.shells = [];
      this.sftps = [];
      this.destroyCount = 0;
      clients.push(this);
    }
    connect(config) {
      this.config = config;
      queueMicrotask(() => config.hostVerifier(Buffer.from('synthetic-host-key'), (accepted) => {
        assert.equal(accepted, true);
        if (options.authenticated) options.authenticated(this);
        else if (!options.authPending) this.emit('ready');
      }));
    }
    shell(pty, shellOptions, callback) {
      this.shellCalls.push({ pty, options: shellOptions, callback });
      if (options.shell) return options.shell(this, callback);
      const stream = new Shell();
      this.shells.push(stream);
      queueMicrotask(() => callback(null, stream));
    }
    sftp(callback) {
      this.sftpCalls.push(callback);
      if (options.sftp) return options.sftp(this, callback);
      const channel = new Sftp();
      this.sftps.push(channel);
      queueMicrotask(() => callback(null, channel));
    }
    destroy() {
      if (this.destroyCount) return;
      this.destroyCount++;
      // ssh2 closes channels from the socket's asynchronous close event.
      queueMicrotask(() => {
        this.emit('close');
        for (const stream of this.shells) stream.destroy();
        for (const channel of this.sftps) channel.end();
      });
    }
  }
  const shared = load('electron/ssh/connection.js', {
    fs: blocked('SSH filesystem'), os: blocked('OS'), net: { isIP },
    events: { EventEmitter }, ssh2: { Client, utils: blocked('key parser') },
  }, timers);
  const connectionModule = {
    ...shared,
    createSshConnection(req) {
      calls.push(req);
      const connection = shared.createSshConnection(req);
      connections.push(connection);
      return connection;
    },
  };
  const { SshSessionManager } = load('electron/ssh/SshSessionManager.js', {
    crypto, 'iconv-lite': iconv, './connection': connectionModule,
    './x11': { async createX11Forwarder(req) {
      if (options.x11) return options.x11(req);
      const forwarder = {
        req, options: { protocol: 'MIT-MAGIC-COOKIE-1', cookie: 'synthetic', screen: 1 },
        client: null, closeCount: 0,
        attach(client) { this.client = client; },
        close() { this.closeCount++; },
      };
      x11.push(forwarder);
      return forwarder;
    } },
  }, timers);
  const asset = {
    id: 'fixture-asset', host: 'target.invalid', user: 'fixture-user', pass: 'synthetic-password',
    methods: { ssh: { enabled: true, port: 2222, advanced: options.advanced || {} } },
  };
  const send = (channel, payload, ownerId) => {
    events.push({ channel, payload, ownerId });
    if (options.send) options.send(channel, payload, ownerId);
  };
  const terminal = new SshSessionManager({ send, log });
  const { SftpManager } = load('electron/sftp/SftpManager.js', {
    fs: options.fs || blocked('SFTP filesystem'), os: blocked('OS'), path,
    '../ssh/connection': connectionModule,
  }, timers);
  const sftp = new SftpManager({ send, log, store: { findAsset: (id) => id === asset.id ? { asset } : null } });
  const testers = load('electron/session/testers.js', {
    net: blocked('network socket'), crypto, '../ssh/connection': connectionModule,
  }, timers);
  const verifyHostKey = options.verifyHostKey || (async () => true);
  const promptKeyboard = options.promptKeyboard;
  const context = { ownerId: 11, verifyHostKey, promptKeyboard };
  let sequence = 0;
  const connect = (req = {}) => terminal.connect({
    ...context, requestId: 'ssh-fixture-' + (++sequence), assetId: asset.id,
    asset, method: asset.methods.ssh, ...req,
  });
  const open = (req = {}) => sftp.openSession({ ...context, assetId: asset.id, ...req });
  const probe = (req = {}) => testers.testSsh({
    host: asset.host, port: asset.methods.ssh.port, username: asset.user, password: asset.pass,
    advanced: asset.methods.ssh.advanced, verifyHostKey, promptKeyboard, log, ...req,
  });
  t.after(async () => {
    terminal.destroyAll();
    sftp.destroyAll();
    for (const connection of connections) connection.close();
    await flush();
    assert.equal(terminal.sessions.size, 0);
    assert.equal(sftp.pending.size, 0);
    assert.equal(sftp.conns.size, 0);
    assert.equal(timers.pending.size, 0, 'all connection/shell/SFTP timers must be released');
    assert.ok(clients.every((client) => client.destroyCount === 1));
  });
  return { terminal, sftp, connect, open, probe, asset, calls, clients, connections, events, logs, timers, x11, Sftp };
}

function data(f, sessionId) {
  return f.events.filter((event) => event.channel === 'ssh:data:' + sessionId).map((event) => event.payload).join('');
}

function states(f, sessionId) {
  return f.events.filter((event) => event.channel === 'ssh:state' && event.payload.sessionId === sessionId).map((event) => event.payload.type);
}

for (const [charset, text] of [['UTF-8', '中文𠮷'], ['GBK', '中文测试'], ['Big5', '中文測試']]) {
  test('terminal ' + charset + ' decodes every byte boundary with independent stderr state', async (t) => {
    const f = fixture(t, { advanced: { charset } });
    const { sessionId } = await f.connect();
    const stream = f.clients[0].shells[0];
    const bytes = iconv.encode(text, charset);
    for (let split = 1; split < bytes.length; split++) {
      const before = data(f, sessionId);
      stream.emit('data', bytes.subarray(0, split));
      stream.stderr.emit('data', Buffer.from('|stderr|'));
      stream.emit('data', bytes.subarray(split));
      const output = data(f, sessionId).slice(before.length);
      assert.equal(output.replace('|stderr|', ''), text);
      assert.ok(output.includes('|stderr|'));
    }
    const before = data(f, sessionId);
    const stderrBytes = iconv.encode('中文', charset);
    stream.stderr.emit('data', stderrBytes.subarray(0, 1));
    stream.emit('data', Buffer.from('stdout'));
    stream.stderr.emit('data', stderrBytes.subarray(1));
    assert.equal(data(f, sessionId).slice(before.length), 'stdout中文');
    assert.ok(f.events.filter((event) => event.channel.startsWith('ssh:data:')).every((event) => event.ownerId === 11));
  });
}

test('terminal flushes incomplete stdout and stderr exactly once on close, ignores late data', async (t) => {
  const f = fixture(t);
  const { sessionId } = await f.connect();
  const stream = f.clients[0].shells[0];
  stream.emit('data', Buffer.from([0xe4]));
  stream.stderr.emit('data', Buffer.from([0xe6]));
  assert.equal(data(f, sessionId), '');
  stream.emit('close');
  stream.emit('close');
  stream.emit('data', Buffer.from('late'));
  stream.stderr.emit('data', Buffer.from('late'));
  assert.equal(data(f, sessionId), '\ufffd\ufffd');
  assert.deepEqual(states(f, sessionId), ['ready', 'ended']);
  assert.equal(stream.destroyCount, 1);
  assert.equal(f.clients[0].destroyCount, 1);
});

for (const [charset, text, unrepresentable] of [
  ['UTF-8', '中文\r', '\ud800'], ['GBK', '中文\r', '\u{1f680}'],
  ['GB2312', '中文\r', '\u{1f680}'], ['Big5', '中文\r', '\u{1f680}'],
  ['ISO-8859-1', 'caf\u00e9\r', '中'], ['ASCII', 'help\r', 'é'],
]) {
  test('terminal ' + charset + ' encodes input and rejects lossy conversion without writing', async (t) => {
    const f = fixture(t, { advanced: { charset } });
    const { sessionId } = await f.connect();
    const stream = f.clients[0].shells[0];
    assert.equal(f.terminal.write(sessionId, text), true);
    assert.deepEqual(stream.writes, [iconv.encode(text, charset)]);
    assert.throws(() => f.terminal.write(sessionId, unrepresentable), { code: 'SSH_ENCODING' });
    assert.equal(stream.writes.length, 1);
    assert.ok(f.logs.some(({ level, args }) => level === 'warn' && args[2].charset === charset));
  });
}

test('terminal UTF-8 accepts a leading BOM rather than treating it as lossy input', async (t) => {
  const f = fixture(t);
  const { sessionId } = await f.connect();
  assert.equal(f.terminal.write(sessionId, '\ufeffpwd\r'), true);
  assert.deepEqual(f.clients[0].shells[0].writes, [Buffer.from('\ufeffpwd\r')]);
});

test('terminal binary input preserves all Latin-1 bytes regardless of selected charset', async (t) => {
  const f = fixture(t, { advanced: { charset: 'ASCII' } });
  const { sessionId } = await f.connect();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.equal(f.terminal.write(sessionId, bytes.toString('latin1'), true), true);
  assert.deepEqual(f.clients[0].shells[0].writes, [bytes]);
  for (const invalid of [null, {}, Buffer.from('a'), 'a'.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => f.terminal.write(sessionId, invalid), { code: 'SSH_INPUT' });
    assert.throws(() => f.terminal.write(sessionId, invalid, true), { code: 'SSH_INPUT' });
  }
  assert.equal(f.clients[0].shells[0].writes.length, 1);
  assert.equal(f.terminal.write('ssh-missing', 'a'), false);
});

test('terminal binary input rejects non-Latin-1 characters instead of truncating them', async (t) => {
  const f = fixture(t);
  const { sessionId } = await f.connect();
  for (const invalid of ['\u0100', '中文', '\u{1f680}']) {
    assert.throws(() => f.terminal.write(sessionId, invalid, true), { code: 'SSH_INPUT' });
  }
  assert.deepEqual(f.clients[0].shells[0].writes, []);
});

for (const term of ['xterm-256color', 'xterm', 'vt100', 'linux', 'ansi']) {
  test('terminal requests ' + term + ' PTY with validated dimensions and shell options', async (t) => {
    const f = fixture(t, { advanced: { term } });
    const result = await f.connect({ cols: 90, rows: 27 });
    assert.equal(result.term, term);
    assert.deepEqual(f.clients[0].shellCalls[0].pty, { term, cols: 90, rows: 27 });
    assert.deepEqual(f.clients[0].shellCalls[0].options, {});
    assert.equal(f.terminal.resize(result.sessionId, 100, 40), true);
    assert.equal(f.terminal.resize(result.sessionId, 100, 40), true);
    for (const dims of [[0, 10], [10, -1], [1001, 10], ['80', 24], [80, 1.5]]) {
      assert.equal(f.terminal.resize(result.sessionId, ...dims), false);
    }
    assert.deepEqual(f.clients[0].shells[0].windows, [[40, 100, 0, 0]]);
    await f.connect({ cols: -1, rows: 1001 });
    assert.deepEqual(f.clients[1].shellCalls[0].pty, { term, cols: 120, rows: 32 });
  });
}

test('terminal attaches X11 to the authenticated client and forwards shell options, then releases it', async (t) => {
  const f = fixture(t, { advanced: { x11Forward: true, x11Display: ':7.1' } });
  const { sessionId } = await f.connect();
  assert.equal(f.x11[0].req.display, ':7.1');
  assert.equal(f.x11[0].client, f.clients[0]);
  assert.equal(f.clients[0].shellCalls[0].options.x11, f.x11[0].options);
  f.terminal.disconnect(sessionId);
  f.terminal.disconnect(sessionId);
  assert.equal(f.x11[0].closeCount, 1);
});

test('terminal delivers buffered initial stdout/stderr using the caller request ID', async (t) => {
  const stream = new Shell();
  const f = fixture(t, { shell: (client, callback) => {
    client.shells.push(stream);
    stream.push(Buffer.from('before callback\n'));
    stream.stderr.write(Buffer.from('initial stderr\n'));
    callback(null, stream);
    stream.push(Buffer.from('after callback\n'));
  } });
  const result = await f.connect({ requestId: 'ssh-initial-output', ownerId: 77 });
  await turn();
  assert.equal(result.sessionId, 'ssh-initial-output');
  const output = data(f, result.sessionId);
  assert.ok(output.includes('before callback\nafter callback\n'));
  assert.ok(output.includes('initial stderr\n'));
  assert.ok(f.events.every((event) => event.ownerId === 77));
  assert.deepEqual(states(f, result.sessionId), ['ready']);
});

test('terminal validates request IDs and does not replace an existing owner/session', async (t) => {
  const f = fixture(t);
  for (const requestId of ['bad', 'ssh-', 'ssh-../bad', 'ssh-' + 'a'.repeat(101), 123]) {
    await assert.rejects(f.connect({ requestId }), { code: 'SSH_REQUEST' });
  }
  const result = await f.connect({ requestId: 'ssh-owned' });
  await assert.rejects(f.connect({ requestId: result.sessionId, ownerId: 99 }), { code: 'SSH_REQUEST' });
  assert.equal(f.clients.length, 1);
  assert.equal(f.terminal.owns(result.sessionId, 11), true);
  assert.equal(f.terminal.owns(result.sessionId, 99), false);
  assert.equal(f.terminal.owns('ssh-missing', 11), false);
});

for (const stage of ['authentication', 'PTY']) {
  test('terminal owner cancellation during ' + stage + ' rejects and cannot revive through late callbacks', async (t) => {
    let shellCallback;
    const f = fixture(t, { authPending: stage === 'authentication', shell: (_, cb) => { shellCallback = cb; } });
    const pending = observe(f.connect({ requestId: 'ssh-cancel' }));
    await flush();
    f.terminal.closeOwner(99);
    assert.equal(f.terminal.sessions.size, 1);
    assert.equal(f.clients[0].destroyCount, 0);
    f.terminal.closeOwner(11);
    await rejected(pending, 'SSH_CANCELED');
    if (stage === 'PTY') {
      const late = new Shell();
      shellCallback(null, late);
      assert.equal(late.destroyCount, 1);
    } else {
      f.clients[0].emit('ready');
      assert.equal(f.clients[0].shellCalls.length, 0);
    }
    await flush();
    assert.deepEqual(states(f, 'ssh-cancel'), ['ended']);
    assert.equal(f.terminal.sessions.size, 0);
  });
}

test('terminal cancellation during X11 initialization closes a late forwarder without opening SSH', async (t) => {
  const waiting = deferred();
  let closed = 0;
  const f = fixture(t, { advanced: { x11Forward: true }, x11: () => waiting.promise });
  const pending = observe(f.connect());
  f.terminal.destroyAll();
  waiting.resolve({ close() { closed++; } });
  await rejected(pending, 'SSH_CANCELED');
  assert.equal(closed, 1);
  assert.equal(f.clients.length, 0);
});

test('terminal PTY timeout rejects, cleans up and destroys a late channel', async (t) => {
  let callback;
  const f = fixture(t, { shell: (_, cb) => { callback = cb; } });
  const pending = observe(f.connect({ requestId: 'ssh-timeout' }));
  await flush();
  f.timers.fire(20000);
  await rejected(pending, 'SSH_SHELL_TIMEOUT');
  const late = new Shell();
  callback(null, late);
  assert.equal(late.destroyCount, 1);
  assert.deepEqual(states(f, 'ssh-timeout'), ['error']);
});

for (const stage of ['authentication', 'PTY', 'stream', 'connection']) {
  test('terminal ' + stage + ' errors retain codes and release owned resources once', async (t) => {
    const error = failure('FIXTURE_' + stage.toUpperCase());
    const f = fixture(t, {
      authPending: stage === 'authentication',
      ...(stage === 'PTY' ? { shell: (_, callback) => callback(error) } : {}),
    });
    const pending = observe(f.connect({ requestId: 'ssh-error' }));
    await flush();
    if (stage === 'authentication' || stage === 'connection') f.clients[0].emit('error', error);
    if (stage === 'stream') f.clients[0].shells[0].emit('error', error);
    if (stage === 'authentication' || stage === 'PTY') await rejected(pending, error.code);
    else assert.equal(pending.status, 'fulfilled');
    assert.equal(f.terminal.sessions.size, 0);
    const errors = f.events.filter((event) => event.payload && event.payload.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.code, error.code);
    assert.equal(errors[0].ownerId, 11);
    assert.ok(f.logs.some(({ level, args }) => level === 'error' && args[2].code === error.code));
    assert.equal(JSON.stringify(f.logs).includes('synthetic-password'), false);
  });
}

for (const target of ['terminal', 'sftp']) {
  test(target + ' rejects authentication success followed by synchronous transport failure', async (t) => {
    const f = fixture(t, { authenticated(client) {
      client.emit('ready');
      client.emit('error', failure('FIXTURE_AUTH_CLOSED'));
    } });
    await assert.rejects(target === 'terminal' ? f.connect() : f.open(), { code: 'FIXTURE_AUTH_CLOSED' });
    assert.equal(f.clients[0].shellCalls.length + f.clients[0].sftpCalls.length, 0);
    assert.equal(f.terminal.sessions.size + f.sftp.pending.size + f.sftp.conns.size, 0);
  });
}

for (const event of ['error', 'close']) {
  test('terminal rejects PTY success followed by synchronous channel ' + event, async (t) => {
    const f = fixture(t, { shell(client, callback) {
      const stream = new Shell();
      client.shells.push(stream);
      callback(null, stream);
      stream.emit(event, failure('FIXTURE_PTY_CLOSED'));
    } });
    await assert.rejects(f.connect({ requestId: 'ssh-race' }), {
      code: event === 'error' ? 'FIXTURE_PTY_CLOSED' : 'SSH_CLOSED',
    });
    assert.ok(!states(f, 'ssh-race').includes('ready'));
    assert.equal(f.terminal.sessions.size, 0);
  });

  test('SFTP rejects REALPATH success followed by synchronous channel ' + event, async (t) => {
    const f = fixture(t, { homePending: true });
    const opening = f.open();
    await flush();
    const channel = f.clients[0].sftps[0];
    channel.homeCallback(null, '/fixture');
    channel.emit(event, failure('FIXTURE_REALPATH_CLOSED'));
    await assert.rejects(opening, {
      code: event === 'error' ? 'FIXTURE_REALPATH_CLOSED' : 'SFTP_CLOSED',
    });
    assert.equal(f.sftp.pending.size + f.sftp.conns.size, 0);
  });
}

test('terminal closeOwner isolates live owners and destroyAll releases the remainder', async (t) => {
  const f = fixture(t);
  const first = await f.connect({ ownerId: 11 });
  const second = await f.connect({ ownerId: 22 });
  f.terminal.closeOwner(11);
  assert.equal(f.terminal.owns(first.sessionId, 11), false);
  assert.equal(f.terminal.owns(second.sessionId, 22), true);
  assert.equal(f.clients[1].destroyCount, 0);
  f.clients[1].shells[0].emit('data', Buffer.from('still alive'));
  assert.equal(data(f, second.sessionId), 'still alive');
  f.terminal.destroyAll();
  assert.deepEqual(states(f, first.sessionId), ['ready', 'ended']);
  assert.deepEqual(states(f, second.sessionId), ['ready', 'ended']);
});

test('SFTP and terminal share advanced options, host verifier and interactive authentication', async (t) => {
  const verified = [];
  const prompted = [];
  const advanced = { charset: 'Big5', term: 'vt100', keepAlive: 17, compression: true,
    hostKeyPolicy: 'strict', privateKeyPath: '/virtual/ignored.key', privateKeyPassphrase: 'synthetic-passphrase' };
  const verifyHostKey = async (details) => { verified.push(details); return true; };
  const promptKeyboard = async (details) => { prompted.push(details); return ['synthetic-otp']; };
  const f = fixture(t, { advanced, verifyHostKey, promptKeyboard, authenticated: (client) => {
    client.emit('keyboard-interactive', 'Fixture', 'Enter OTP', '', [{ prompt: 'OTP:', echo: false }], (answers) => {
      assert.deepEqual(answers, ['synthetic-otp']);
      client.emit('ready');
    });
  } });
  await f.connect();
  const result = await f.open();
  assert.equal(result.home, '/home/fixture');
  assert.equal(f.sftp.pending.size, 0);
  assert.equal(f.sftp.conns.get(result.connId).ownerId, 11);
  assert.deepEqual(f.connections[0].advanced, f.connections[1].advanced);
  for (const req of f.calls) {
    assert.equal(req.verifyHostKey, verifyHostKey);
    assert.equal(req.promptKeyboard, promptKeyboard);
  }
  assert.equal(f.calls[1].advanced, advanced);
  assert.equal(verified.length, 2);
  assert.equal(prompted.length, 2);
  for (const details of [...verified, ...prompted]) {
    assert.equal(details.host, 'target.invalid');
    assert.equal(details.port, 2222);
    assert.equal(details.isActive(), true);
  }
  assert.ok(verified.every((details) => details.policy === 'strict'));
  assert.ok(f.clients.every((client) => client.config.keepaliveInterval === 17000));
  assert.deepEqual(f.clients[1].config.algorithms.compress, ['zlib@openssh.com', 'zlib', 'none']);
  assert.equal(f.clients[1].shellCalls.length, 0);
  f.terminal.destroyAll();
  f.sftp.destroyAll();
  assert.ok([...verified, ...prompted].every((details) => details.isActive() === false));
  assert.equal(JSON.stringify(f.logs).includes('synthetic-passphrase'), false);
});

test('SFTP invalid assets, disabled SSH and rejected host keys cannot create a live session', async (t) => {
  const f = fixture(t, { verifyHostKey: async () => { throw failure('SSH_HOST_KEY_MISMATCH'); } });
  await assert.rejects(f.open({ assetId: 'missing' }), { code: 'NOT_FOUND' });
  f.asset.methods.ssh.enabled = false;
  await assert.rejects(f.open(), { code: 'SSH_DISABLED' });
  assert.equal(f.clients.length, 0);
  f.asset.methods.ssh.enabled = true;
  await assert.rejects(f.open(), { code: 'SSH_HOST_KEY_MISMATCH' });
  assert.equal(f.clients[0].sftpCalls.length, 0);
  assert.equal(f.sftp.pending.size, 0);
});

for (const stage of ['authentication', 'subsystem', 'realpath']) {
  test('SFTP closeOwner during ' + stage + ' rejects pending work and disposes late callbacks', async (t) => {
    let callback;
    const f = fixture(t, {
      authPending: stage === 'authentication', homePending: stage === 'realpath',
      ...(stage === 'subsystem' ? { sftp: (_, cb) => { callback = cb; } } : {}),
    });
    const pending = observe(f.open());
    await flush();
    f.sftp.closeOwner(99);
    assert.equal(f.sftp.pending.size, 1);
    assert.equal(f.clients[0].destroyCount, 0);
    f.sftp.closeOwner(11);
    await rejected(pending, ['SSH_CANCELED', 'SSH_CLOSED', 'SFTP_CLOSED']);
    if (stage === 'subsystem') {
      const late = new f.Sftp();
      callback(null, late);
      assert.equal(late.endCount, 1);
    } else if (stage === 'realpath') {
      f.clients[0].sftps[0].homeCallback(null, '/late');
    } else {
      f.clients[0].emit('ready');
      assert.equal(f.clients[0].sftpCalls.length, 0);
    }
    await flush();
    assert.equal(f.sftp.pending.size, 0);
    assert.equal(f.sftp.conns.size, 0);
  });
}

for (const stage of ['subsystem-error', 'channel-error', 'channel-close', 'connection-error']) {
  test('SFTP initialization ' + stage + ' rejects promptly and clears pending state', async (t) => {
    const error = failure('FIXTURE_SFTP_INIT');
    const f = fixture(t, { homePending: true,
      ...(stage === 'subsystem-error' ? { sftp: (_, callback) => callback(error) } : {}) });
    const pending = observe(f.open());
    await flush();
    if (stage === 'channel-error') f.clients[0].sftps[0].emit('error', error);
    if (stage === 'channel-close') f.clients[0].sftps[0].emit('close');
    if (stage === 'connection-error') f.clients[0].emit('error', error);
    await rejected(pending, stage === 'channel-close' ? 'SFTP_CLOSED' : 'FIXTURE_SFTP_INIT');
    assert.equal(f.sftp.pending.size, 0);
    assert.equal(f.sftp.conns.size, 0);
    assert.ok(f.logs.some(({ level, args }) => level === 'error' && args[0] === 'sftp'));
  });
}

test('SFTP initialization timeout closes transport and ends a late subsystem', async (t) => {
  let callback;
  const f = fixture(t, { sftp: (_, cb) => { callback = cb; } });
  const pending = observe(f.open());
  await flush();
  f.timers.fire(20000);
  await rejected(pending, 'SFTP_TIMEOUT');
  const late = new f.Sftp();
  callback(null, late);
  assert.equal(late.endCount, 1);
});

for (const source of ['channel-error', 'channel-close', 'connection-error']) {
  test('SFTP live ' + source + ' closes the session instead of keeping stale state', async (t) => {
    const f = fixture(t);
    const result = await f.open();
    if (source === 'connection-error') f.clients[0].emit('error', failure('ECONNRESET'));
    else f.clients[0].sftps[0].emit(source === 'channel-error' ? 'error' : 'close', failure('SFTP_CHANNEL'));
    assert.equal(f.sftp.conns.has(result.connId), false);
    assert.equal(f.clients[0].destroyCount, 1);
    assert.throws(() => f.sftp._conn(result.connId), { code: 'NO_CONN' });
  });
}

test('SFTP owner cleanup isolates other owners and destroyAll also closes pending authentication', async (t) => {
  const f = fixture(t);
  const first = await f.open({ ownerId: 11 });
  const second = await f.open({ ownerId: 22 });
  f.sftp.closeOwner(11);
  assert.equal(f.sftp.conns.has(first.connId), false);
  assert.equal(f.sftp.conns.has(second.connId), true);
  assert.equal(f.clients[1].destroyCount, 0);
  const approval = deferred();
  const pending = observe(f.open({ ownerId: 33, verifyHostKey: () => approval.promise }));
  await flush();
  f.sftp.destroyAll();
  await rejected(pending, 'SSH_CANCELED');
  approval.resolve(true);
  await flush();
  assert.equal(f.sftp.conns.size, 0);
  assert.equal(f.clients[2].sftpCalls.length, 0);
});

function memoryFiles(payload) {
  const files = new Map([['/virtual/input.bin', Buffer.from(payload)]]);
  const descriptors = new Map();
  let nextFd = 0;
  const api = {
    statSync(name) { return { size: files.get(name).length, isDirectory: () => false }; },
    openSync(name, mode) {
      if (mode === 'w') files.set(name, Buffer.alloc(0));
      assert.ok(files.has(name));
      descriptors.set(++nextFd, name);
      return nextFd;
    },
    readSync(fd, buffer, offset, length, position) {
      assert.ok(descriptors.has(fd));
      const bytes = files.get(descriptors.get(fd));
      return bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
    },
    writeSync(fd, buffer, offset, length, position) {
      assert.ok(descriptors.has(fd));
      const name = descriptors.get(fd);
      const old = files.get(name);
      const bytes = Buffer.alloc(Math.max(old.length, position + length));
      old.copy(bytes);
      buffer.copy(bytes, position, offset, offset + length);
      files.set(name, bytes);
      return length;
    },
    closeSync(fd) { if (!descriptors.delete(fd)) throw failure('EBADF'); },
  };
  return { api, files, descriptors };
}

for (const charset of ['UTF-8', 'GBK', 'Big5', 'ASCII']) {
  test('SFTP ' + charset + ' uploads and downloads arbitrary multichunk bytes without transcoding', async (t) => {
    const payload = Buffer.alloc(65536 + 513);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const memory = memoryFiles(payload);
    const f = fixture(t, { fs: memory.api, advanced: { charset } });
    const { connId } = await f.open();
    const remote = f.clients[0].sftps[0];
    const writes = [];
    let openHandles = 0;
    remote.mkdir = (_, callback) => callback(null);
    remote.open = (_, mode, callback) => { openHandles++; callback(null, Buffer.from(mode)); };
    remote.close = (_, callback) => { openHandles--; callback(null); };
    remote.write = (_, buffer, offset, length, position, callback) => {
      assert.equal(position, writes.reduce((n, bytes) => n + bytes.length, 0));
      writes.push(Buffer.from(buffer.subarray(offset, offset + length)));
      callback(null);
    };
    remote.stat = (_, callback) => callback(null, { size: payload.length });
    remote.read = (_, buffer, offset, length, position, callback) => {
      const count = payload.copy(buffer, offset, position, Math.min(payload.length, position + length));
      callback(null, count);
    };
    for (const direction of ['upload', 'download']) {
      const { taskId } = await f.sftp[direction]({ connId, remotePath: '/fixture.bin',
        localPath: direction === 'upload' ? '/virtual/input.bin' : '/virtual/output.bin' });
      const task = f.sftp.tasks.get(taskId);
      for (let i = 0; i < 10 && task.status === 'running'; i++) await turn();
      assert.equal(task.status, 'done');
      assert.equal(task.transferred, payload.length);
      assert.equal(openHandles, 0);
      assert.equal(memory.descriptors.size, 0);
    }
    assert.equal(writes.length, 2);
    assert.deepEqual(Buffer.concat(writes), payload);
    assert.deepEqual(memory.files.get('/virtual/output.bin'), payload);
  });
}

function promptsFixture(t) {
  const timers = clock();
  const { SshPrompts } = load('electron/ssh/SshPrompts.js', { crypto }, timers);
  const prompts = new SshPrompts();
  const sender = (id) => ({
    id, destroyed: false, sent: [],
    isDestroyed() { return this.destroyed; },
    send(channel, payload) { this.sent.push({ channel, payload }); },
  });
  const details = (extra = {}) => ({ host: 'fixture.invalid', port: 2222,
    prompts: [{ prompt: 'OTP:', echo: false }], ...extra });
  t.after(() => {
    prompts.destroyAll();
    assert.equal(prompts.pending.size, 0);
    assert.equal(timers.pending.size, 0);
  });
  return { prompts, timers, sender, details };
}

test('prompts replies are owner-isolated, validated, single-use and preserve answer order', async (t) => {
  const f = promptsFixture(t);
  const owner = f.sender(11);
  const pending = f.prompts.request(owner, f.details({ prompts: [
    { prompt: 'Account:', echo: true }, { prompt: 'OTP:', echo: false },
  ] }));
  const { requestId } = owner.sent[0].payload;
  assert.equal(owner.sent[0].channel, 'ssh:auth-prompt');
  assert.equal(f.prompts.reply(22, requestId, {}), false);
  for (const invalid of [undefined, {}, [], ['one'], ['one', 123], ['one', 'a'.repeat(65537)]]) {
    assert.throws(() => f.prompts.reply(11, requestId, invalid), { code: 'SSH_AUTH_RESPONSE' });
    assert.equal(f.prompts.pending.size, 1);
  }
  assert.equal(f.prompts.reply(11, requestId, ['fixture-account', 'synthetic-otp']), true);
  assert.deepEqual(await pending, ['fixture-account', 'synthetic-otp']);
  assert.equal(f.prompts.reply(11, requestId, ['late', 'late']), false);
  assert.deepEqual(owner.sent[1], { channel: 'ssh:auth-cancel', payload: { requestId } });
  assert.equal(f.timers.pending.size, 0);
});

test('prompts validate challenge limits, normalize display fields and accept boundary-sized answers', async (t) => {
  const f = promptsFixture(t);
  const owner = f.sender(11);
  for (const prompts of [null, {}, 'OTP', [null], [{ prompt: 1 }], [{ prompt: 'a'.repeat(4097) }],
    Array.from({ length: 33 }, () => ({ prompt: 'OTP' }))]) {
    await assert.rejects(f.prompts.request(owner, f.details({ prompts })), { code: 'SSH_AUTH_PROMPT' });
  }
  assert.equal(owner.sent.length, 0);
  assert.deepEqual(await f.prompts.request(owner, f.details({ prompts: [] })), []);
  const pending = f.prompts.request(owner, f.details({ name: 'n'.repeat(5000), instructions: 'i'.repeat(5000),
    prompts: Array.from({ length: 32 }, () => ({ prompt: 'p'.repeat(4096), echo: 1 })) }));
  const payload = owner.sent[0].payload;
  assert.equal(payload.name.length, 4096);
  assert.equal(payload.instructions.length, 4096);
  assert.equal(payload.prompts.length, 32);
  assert.ok(payload.prompts.every((prompt) => prompt.echo === true));
  const answers = Array.from({ length: 32 }, () => 'a'.repeat(65536));
  assert.equal(f.prompts.reply(11, payload.requestId, answers), true);
  assert.deepEqual(await pending, answers);
});

test('prompts reject sparse challenge arrays rather than sending missing questions', async (t) => {
  const f = promptsFixture(t);
  const state = observe(f.prompts.request(f.sender(11), f.details({ prompts: new Array(1) })));
  await rejected(state, 'SSH_AUTH_PROMPT');
});

test('prompts reject sparse answer arrays rather than accepting missing responses', (t) => {
  const f = promptsFixture(t);
  const owner = f.sender(11);
  f.prompts.request(owner, f.details());
  assert.throws(() => f.prompts.reply(11, owner.sent[0].payload.requestId, new Array(1)), { code: 'SSH_AUTH_RESPONSE' });
});

test('prompts cancellation and owner cleanup do not settle another owner', async (t) => {
  const f = promptsFixture(t);
  const first = f.sender(11);
  const second = f.sender(22);
  const a = f.prompts.request(first, f.details());
  const b = observe(f.prompts.request(second, f.details()));
  f.prompts.closeOwner(11);
  assert.equal(await a, null);
  await flush();
  assert.equal(b.status, 'pending');
  assert.equal(f.prompts.pending.size, 1);
  assert.equal(f.prompts.reply(22, second.sent[0].payload.requestId, null), true);
  await flush();
  assert.equal(b.value, null);
  assert.equal(f.prompts.pending.size, 0);
});

test('prompts cancel inactive requests, enforce timeout and ignore late replies', async (t) => {
  const f = promptsFixture(t);
  const owner = f.sender(11);
  let active = true;
  const first = f.prompts.request(owner, f.details({ isActive: () => active }));
  const firstId = owner.sent[0].payload.requestId;
  active = false;
  f.timers.fire(250);
  assert.equal(await first, null);
  assert.equal(f.prompts.reply(11, firstId, ['late']), false);
  assert.equal(f.timers.pending.size, 0);
  const second = f.prompts.request(owner, f.details());
  f.timers.fire(120000);
  assert.equal(await second, null);
  assert.equal(f.prompts.pending.size, 0);
});

test('native host confirmation receives cancellation and rejects a late approval', async () => {
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  const declaration = source.match(/function sshRequestContext\(sender\) \{[\s\S]*?\n\}/)[0];
  const pending = deferred();
  let options;
  const requestContext = new vm.Script('(' + declaration + ')').runInNewContext({
    logger: {}, createHostKeyVerifier: ({ confirm }) => confirm,
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
    store: { getSettings: () => ({ lang: 'en' }) },
    dialog: { showMessageBox(parent, supplied) { options = supplied; return pending.promise; } },
  });
  const context = requestContext({ id: 11, isDestroyed: () => false });
  const controller = new AbortController();
  const answer = context.verifyHostKey({
    host: 'fixture.invalid', port: 22, fingerprint: 'fixture', keyType: 'ssh-ed25519', signal: controller.signal,
  });
  assert.equal(options.signal, controller.signal);
  assert.equal(options.cancelId, 0);
  assert.equal(options.defaultId, 0);
  controller.abort();
  pending.resolve({ response: 1 });
  assert.equal(await answer, false);
});

test('prompt abort signals close immediately and release their listeners', async (t) => {
  const { getEventListeners } = require('node:events');
  const f = promptsFixture(t);
  const owner = f.sender(11);
  const controller = new AbortController();
  const pending = f.prompts.request(owner, f.details({ signal: controller.signal, isActive: () => true }));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  assert.equal([...f.timers.pending.values()].filter((timer) => timer.repeat).length, 0);
  controller.abort();
  assert.equal(f.prompts.pending.size, 0);
  assert.equal(await pending, null);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const before = owner.sent.length;
  assert.equal(await f.prompts.request(owner, f.details({ signal: controller.signal })), null);
  assert.equal(owner.sent.length, before);
  const replied = new AbortController();
  const response = f.prompts.request(owner, f.details({ signal: replied.signal }));
  f.prompts.reply(11, owner.sent.at(-1).payload.requestId, ['fixture']);
  await response;
  assert.equal(getEventListeners(replied.signal, 'abort').length, 0);
});

test('prompts suppress destroyed/inactive owners and destroyAll cancels outstanding owners', async (t) => {
  const f = promptsFixture(t);
  const first = f.sender(11);
  const second = f.sender(22);
  first.destroyed = true;
  assert.equal(await f.prompts.request(first, f.details()), null);
  assert.equal(await f.prompts.request(second, f.details({ isActive: () => false })), null);
  assert.equal(first.sent.length + second.sent.length, 0);
  first.destroyed = false;
  const a = f.prompts.request(first, f.details());
  const b = f.prompts.request(second, f.details());
  first.destroyed = true;
  f.prompts.destroyAll();
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent[1].channel, 'ssh:auth-cancel');
});

for (const target of ['terminal', 'sftp']) {
  test(target + ' cancellation invalidates a live authentication dialog and ignores late answers', async (t) => {
    const dialogs = promptsFixture(t);
    const owner = dialogs.sender(11);
    let answersDelivered = 0;
    const f = fixture(t, {
      promptKeyboard: (details) => dialogs.prompts.request(owner, details),
      authenticated(client) {
        client.emit('keyboard-interactive', 'Fixture', 'Enter OTP', '', [{ prompt: 'OTP:', echo: false }], () => {
          answersDelivered++;
          client.emit('ready');
        });
      },
    });
    const pending = observe(target === 'terminal' ? f.connect() : f.open());
    await flush();
    assert.equal(dialogs.prompts.pending.size, 1);
    const requestId = owner.sent[0].payload.requestId;
    assert.equal(owner.sent[0].payload.host, 'target.invalid');
    f[target].closeOwner(11);
    await rejected(pending, 'SSH_CANCELED');
    if (dialogs.prompts.pending.size) dialogs.timers.fire(250);
    await flush();
    assert.equal(dialogs.prompts.pending.size, 0);
    assert.equal(dialogs.prompts.reply(11, requestId, ['late']), false);
    assert.equal(answersDelivered, 0);
    assert.equal(f.clients[0].shellCalls.length + f.clients[0].sftpCalls.length, 0);
  });
}

test('authentication test reports authentication scope only and onConnection ownership is cleaned', async (t) => {
  const f = fixture(t, { advanced: { charset: 'GBK', term: 'ansi', compression: true } });
  const tracked = new Set();
  let notifications = 0;
  const result = await f.probe({ onConnection: (connection) => {
    notifications++;
    tracked.add(connection);
    connection.once('closed', () => tracked.delete(connection));
  } });
  assert.equal(result.ok, true);
  assert.equal(result.auth, 'ok');
  assert.equal(result.scope, 'authentication');
  assert.equal(result.error, undefined);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(notifications, 1);
  assert.equal(tracked.size, 0);
  assert.equal(f.clients[0].shellCalls.length + f.clients[0].sftpCalls.length, 0);
  assert.equal(f.clients[0].destroyCount, 1);
  assert.equal(f.calls[0].advanced, f.asset.methods.ssh.advanced);
});

for (const mode of ['auth-failure', 'owner-cancel', 'callback-failure', 'config-failure']) {
  test('authentication test ' + mode + ' never reports success and cleans onConnection resources', async (t) => {
    if (mode === 'callback-failure' && process.env.NOVOTERMINAL_SSH_CALLBACK_PROBE !== '1') {
      // Isolate an unhandled ready rejection so it fails this regression, not a later test.
      const env = { ...process.env, NOVOTERMINAL_SSH_CALLBACK_PROBE: '1' };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--test',
        '--test-name-pattern=^authentication test callback-failure ', __filename], {
        env, encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.ifError(child.error);
      assert.match(child.stdout, /authentication test callback-failure never reports success/);
      assert.equal(child.status, 0, 'onConnection failure must not leave an unhandled ready rejection:\n' + child.stdout + child.stderr);
      return;
    }
    const f = fixture(t, { authPending: true });
    const tracked = new Set();
    let notified = 0;
    const pending = f.probe({
      ...(mode === 'config-failure' ? { advanced: { charset: 'invalid' } } : {}),
      onConnection(connection) {
        notified++;
        tracked.add(connection);
        connection.once('closed', () => tracked.delete(connection));
        if (mode === 'callback-failure') throw failure('FIXTURE_CALLBACK');
        if (mode === 'owner-cancel') connection.close();
      },
    });
    await flush();
    if (mode === 'auth-failure') f.clients[0].emit('error', failure('SSH_AUTH_FAILED'));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, {
      'auth-failure': 'SSH_AUTH_FAILED', 'owner-cancel': 'SSH_CANCELED',
      'callback-failure': 'FIXTURE_CALLBACK', 'config-failure': 'SSH_CONFIG',
    }[mode]);
    assert.equal(result.auth, undefined);
    assert.equal(result.scope, undefined);
    assert.equal(result.latencyMs, undefined);
    assert.equal(notified, mode === 'config-failure' ? 0 : 1);
    assert.equal(tracked.size, 0);
  });
}
