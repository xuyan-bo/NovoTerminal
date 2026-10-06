const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const compiler = require('vue/compiler-sfc');

const root = path.resolve(__dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));

function evaluate(source, filename, bindings = {}, extraExports = []) {
  const names = [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  const code = source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export default /gm, 'module.exports = ')
    .replace(/^export (?=const |function )/gm, '');
  const sandbox = { ...bindings, module: { exports: {} } };
  const exports = [...names, ...extraExports];
  new vm.Script(code + (exports.length ? `\nmodule.exports = { ${exports.join(', ')} };` : ''), { filename })
    .runInNewContext(sandbox);
  return sandbox.module.exports;
}

function loadModule(relative, bindings, extraExports) {
  const filename = path.join(root, relative);
  return evaluate(fs.readFileSync(filename, 'utf8'), filename, bindings, extraExports);
}

function readComponent(name) {
  const filename = path.join(root, 'src/components/dialogs', name);
  const descriptor = compiler.parse({ source: fs.readFileSync(filename, 'utf8'), filename });
  assert.deepEqual(descriptor.errors, []);
  const compiled = compiler.compileTemplate({ source: descriptor.template.content, filename });
  assert.deepEqual(compiled.errors, []);
  for (const style of descriptor.styles) {
    const result = compiler.compileStyle({ source: style.content, filename, id: 'offline-test', scoped: style.scoped });
    assert.deepEqual(result.errors, []);
  }
  return { filename, script: descriptor.script.content, template: descriptor.template.content };
}

const protocols = loadModule('src/protocols.js');
const constants = loadModule('src/constants.js', protocols);
const translations = loadModule('src/i18n.js', { document: { documentElement: {} } }, ['dict']);
const advancedComponent = readComponent('MethodAdvancedDialog.vue');
const themeComponent = readComponent('SshThemeDialog.vue');

function instantiate(options, initial = {}) {
  const instance = { ...options.data(), ...initial };
  for (const [key, method] of Object.entries(options.methods)) instance[key] = method.bind(instance);
  for (const [key, getter] of Object.entries(options.computed || {})) {
    Object.defineProperty(instance, key, typeof getter === 'function'
      ? { get: getter.bind(instance) }
      : { get: getter.get.bind(instance), set: getter.set.bind(instance) });
  }
  return instance;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function harness({ methodId = 'ssh', advanced = {}, detail = false, update, refresh } = {}) {
  translations.setLocale('zh');
  const store = {
    methodAdvancedDialog: {
      visible: true, methodId, methodName: methodId.toUpperCase(), advanced: freeze(advanced),
      context: detail ? { type: 'detail', assetId: 'offline-asset' } : { type: 'asset-dialog' },
    },
    methodAdvancedResult: null,
  };
  let hit = freeze({
    group: { id: 'offline-group' },
    asset: {
      id: 'offline-asset', name: 'Offline fixture', host: 'example.invalid', user: 'example',
      methods: { [methodId]: { enabled: true, primary: true, port: 2222, advanced } },
    },
  });
  const writes = [];
  const logs = [];
  const errors = [];
  const successes = [];
  const emissions = [];
  const bindings = {
    ...constants, t: translations.t, store, window: { novoTerminal: { platform: 'win32' } },
    findAsset: () => hit,
    api: {
      async updateAsset(id, payload) {
        writes.push({ id, payload });
        return update ? update(id, payload) : { ok: true };
      },
      async logWrite(entry) { logs.push(entry); },
    },
    unwrap(result) {
      if (result && result.__error) throw Object.assign(new Error(result.message), { code: result.code });
      return result;
    },
    refresh: refresh || (async () => {}),
  };
  const options = evaluate(advancedComponent.script, advancedComponent.filename, bindings);
  const initial = {
    $message: { error: (message) => errors.push(message), success: (message) => successes.push(message) },
    $emit: (...args) => emissions.push(args),
    // The dialog only reaches for $refs/$nextTick to drive el-form visuals; empty refs skips that path
    $refs: {},
    $nextTick: () => Promise.resolve(),
  };
  const dialog = instantiate(options, initial);
  dialog.loadForm();
  return {
    dialog, options, store, writes, logs, errors, successes, emissions,
    get hit() { return hit; },
    setHit(value) { hit = freeze(value); },
    theme() {
      const themeOptions = evaluate(themeComponent.script, themeComponent.filename, bindings);
      return instantiate(themeOptions, { ...initial, assetId: 'offline-asset' });
    },
  };
}

function assertRejected(h) {
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.methodAdvancedResult, null);
  assert.equal(h.dialog.saving, false);
  assert.equal(h.dialog.visible, true);
  assert.equal(h.errors.length, 1);
}

const originalKeys = ['charset', 'term', 'scrollback', 'keepAlive', 'compression', 'authType', 'privateKeyPath', 'proxyJump', 'x11Forward', 'hostKeyPolicy'];

test('SSH defaults and schema retain every field and add conditional passphrase/display', () => {
  const keys = [...originalKeys, 'privateKeyPassphrase', 'x11Display'].sort();
  assert.deepEqual(Object.keys(constants.ADVANCED_DEFAULTS.ssh).sort(), keys);
  assert.deepEqual(plain(constants.ADVANCED_FIELDS.ssh.map((f) => f.key).sort()), keys);
  const fields = Object.fromEntries(constants.ADVANCED_FIELDS.ssh.map((f) => [f.key, f]));
  assert.equal(constants.ADVANCED_DEFAULTS.ssh.privateKeyPassphrase, '');
  assert.equal(constants.ADVANCED_DEFAULTS.ssh.x11Display, '');
  assert.equal(fields.privateKeyPassphrase.type, 'password');
  assert.equal(fields.x11Display.type, 'text');
  assert.deepEqual(plain(fields.privateKeyPath.showWhen), { authType: 'publickey' });
  assert.deepEqual(plain(fields.privateKeyPassphrase.showWhen), { authType: 'publickey' });
  assert.deepEqual(plain(fields.x11Display.showWhen), { x11Forward: true });
  assert.equal(fields.keepAlive.integer, true);
  assert.equal(fields.keepAlive.min, 0);
  assert.equal(fields.keepAlive.max, 3600);
  assert.equal(constants.ADVANCED_DEFAULTS.ssh.scrollback, 2000);
  assert.equal(fields.scrollback.integer, true);
  assert.equal(fields.scrollback.min, 100);
  assert.equal(fields.scrollback.max, 20000);
  const saved = { privateKeyPassphrase: '  synthetic passphrase  ', x11Display: ':9' };
  const resolved = constants.resolveAdvanced('ssh', saved);
  assert.equal(resolved.scrollback, 2000);
  assert.equal(resolved.privateKeyPassphrase, saved.privateKeyPassphrase);
  assert.equal(resolved.x11Display, ':9');
});

test('showWhen changes visibility without losing hidden values on save', async () => {
  const advanced = { privateKeyPath: '/offline/key', privateKeyPassphrase: '  synthetic  ', x11Display: ':9' };
  const h = harness({ advanced });
  const visibleKeys = () => h.dialog.fields.map((f) => f.key);
  for (const key of ['privateKeyPath', 'privateKeyPassphrase', 'x11Display']) assert.ok(!visibleKeys().includes(key));
  h.dialog.form.authType = 'publickey';
  h.dialog.form.x11Forward = true;
  assert.equal(visibleKeys().length, 12);
  h.dialog.form.authType = 'password';
  h.dialog.form.x11Forward = false;
  await h.dialog.confirm();
  for (const [key, value] of Object.entries(advanced)) assert.equal(h.store.methodAdvancedResult.advanced[key], value);
});

test('draft save merges colors and other extras without mutating its source', async () => {
  const advanced = { colors: { foreground: '#123456', bold: '#654321' }, extra: { value: 1 }, keepAlive: 120 };
  const before = plain(advanced);
  const h = harness({ advanced });
  h.dialog.form.keepAlive = 60;
  await h.dialog.confirm();
  const result = h.store.methodAdvancedResult.advanced;
  assert.deepEqual(plain(result.colors), before.colors);
  assert.deepEqual(plain(result.extra), before.extra);
  assert.equal(result.keepAlive, 60);
  assert.deepEqual(advanced, before);
  assert.equal(h.writes.length, 0);
  assert.equal(h.dialog.visible, false);
});

test('detail save merges latest method extras, not stale dialog extras', async () => {
  const h = harness({ detail: true, advanced: { colors: { foreground: '#111111' }, removedExtra: 'old' } });
  const latest = plain(h.hit);
  latest.asset.methods.ssh.advanced = { colors: { foreground: '#222222', bold: '#333333' }, latestExtra: 7 };
  latest.asset.methods.vnc = { enabled: false, port: 5901, advanced: { viewOnly: true } };
  h.setHit(latest);
  h.dialog.form.keepAlive = 90;
  await h.dialog.confirm();
  assert.equal(h.writes.length, 1);
  const methods = h.writes[0].payload.methods;
  assert.deepEqual(plain(methods.ssh.advanced.colors), latest.asset.methods.ssh.advanced.colors);
  assert.equal(methods.ssh.advanced.latestExtra, 7);
  assert.equal(methods.ssh.advanced.removedExtra, undefined);
  assert.equal(methods.ssh.advanced.keepAlive, 90);
  assert.equal(methods.ssh.port, 2222);
  assert.equal(methods.ssh.primary, true);
  assert.deepEqual(plain(methods.vnc), latest.asset.methods.vnc);
  assert.deepEqual(plain(h.store.methodAdvancedResult.advanced), plain(methods.ssh.advanced));
  assert.equal(h.hit.asset.methods.ssh.advanced.keepAlive, undefined);
});

test('invalid keep-alive values block draft and detail saves', async () => {
  for (const detail of [false, true]) {
    for (const value of [-1, 3601, 1.5, Infinity, -Infinity, NaN, 'Infinity', '1e309', 'invalid']) {
      const h = harness({ detail });
      h.dialog.form.keepAlive = value;
      await h.dialog.confirm();
      assertRejected(h);
      assert.equal(h.errors[0], translations.t('adv.ssh.keepAliveInvalid'));
    }
  }
  const h = harness({ advanced: { keepAlive: 3601 } });
  await h.dialog.confirm();
  assertRejected(h);
});

test('keep-alive accepts endpoints and uses defaults for empty fields', async () => {
  for (const [value, expected] of [[0, 0], [3600, 3600], ['45', 45], ['', 30], ['  ', 30], [null, 30], [undefined, 30]]) {
    const h = harness();
    h.dialog.form.keepAlive = value;
    await h.dialog.confirm();
    assert.equal(h.errors.length, 0);
    assert.equal(h.store.methodAdvancedResult.advanced.keepAlive, expected);
  }
});

test('all visible SSH select fields reject invalid enum values and accept their options', async () => {
  for (const field of constants.ADVANCED_FIELDS.ssh.filter((f) => f.type === 'select')) {
    for (const value of ['', 'unsupported', '__proto__', null, 1]) {
      const h = harness();
      h.dialog.form[field.key] = value;
      await h.dialog.confirm();
      assertRejected(h);
      assert.equal(h.errors[0], translations.t('adv.ssh.invalidOption', { name: translations.t(field.labelKey) }));
    }
    for (const option of field.options) {
      const h = harness();
      h.dialog.form[field.key] = option.value;
      h.dialog.form.privateKeyPath = '/offline/key';
      await h.dialog.confirm();
      assert.equal(h.errors.length, 0);
      assert.equal(h.store.methodAdvancedResult.advanced[field.key], option.value);
    }
  }
});

test('private key path is required only for private key authentication', async () => {
  for (const value of ['', ' \t ', null, undefined]) {
    const h = harness({ advanced: { authType: 'publickey' } });
    h.dialog.form.privateKeyPath = value;
    await h.dialog.confirm();
    assertRejected(h);
    assert.equal(h.errors[0], translations.t('adv.ssh.privateKeyRequired'));
  }
  const h = harness();
  await h.dialog.confirm();
  assert.equal(h.errors.length, 0);
});

test('cleared hidden paths, passphrases and display override old values; passphrases are never trimmed', async () => {
  for (const detail of [false, true]) {
    for (const value of ['', null, undefined]) {
      const h = harness({ detail, advanced: { privateKeyPath: '/offline/old', privateKeyPassphrase: 'synthetic-old', x11Display: ':9' } });
      h.dialog.form.privateKeyPath = value;
      h.dialog.form.privateKeyPassphrase = value;
      h.dialog.form.x11Display = value;
      await h.dialog.confirm();
      const result = h.store.methodAdvancedResult.advanced;
      for (const key of ['privateKeyPath', 'privateKeyPassphrase', 'x11Display']) assert.equal(result[key], '');
    }
    for (const passphrase of ['  synthetic passphrase  ', '   ']) {
      const h = harness({ detail, advanced: { authType: 'publickey', privateKeyPath: '/offline/key' } });
      h.dialog.form.privateKeyPassphrase = passphrase;
      await h.dialog.confirm();
      assert.equal(h.store.methodAdvancedResult.advanced.privateKeyPassphrase, passphrase);
      assert.ok(!JSON.stringify(h.logs).includes('passphrase'));
      assert.ok(!JSON.stringify(h.logs).includes('/offline/key'));
    }
  }
});

test('reset only resets schema fields; cancel writes nothing and reopening reloads saved values', async () => {
  for (const detail of [false, true]) {
    const advanced = { keepAlive: 120, privateKeyPassphrase: 'synthetic', colors: { background: '#123456', bold: '#777777' } };
    const h = harness({ detail, advanced });
    h.dialog.reset();
    assert.deepEqual(plain(h.dialog.form), plain(constants.ADVANCED_DEFAULTS.ssh));
    assert.equal(h.hit.asset.methods.ssh.advanced.keepAlive, 120);
    h.dialog.visible = false;
    assert.equal(h.store.methodAdvancedResult, null);
    assert.equal(h.writes.length, 0);
    h.dialog.visible = true;
    h.options.watch.dlg.call(h.dialog, h.store.methodAdvancedDialog);
    assert.equal(h.dialog.form.keepAlive, 120);
    h.dialog.reset();
    await h.dialog.confirm();
    assert.equal(h.store.methodAdvancedResult.advanced.privateKeyPassphrase, '');
    assert.deepEqual(plain(h.store.methodAdvancedResult.advanced.colors), advanced.colors);
  }
});

test('validation translates at invocation time, with complete bilingual SSH text', () => {
  const h = harness();
  const cases = [
    ['keepAlive', -1, 'adv.ssh.keepAliveInvalid'],
    ['charset', 'invalid', 'adv.ssh.invalidOption'],
    ['privateKeyPath', '', 'adv.ssh.privateKeyRequired'],
  ];
  for (const [key, value, messageKey] of cases) {
    h.dialog.reset();
    if (key === 'privateKeyPath') h.dialog.form.authType = 'publickey';
    h.dialog.form[key] = value;
    const messages = [];
    for (const locale of ['zh', 'en']) {
      translations.setLocale(locale);
      assert.equal(h.dialog.validate(), false);
      messages.push(h.errors.at(-1));
      assert.equal(h.errors.at(-1), translations.t(messageKey, { name: translations.t('adv.ssh.charset') }));
    }
    assert.notEqual(messages[0], messages[1]);
  }
  const keys = constants.ADVANCED_FIELDS.ssh.flatMap((f) =>
    [f.labelKey, f.placeholderKey, f.hintKey, ...(f.options || []).map((o) => o.labelKey)].filter(Boolean));
  keys.push('adv.ssh.keepAliveInvalid', 'adv.ssh.invalidOption', 'adv.ssh.privateKeyRequired', 'theme.boldUnsupported');
  for (const locale of ['zh', 'en']) {
    for (const key of keys) assert.equal(typeof translations.dict[locale][key], 'string', `${locale}: ${key}`);
    assert.equal(translations.dict[locale]['adv.rdp.mstscTip'], undefined);
  }
});

test('RDP engine filtering preserves hidden values, labels and platform client options', async () => {
  const advanced = { engine: 'external', client: 'mstsc', clipboard: false, nla: false, screenMode: 'fullscreen', adminSession: true };
  const h = harness({ methodId: 'rdp', advanced });
  let keys = h.dialog.fields.map((f) => f.key);
  assert.ok(keys.includes('client'));
  assert.ok(!keys.includes('clipboard'));
  const resolution = h.dialog.allFields.find((f) => f.key === 'resolution');
  assert.equal(h.dialog.optLabel(resolution.options[0]), translations.t('adv.rdp.resolution.system'));
  assert.equal(h.dialog.clientOptions[0].value, 'mstsc');
  h.dialog.form.engine = 'ironrdp';
  keys = h.dialog.fields.map((f) => f.key);
  assert.ok(keys.includes('clipboard'));
  assert.ok(!keys.includes('client'));
  assert.equal(h.dialog.optLabel(resolution.options[0]), translations.t('adv.rdp.resolution.auto'));
  await h.dialog.confirm();
  for (const key of ['client', 'clipboard', 'nla', 'screenMode', 'adminSession']) {
    assert.equal(h.store.methodAdvancedResult.advanced[key], advanced[key]);
  }
  assert.ok(!advancedComponent.template.includes('mstscTip'));
});

test('VNC defaults, password whitespace and numeric fallbacks remain unchanged', async () => {
  const h = harness({ methodId: 'vnc', advanced: { viewOnly: true, extra: 'preserved' } });
  h.dialog.form.password = '  ';
  h.dialog.form.compressLevel = '';
  h.dialog.form.jpegQuality = 'not-a-number';
  await h.dialog.confirm();
  const result = h.store.methodAdvancedResult.advanced;
  assert.equal(result.password, '');
  assert.equal(result.compressLevel, 6);
  assert.equal(result.jpegQuality, 6);
  assert.equal(result.viewOnly, true);
  assert.equal(result.extra, 'preserved');
});

test('saving prevents duplicate writes and reset while retaining retry after IPC errors', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const h = harness({ detail: true, update: () => gate });
  h.dialog.form.keepAlive = 90;
  const pending = h.dialog.confirm();
  assert.equal(h.dialog.saving, true);
  h.dialog.reset();
  assert.equal(h.dialog.form.keepAlive, 90);
  await h.dialog.confirm();
  assert.equal(h.writes.length, 1);
  finish({ __error: true, message: 'Synthetic IPC failure', code: 'OFFLINE_FAILURE' });
  await pending;
  assert.equal(h.dialog.saving, false);
  assert.equal(h.dialog.visible, true);
  assert.equal(h.store.methodAdvancedResult, null);
  assert.deepEqual(h.errors, ['Synthetic IPC failure']);
  assert.equal(h.logs[0].meta.code, 'OFFLINE_FAILURE');
  await h.dialog.confirm();
  assert.equal(h.writes.length, 2);
  assert.match(advancedComponent.template, /:disabled="saving"/);
  assert.match(advancedComponent.template, /:close-on-press-escape="!saving"/);
  assert.match(advancedComponent.template, /:show-close="!saving"/);
});

test('late save results cannot close or overwrite a replacement dialog', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const h = harness({ detail: true, update: () => gate });
  const pending = h.dialog.confirm();
  h.store.methodAdvancedDialog = { visible: true, methodId: 'vnc', advanced: {}, context: { type: 'asset-dialog' } };
  h.options.watch.dlg.call(h.dialog, h.store.methodAdvancedDialog);
  finish({ ok: true });
  await pending;
  assert.equal(h.dialog.methodId, 'vnc');
  assert.equal(h.dialog.visible, true);
  assert.equal(h.store.methodAdvancedResult, null);
  assert.equal(h.successes.length, 0);
  assert.equal(h.dialog.saving, false);
});

test('xterm theme omits unsupported bold while preserving foreground/background/cursor/ANSI', () => {
  const colors = { foreground: '#123456', background: '#234567', cursor: '#345678', bold: '#456789', ansi: Array(16).fill('#567890') };
  const before = plain(colors);
  const resolved = constants.resolveSshTheme(freeze(colors));
  const theme = constants.sshThemeToXterm(colors);
  assert.ok(!Object.hasOwn(constants.SSH_THEME_DEFAULT, 'bold'));
  assert.ok(!Object.hasOwn(resolved, 'bold'));
  assert.ok(!Object.hasOwn(theme, 'bold'));
  for (const key of ['foreground', 'background', 'cursor']) assert.equal(theme[key], colors[key]);
  assert.equal(theme.black, colors.ansi[0]);
  assert.equal(theme.brightWhite, colors.ansi[15]);
  resolved.ansi[0] = '#000001';
  assert.deepEqual(colors, before);
  assert.ok(!themeComponent.template.includes('form.bold'));
});

test('theme reset/save preserves legacy bold data and other advanced settings without applying it', async () => {
  const h = harness({ advanced: { keepAlive: 75, colors: { foreground: '#123456', bold: '#654321', extra: 'legacy' } } });
  const theme = h.theme();
  theme.open();
  assert.equal(theme.form.foreground, '#123456');
  assert.ok(!theme.basicRows.some((row) => row.key === 'bold'));
  theme.reset();
  assert.equal(h.writes.length, 0);
  await theme.confirm();
  const advanced = h.writes[0].payload.methods.ssh.advanced;
  assert.equal(advanced.keepAlive, 75);
  assert.equal(advanced.colors.bold, '#654321');
  assert.equal(advanced.colors.extra, 'legacy');
  assert.equal(advanced.colors.foreground, constants.SSH_THEME_DEFAULT.foreground);
  assert.equal(constants.sshThemeToXterm(advanced.colors).bold, undefined);
  assert.equal(h.hit.asset.methods.ssh.advanced.colors.foreground, '#123456');
  assert.equal(h.emissions[0][0], 'saved');
});
