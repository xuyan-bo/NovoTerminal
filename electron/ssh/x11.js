const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROTOCOL = 'MIT-MAGIC-COOKIE-1';
const PROTOCOL_BYTES = Buffer.from(PROTOCOL, 'ascii');
const COOKIE_SIZE = 16;
const MAX_AUTHORITY_SIZE = 1024 * 1024;
const MAX_CHANNELS = 32;
const HANDSHAKE_TIMEOUT = 10000;
const FAMILY_INTERNET = 0;
const FAMILY_INTERNET6 = 6;
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;

function x11Error(code, message) {
  return Object.assign(new Error(message), { code });
}

function displayError() {
  return x11Error('SSH_X11_DISPLAY', 'X11 requires a local DISPLAY (for example :0, localhost:0 or [::1]:0). Set x11Display or DISPLAY and install a local X server with cookie access control. Remote displays are not supported.');
}

function authError() {
  return x11Error('SSH_X11_AUTH', 'No valid MIT-MAGIC-COOKIE-1 cookie is available for this local display. Check XAUTHORITY (or ~/.Xauthority), the display number and X server cookie access control; unauthenticated X11 forwarding is disabled.');
}

function parseDisplay(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw displayError();
  const display = value.trim();
  if (!display) throw displayError();
  const match = /^(.*):([0-9]+)(?:\.([0-9]+))?$/.exec(display);
  if (!match) throw displayError();
  const host = match[1];
  const number = Number(match[2]);
  const screen = Number(match[3] || 0);
  if (!Number.isSafeInteger(number) || number > 59535 || !Number.isSafeInteger(screen) || screen > 0xffffffff) {
    throw displayError();
  }
  if (host.startsWith('/') && !host.startsWith('//') && !host.includes(':') && platform !== 'win32') {
    return { number, screen, family: FAMILY_LOCAL, endpoint: { path: `${host}:${match[2]}` } };
  }
  if (host === '' || host === 'unix') {
    if (platform !== 'win32') {
      return { number, screen, family: FAMILY_LOCAL, endpoint: { path: `/tmp/.X11-unix/X${number}` } };
    }
    if (host === 'unix') throw displayError();
    return { number, screen, family: FAMILY_INTERNET, endpoint: { host: '127.0.0.1', port: 6000 + number } };
  }
  if (host === 'localhost' || host === '127.0.0.1') {
    return { number, screen, family: FAMILY_INTERNET, endpoint: { host: '127.0.0.1', port: 6000 + number } };
  }
  if (host === '[::1]') {
    return { number, screen, family: FAMILY_INTERNET6, endpoint: { host: '::1', port: 6000 + number } };
  }
  throw displayError();
}

function parseXauthority(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_AUTHORITY_SIZE) throw authError();
  let offset = 0;
  const records = [];
  const readNumber = () => {
    if (offset + 2 > buffer.length) throw authError();
    const result = buffer.readUInt16BE(offset);
    offset += 2;
    return result;
  };
  const readField = () => {
    const length = readNumber();
    if (offset + length > buffer.length) throw authError();
    const result = buffer.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  while (offset < buffer.length) {
    if (records.length >= 4096) throw authError();
    records.push({
      family: readNumber(),
      address: readField(),
      number: readField(),
      name: readField(),
      data: readField(),
    });
  }
  return records;
}

function selectCookie(records, target) {
  const number = Buffer.from(String(target.number), 'ascii');
  const hostname = Buffer.from(os.hostname(), 'utf8');
  const address = target.family === FAMILY_INTERNET
    ? Buffer.from([127, 0, 0, 1])
    : Buffer.from('00000000000000000000000000000001', 'hex');
  let selected;
  let bestScore = 0;
  for (const record of records) {
    if (!record.number.equals(number) || !record.name.equals(PROTOCOL_BYTES) || record.data.length !== COOKIE_SIZE) continue;
    let score = 0;
    if (record.family === FAMILY_WILD) score = 1;
    // Xlib also uses hostname-based FamilyLocal records for loopback displays.
    if (record.family === FAMILY_LOCAL && record.address.equals(hostname)) score = 2;
    if (target.family !== FAMILY_LOCAL && record.family === target.family && record.address.equals(address)) score = 3;
    if (score > bestScore) {
      selected = record.data;
      bestScore = score;
    }
  }
  if (!selected) throw authError();
  return Buffer.from(selected);
}

async function readCookie(target) {
  let buffer;
  try {
    const filename = process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority');
    const file = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    let length = 0;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_AUTHORITY_SIZE) throw authError();
      buffer = Buffer.alloc(MAX_AUTHORITY_SIZE + 1);
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
    } finally {
      await file.close();
    }
    return selectCookie(parseXauthority(buffer.subarray(0, length)), target);
  } catch (_) {
    throw authError();
  } finally {
    if (buffer) buffer.fill(0);
  }
}

function setupLength(header) {
  const littleEndian = header[0] === 0x6c;
  if (!littleEndian && header[0] !== 0x42) throw x11Error('SSH_X11_SETUP', 'Invalid X11 setup byte order.');
  const readNumber = (offset) => littleEndian ? header.readUInt16LE(offset) : header.readUInt16BE(offset);
  if (readNumber(2) !== 11 || readNumber(4) !== 0) throw x11Error('SSH_X11_SETUP', 'Unsupported X11 setup version.');
  if (readNumber(6) !== PROTOCOL_BYTES.length || readNumber(8) !== COOKIE_SIZE) {
    throw x11Error('SSH_X11_COOKIE', 'X11 setup must use a 16-byte MIT-MAGIC-COOKIE-1 cookie.');
  }
  return 12 + ((PROTOCOL_BYTES.length + 3) & ~3) + COOKIE_SIZE;
}

async function createX11Forwarder({ display, log, sessionId } = {}) {
  let target;
  const report = (level, message, code) => {
    if (!log || typeof log[level] !== 'function') return;
    log[level]('ssh', message, {
      sessionId,
      ...(target ? { displayNumber: target.number, transport: target.endpoint.path ? 'unix' : 'tcp', host: target.endpoint.host, port: target.endpoint.port } : {}),
      ...(code ? { code } : {}),
    });
  };
  let realCookie;
  try {
    const configured = display == null || (typeof display === 'string' && !display.trim()) ? process.env.DISPLAY : display;
    target = parseDisplay(configured);
    realCookie = await readCookie(target);
  } catch (error) {
    const failure = error.code === 'SSH_X11_DISPLAY' ? error : authError();
    report('error', failure.message, failure.code);
    throw failure;
  }
  let fakeCookie;
  do {
    fakeCookie = crypto.randomBytes(COOKIE_SIZE);
  } while (crypto.timingSafeEqual(fakeCookie, realCookie));
  const options = { protocol: PROTOCOL, cookie: fakeCookie.toString('hex'), screen: target.screen, single: false };
  const connections = new Set();
  let client;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    if (client) {
      client.removeListener('x11', onX11);
      client.removeListener('end', close);
      client.removeListener('close', close);
      client.removeListener('error', onClientError);
      client = null;
    }
    for (const connection of [...connections]) connection.finish();
    connections.clear();
    realCookie.fill(0);
    fakeCookie.fill(0);
    report('info', 'X11 forwarding closed');
  }

  function destroyStream(stream) {
    try {
      stream.destroy();
    } catch (_) {
      report('warn', 'Unable to close an X11 stream cleanly.', 'SSH_X11_CLOSE');
    }
  }

  function onClientError() {
    report('warn', 'X11 forwarding stopped because the SSH client failed.', 'SSH_X11_CLIENT');
    close();
  }

  function onX11(info, accept, reject) {
    if (closed || connections.size >= MAX_CHANNELS) {
      reject();
      if (!closed) report('warn', 'X11 channel limit reached.', 'SSH_X11_LIMIT');
      return;
    }
    let channel;
    let socket;
    let timer;
    let header;
    let setup;
    let length;
    let validated = false;
    let connected = false;
    let done = false;
    let channelClosed = false;
    let socketClosed = true;
    const connection = { finish };
    connections.add(connection);

    function release() {
      // ssh2 destroy sends CLOSE but the peer may never acknowledge it; retain the channel limit until then.
      if (channelClosed && socketClosed) connections.delete(connection);
    }
    function finish(code, message) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (setup) setup.fill(0);
      header = null;
      if (channel) {
        channel.removeListener('readable', onReadable);
        channel.removeListener('end', onChannelEnd);
        channel.unpipe();
        destroyStream(channel);
      }
      if (socket) {
        socket.removeListener('connect', onConnect);
        socket.unpipe();
        destroyStream(socket);
      }
      release();
      if (code) report('warn', message, code);
      else if (connected) report('info', 'X11 forwarding channel closed');
    }

    // Keep error handlers until close: destroy can deliver a queued error asynchronously.
    function onChannelClose() {
      channelClosed = true;
      channel.removeListener('error', onChannelError);
      channel.removeListener('close', onChannelClose);
      if (!validated) finish('SSH_X11_SETUP', 'X11 channel closed before its authentication setup was complete.');
      else if (!connected) finish('SSH_X11_CHANNEL', 'X11 channel closed before the local connection was ready.');
      else finish();
      release();
    }
    function onSocketClose() {
      socketClosed = true;
      socket.removeListener('error', onSocketError);
      socket.removeListener('close', onSocketClose);
      if (!connected) finish('SSH_X11_CONNECT', 'Local X server connection closed before it was ready.');
      else finish();
      release();
    }
    function onChannelError() {
      finish('SSH_X11_CHANNEL', 'X11 remote channel failed.');
    }
    function onSocketError(error) {
      const reason = error && ['ECONNREFUSED', 'ENOENT', 'EACCES', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code) ? ` (${error.code})` : '';
      finish('SSH_X11_CONNECT', `Local X server connection failed${reason}. Check that the X server is installed, running and using cookie access control.`);
    }
    function onChannelEnd() {
      if (!validated) finish('SSH_X11_SETUP', 'X11 channel ended before its authentication setup was complete.');
    }
    function armTimeout(message) {
      clearTimeout(timer);
      timer = setTimeout(() => finish('SSH_X11_TIMEOUT', message), HANDSHAKE_TIMEOUT);
      timer.unref();
    }
    function onConnect() {
      if (done || closed) return finish();
      connected = true;
      socket.pipe(channel);
      socket.write(setup, (error) => {
        setup.fill(0);
        if (done || closed) return;
        if (error) return onSocketError(error);
        clearTimeout(timer);
        report('info', 'X11 local transport connected');
        channel.pipe(socket);
      });
    }
    function onReadable() {
      if (done || validated) return;
      try {
        if (!header) {
          header = channel.read(12);
          if (!header) return;
          if (header.length !== 12) return onChannelEnd();
          length = setupLength(header);
        }
        const rest = channel.read(length - 12);
        if (!rest) return;
        if (rest.length !== length - 12) return onChannelEnd();
        const cookieOffset = (PROTOCOL_BYTES.length + 3) & ~3;
        if (!rest.subarray(0, PROTOCOL_BYTES.length).equals(PROTOCOL_BYTES)
            || !crypto.timingSafeEqual(rest.subarray(cookieOffset), fakeCookie)) {
          return finish('SSH_X11_COOKIE', 'X11 authentication protocol or forwarding cookie was rejected.');
        }
        setup = Buffer.concat([header, rest]);
        realCookie.copy(setup, 12 + cookieOffset);
        header = null;
        validated = true;
        channel.removeListener('readable', onReadable);
        channel.pause();
        armTimeout('Local X server connection timed out. Check that the X server is running.');
        socketClosed = false;
        socket = new net.Socket();
        socket.on('error', onSocketError);
        socket.once('close', onSocketClose);
        if (done || closed) {
          destroyStream(socket);
          return;
        }
        socket.once('connect', onConnect);
        socket.connect(target.endpoint);
      } catch (error) {
        if (!socket) socketClosed = true;
        if (error.code === 'SSH_X11_SETUP' || error.code === 'SSH_X11_COOKIE') finish(error.code, error.message);
        else onSocketError(error);
      }
    }

    try {
      channel = accept();
    } catch (_) {
      channelClosed = true;
      finish('SSH_X11_CHANNEL', 'Unable to accept the remote X11 channel.');
      release();
      return;
    }
    channel.on('error', onChannelError);
    channel.once('close', onChannelClose);
    if (done || closed) {
      destroyStream(channel);
      return;
    }
    channel.on('end', onChannelEnd);
    channel.on('readable', onReadable);
    armTimeout('X11 authentication setup timed out.');
    onReadable();
  }

  function attach(nextClient) {
    if (closed) throw x11Error('SSH_X11_CLOSED', 'X11 forwarding is already closed.');
    if (client === nextClient) return;
    if (client) throw x11Error('SSH_X11_STATE', 'X11 forwarding is already attached to another SSH client.');
    client = nextClient;
    client.on('x11', onX11);
    client.once('end', close);
    client.once('close', close);
    client.once('error', onClientError);
  }

  report('info', 'X11 forwarding prepared with local cookie authentication');
  return { options, attach, close };
}

module.exports = { createX11Forwarder, parseDisplay, parseXauthority };
