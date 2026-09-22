const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const compiler = require('vue/compiler-sfc');

function component(name, bindings) {
  const filename = path.join(__dirname, '..', 'src', 'components', name);
  const parsed = compiler.parse({ source: fs.readFileSync(filename, 'utf8'), filename });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(compiler.compileTemplate({ source: parsed.template.content, filename }).errors, []);
  const source = parsed.script.content
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^import ['"][^'"]+['"];\r?\n/gm, '')
    .replace('export default ', 'module.exports = ');
  const sandbox = { module: { exports: {} }, setTimeout, clearTimeout, crypto, ...bindings };
  new vm.Script(source, { filename }).runInNewContext(sandbox);
  return sandbox.module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const requests = [];
  const disconnected = [];
  const output = [];
  const data = new Map();
  const states = new Set();
  const sent = [];
  let refreshed = 0;
  const api = {
    sshConnect(req) {
      assert.ok(data.has(req.requestId));
      assert.equal(states.size, 1);
      const pending = deferred();
      requests.push({ ...req, ...pending });
      return pending.promise;
    },
    async sshDisconnect(id) { disconnected.push(id); return { ok: true }; },
    onSshData(id, cb) { data.set(id, cb); return () => data.delete(id); },
    onSshState(cb) { states.add(cb); return () => states.delete(cb); },
    async sshWrite(id, value) { sent.push({ id, value, binary: false }); return true; },
    async sshWriteBinary(id, value) { sent.push({ id, value, binary: true }); return true; },
  };
  const options = component('TerminalView.vue', {
    api, store: { tabs: [] }, t: (key) => key, SshThemeDialog: {},
    createFullscreenMixin: () => ({}),
    refresh: async () => { refreshed += 1; },
    unwrap: (result) => {
      if (result && result.__error) throw Object.assign(new Error(result.message), { code: result.code });
      return result;
    },
  });
  const view = {
    ...options.data(), assetId: 'fixture', methodId: 'ssh', sessionId: 'tab-fixture', active: true,
    term: { cols: 100, rows: 40, clear() {}, focus() {}, write: (v) => output.push(v), writeln: (v) => output.push(v) },
  };
  for (const [key, method] of Object.entries(options.methods)) view[key] = method.bind(view);
  options.created.call(view);
  view.scheduleFit = () => {};
  view.scheduleRemoteResize = () => {};
  view.doFit = () => {};
  return {
    view, api, options, requests, disconnected, output, data, states, sent,
    get refreshed() { return refreshed; },
    emit(ev) { for (const cb of [...states]) cb(ev); },
    ready(index) { const req = requests[index]; req.resolve({ sessionId: req.requestId }); },
  };
}

test('terminal subscribes before connect and receives initial Unicode output', async () => {
  const h = harness();
  const pending = h.view.connect();
  const id = h.requests[0].requestId;
  assert.match(id, /^ssh-[a-zA-Z0-9-]+$/);
  h.data.get(id)('中文 initial output');
  assert.ok(h.output.includes('中文 initial output'));
  h.emit({ sessionId: 'other', type: 'ready' });
  assert.equal(h.view.status, 'connecting');
  h.emit({ sessionId: id, type: 'ready' });
  h.ready(0);
  await pending;
  assert.equal(h.view.status, 'ready');
  assert.equal(h.view.liveSessionId, id);
  assert.equal(h.refreshed, 1);
  assert.equal(h.view._sentCols, 100);
  h.view.disconnectNow(true);
});

test('cancel during handshake removes listeners and disconnects a late result', async () => {
  const h = harness();
  const pending = h.view.connect();
  const id = h.requests[0].requestId;
  const lateData = h.data.get(id);
  h.view.disconnectNow(false);
  assert.equal(h.data.size, 0);
  assert.equal(h.states.size, 0);
  lateData('must not be rendered');
  h.ready(0);
  await pending;
  assert.equal(h.view.liveSessionId, null);
  assert.equal(h.view.status, 'ended');
  assert.equal(h.refreshed, 0);
  assert.ok(!h.output.includes('must not be rendered'));
  assert.deepEqual(h.disconnected, [id, id]);
});

test('old connection result cannot replace a reconnected terminal', async () => {
  const h = harness();
  const first = h.view.connect();
  const oldId = h.requests[0].requestId;
  const staleState = [...h.states][0];
  const second = h.view.connect();
  const newId = h.requests[1].requestId;
  assert.notEqual(oldId, newId);
  staleState({ sessionId: oldId, type: 'error', code: 'STALE' });
  h.ready(1);
  await second;
  h.ready(0);
  await first;
  assert.equal(h.view.liveSessionId, newId);
  assert.equal(h.view.status, 'ready');
  assert.equal(h.data.size, 1);
  assert.equal(h.states.size, 1);
  assert.equal(h.refreshed, 1);
  h.view.disconnectNow(true);
});

test('destruction invalidates pending connections without reviving state', async () => {
  const h = harness();
  const pending = h.view.connect();
  h.view._disposed = true;
  h.view.disconnectNow(true);
  h.view.term = null;
  h.ready(0);
  await pending;
  await h.view.connect();
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.size, 0);
  assert.equal(h.refreshed, 0);
});

test('remote errors and ended events release listeners without being overwritten by invoke results', async () => {
  for (const type of ['error', 'ended']) {
    const h = harness();
    const pending = h.view.connect();
    const id = h.requests[0].requestId;
    h.emit({ sessionId: id, type, message: 'Fixture failure' });
    h.requests[0].reject(new Error('Late invoke rejection'));
    await pending;
    assert.equal(h.view.status, type);
    assert.equal(h.view.liveSessionId, null);
    assert.equal(h.data.size, 0);
    assert.equal(h.states.size, 0);
    assert.ok(!h.output.includes('Late invoke rejection'));
  }
});

test('invoke errors preserve message and leave reconnection possible', async () => {
  const h = harness();
  const pending = h.view.connect();
  h.requests[0].resolve({ __error: true, message: 'Fixture key rejected', code: 'SSH_HOST_KEY_REJECTED' });
  await pending;
  assert.equal(h.view.status, 'error');
  assert.equal(h.view.statusDetail, 'Fixture key rejected');
  assert.equal(h.view.liveSessionId, null);
  const next = h.view.connect();
  h.ready(1);
  await next;
  assert.equal(h.view.status, 'ready');
  h.view.disconnectNow(true);
});

test('text and binary inputs use separate APIs and encoding errors remain visible', async () => {
  const h = harness();
  await h.view.sendInput('ignored');
  assert.equal(h.sent.length, 0);
  const pending = h.view.connect();
  h.ready(0);
  await pending;
  const id = h.view.liveSessionId;
  await h.view.sendInput('中文');
  await h.view.sendInput('\xff\x80', true);
  assert.deepEqual(h.sent, [{ id, value: '中文', binary: false }, { id, value: '\xff\x80', binary: true }]);
  h.api.sshWrite = async () => ({ __error: true, code: 'SSH_ENCODING', message: 'Cannot encode input' });
  await h.view.sendInput('unrepresentable');
  assert.equal(h.view.statusDetail, 'Cannot encode input');
  h.view.disconnectNow(true);
});

test('remote resize handles IPC failures and ignores completion after cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const connecting = h.view.connect();
  h.ready(0);
  await connecting;
  h.view.scheduleRemoteResize = h.options.methods.scheduleRemoteResize.bind(h.view);
  h.view.term.cols = 101;
  h.api.sshResize = async () => ({ __error: true, message: 'Resize rejected', code: 'FIXTURE' });
  h.view.scheduleRemoteResize();
  t.mock.timers.tick(220);
  await new Promise(setImmediate);
  assert.equal(h.view.statusDetail, 'Resize rejected');
  assert.equal(h.view._sentCols, 100);
  const gate = deferred();
  h.api.sshResize = () => gate.promise;
  h.view.scheduleRemoteResize();
  t.mock.timers.tick(220);
  h.view.disconnectNow(true);
  gate.resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.view._sentCols, 100);
  h.view._disposed = true;
  h.view.scheduleRemoteResize();
  t.mock.timers.tick(220);
  assert.equal(h.view.liveSessionId, null);
});

test('interactive dialog queues independent prompts and clears submitted answers', async () => {
  const events = {};
  const replies = [];
  const api = {
    onSshAuthPrompt(cb) { events.prompt = cb; return () => { delete events.prompt; }; },
    onSshAuthCancel(cb) { events.cancel = cb; return () => { delete events.cancel; }; },
    async sshAuthReply(id, answers) { replies.push({ id, answers }); return true; },
  };
  const options = component('SshAuthDialog.vue', { api, unwrap: (v) => v });
  const view = { ...options.data(), $message: { error() {} } };
  for (const [key, method] of Object.entries(options.methods)) view[key] = method.bind(view);
  Object.defineProperty(view, 'active', { get: options.computed.active.bind(view) });
  options.created.call(view);
  events.prompt({ requestId: 'first', prompts: [{ prompt: 'OTP', echo: false }] });
  events.prompt({ requestId: 'second', prompts: [{ prompt: 'User', echo: true }] });
  const first = view.active;
  first.answers[0] = '123456';
  await view.finish(first.answers.slice());
  assert.equal(first.answers.length, 0);
  assert.equal(view.active.requestId, 'second');
  assert.equal(replies[0].id, 'first');
  assert.equal(replies[0].answers[0], '123456');
  events.cancel({ requestId: 'second' });
  assert.equal(view.active, null);
  events.prompt({ requestId: 'third', prompts: [] });
  options.beforeDestroy.call(view);
  assert.equal(view.requests.length, 0);
  assert.equal(replies[1].answers, null);
  assert.deepEqual(events, {});
});

for (const charset of ['UTF-8', 'GBK', 'Big5']) {
  test(`local SSH terminal negotiates PTY and round-trips ${charset} bytes`, { timeout: 10000 }, async (t) => {
    const { Server, utils } = require('ssh2');
    const { once } = require('node:events');
    const iconv = require('iconv-lite');
    const { SshSessionManager } = require('../electron/ssh/SshSessionManager');
    const sockets = new Set();
    const input = deferred();
    const output = deferred();
    const text = charset === 'Big5' ? '終端測試\r\n' : '终端测试\r\n';
    const bytes = iconv.encode(text, charset);
    let pty;
    let received = '';
    let verified = 0;
    const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === 'fixture-password') ctx.accept();
        else ctx.reject(['password']);
      });
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty, reject, info) => { pty = info; acceptPty(); });
        session.on('shell', (acceptShell) => {
          const channel = acceptShell();
          const chunks = [];
          channel.on('data', (chunk) => {
            chunks.push(chunk);
            const combined = Buffer.concat(chunks);
            if (combined.length >= bytes.length) input.resolve(combined);
          });
          channel.on('error', () => {});
          channel.write(bytes.subarray(0, 1));
          channel.write(bytes.subarray(1));
        });
      }));
    });
    server._srv.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const manager = new SshSessionManager({
      send(channel, payload, ownerId) {
        assert.equal(ownerId, 41);
        if (channel.startsWith('ssh:data:')) {
          received += payload;
          if (received.length >= text.length) output.resolve(received);
        }
      },
    });
    t.after(async () => {
      manager.destroyAll();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const result = await manager.connect({
      ownerId: 41, requestId: 'ssh-offline-' + crypto.randomUUID(), assetId: 'fixture',
      asset: { host: '127.0.0.1', user: 'fixture', pass: 'fixture-password' },
      method: { port: server.address().port, advanced: { charset, term: 'vt100', compression: true, keepAlive: 0 } },
      cols: 91, rows: 29,
      verifyHostKey: async ({ host, port, key }) => {
        assert.equal(host, '127.0.0.1');
        assert.equal(port, server.address().port);
        assert.ok(Buffer.isBuffer(key));
        verified += 1;
        return true;
      },
    });
    assert.equal(await output.promise, text);
    assert.equal(verified, 1);
    assert.equal(pty.term, 'vt100');
    assert.equal(pty.cols, 91);
    assert.equal(pty.rows, 29);
    assert.equal(manager.write(result.sessionId, text), true);
    assert.deepEqual(await input.promise, bytes);
    manager.closeOwner(41);
    assert.equal(manager.list().length, 0);
  });
}

for (const protocol of ['shell', 'sftp']) {
  test(`local ${protocol} success batched with disconnect cannot publish a live session`, { timeout: 10000 }, async (t) => {
    const { Server, utils } = require('ssh2');
    const { once } = require('node:events');
    const { SshSessionManager } = require('../electron/ssh/SshSessionManager');
    const { SftpManager } = require('../electron/sftp/SftpManager');
    const sockets = new Set();
    const states = [];
    const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => ctx.method === 'password' ? ctx.accept() : ctx.reject(['password']));
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty());
        session.on('shell', (acceptShell) => {
          client._sock.cork();
          acceptShell().on('error', () => {});
          client._protocol.disconnect(2);
          client._sock.end();
          client._sock.uncork();
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          sftp.on('error', () => {});
          sftp.on('REALPATH', (id) => {
            client._sock.cork();
            sftp.name(id, [{ filename: '/', longname: '/', attrs: {} }]);
            client._protocol.disconnect(2);
            client._sock.end();
            client._sock.uncork();
          });
        });
      }));
    });
    server._srv.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    let manager;
    t.after(async () => {
      if (manager) manager.destroyAll();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const asset = {
      host: '127.0.0.1', user: 'fixture', pass: 'fixture-password',
      methods: { ssh: { enabled: true, port: server.address().port } },
    };
    if (protocol === 'shell') {
      manager = new SshSessionManager({ send: (channel, payload) => { if (channel === 'ssh:state') states.push(payload.type); } });
      await assert.rejects(manager.connect({
        ownerId: 41, assetId: 'fixture', asset, method: asset.methods.ssh, verifyHostKey: async () => true,
      }));
      assert.equal(manager.list().length, 0);
      assert.ok(!states.includes('ready'));
    } else {
      manager = new SftpManager({ store: { findAsset: () => ({ asset }) } });
      await assert.rejects(manager.openSession({ ownerId: 41, assetId: 'fixture', verifyHostKey: async () => true }));
      assert.equal(manager.pending.size, 0);
      assert.equal(manager.conns.size, 0);
    }
  });
}
