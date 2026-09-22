const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const { Channel, MAX_WINDOW, PACKET_SIZE } = require('ssh2/lib/Channel');

const filename = path.resolve(__dirname, '../electron/ssh/x11.js');
const source = fs.readFileSync(filename, 'utf8');
const factory = vm.runInThisContext(`(function(require, module, exports, process, setTimeout, clearTimeout) {\n${source}\n})`, { filename });
const PROTOCOL = 'MIT-MAGIC-COOKIE-1';
const REAL_COOKIE = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const OTHER_COOKIE = Buffer.alloc(16, 0x42);
const HOSTNAME = 'offline-x11-test';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function authorityRecord({ family = 256, address = HOSTNAME, number = '3', name = PROTOCOL, data = REAL_COOKIE } = {}) {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(family);
  const fields = [prefix];
  for (const value of [address, number, name, data]) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    fields.push(length, bytes);
  }
  return Buffer.concat(fields);
}

function setupPacket(cookie, { littleEndian = true, protocol = PROTOCOL, major = 11, minor = 0 } = {}) {
  const auth = Buffer.isBuffer(cookie) ? cookie : Buffer.from(cookie, 'hex');
  const name = Buffer.from(protocol);
  const packet = Buffer.alloc(12 + ((name.length + 3) & ~3) + ((auth.length + 3) & ~3));
  packet[0] = littleEndian ? 0x6c : 0x42;
  const write = (number, offset) => littleEndian ? packet.writeUInt16LE(number, offset) : packet.writeUInt16BE(number, offset);
  write(major, 2);
  write(minor, 4);
  write(name.length, 6);
  write(auth.length, 8);
  name.copy(packet, 12);
  auth.copy(packet, 12 + ((name.length + 3) & ~3));
  return packet;
}

class MockChannel extends Duplex {
  constructor() {
    super({ writableHighWaterMark: 1 });
    this.writes = [];
    this.destroyCalls = 0;
  }
  _read() {}
  _write(chunk, encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }
  _destroy(error, callback) {
    this.destroyCalls++;
    callback(error);
  }
}

function harness(settings = {}) {
  const authority = settings.authority === undefined ? authorityRecord() : settings.authority;
  const sockets = [];
  const timers = new Set();
  const logs = [];
  const openPaths = [];
  const buffers = [];
  let fileCloses = 0;
  class MockSocket extends MockChannel {
    constructor() {
      super();
      this.pendingWrites = [];
      sockets.push(this);
      if (settings.onSocketCreated) settings.onSocketCreated(this);
    }
    connect(endpoint) {
      this.endpoint = { ...endpoint };
      if (settings.connectThrows) throw Object.assign(new Error('mock failure'), { code: 'ECONNREFUSED' });
      if (settings.autoConnect !== false) queueMicrotask(() => {
        if (this.destroyed) return;
        if (settings.connectError) this.destroy(Object.assign(new Error('mock failure'), { code: settings.connectError }));
        else this.emit('connect');
      });
      return this;
    }
    _write(chunk, encoding, callback) {
      this.writes.push(Buffer.from(chunk));
      if (settings.delayWrites) this.pendingWrites.push(callback);
      else callback();
    }
  }
  const fakeFs = {
    constants: fs.constants,
    promises: {
      async open(name) {
        openPaths.push(name);
        if (settings.openError) throw new Error('private path must not be logged');
        let position = 0;
        return {
          async stat() {
            return { isFile: () => settings.regularFile !== false, size: settings.fileSize === undefined ? authority.length : settings.fileSize };
          },
          async read(buffer, offset, length) {
            buffers.push(buffer);
            if (settings.readError) throw new Error('private file bytes must not be logged');
            const count = Math.min(length, settings.readChunkSize || 97, authority.length - position);
            authority.copy(buffer, offset, position, position + count);
            position += count;
            return { bytesRead: count };
          },
          async close() {
            fileCloses++;
            if (settings.closeError) throw new Error('private close failure');
          },
        };
      },
    },
  };
  const mocks = {
    fs: fakeFs,
    net: { Socket: MockSocket },
    os: { hostname: () => HOSTNAME, homedir: () => '/offline-home' },
  };
  const fakeProcess = { platform: settings.platform || 'linux', env: settings.env || { DISPLAY: ':3', XAUTHORITY: '/offline-authority' } };
  const loaded = { exports: {} };
  factory((name) => mocks[name] || require(name), loaded, loaded.exports, fakeProcess, (callback, delay) => {
    const timer = { callback, delay, unref() { return this; } };
    timers.add(timer);
    return timer;
  }, (timer) => timers.delete(timer));
  const log = {};
  for (const level of ['info', 'warn', 'error']) log[level] = (category, message, meta) => logs.push({ level, category, message, meta });
  return {
    ...loaded.exports,
    sockets,
    timers,
    logs,
    openPaths,
    buffers,
    get fileCloses() { return fileCloses; },
    create: (options = {}) => loaded.exports.createX11Forwarder({ log, sessionId: 'offline-session', ...options }),
    expireTimers() {
      for (const timer of [...timers]) {
        timers.delete(timer);
        assert.equal(timer.delay, 10000);
        timer.callback();
      }
    },
  };
}

function request(client, channel = new MockChannel(), onAccept) {
  const result = { channel, accepted: 0, rejected: 0 };
  client.emit('x11', { srcIP: 'untrusted source', srcPort: 1234 }, () => {
    result.accepted++;
    if (onAccept) onAccept();
    return channel;
  }, () => result.rejected++);
  return result;
}

function assertClean(h, client, channels = []) {
  assert.equal(h.timers.size, 0);
  for (const name of ['x11', 'end', 'close', 'error']) assert.equal(client.listenerCount(name), 0, name);
  for (const stream of [...h.sockets, ...channels]) {
    assert.equal(stream.destroyed, true);
    for (const name of ['readable', 'connect', 'end', 'close', 'error', 'data', 'drain']) {
      assert.equal(stream.listenerCount(name), 0, `stream listener ${name}`);
    }
  }
}

function ssh2Channel(client, id = 0) {
  const writes = [];
  client._protocol = {
    channelData: (channelId, data) => writes.push(Buffer.from(data)),
    channelEOF() {},
    channelClose() {},
    channelWindowAdjust() {},
  };
  const channel = new Channel(client, {
    type: 'x11',
    incoming: { id, window: MAX_WINDOW, packetSize: PACKET_SIZE, state: 'open' },
    outgoing: { id, window: MAX_WINDOW, packetSize: PACKET_SIZE, state: 'open' },
  });
  return { channel, writes };
}

function acknowledgeSsh2Close(channel) {
  channel.incoming.state = 'closed';
  channel.outgoing.state = 'closed';
  channel.push(null);
  channel.stderr.push(null);
  channel.emit('close');
}

test('DISPLAY resolves only explicit local transports and preserves screen', () => {
  const { parseDisplay } = harness();
  assert.deepEqual(parseDisplay(':0.2', 'linux'), { number: 0, screen: 2, family: 256, endpoint: { path: '/tmp/.X11-unix/X0' } });
  assert.deepEqual(parseDisplay(':0', 'win32'), { number: 0, screen: 0, family: 0, endpoint: { host: '127.0.0.1', port: 6000 } });
  assert.deepEqual(parseDisplay('unix:7', 'linux').endpoint, { path: '/tmp/.X11-unix/X7' });
  for (const host of ['localhost', '127.0.0.1']) {
    assert.deepEqual(parseDisplay(`${host}:3.1`).endpoint, { host: '127.0.0.1', port: 6003 });
  }
  assert.deepEqual(parseDisplay('[::1]:4.1'), { number: 4, screen: 1, family: 6, endpoint: { host: '::1', port: 6004 } });
  const launchd = '/private/tmp/com.apple.launchd.test/org.xquartz:0';
  assert.deepEqual(parseDisplay(`${launchd}.1`, 'darwin'), { number: 0, screen: 1, family: 256, endpoint: { path: launchd } });
  assert.equal(parseDisplay('127.0.0.1:59535.4294967295').endpoint.port, 65535);
  assert.equal(parseDisplay(' :3 ').number, 3);
});

test('DISPLAY rejects remote, malformed and out-of-range endpoints', () => {
  const { parseDisplay } = harness();
  for (const value of [undefined, null, 1, {}, '', ' ', ':', ':0.1.2', ':0.-1', ':-1', ':59536', ':0.4294967296', ':0\u0000', ':0\n', ':0\t', '\n:0', 'host:0', '192.0.2.1:0', '127.0.0.2:0', '0.0.0.0:0', '[::]:0', '[::ffff:127.0.0.1]:0', '//remote/xquartz:0', 'tcp/localhost:0', 'localhost:6000/0', '/tmp/x:0:0', ':1e3', ':Infinity', ':0.' + '9'.repeat(4096)]) {
    assert.throws(() => parseDisplay(value), { code: 'SSH_X11_DISPLAY' });
  }
  for (const value of ['unix:0', '/private/tmp/launchd/org.xquartz:0']) {
    assert.throws(() => parseDisplay(value, 'win32'), { code: 'SSH_X11_DISPLAY' });
  }
});

test('binary Xauthority parser checks all record and field boundaries', () => {
  const { parseXauthority } = harness();
  const local = authorityRecord();
  const inet6 = authorityRecord({ family: 6, address: Buffer.from('00000000000000000000000000000001', 'hex') });
  const records = parseXauthority(Buffer.concat([local, inet6]));
  assert.equal(records.length, 2);
  assert.equal(records[0].family, 256);
  assert.equal(records[0].address.toString(), HOSTNAME);
  assert.equal(records[0].number.toString(), '3');
  assert.equal(records[0].name.toString(), PROTOCOL);
  assert.deepEqual(records[0].data, REAL_COOKIE);
  assert.equal(records[1].family, 6);
  for (let length = 0; length < local.length; length++) {
    assert.throws(() => parseXauthority(local.subarray(0, length)), { code: 'SSH_X11_AUTH' });
  }
  for (const invalid of [Buffer.concat([local, Buffer.from([0])]), Buffer.alloc(1024 * 1024 + 1), 'not binary', Buffer.from([0, 0, 255, 255])]) {
    assert.throws(() => parseXauthority(invalid), { code: 'SSH_X11_AUTH' });
  }
});

test('initialization uses DISPLAY/XAUTHORITY or homedir defaults without exposing real cookie', async () => {
  const h = harness({ env: { DISPLAY: ':3.2' } });
  const forwarder = await h.create({ display: ' ' });
  assert.equal(h.openPaths[0], path.join('/offline-home', '.Xauthority'));
  assert.equal(h.fileCloses, 1);
  assert.ok(h.buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  assert.equal(forwarder.options.protocol, PROTOCOL);
  assert.match(forwarder.options.cookie, /^[a-f0-9]{32}$/);
  assert.notEqual(forwarder.options.cookie, REAL_COOKIE.toString('hex'));
  assert.equal(forwarder.options.screen, 2);
  assert.equal(forwarder.options.single, false);
  const second = await h.create();
  assert.notEqual(second.options.cookie, forwarder.options.cookie);
  forwarder.close();
  second.close();
  const explicit = harness({ env: { DISPLAY: 'remote:3', XAUTHORITY: '/mock/custom-authority' } });
  (await explicit.create({ display: ':3' })).close();
  assert.deepEqual(explicit.openPaths, ['/mock/custom-authority']);
});

test('missing or invalid DISPLAY fails before reading any authority', async () => {
  for (const env of [{}, { DISPLAY: '' }, { DISPLAY: 'remote:3' }]) {
    const h = harness({ env });
    await assert.rejects(h.create(), { code: 'SSH_X11_DISPLAY' });
    assert.equal(h.openPaths.length, 0);
    assert.equal(h.logs[0].meta.code, 'SSH_X11_DISPLAY');
    assert.match(h.logs[0].message, /local DISPLAY/);
  }
});

test('authority absence, unsafe file types, size, I/O and parse errors fail closed', async () => {
  const cases = [
    { openError: true }, { readError: true }, { closeError: true }, { regularFile: false },
    { fileSize: 1024 * 1024 + 1 }, { authority: Buffer.alloc(0) },
    { authority: Buffer.concat([authorityRecord(), Buffer.from([255])]) },
    { authority: Buffer.alloc(1024 * 1024 + 1), fileSize: 0, readChunkSize: 1024 * 1024 + 1 },
  ];
  for (const settings of cases) {
    const h = harness(settings);
    await assert.rejects(h.create(), { code: 'SSH_X11_AUTH' });
    assert.equal(h.sockets.length, 0);
    assert.equal(h.fileCloses, settings.openError ? 0 : 1);
    assert.ok(h.buffers.every((buffer) => buffer.every((byte) => byte === 0)));
    assert.equal(h.logs[0].meta.code, 'SSH_X11_AUTH');
    assert.doesNotMatch(JSON.stringify(h.logs), /private|00112233445566778899aabbccddeeff/);
  }
});

test('cookie selection rejects unrelated displays, hosts, families, protocols and lengths', async () => {
  const cases = [
    { number: '4' }, { number: '' }, { address: 'other-host' }, { address: '' },
    { family: 0, address: Buffer.from([127, 0, 0, 1]) },
    { family: 6, address: Buffer.from('00000000000000000000000000000001', 'hex') },
    { family: 999 }, { name: 'XDM-AUTHORIZATION-1' }, { data: Buffer.alloc(0) }, { data: Buffer.alloc(15) }, { data: Buffer.alloc(17) },
  ];
  for (const record of cases) {
    const h = harness({ authority: authorityRecord(record) });
    await assert.rejects(h.create(), { code: 'SSH_X11_AUTH' });
  }
  for (const [display, record] of [
    ['127.0.0.1:3', { family: 0, address: Buffer.from([192, 0, 2, 1]) }],
    ['127.0.0.1:3', { family: 6, address: Buffer.from('00000000000000000000000000000001', 'hex') }],
    ['[::1]:3', { family: 0, address: Buffer.from([127, 0, 0, 1]) }],
    ['[::1]:3', { family: 6, address: Buffer.alloc(16) }],
  ]) {
    const h = harness({ authority: authorityRecord(record) });
    await assert.rejects(h.create({ display }), { code: 'SSH_X11_AUTH' });
  }
});

test('cookie selection supports exact IPv4/IPv6, local loopback records and FamilyWild', async () => {
  const cases = [
    { display: ':3', family: 256, address: HOSTNAME },
    { display: 'localhost:3', family: 0, address: Buffer.from([127, 0, 0, 1]) },
    { display: '[::1]:3', family: 6, address: Buffer.from('00000000000000000000000000000001', 'hex') },
    { display: '127.0.0.1:3', family: 256, address: HOSTNAME },
    { display: ':3', platform: 'win32', family: 256, address: HOSTNAME },
    { display: ':3', family: 65535, address: 'wildcard-address' },
    { display: '/private/tmp/test/org.xquartz:3', platform: 'darwin', family: 256, address: HOSTNAME },
  ];
  for (const entry of cases) {
    const h = harness({ platform: entry.platform, authority: authorityRecord(entry) });
    const forwarder = await h.create({ display: entry.display });
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    channel.push(setupPacket(forwarder.options.cookie));
    await flush();
    assert.deepEqual(Buffer.concat(h.sockets[0].writes), setupPacket(REAL_COOKIE));
    forwarder.close();
    await flush();
    assertClean(h, client, [channel]);
  }
  const h = harness({ authority: Buffer.concat([
    authorityRecord({ family: 65535, data: OTHER_COOKIE }),
    authorityRecord({ data: OTHER_COOKIE }),
    authorityRecord({ family: 0, address: Buffer.from([127, 0, 0, 1]) }),
  ]) });
  const forwarder = await h.create({ display: 'localhost:3' });
  const client = new EventEmitter();
  forwarder.attach(client);
  request(client).channel.push(setupPacket(forwarder.options.cookie));
  await flush();
  assert.deepEqual(Buffer.concat(h.sockets[0].writes), setupPacket(REAL_COOKIE));
  forwarder.close();
  await flush();
});

for (const littleEndian of [true, false]) {
  for (const fragmentSize of [1, 7, 48]) {
    test(`setup authenticates ${littleEndian ? 'LE' : 'BE'}, fragments=${fragmentSize}, preserving trailing data and bidirectional bytes`, async () => {
      const h = harness();
      const forwarder = await h.create();
      const fakeCookie = forwarder.options.cookie;
      const client = new EventEmitter();
      forwarder.attach(client);
      const { channel } = request(client);
      const setup = setupPacket(fakeCookie, { littleEndian });
      const extra = Buffer.from([0, 255, 7, 8, 9]);
      for (let offset = 0; offset < setup.length; offset += fragmentSize) {
        const end = Math.min(offset + fragmentSize, setup.length);
        channel.push(end === setup.length ? Buffer.concat([setup.subarray(offset, end), extra]) : setup.subarray(offset, end));
        await flush();
        if (end < setup.length) assert.equal(h.sockets.length, 0, 'never connects before authentication');
      }
      assert.equal(h.sockets.length, 1);
      const socket = h.sockets[0];
      assert.deepEqual(socket.endpoint, { path: '/tmp/.X11-unix/X3' });
      assert.deepEqual(Buffer.concat(socket.writes), Buffer.concat([setupPacket(REAL_COOKIE, { littleEndian }), extra]));
      assert.deepEqual(setup, setupPacket(fakeCookie, { littleEndian }), 'does not overwrite shared incoming bytes');
      const response = Buffer.from([1, 0, 0, 0, 128]);
      socket.push(response);
      channel.push(Buffer.from('next request'));
      await flush();
      assert.deepEqual(Buffer.concat(channel.writes), response);
      assert.deepEqual(Buffer.concat(socket.writes), Buffer.concat([setupPacket(REAL_COOKIE, { littleEndian }), extra, Buffer.from('next request')]));
      assert.equal(h.timers.size, 0);
      forwarder.close();
      forwarder.close();
      await flush();
      assertClean(h, client, [channel]);
      const logs = JSON.stringify(h.logs);
      assert.ok(!logs.includes(REAL_COOKIE.toString('hex')));
      assert.ok(!logs.includes(fakeCookie));
      assert.ok(!logs.includes('untrusted source'));
    });
  }
}

test('invalid authentication and oversized setup declarations are rejected without opening a local socket', async () => {
  const mutators = [
    () => setupPacket(OTHER_COOKIE),
    () => setupPacket(Buffer.alloc(0)),
    () => setupPacket(Buffer.alloc(32)),
    (cookie) => setupPacket(cookie, { protocol: 'NOT-MAGIC-COOKIE-1' }),
    (cookie) => setupPacket(cookie, { major: 10 }),
    (cookie) => setupPacket(cookie, { minor: 1 }),
    (cookie) => { const packet = setupPacket(cookie); packet[0] = 0x41; return packet; },
    (cookie) => { const packet = setupPacket(cookie); packet.writeUInt16LE(65535, 6); packet.writeUInt16LE(65535, 8); return packet.subarray(0, 12); },
    (cookie) => { const packet = setupPacket(cookie); packet[12] ^= 1; return packet; },
  ];
  for (const mutate of mutators) {
    const h = harness();
    const forwarder = await h.create();
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    channel.push(mutate(forwarder.options.cookie));
    await flush();
    assert.equal(channel.destroyed, true);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.timers.size, 0);
    assert.ok(h.logs.some((log) => log.level === 'warn' && /^SSH_X11_(COOKIE|SETUP)$/.test(log.meta.code)));
    forwarder.close();
    await flush();
    assertClean(h, client, [channel]);
  }
});

test('EOF during any partial setup fails without opening the X server', async () => {
  for (const length of [0, 1, 11, 12, 13, 47]) {
    const h = harness();
    const forwarder = await h.create();
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    channel.push(setupPacket(forwarder.options.cookie).subarray(0, length));
    channel.push(null);
    await flush();
    assert.equal(channel.destroyed, true);
    assert.equal(h.sockets.length, 0);
    assert.ok(h.logs.some((log) => log.meta.code === 'SSH_X11_SETUP'));
    forwarder.close();
    await flush();
    assertClean(h, client, [channel]);
  }
});

test('setup and local connection timeouts release all resources', async () => {
  for (const authenticate of [false, true]) {
    const h = harness({ autoConnect: false });
    const forwarder = await h.create();
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    if (authenticate) channel.push(setupPacket(forwarder.options.cookie));
    await flush();
    h.expireTimers();
    await flush();
    assert.ok(h.logs.some((log) => log.meta.code === 'SSH_X11_TIMEOUT'));
    assert.equal(channel.destroyed, true);
    assert.equal(h.timers.size, 0);
    forwarder.close();
    await flush();
    assertClean(h, client, [channel]);
  }
});

test('channel count includes unauthenticated streams and releases capacity on failure', async () => {
  const h = harness();
  const forwarder = await h.create();
  const client = new EventEmitter();
  forwarder.attach(client);
  const channels = Array.from({ length: 32 }, () => request(client).channel);
  const overflow = request(client);
  assert.equal(overflow.accepted, 0);
  assert.equal(overflow.rejected, 1);
  overflow.channel.destroy();
  assert.ok(h.logs.some((log) => log.meta.code === 'SSH_X11_LIMIT'));
  assert.equal(h.timers.size, 32);
  channels[0].push(setupPacket(OTHER_COOKIE));
  await flush();
  const next = request(client);
  assert.equal(next.accepted, 1);
  forwarder.close();
  await flush();
  assertClean(h, client, [...channels, next.channel]);
});

test('attach is idempotent, refuses another client and cannot revive a closed forwarder', async () => {
  const h = harness();
  const forwarder = await h.create();
  const client = new EventEmitter();
  forwarder.attach(client);
  const captured = client.listeners('x11')[0];
  forwarder.attach(client);
  assert.equal(client.listenerCount('x11'), 1);
  assert.throws(() => forwarder.attach(new EventEmitter()), { code: 'SSH_X11_STATE' });
  forwarder.close();
  assert.throws(() => forwarder.attach(client), { code: 'SSH_X11_CLOSED' });
  let rejected = false;
  captured({}, () => assert.fail('late request must not be accepted'), () => { rejected = true; });
  assert.equal(rejected, true);
  assertClean(h, client);
  const neverAttached = await h.create();
  neverAttached.close();
  assert.throws(() => neverAttached.attach(client), { code: 'SSH_X11_CLOSED' });
});

test('close reentered by accept destroys the late returned channel', async () => {
  const h = harness();
  const forwarder = await h.create();
  const client = new EventEmitter();
  forwarder.attach(client);
  const { channel } = request(client, new MockChannel(), () => forwarder.close());
  await flush();
  assert.equal(h.sockets.length, 0);
  assertClean(h, client, [channel]);
});

test('close during socket creation destroys the late socket without connecting', async () => {
  let forwarder;
  const h = harness({ onSocketCreated: () => forwarder.close() });
  forwarder = await h.create();
  const client = new EventEmitter();
  forwarder.attach(client);
  const { channel } = request(client);
  channel.push(setupPacket(forwarder.options.cookie));
  await flush();
  assert.equal(h.sockets[0].endpoint, undefined);
  assertClean(h, client, [channel]);
});

test('close during pending authentication or connect cancels timers and ignores late connect', async () => {
  for (const authenticate of [false, true]) {
    const h = harness({ autoConnect: false });
    const forwarder = await h.create();
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    channel.push(authenticate ? setupPacket(forwarder.options.cookie) : Buffer.from([0x6c]));
    await flush();
    forwarder.close();
    for (const socket of h.sockets) socket.emit('connect');
    await flush();
    assertClean(h, client, [channel]);
    assert.ok(h.sockets.every((socket) => socket.writes.length === 0));
  }
});

test('initial setup write backpressure preserves extra data and close ignores late write callbacks', async () => {
  for (const closeBeforeWrite of [false, true]) {
    const h = harness({ delayWrites: true });
    const forwarder = await h.create();
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    const extra = Buffer.alloc(65536, 0x7f);
    channel.push(Buffer.concat([setupPacket(forwarder.options.cookie), extra]));
    await flush();
    const socket = h.sockets[0];
    assert.deepEqual(Buffer.concat(socket.writes), setupPacket(REAL_COOKIE));
    if (closeBeforeWrite) forwarder.close();
    socket.pendingWrites.shift()();
    await flush();
    if (!closeBeforeWrite) {
      assert.deepEqual(Buffer.concat(socket.writes), Buffer.concat([setupPacket(REAL_COOKIE), extra]));
      socket.pendingWrites.shift()();
      await flush();
      forwarder.close();
    } else {
      assert.equal(socket.writes.length, 1);
      assert.ok(!h.logs.some((log) => log.message === 'X11 local transport connected'));
    }
    await flush();
    assertClean(h, client, [channel]);
  }
});

test('local connection failures are logged clearly and destroy both streams', async () => {
  for (const settings of [{ connectError: 'ECONNREFUSED' }, { connectError: 'ENOENT' }, { connectThrows: true }]) {
    const h = harness(settings);
    const forwarder = await h.create();
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    channel.push(setupPacket(forwarder.options.cookie));
    await flush();
    assert.ok(h.logs.some((log) => log.meta.code === 'SSH_X11_CONNECT' && /X server/.test(log.message)));
    assert.equal(h.sockets[0].writes.length, 0);
    forwarder.close();
    await flush();
    assertClean(h, client, [channel]);
  }
});

test('SSH lifecycle closes active streams without removing caller listeners', async () => {
  for (const event of ['end', 'close', 'error']) {
    const h = harness();
    const forwarder = await h.create();
    const client = new EventEmitter();
    let callerEvents = 0;
    const caller = () => callerEvents++;
    client.on(event, caller);
    forwarder.attach(client);
    const { channel } = request(client);
    channel.push(setupPacket(forwarder.options.cookie));
    await flush();
    client.emit(event, event === 'error' ? new Error('mock client failure') : undefined);
    await flush();
    assert.equal(callerEvents, 1);
    assert.equal(client.listenerCount(event), 1);
    client.removeListener(event, caller);
    assertClean(h, client, [channel]);
    assert.throws(() => forwarder.attach(client), { code: 'SSH_X11_CLOSED' });
  }
});

test('queued stream errors during close are handled until close removes listeners', async () => {
  for (const side of ['channel', 'socket']) {
    const h = harness();
    const forwarder = await h.create();
    const client = new EventEmitter();
    forwarder.attach(client);
    const { channel } = request(client);
    channel.push(setupPacket(forwarder.options.cookie));
    await flush();
    const stream = side === 'channel' ? channel : h.sockets[0];
    stream.destroy(new Error('queued failure'));
    forwarder.close();
    await flush();
    assertClean(h, client, [channel]);
  }
});

test('ssh2 1.17 Channel interoperates with setup buffering, piping and close', async () => {
  const h = harness();
  const forwarder = await h.create();
  const client = new EventEmitter();
  forwarder.attach(client);
  const { channel, writes } = ssh2Channel(client);
  const baselineEnd = channel.listenerCount('end');
  const baselineClose = channel.listenerCount('close');
  request(client, channel);
  const packet = setupPacket(forwarder.options.cookie, { littleEndian: false });
  channel.push(packet.subarray(0, 10));
  await flush();
  assert.equal(h.sockets.length, 0);
  const extra = Buffer.alloc(PACKET_SIZE, 0x23);
  channel.push(Buffer.concat([packet.subarray(10), extra]));
  await flush();
  assert.deepEqual(Buffer.concat(h.sockets[0].writes), Buffer.concat([setupPacket(REAL_COOKIE, { littleEndian: false }), extra]));
  h.sockets[0].push(Buffer.from('X server response'));
  await flush();
  assert.deepEqual(Buffer.concat(writes), Buffer.from('X server response'));
  forwarder.close();
  assert.equal(channel.outgoing.state, 'closing');
  acknowledgeSsh2Close(channel);
  await flush();
  assertClean(h, client);
  assert.equal(channel.listenerCount('readable'), 0);
  assert.equal(channel.listenerCount('error'), 0);
  assert.equal(channel.listenerCount('end'), baselineEnd);
  assert.equal(channel.listenerCount('close'), baselineClose);
});

test('ssh2 channels awaiting remote CLOSE acknowledgement still count towards the limit', async () => {
  const h = harness();
  const forwarder = await h.create();
  const client = new EventEmitter();
  forwarder.attach(client);
  const channels = Array.from({ length: 32 }, (_, index) => {
    const { channel } = ssh2Channel(client, index);
    request(client, channel);
    channel.push(setupPacket(OTHER_COOKIE));
    return channel;
  });
  await flush();
  assert.equal(h.timers.size, 0);
  assert.ok(channels.every((channel) => channel.outgoing.state === 'closing'));
  const overflow = request(client);
  assert.equal(overflow.rejected, 1);
  overflow.channel.destroy();
  acknowledgeSsh2Close(channels[0]);
  const replacement = request(client);
  assert.equal(replacement.accepted, 1);
  forwarder.close();
  for (const channel of channels.slice(1)) acknowledgeSsh2Close(channel);
  await flush();
  assertClean(h, client, [replacement.channel]);
  assert.ok(channels.every((channel) => channel.listenerCount('error') === 0));
});
