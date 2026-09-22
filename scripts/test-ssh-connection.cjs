const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const Module = require('node:module');
const { EventEmitter, once } = require('node:events');
const ssh2 = require('ssh2');
const { SSH_DEFAULTS, resolveAdvanced, parseProxyJump, createSshConnection } = require('../electron/ssh/connection');
const { createHostKeyVerifier } = require('../electron/ssh/hostKeys');

const connectionFile = path.resolve(__dirname, '../electron/ssh/connection.js');
const hostPair = ssh2.utils.generateKeyPairSync('ed25519');
const otherPair = ssh2.utils.generateKeyPairSync('ed25519');
const hostKey = ssh2.utils.parseKey(hostPair.private).getPublicSSH();
const otherKey = ssh2.utils.parseKey(otherPair.private).getPublicSSH();
const keyType = 'ssh-ed25519';
const fingerprint = (key) => crypto.createHash('sha256').update(key).digest('base64');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-ssh-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'known_hosts.json') };
}

function details(overrides = {}) {
  return { host: 'fixture.invalid', port: 22, key: hostKey, policy: 'ask', ...overrides };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function logger() {
  const records = [];
  return {
    records,
    info: (...args) => records.push(args),
    warn: (...args) => records.push(args),
    error: (...args) => records.push(args),
  };
}

function fakeConnection(behavior = {}, overrides = {}) {
  const clients = [];
  const channels = [];
  class Channel extends EventEmitter {
    constructor() { super(); this.destroyCount = 0; channels.push(this); }
    destroy() { this.destroyCount++; this.emit('close'); }
  }
  class Client extends EventEmitter {
    constructor() { super(); this.index = clients.length; this.destroyCount = 0; clients.push(this); }
    connect(options) {
      this.options = options;
      if (behavior.connect) return behavior.connect(this);
      queueMicrotask(() => options.hostVerifier(hostKey, (accepted) => {
        if (!accepted) return;
        if (behavior.verified) behavior.verified(this);
        else this.emit('ready');
      }));
    }
    destroy() { this.destroyCount++; this.emit('close'); }
    forwardOut(source, sourcePort, host, port, callback) {
      this.forward = { source, sourcePort, host, port };
      if (behavior.forward) return behavior.forward(this, callback, Channel);
      queueMicrotask(() => callback(null, new Channel()));
    }
  }
  const loaded = new Module(connectionFile, module);
  loaded.filename = connectionFile;
  loaded.paths = module.paths;
  loaded.require = (id) => {
    if (id === 'ssh2') return { ...ssh2, Client };
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
    return require(id);
  };
  loaded._compile(fs.readFileSync(connectionFile, 'utf8'), connectionFile);
  return {
    clients, channels, Channel,
    open: (options = {}) => loaded.exports.createSshConnection({
      host: 'target.invalid', username: 'target-user', password: 'fixture-password',
      verifyHostKey: async () => true, ...options,
    }),
  };
}

async function serverFixture(t, { authenticate, forwards = [], hostPrivateKey = hostPair.private } = {}) {
  const attempts = [];
  const handshakes = [];
  const sockets = new Set();
  const closed = [];
  const server = new ssh2.Server({ hostKeys: [hostPrivateKey] }, (client) => {
    closed.push(new Promise((resolve) => client.once('close', resolve)));
    client.on('error', () => {});
    client.on('handshake', (algorithms) => handshakes.push(algorithms));
    client.on('authentication', (ctx) => {
      attempts.push({ method: ctx.method, username: ctx.username });
      if (authenticate) authenticate(ctx, client);
      else if (ctx.method === 'password' && ctx.password === 'fixture-password') ctx.accept();
      else ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || !forwards.includes(info.destPort)) return reject();
      const socket = net.createConnection({ host: '127.0.0.1', port: info.destPort });
      sockets.add(socket);
      let channel;
      socket.once('connect', () => {
        channel = accept();
        channel.on('error', () => socket.destroy());
        channel.on('close', () => socket.destroy());
        socket.pipe(channel).pipe(socket);
      });
      socket.on('error', () => { if (channel) channel.destroy(); else reject(); });
      socket.on('close', () => { sockets.delete(socket); if (channel) channel.destroy(); });
    });
  });
  server._srv.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, attempts, handshakes, closed };
}

function localConnection(t, server, options = {}) {
  const connection = createSshConnection({
    host: '127.0.0.1', port: server.port, username: 'target-user', password: 'fixture-password',
    verifyHostKey: async () => true, ...options,
  });
  t.after(() => connection.close());
  return connection;
}

test('advanced defaults, enum validation, strict booleans and passphrase whitespace', () => {
  assert.equal(Object.keys(SSH_DEFAULTS).length, 11);
  assert.deepEqual(resolveAdvanced(), SSH_DEFAULTS);
  assert.deepEqual(resolveAdvanced(null), SSH_DEFAULTS);
  assert.equal(resolveAdvanced({ keepAlive: ' 0 ' }).keepAlive, 0);
  assert.equal(resolveAdvanced({ keepAlive: 3600 }).keepAlive, 3600);
  assert.equal(resolveAdvanced({ keepAlive: '', term: ' ' }).term, 'xterm-256color');
  assert.equal(resolveAdvanced({ privateKeyPassphrase: '  fixture secret  ' }).privateKeyPassphrase, '  fixture secret  ');
  assert.equal(resolveAdvanced({ privateKeyPath: ' ~/fixture.pem ' }).privateKeyPath, '~/fixture.pem');
  assert.equal(resolveAdvanced({ x11Display: ' localhost:0.0 ' }).x11Display, 'localhost:0.0');
  assert.equal(resolveAdvanced({ x11Forward: true, compression: true }).compression, true);
  assert.equal(resolveAdvanced(Object.create({ compression: true })).compression, false);
  for (const charset of ['UTF-8', 'GBK', 'GB2312', 'Big5', 'ISO-8859-1', 'ASCII']) {
    assert.equal(resolveAdvanced({ charset }).charset, charset);
  }
  for (const term of ['xterm-256color', 'xterm', 'vt100', 'linux', 'ansi']) {
    assert.equal(resolveAdvanced({ term }).term, term);
  }
  for (const saved of [[], 'ssh', { charset: 'utf-8' }, { term: 'screen' }, { authType: 'agent' },
    { hostKeyPolicy: 'off' }, { authType: 'publickey' }, { privateKeyPassphrase: 123 },
    { keepAlive: Infinity }, { keepAlive: NaN }, { keepAlive: -1 }, { keepAlive: 3601 },
    { keepAlive: 1.5 }, { keepAlive: true }, { keepAlive: [] }, { keepAlive: '1e2' },
    { compression: 'false' }, { x11Forward: 1 }, { compression: '' }, { privateKeyPath: 'a\0b' }]) {
    assert.throws(() => resolveAdvanced(saved), { code: 'SSH_CONFIG' });
  }
  assert.equal(resolveAdvanced({ authType: 'publickey', privateKeyPath: 'fixture.pem' }).authType, 'publickey');
});

test('ProxyJump accepts hostnames, bracketed IPv6, URI usernames and multiple hops', () => {
  assert.deepEqual(parseProxyJump(' '), []);
  assert.deepEqual(parseProxyJump('jump.invalid'), [{ host: 'jump.invalid', port: 22, username: '' }]);
  assert.deepEqual(parseProxyJump(' alice@jump.invalid:2222, [::1], ssh://b%6fb@[2001:db8::1]:65535 '), [
    { host: 'jump.invalid', port: 2222, username: 'alice' },
    { host: '::1', port: 22, username: '' },
    { host: '2001:db8::1', port: 65535, username: 'bob' },
  ]);
});

test('ProxyJump rejects malformed nonempty values instead of silently connecting directly', () => {
  for (const value of [true, 123, {}, ',', 'a,', ',a', 'a,,b', '@host', 'user@@host', 'user@',
    'host:0', 'host:65536', 'host:-1', 'host:22.5', 'host:', '::1', '[127.0.0.1]', '[::1]x',
    '[not-ipv6]', 'ssh://host/', 'ssh://host/path', 'ssh://host?x', 'ssh://host#x', 'ssh://host?',
    'http://host', 'ssh://user:password@host', 'ssh://user%3Apassword@host', 'ssh://%zz@host',
    'ssh://%0A@host', 'ssh://host%2fpath', 'a b', 'host\nother', 'host;command', 'host\\path']) {
    assert.throws(() => parseProxyJump(value), { code: 'SSH_CONFIG' }, String(value));
  }
  const fake = fakeConnection();
  assert.throws(() => fake.open({ advanced: { proxyJump: 'broken:' } }), { code: 'SSH_CONFIG' });
  assert.equal(fake.clients.length, 0);
});

test('host keys: strict unknown, missing ask handler and rejected confirmation never persist', async (t) => {
  const { file } = temporary(t);
  const verify = createHostKeyVerifier({ file });
  await assert.rejects(verify(details({ policy: 'strict' })), { code: 'SSH_HOST_KEY_UNKNOWN' });
  await assert.rejects(verify(details()), { code: 'SSH_HOST_KEY_CONFIRM_REQUIRED' });
  for (const response of [false, null, undefined, 'true', 1]) {
    const reject = createHostKeyVerifier({ file, confirm: async () => response });
    await assert.rejects(reject(details()), { code: 'SSH_HOST_KEY_REJECTED' });
  }
  assert.equal(fs.existsSync(file), false);
});

test('host keys: ask awaits exact confirmation, saves legacy format and known strict works', async (t) => {
  const { file } = temporary(t);
  const pending = deferred();
  const log = logger();
  const { signal } = new AbortController();
  const verify = createHostKeyVerifier({ file, log, confirm: async (info) => {
    assert.deepEqual(info, { host: 'fixture.invalid', port: 22, fingerprint: fingerprint(hostKey), keyType, signal });
    return pending.promise;
  } });
  const result = verify(details({ signal }));
  await flush();
  assert.equal(fs.existsSync(file), false);
  pending.resolve(true);
  assert.equal(await result, true);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(stored), ['fixture.invalid:22']);
  assert.equal(stored['fixture.invalid:22'].fp, fingerprint(hostKey));
  assert.equal(stored['fixture.invalid:22'].type, keyType);
  assert.equal(typeof stored['fixture.invalid:22'].savedAt, 'number');
  assert.equal(await verify(details({ policy: 'strict' })), true);
  assert.equal(log.records[0][2].keyType, keyType);
  assert.equal('type' in log.records[0][2], false);
  assert.equal(JSON.stringify(log.records).includes(hostPair.private), false);
});

test('host keys: accept-new and old records work, every policy rejects changed keys', async (t) => {
  const { file } = temporary(t);
  const verify = createHostKeyVerifier({ file, confirm: () => { throw new Error('Must not confirm changed keys'); } });
  await verify(details({ policy: 'accept-new' }));
  const original = fs.readFileSync(file, 'utf8');
  for (const policy of ['ask', 'strict', 'accept-new']) {
    assert.equal(await verify(details({ policy })), true);
    await assert.rejects(verify(details({ policy, key: otherKey })), { code: 'SSH_HOST_KEY_MISMATCH' });
  }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, JSON.stringify({ 'fixture.invalid:22': { fp: fingerprint(hostKey), type: 'unknown', savedAt: 1 } }));
  assert.equal(await verify(details({ policy: 'strict' })), true);
});

test('host keys: cancellation during confirmation cannot add trust', async (t) => {
  const { file } = temporary(t);
  const pending = deferred();
  let active = true;
  const verify = createHostKeyVerifier({ file, confirm: () => pending.promise });
  const result = verify(details({ isActive: () => active }));
  active = false;
  pending.resolve(true);
  await assert.rejects(result, { code: 'SSH_CANCELED' });
  await assert.rejects(verify(details({ policy: 'accept-new', isActive: () => false })), { code: 'SSH_CANCELED' });
  assert.equal(fs.existsSync(file), false);
});

test('host keys: signal-only cancellation prevents late acceptance and cancels an abort-aware confirm', async (t) => {
  const { file, directory } = temporary(t);
  for (const honorsAbort of [false, true]) {
    const controller = new AbortController();
    const pending = deferred();
    const failure = Object.assign(new Error('Fixture confirmation aborted'), { name: 'AbortError' });
    let canceled = false;
    const verify = createHostKeyVerifier({ file, confirm: ({ signal }) => {
      assert.equal(signal, controller.signal);
      signal.addEventListener('abort', () => {
        canceled = true;
        if (honorsAbort) pending.reject(failure);
      }, { once: true });
      return pending.promise;
    } });
    const result = verify(details({ signal: controller.signal }));
    const rejected = assert.rejects(result, honorsAbort ? (error) => error === failure : { code: 'SSH_CANCELED' });
    controller.abort();
    assert.equal(canceled, true);
    pending.resolve(true);
    await rejected;
    await assert.rejects(verify(details({ policy: 'accept-new', signal: controller.signal })), { code: 'SSH_CANCELED' });
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('host keys: signal cancellation before rename leaves trust and temporary files unchanged', async (t) => {
  const { file, directory } = temporary(t);
  fs.writeFileSync(file, '{}');
  const controller = new AbortController();
  const original = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (...args) => { original(...args); controller.abort(); });
  await assert.rejects(createHostKeyVerifier({ file })(details({ policy: 'accept-new', signal: controller.signal })), { code: 'SSH_CANCELED' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(directory), ['known_hosts.json']);
});

test('host keys: concurrent confirmations merge and a concurrent key change fails closed', async (t) => {
  const { file, directory } = temporary(t);
  const a = deferred();
  const b = deferred();
  const verifyA = createHostKeyVerifier({ file, confirm: () => a.promise });
  const verifyB = createHostKeyVerifier({ file, confirm: () => b.promise });
  const first = verifyA(details({ host: 'a.invalid' }));
  const second = verifyB(details({ host: 'b.invalid' }));
  b.resolve(true);
  await second;
  a.resolve(true);
  await first;
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length, 2);
  const pending = deferred();
  const waiting = createHostKeyVerifier({ file, confirm: () => pending.promise })(details({ host: 'race.invalid' }));
  await createHostKeyVerifier({ file })(details({ host: 'race.invalid', key: otherKey, policy: 'accept-new' }));
  pending.resolve(true);
  await assert.rejects(waiting, { code: 'SSH_HOST_KEY_MISMATCH' });
  assert.deepEqual(fs.readdirSync(directory), ['known_hosts.json']);
});

test('host keys: corrupt files and read/write errors reject without replacing trust', async (t) => {
  const { file, directory } = temporary(t);
  const verify = createHostKeyVerifier({ file });
  for (const value of ['', '{', 'null', '[]', '{"host:22":{"fp":"invalid"}}']) {
    fs.writeFileSync(file, value);
    await assert.rejects(verify(details({ policy: 'accept-new' })), { code: 'SSH_HOST_KEY_READ' });
    assert.equal(fs.readFileSync(file, 'utf8'), value);
  }
  await assert.rejects(createHostKeyVerifier({ file: directory })(details({ policy: 'accept-new' })), { code: 'SSH_HOST_KEY_READ' });
  fs.writeFileSync(file, '{}');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('fixture write failure'), { code: 'EACCES' }); });
  await assert.rejects(verify(details({ policy: 'accept-new' })), { code: 'SSH_HOST_KEY_WRITE' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(directory), ['known_hosts.json']);
});

test('host keys: cancellation at atomic rename leaves file unchanged and removes temporary file', async (t) => {
  const { file, directory } = temporary(t);
  fs.writeFileSync(file, '{}');
  let active = true;
  const original = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (...args) => { original(...args); active = false; });
  await assert.rejects(createHostKeyVerifier({ file })(details({ policy: 'accept-new', isActive: () => active })), { code: 'SSH_CANCELED' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(directory), ['known_hosts.json']);
});

test('fake chain: all hosts verified, independent usernames, compression, auth and keepalive uniform', async () => {
  const fake = fakeConnection();
  const verified = [];
  const log = logger();
  const connection = fake.open({ advanced: { proxyJump: 'one@first.invalid,ssh://two@[::1]:2200', compression: true, keepAlive: 0 },
    log, verifyHostKey: async (info) => { verified.push(info); return true; } });
  assert.ok(connection instanceof EventEmitter);
  const target = await connection.ready;
  assert.equal(target, fake.clients[2]);
  assert.deepEqual(verified.map(({ host, port, policy }) => ({ host, port, policy })), [
    { host: 'first.invalid', port: 22, policy: 'ask' },
    { host: '::1', port: 2200, policy: 'ask' },
    { host: 'target.invalid', port: 22, policy: 'ask' },
  ]);
  assert.deepEqual(fake.clients.map((client) => client.options.username), ['one', 'two', 'target-user']);
  for (const client of fake.clients) {
    assert.deepEqual(client.options.algorithms.compress, ['zlib@openssh.com', 'zlib', 'none']);
    assert.equal(client.options.keepaliveInterval, 0);
    assert.equal(client.options.keepaliveCountMax, 3);
    assert.equal(client.options.compress, undefined);
    assert.deepEqual(client.options.authHandler, ['password', 'keyboard-interactive']);
    assert.equal(client.options.tryKeyboard, true);
  }
  assert.equal(fake.clients[1].options.sock, fake.channels[0]);
  assert.equal(fake.clients[2].options.sock, fake.channels[1]);
  assert.equal(fake.clients[1].forward.host, 'target.invalid');
  const closed = [];
  connection.on('closed', (error) => closed.push(error));
  connection.close();
  connection.close();
  assert.deepEqual(closed, [null]);
  assert.ok(fake.clients.every((client) => client.destroyCount === 1));
  assert.ok(fake.channels.every((channel) => channel.destroyCount === 1));
  assert.ok(verified.every((info) => info.isActive() === false));
  assert.ok(verified.every((info) => info.signal === verified[0].signal && info.signal.aborted));
  assert.equal(JSON.stringify(log.records).includes('fixture-password'), false);
});

test('fake password auth ignores unreadable irrelevant private key and keeps default compression off', async () => {
  const fake = fakeConnection({}, { fs: { promises: { readFile: () => { throw new Error('Must not read'); } } } });
  const connection = fake.open({ advanced: { privateKeyPath: '~/does-not-exist.pem', privateKeyPassphrase: 'ignored' } });
  const client = await connection.ready;
  assert.deepEqual(client.options.algorithms.compress, ['none']);
  assert.equal(client.options.keepaliveInterval, 30000);
  assert.equal(client.options.privateKey, undefined);
  assert.equal(client.options.passphrase, undefined);
  connection.close();
});

test('fake public key auth expands home and passes an encrypted key passphrase to every hop', async (t) => {
  const { directory } = temporary(t);
  const passphrase = '  fixture passphrase  ';
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encrypted = pair.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  fs.writeFileSync(path.join(directory, 'encrypted.pem'), encrypted);
  const fake = fakeConnection({}, { os: { homedir: () => directory } });
  const connection = fake.open({ advanced: { authType: 'publickey', privateKeyPath: '~/encrypted.pem',
    privateKeyPassphrase: passphrase, proxyJump: 'jump.invalid' } });
  await connection.ready;
  for (const client of fake.clients) {
    assert.equal(client.options.privateKey.toString(), encrypted);
    assert.equal(client.options.passphrase, passphrase);
    assert.deepEqual(client.options.authHandler, ['publickey']);
    assert.equal(client.options.password, undefined);
  }
  connection.close();
  const invalid = fake.open({ advanced: { authType: 'publickey', privateKeyPath: '~/encrypted.pem', privateKeyPassphrase: 'wrong' } });
  await assert.rejects(invalid.ready, { code: 'SSH_KEY_PARSE' });
  assert.equal(fake.clients.length, 2);
  const missing = fake.open({ advanced: { authType: 'publickey', privateKeyPath: '~/missing.pem' } });
  await assert.rejects(missing.ready, { code: 'SSH_KEY_READ' });
});

test('close before initialization rejects ready once and does not create a Client', async () => {
  const fake = fakeConnection();
  const connection = fake.open();
  const closed = [];
  connection.on('closed', (error) => closed.push(error));
  const rejected = assert.rejects(connection.ready, { code: 'SSH_CANCELED' });
  connection.close();
  connection.close();
  await rejected;
  await flush();
  assert.equal(fake.clients.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 'SSH_CANCELED');
});

test('close during private key read cannot start a late client', async () => {
  const pending = deferred();
  const fake = fakeConnection({}, { fs: { promises: { readFile: () => pending.promise } } });
  const connection = fake.open({ advanced: { authType: 'publickey', privateKeyPath: 'fixture.pem' } });
  await flush();
  const rejected = assert.rejects(connection.ready, { code: 'SSH_CANCELED' });
  connection.close();
  pending.resolve(Buffer.from(hostPair.private));
  await rejected;
  await flush();
  assert.equal(fake.clients.length, 0);
});

test('close during host confirmation destroys handshake Client and late approval cannot persist', async (t) => {
  const { file } = temporary(t);
  const pending = deferred();
  const fake = fakeConnection();
  let signal;
  let abortCount = 0;
  const connection = fake.open({ verifyHostKey: createHostKeyVerifier({ file, confirm: (info) => {
    signal = info.signal;
    signal.addEventListener('abort', () => { abortCount++; }, { once: true });
    return pending.promise;
  } }) });
  await flush();
  assert.equal(signal.aborted, false);
  const rejected = assert.rejects(connection.ready, { code: 'SSH_CANCELED' });
  connection.close();
  connection.close();
  assert.equal(signal.aborted, true);
  assert.equal(abortCount, 1);
  pending.resolve(true);
  await rejected;
  await flush();
  assert.equal(fake.clients[0].destroyCount, 1);
  assert.equal(fs.existsSync(file), false);
});

test('a security error at any hop keeps its code, stops the chain and notifies closed exactly once', async () => {
  for (let rejectedIndex = 0; rejectedIndex < 3; rejectedIndex++) {
    const fake = fakeConnection();
    let index = 0;
    const failure = Object.assign(new Error('Fixture host changed'), { code: 'SSH_HOST_KEY_MISMATCH' });
    const connection = fake.open({ advanced: { proxyJump: 'first.invalid,second.invalid' }, verifyHostKey: async () => {
      if (index++ === rejectedIndex) throw failure;
      return true;
    } });
    const closed = [];
    connection.on('closed', (error) => closed.push(error));
    await assert.rejects(connection.ready, (error) => error === failure);
    assert.equal(fake.clients.length, rejectedIndex + 1);
    assert.deepEqual(closed, [failure]);
    assert.ok(fake.clients.every((client) => client.destroyCount === 1));
    assert.ok(fake.channels.every((channel) => channel.destroyCount === 1));
  }
  const fake = fakeConnection();
  const connection = fake.open({ verifyHostKey: async () => false });
  await assert.rejects(connection.ready, { code: 'SSH_HOST_KEY_REJECTED' });
});

test('late forwarding channel is destroyed without opening another Client', async () => {
  let complete;
  const fake = fakeConnection({ forward: (client, callback) => { complete = callback; } });
  const connection = fake.open({ advanced: { proxyJump: 'jump.invalid' } });
  await flush();
  const rejected = assert.rejects(connection.ready, { code: 'SSH_CANCELED' });
  connection.close();
  complete(null, new fake.Channel());
  await rejected;
  assert.equal(fake.channels[0].destroyCount, 1);
  assert.equal(fake.clients.length, 1);
});

test('next-hop handshake close, synchronous connect failure and forward error release all resources', async () => {
  const fake = fakeConnection({ verified: (client) => { if (!client.index) client.emit('ready'); } });
  const connection = fake.open({ advanced: { proxyJump: 'jump.invalid' } });
  await flush();
  assert.equal(fake.clients.length, 2);
  const rejected = assert.rejects(connection.ready, { code: 'SSH_CANCELED' });
  connection.close();
  await rejected;
  assert.ok(fake.clients.every((client) => client.destroyCount === 1));
  assert.equal(fake.channels[0].destroyCount, 1);
  const broken = fakeConnection({ connect: () => { throw Object.assign(new Error('Fixture connect failure'), { code: 'ECONNRESET' }); } });
  const failed = broken.open();
  await assert.rejects(failed.ready, { code: 'ECONNRESET' });
  assert.equal(broken.clients[0].destroyCount, 1);
  const forward = fakeConnection({ forward: (client, callback, Channel) => callback(Object.assign(new Error('Denied'), { code: 'FORWARD_DENIED' }), new Channel()) });
  const denied = forward.open({ advanced: { proxyJump: 'jump.invalid' } });
  await assert.rejects(denied.ready, { code: 'FORWARD_DENIED' });
  assert.equal(forward.channels[0].destroyCount, 1);
  assert.equal(forward.clients.length, 1);
});

test('runtime errors on target, jump and forwarding channel notify closed without emitting error', async () => {
  for (const source of ['target', 'jump', 'channel']) {
    const fake = fakeConnection();
    const connection = fake.open({ advanced: { proxyJump: 'jump.invalid' } });
    const target = await connection.ready;
    const closed = [];
    connection.on('closed', (error) => closed.push(error));
    const failure = Object.assign(new Error('Fixture runtime disconnect'), { code: 'ECONNRESET' });
    const emitter = source === 'target' ? target : source === 'jump' ? fake.clients[0] : fake.channels[0];
    emitter.emit('error', failure);
    emitter.emit('error', failure);
    connection.close();
    assert.deepEqual(closed, [failure]);
    assert.ok(fake.clients.every((client) => client.destroyCount === 1));
    assert.ok(fake.channels.every((channel) => channel.destroyCount === 1));
  }
});

test('remote end before ready rejects; remote close after ready reports a normal close', async () => {
  const fake = fakeConnection({ connect: (client) => queueMicrotask(() => client.emit('end')) });
  await assert.rejects(fake.open().ready, { code: 'SSH_ENDED' });
  const normal = fakeConnection();
  const connection = normal.open();
  const target = await connection.ready;
  const closed = once(connection, 'closed');
  target.emit('close');
  assert.deepEqual(await closed, [null]);
});

test('handshake and forward deadlines reject and clean up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const behavior of [{ connect: () => {} }, { forward: () => {} }]) {
    const fake = fakeConnection(behavior);
    const connection = fake.open({ readyTimeout: 20, advanced: { proxyJump: 'jump.invalid' } });
    const rejected = assert.rejects(connection.ready, { code: 'SSH_TIMEOUT' });
    await flush();
    t.mock.timers.tick(21);
    await rejected;
    assert.ok(fake.clients.every((client) => client.destroyCount === 1));
  }
});

test('rekey verification cannot remove the pending forwarding deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = fakeConnection({ forward: () => {} });
  const connection = fake.open({ readyTimeout: 20, advanced: { proxyJump: 'jump.invalid' } });
  const rejected = assert.rejects(connection.ready, { code: 'SSH_TIMEOUT' });
  await flush();
  fake.clients[0].options.hostVerifier(hostKey, () => {});
  await flush();
  t.mock.timers.tick(21);
  await rejected;
  assert.equal(fake.clients.length, 1);
  assert.equal(fake.clients[0].destroyCount, 1);
});

test('host confirmation has a bounded UI deadline and late timeout approval cannot persist', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { file } = temporary(t);
  const pending = deferred();
  const fake = fakeConnection();
  let signal;
  let aborted = false;
  const connection = fake.open({ readyTimeout: 20,
    verifyHostKey: createHostKeyVerifier({ file, confirm: (info) => {
      signal = info.signal;
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return pending.promise;
    } }) });
  const rejected = assert.rejects(connection.ready, { code: 'SSH_INTERACTION_TIMEOUT' });
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(fake.clients[0].destroyCount, 0);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(119001);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(aborted, true);
  pending.resolve(true);
  await flush();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fake.clients[0].destroyCount, 1);
});

test('runtime rekey rejection preserves the security code and closes an authenticated client', async () => {
  const fake = fakeConnection();
  let verified = false;
  const failure = Object.assign(new Error('Fixture changed key'), { code: 'SSH_HOST_KEY_MISMATCH' });
  const connection = fake.open({ verifyHostKey: async () => {
    if (verified) throw failure;
    verified = true;
    return true;
  } });
  const client = await connection.ready;
  const closed = once(connection, 'closed');
  let accepted = false;
  client.options.hostVerifier(otherKey, () => { accepted = true; });
  assert.deepEqual(await closed, [failure]);
  assert.equal(accepted, false);
  assert.equal(client.destroyCount, 1);
});

test('keyboard prompts pause handshake timeout, retain a finite 120s budget and validate answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = deferred();
  const prompts = [{ prompt: 'Password:', echo: false }, { prompt: 'OTP:', echo: false }];
  let answers;
  const fake = fakeConnection({ verified: (client) => client.emit('keyboard-interactive', 'Fixture', 'Enter credentials', '', prompts, (value) => {
    answers = value;
    client.emit('ready');
  }) });
  let isActive;
  const connection = fake.open({ readyTimeout: 20, promptKeyboard: async (info) => {
    isActive = info.isActive;
    assert.equal(isActive(), true);
    assert.ok(info.signal instanceof AbortSignal);
    assert.equal(info.signal.aborted, false);
    assert.deepEqual({ ...info, isActive: undefined, signal: undefined }, {
      name: 'Fixture', instructions: 'Enter credentials', prompts,
      host: 'target.invalid', port: 22, isActive: undefined, signal: undefined,
    });
    return pending.promise;
  } });
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(fake.clients[0].destroyCount, 0);
  pending.resolve(['fixture-password', '654321']);
  await connection.ready;
  assert.deepEqual(answers, ['fixture-password', '654321']);
  connection.close();
  assert.equal(isActive(), false);
  const hanging = fake.open({ readyTimeout: 20, promptKeyboard: () => new Promise(() => {}) });
  const rejected = assert.rejects(hanging.ready, { code: 'SSH_INTERACTION_TIMEOUT' });
  await flush();
  t.mock.timers.tick(120001);
  await rejected;
});

test('nested host verification and OTP keep the original UI deadline in either completion order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const first of ['host-key', 'keyboard']) {
    const pending = { 'host-key': deferred(), keyboard: deferred() };
    const info = {};
    const completed = [];
    const aborted = [];
    const action = (kind) => (request) => {
      info[kind] = request;
      request.signal.addEventListener('abort', () => aborted.push([kind, request.isActive()]), { once: true });
      return pending[kind].promise;
    };
    const fake = fakeConnection({ connect: () => {} });
    const connection = fake.open({ readyTimeout: 20,
      verifyHostKey: action('host-key'), promptKeyboard: action('keyboard') });
    const rejected = assert.rejects(connection.ready, { code: 'SSH_INTERACTION_TIMEOUT' });
    const closed = [];
    connection.on('closed', (error) => closed.push(error));
    await flush();
    const client = fake.clients[0];
    client.emit('keyboard-interactive', '', '', '', [{ prompt: 'OTP:', echo: false }], () => completed.push('keyboard'));
    t.mock.timers.tick(30000);
    client.options.hostVerifier(hostKey, () => completed.push('host-key'));
    assert.equal(info['host-key'].signal, info.keyboard.signal);
    t.mock.timers.tick(20000);
    pending[first].resolve(first === 'host-key' ? true : ['654321']);
    await flush();
    assert.deepEqual(completed, [first]);
    t.mock.timers.tick(69999);
    assert.equal(client.destroyCount, 0);
    assert.equal(info.keyboard.signal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.deepEqual(aborted, [['keyboard', false], ['host-key', false]]);
    pending['host-key'].resolve(true);
    pending.keyboard.resolve(['654321']);
    await flush();
    t.mock.timers.tick(120000);
    assert.deepEqual(completed, [first]);
    assert.equal(closed.length, 1);
    assert.equal(client.destroyCount, 1);
  }
});

test('nested interactions charge elapsed UI time once and resume only the remaining handshake time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const deadline of ['handshake', 'UI']) {
    let keyboard = deferred();
    const host = deferred();
    const fake = fakeConnection({ connect: () => {} });
    const connection = fake.open({ readyTimeout: 20,
      verifyHostKey: () => host.promise, promptKeyboard: () => keyboard.promise });
    const rejected = assert.rejects(connection.ready, { code: deadline === 'UI' ? 'SSH_INTERACTION_TIMEOUT' : 'SSH_TIMEOUT' });
    await flush();
    const client = fake.clients[0];
    const prompt = () => client.emit('keyboard-interactive', '', '', '', [{ prompt: 'OTP:', echo: false }], () => {});
    t.mock.timers.tick(5);
    prompt();
    t.mock.timers.tick(10000);
    client.options.hostVerifier(hostKey, () => {});
    t.mock.timers.tick(10000);
    keyboard.resolve(['654321']);
    await flush();
    t.mock.timers.tick(10000);
    assert.equal(client.destroyCount, 0);
    host.resolve(true);
    await flush();
    if (deadline === 'handshake') {
      t.mock.timers.tick(14);
    } else {
      t.mock.timers.tick(5);
      keyboard = deferred();
      prompt();
      t.mock.timers.tick(89999);
    }
    assert.equal(client.destroyCount, 0);
    t.mock.timers.tick(1);
    await rejected;
    keyboard.resolve(['654321']);
    await flush();
    assert.equal(client.destroyCount, 1);
  }
});

test('overlapping requests of the same kind reject without invoking a second UI action', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const kind of ['keyboard', 'host-key']) {
    const pending = deferred();
    let called = 0;
    let completed = 0;
    let signal;
    const action = (info) => { called++; signal = info.signal; return pending.promise; };
    const fake = fakeConnection({ connect: () => {} });
    const connection = fake.open({ promptKeyboard: action, verifyHostKey: action });
    const rejected = assert.rejects(connection.ready, { code: 'SSH_INTERACTION' });
    await flush();
    const client = fake.clients[0];
    const request = kind === 'keyboard'
      ? () => client.emit('keyboard-interactive', '', '', '', [{ prompt: 'OTP:', echo: false }], () => { completed++; })
      : () => client.options.hostVerifier(hostKey, () => { completed++; });
    request();
    request();
    await rejected;
    assert.equal(called, 1);
    assert.equal(signal.aborted, true);
    pending.resolve(kind === 'keyboard' ? ['654321'] : true);
    await flush();
    t.mock.timers.tick(120000);
    assert.equal(completed, 0);
    assert.equal(client.destroyCount, 1);
  }
});

test('nested rekey security failure aborts the pending OTP without replacing the original error', async () => {
  const pending = deferred();
  const failure = Object.assign(new Error('Fixture changed key'), { code: 'SSH_HOST_KEY_MISMATCH' });
  let info;
  let activeAtAbort;
  let completed = false;
  const fake = fakeConnection({ verified: (client) => {
    client.emit('keyboard-interactive', '', '', '', [{ prompt: 'OTP:', echo: false }], () => { completed = true; });
  } });
  const connection = fake.open({
    verifyHostKey: async ({ key }) => { if (key === otherKey) throw failure; return true; },
    promptKeyboard: (request) => {
      info = request;
      request.signal.addEventListener('abort', () => {
        activeAtAbort = request.isActive();
        pending.resolve(null);
      }, { once: true });
      return pending.promise;
    },
  });
  const rejected = assert.rejects(connection.ready, (error) => error === failure);
  await flush();
  fake.clients[0].options.hostVerifier(otherKey, () => { completed = true; });
  await rejected;
  await flush();
  assert.equal(info.signal.aborted, true);
  assert.equal(activeAtAbort, false);
  assert.equal(completed, false);
  assert.equal(fake.clients[0].destroyCount, 1);
});

test('keyboard rejection, missing handler, invalid replies and late replies never fill OTP with asset password', async () => {
  const prompts = [{ prompt: 'OTP:', echo: false }];
  for (const [promptKeyboard, code] of [[undefined, 'SSH_KEYBOARD_REQUIRED'], [async () => null, 'SSH_CANCELED'],
    [async () => [], 'SSH_KEYBOARD_RESPONSE'], [async () => [123], 'SSH_KEYBOARD_RESPONSE']]) {
    let finished = false;
    const fake = fakeConnection({ verified: (client) => client.emit('keyboard-interactive', '', '', '', prompts, () => { finished = true; }) });
    const connection = fake.open({ promptKeyboard });
    await assert.rejects(connection.ready, { code });
    assert.equal(finished, false);
  }
  const pending = deferred();
  let finished = false;
  let signal;
  let activeAtAbort;
  const fake = fakeConnection({ verified: (client) => client.emit('keyboard-interactive', '', '', '', prompts, () => { finished = true; }) });
  const connection = fake.open({ promptKeyboard: (info) => {
    signal = info.signal;
    signal.addEventListener('abort', () => { activeAtAbort = info.isActive(); }, { once: true });
    return pending.promise;
  } });
  await flush();
  assert.equal(signal.aborted, false);
  const rejected = assert.rejects(connection.ready, { code: 'SSH_CANCELED' });
  connection.close();
  assert.equal(signal.aborted, true);
  assert.equal(activeAtAbort, false);
  pending.resolve(['654321']);
  await rejected;
  await flush();
  assert.equal(finished, false);
});

test('local ssh2 Server negotiates enabled/disabled compression and authenticates by password only', { timeout: 15000 }, async (t) => {
  for (const compression of [false, true]) {
    const server = await serverFixture(t);
    const connection = localConnection(t, server, { advanced: { compression, privateKeyPath: '~/irrelevant.pem' } });
    await connection.ready;
    assert.deepEqual(server.attempts, [{ method: 'password', username: 'target-user' }]);
    assert.equal(server.handshakes[0].cs.compress, compression ? 'zlib@openssh.com' : 'none');
    assert.equal(server.handshakes[0].sc.compress, compression ? 'zlib@openssh.com' : 'none');
    connection.close();
    await Promise.all(server.closed);
  }
});

test('local ssh2 Server authenticates encrypted private keys without password fallback', { timeout: 15000 }, async (t) => {
  const { directory } = temporary(t);
  const passphrase = ' fixture encrypted passphrase ';
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  const publicKey = ssh2.utils.parseKey(privateKey, passphrase);
  const keyFile = path.join(directory, 'encrypted.pem');
  fs.writeFileSync(keyFile, privateKey);
  const server = await serverFixture(t, { authenticate: (ctx) => {
    if (ctx.method !== 'publickey' || !ctx.key.data.equals(publicKey.getPublicSSH())) return ctx.reject(['publickey']);
    if (ctx.signature && publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
    ctx.accept();
  } });
  const connection = localConnection(t, server, { advanced: { authType: 'publickey', privateKeyPath: keyFile, privateKeyPassphrase: passphrase } });
  await connection.ready;
  assert.ok(server.attempts.length >= 1);
  assert.ok(server.attempts.every(({ method }) => method === 'publickey'));
  connection.close();
  await Promise.all(server.closed);
  const rejecting = await serverFixture(t, { authenticate: (ctx) => {
    if (ctx.method === 'password') return ctx.accept();
    ctx.reject(['password', 'publickey']);
  } });
  const failed = localConnection(t, rejecting, { advanced: { authType: 'publickey', privateKeyPath: keyFile, privateKeyPassphrase: passphrase } });
  await assert.rejects(failed.ready, { code: 'SSH_AUTH_FAILED' });
  assert.ok(rejecting.attempts.every(({ method }) => method === 'publickey'));
});

test('local ssh2 Server keyboard-interactive requires explicit independent OTP answers', { timeout: 15000 }, async (t) => {
  let received;
  const server = await serverFixture(t, { authenticate: (ctx) => {
    if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
    ctx.prompt([{ prompt: 'Password:', echo: false }, { prompt: 'OTP:', echo: false }], (answers) => {
      received = answers;
      if (answers[0] === 'fixture-password' && answers[1] === '654321') ctx.accept();
      else ctx.reject(['keyboard-interactive']);
    });
  } });
  const connection = localConnection(t, server, { promptKeyboard: async ({ prompts }) => {
    assert.equal(prompts.length, 2);
    return ['fixture-password', '654321'];
  } });
  await connection.ready;
  assert.deepEqual(received, ['fixture-password', '654321']);
  assert.deepEqual(server.attempts.map(({ method }) => method), ['password', 'keyboard-interactive']);
  connection.close();
  await Promise.all(server.closed);
});

test('local ssh2 rekeys while OTP is pending and again after authentication', { timeout: 15000 }, async (t) => {
  const prompted = deferred();
  const otp = deferred();
  let peer;
  let received;
  let keyboardPending = false;
  let verifications = 0;
  let keyboardSignal;
  const server = await serverFixture(t, { authenticate: (ctx, client) => {
    if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
    peer = client;
    ctx.prompt([{ prompt: 'OTP:', echo: false }], (answers) => {
      received = answers;
      if (answers[0] === '654321') ctx.accept();
      else ctx.reject(['keyboard-interactive']);
    });
  } });
  const connection = localConnection(t, server, {
    verifyHostKey: async ({ signal, isActive }) => {
      verifications++;
      assert.equal(isActive(), true);
      assert.equal(signal.aborted, false);
      if (verifications === 2) {
        assert.equal(keyboardPending, true);
        assert.equal(signal, keyboardSignal);
      }
      return true;
    },
    promptKeyboard: async ({ signal }) => {
      keyboardSignal = signal;
      keyboardPending = true;
      prompted.resolve();
      const answers = await otp.promise;
      keyboardPending = false;
      return answers;
    },
  });
  const prematureReady = connection.ready.then(() => assert.fail('Authenticated before OTP completion'));
  await Promise.race([prompted.promise, prematureReady]);
  const rekey = () => new Promise((resolve, reject) => peer.rekey((error) => error ? reject(error) : resolve()));
  await Promise.race([rekey(), prematureReady]);
  assert.equal(verifications, 2);
  assert.equal(keyboardPending, true);
  assert.equal(received, undefined);
  otp.resolve(['654321']);
  await connection.ready;
  await rekey();
  assert.equal(verifications, 3);
  assert.deepEqual(received, ['654321']);
  connection.close();
  assert.equal(keyboardSignal.aborted, true);
  await Promise.all(server.closed);
});

test('local two-hop chain verifies every server, tunnels in order and closes every connection', { timeout: 20000 }, async (t) => {
  const { file } = temporary(t);
  const target = await serverFixture(t);
  const second = await serverFixture(t, { forwards: [target.port], hostPrivateKey: otherPair.private });
  const first = await serverFixture(t, { forwards: [second.port] });
  const visited = [];
  const verify = createHostKeyVerifier({ file });
  const connection = localConnection(t, target, { advanced: {
    proxyJump: `first-user@127.0.0.1:${first.port},ssh://second-user@127.0.0.1:${second.port}`,
    compression: true, hostKeyPolicy: 'accept-new',
  }, verifyHostKey: async (info) => { visited.push(info.port); return verify(info); } });
  await connection.ready;
  assert.deepEqual(visited, [first.port, second.port, target.port]);
  assert.deepEqual([first, second, target].map((server) => server.attempts[0].username), ['first-user', 'second-user', 'target-user']);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length, 3);
  assert.ok([first, second, target].every((server) => server.handshakes[0].cs.compress === 'zlib@openssh.com'));
  connection.close();
  await Promise.all([first, second, target].flatMap((server) => server.closed));
});

test('local server never receives authentication after strict, ask or changed-key rejection', { timeout: 20000 }, async (t) => {
  const { file } = temporary(t);
  for (const policy of ['strict', 'ask', 'accept-new']) {
    const server = await serverFixture(t);
    if (policy === 'accept-new') {
      fs.writeFileSync(file, JSON.stringify({ [`127.0.0.1:${server.port}`]: { fp: fingerprint(otherKey), type: keyType, savedAt: 1 } }));
    }
    const verify = createHostKeyVerifier({ file, confirm: async () => false });
    const connection = localConnection(t, server, { advanced: { hostKeyPolicy: policy }, verifyHostKey: verify });
    const code = policy === 'strict' ? 'SSH_HOST_KEY_UNKNOWN' : policy === 'ask' ? 'SSH_HOST_KEY_REJECTED' : 'SSH_HOST_KEY_MISMATCH';
    await assert.rejects(connection.ready, { code });
    await Promise.all(server.closed);
    assert.deepEqual(server.attempts, []);
  }
});
