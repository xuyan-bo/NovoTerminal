const net = require('net');
const { EventEmitter } = require('events');

/** Telnet 协议字节与协商选项（RFC 854 及常用扩展） */
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const NOP = 241;
const GA = 249;

const ECHO = 1;
const SGA = 3;
const TTYPE = 24;
const NAWS = 31;

const OPT = {
  ECHO,
  SGA,
  TTYPE,
  NAWS,
};

const TELNET_DEFAULTS = Object.freeze({
  charset: 'UTF-8',
  term: 'xterm',
  scrollback: 2000,
  connectTimeout: 20,
});

const ENUMS = {
  charset: ['UTF-8', 'GBK', 'GB2312', 'Big5', 'ISO-8859-1', 'ASCII'],
  term: ['xterm-256color', 'xterm', 'vt100', 'linux', 'ansi'],
};

function configError(field) {
  return Object.assign(new Error(`Invalid Telnet configuration: ${field}`), { code: 'TELNET_CONFIG' });
}

function resolveAdvanced(saved) {
  if (saved != null && (typeof saved !== 'object' || Array.isArray(saved))) {
    throw configError('advanced');
  }
  const advanced = { ...TELNET_DEFAULTS };
  for (const field of Object.keys(TELNET_DEFAULTS)) {
    if (!saved || !Object.prototype.hasOwnProperty.call(saved, field)) continue;
    let value = saved[field];
    if (value == null) continue;
    if (field === 'connectTimeout' || field === 'scrollback') {
      if (typeof value === 'string') {
        value = value.trim();
        if (!value) continue;
        if (!/^\d+$/.test(value)) throw configError(field);
        value = Number(value);
      }
      const max = field === 'connectTimeout' ? 300 : 20000;
      const min = field === 'connectTimeout' ? 5 : 100;
      if (!Number.isInteger(value) || value < min || value > max) throw configError(field);
    } else {
      if (typeof value !== 'string') throw configError(field);
      value = value.trim();
      if (!value) continue;
      if (/[\x00-\x1f\x7f]/.test(value)) throw configError(field);
      if (ENUMS[field] && !ENUMS[field].includes(value)) throw configError(field);
    }
    advanced[field] = value;
  }
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

function neg(command, option) {
  return Buffer.from([IAC, command, option]);
}

/** 子协商载荷：IAC SB <opt> <payload…> IAC SE。载荷里的 IAC 需双写转义。 */
function subnegotiation(option, payload) {
  const body = [];
  for (const byte of payload) {
    body.push(byte);
    if (byte === IAC) body.push(IAC);
  }
  return Buffer.from([IAC, SB, option, ...body, IAC, SE]);
}

/**
 * 建立一条 Telnet TCP 连接。
 *
 * 返回对象继承 EventEmitter：'data' 推送已剥掉协商字节的原始缓冲区（交给上层按 charset 解码），
 * 'error' 推送致命错误，'closed' 在连接结束时触发一次。ready Promise 解析出 { write, resize }。
 * 协商采用保守策略：接受服务端的 ECHO/SGA/GA，答应 TTYPE 与 NAWS，其余一律拒绝，
 * 这样既拿到可用的字符模式终端，又不引入需要额外状态机的 LINEMODE 等扩展。
 */
function createTelnetConnection({ host, port = 23, advanced, cols = 120, rows = 32, log }) {
  const adv = resolveAdvanced(advanced);
  const targetPort = parsePort(port);
  if (typeof host !== 'string' || !host.trim()) throw configError('host');

  const emitter = new EventEmitter();
  const socket = new net.Socket();
  socket.setNoDelay(true);

  let state = 'data';
  let sbOption = null;
  let sbPayload = [];
  let pendingCommand = 0;
  let settled = false;
  let closed = false;
  let windowCols = Number.isInteger(cols) && cols > 0 ? cols : 120;
  let windowRows = Number.isInteger(rows) && rows > 0 ? rows : 32;

  const fail = (code, message) => Object.assign(new Error(message), { code });

  const send = (buf) => {
    if (!closed && !socket.destroyed) socket.write(buf);
  };

  const sendNaws = () => {
    const w = Math.max(0, Math.min(65535, windowCols));
    const h = Math.max(0, Math.min(65535, windowRows));
    send(subnegotiation(NAWS, [w >> 8, w & 0xff, h >> 8, h & 0xff]));
  };

  const sendTtype = () => {
    const name = Buffer.from(adv.term, 'ascii');
    send(subnegotiation(TTYPE, [0, ...name]));
  };

  const respondWill = (option) => {
    if (option === ECHO || option === SGA || option === GA) {
      send(neg(DO, option));
    } else {
      send(neg(DONT, option));
    }
  };

  const respondDo = (option) => {
    if (option === TTYPE) {
      send(neg(WILL, option));
    } else if (option === NAWS) {
      send(neg(WILL, option));
      sendNaws();
    } else {
      send(neg(WONT, option));
    }
  };

  const handleNegotiation = (command, option) => {
    if (command === WILL) respondWill(option);
    else if (command === DO) respondDo(option);
    else if (command === WONT) {
      // 服务端撤回能力：回 DONT 结束握手即可，不影响已有字符流
      send(neg(DONT, option));
    } else if (command === DONT) {
      send(neg(WONT, option));
    }
  };

  const handleSubnegotiation = () => {
    const payload = sbPayload;
    sbPayload = [];
    if (sbOption === TTYPE && payload[0] === 1) sendTtype();
    sbOption = null;
  };

  const feed = (chunk) => {
    const out = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i];
      if (state === 'data') {
        if (byte === IAC) state = 'iac';
        else out.push(byte);
      } else if (state === 'iac') {
        if (byte === IAC) {
          out.push(IAC);
          state = 'data';
        } else if (byte === DO || byte === DONT || byte === WILL || byte === WONT) {
          state = 'neg';
          pendingCommand = byte;
        } else if (byte === SB) {
          state = 'sb-opt';
          sbPayload = [];
        } else if (byte === NOP || byte === GA) {
          state = 'data';
        } else {
          state = 'data';
        }
      } else if (state === 'neg') {
        handleNegotiation(pendingCommand, byte);
        state = 'data';
      } else if (state === 'sb-opt') {
        sbOption = byte;
        state = 'sb-body';
      } else if (state === 'sb-body') {
        if (byte === IAC) state = 'sb-iac';
        else sbPayload.push(byte);
      } else if (state === 'sb-iac') {
        if (byte === IAC) {
          sbPayload.push(IAC);
          state = 'sb-body';
        } else if (byte === SE) {
          handleSubnegotiation();
          state = 'data';
        } else {
          state = 'sb-body';
        }
      }
    }
    if (out.length) emitter.emit('data', Buffer.from(out));
  };

  let resolveReady;
  let rejectReady;
  emitter.ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  emitter.ready.catch(() => {});

  const finish = (error) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (!settled) {
      settled = true;
      rejectReady(error || fail('TELNET_CLOSED', 'Telnet connection closed before ready'));
    }
    if (error && error.code !== 'TELNET_CANCELED') emitter.emit('error', error);
    emitter.emit('closed', error || null);
  };

  const timer = setTimeout(() => {
    finish(fail('TELNET_TIMEOUT', 'Telnet connection timed out'));
    socket.destroy();
  }, adv.connectTimeout * 1000);

  socket.on('connect', () => {
    if (closed) return;
    clearTimeout(timer);
    settled = true;
    resolveReady({
      write(bytes) {
        if (closed || socket.destroyed) return false;
        socket.write(bytes);
        return true;
      },
      resize(nextCols, nextRows) {
        if (![nextCols, nextRows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) return false;
        windowCols = nextCols;
        windowRows = nextRows;
        sendNaws();
        return true;
      },
    });
    log && log.info('telnet', 'telnet connected', { host, port: targetPort });
  });
  socket.on('data', feed);
  socket.on('error', (error) => {
    log && log.error('telnet', 'telnet socket error', {
      host, port: targetPort, code: error.code || 'TELNET_ERROR', message: error.message,
    });
    finish(error);
  });
  socket.on('close', () => finish(null));
  socket.connect(targetPort, host);

  emitter.close = () => {
    if (closed) return;
    finish(fail('TELNET_CANCELED', 'Telnet connection canceled'));
    socket.destroy();
  };
  emitter.destroy = () => socket.destroy();
  return emitter;
}

module.exports = { createTelnetConnection, resolveAdvanced, TELNET_DEFAULTS, OPT };
