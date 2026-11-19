#!/usr/bin/env node
/**
 * 模拟 Telnet 服务端 —— 用于在无真实设备时测试 NovoTerminal 的 Telnet 适配。
 *
 * 用法：
 *   node scripts/mock-telnet-server.js [选项]
 *
 * 选项：
 *   --port <n>      监听端口，默认 2323（避免与真实 23 冲突）
 *   --host <ip>     监听地址，默认 127.0.0.1；监听 0.0.0.0 可供局域网/Linux 服务器测试
 *   --user <name>   登录用户名，默认 root
 *   --pass <pass>   登录密码，默认 123456
 *   --gbk           服务端使用 GBK 编码（用于测试客户端「字符编码」高级参数）
 *   --slow <ms>     每次输出前延迟，模拟慢速设备
 *   --no-neg        不主动发起 IAC 协商（测试无协商的老设备行为）
 *
 * 行为：
 *   1. 建立 IAC 协商（WILL ECHO / WILL SGA / DO TTYPE / DO NAWS，客户端 resize 会实时更新）
 *   2. 回显 "login:" / "Password:" 提示，校验失败会重试 3 次后断开
 *   3. 登录后进入假 shell：提示符 mock@server:~# ，支持 help/ls/uname/uptime/echo/ps/exit 等命令
 *   4. 接收 UTF-8（或 --gbk）并回显，可用于验证中文与字符集设置
 *
 * 依赖：仅 Node 内置模块 + 可选 iconv-lite（GBK 模式需要，项目内自带）。
 */
'use strict';

const net = require('net');
const path = require('path');

// 解析参数（opt/has 自动补 -- 前缀：opt('port') 即 --port）
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const has = (name) => args.includes('--' + name);

const PORT = Number(opt('port')) || 2323;
const HOST = opt('host') || '127.0.0.1';
const USERNAME = opt('user') || 'root';
const PASSWORD = opt('pass') || '123456';
const GBK = has('gbk');
const SLOW = Number(opt('slow')) || 0;
const NEGOTIATE = !has('no-neg');

let iconv = null;
if (GBK) {
  try {
    iconv = require('iconv-lite');
  } catch {
    // 从 scripts/ 运行时 fallback 到项目 node_modules
    iconv = require(path.join(__dirname, '..', 'node_modules', 'iconv-lite'));
  }
}

const encodeText = (s) => (iconv ? iconv.encode(s, 'gbk') : Buffer.from(s, 'utf8'));

// ---- Telnet IAC 常量 ----
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251;
const SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;

// ---- 状态机：剥离客户端发来的 IAC，收集纯文本与 NAWS/TTYPE ----
function createParser(sock) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const out = [];
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      if (b !== IAC) {
        out.push(buf[i]);
        i += 1;
        continue;
      }
      // IAC 序列
      if (i + 1 >= buf.length) break; // 等待更多数据
      const cmd = buf[i + 1];
      if (cmd === IAC) { out.push(IAC); i += 2; continue; }
      if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
        if (i + 2 >= buf.length) break;
        const o = buf[i + 2];
        if (cmd === DO && o === OPT_NAWS) sock._peerSizeAsked = true;
        i += 3;
        continue;
      }
      if (cmd === SB) {
        // 找 IAC SE 结束
        let j = i + 2;
        let found = -1;
        while (j + 1 < buf.length) {
          if (buf[j] === IAC && buf[j + 1] === SE) { found = j; break; }
          j += 1;
        }
        if (found < 0) break; // 子协商不完整，等下一块
        const sbOpt = buf[i + 2];
        const payload = buf.slice(i + 3, found);
        if (sbOpt === OPT_TTYPE && payload[0] === 0) {
          sock._peerTerm = payload.slice(1).toString('latin1');
          log(`  [ttype] 客户端终端类型: ${sock._peerTerm}`);
        }
        if (sbOpt === OPT_NAWS) {
          const cols = payload.readUInt16BE(0);
          const rows = payload.readUInt16BE(2);
          log(`  [naws] 客户端窗口尺寸: ${cols}x${rows}`);
        }
        i = found + 2;
        continue;
      }
      i += 2; // 未知命令，跳过
    }
    buf = buf.slice(i);
    return Buffer.from(out);
  };
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} ${msg}`);
}

// ---- 假 shell ----
const FILES = ['bin', 'etc', 'home', 'root', 'usr', 'var', 'README.md', 'config.cfg'];
function fakeShell(line) {
  const cmd = line.trim();
  if (!cmd) return '';
  const [name, ...rest] = cmd.split(/\s+/);
  switch (name) {
    case 'help':
      return 'Commands: help ls uname uptime echo ps cat whoami exit\r\n';
    case 'ls': return FILES.join('  ') + '\r\n';
    case 'uname': return rest[0] === '-a' ? 'Linux mock-server 5.4.0-telnet-mock #1 SMP x86_64\r\n' : 'Linux\r\n';
    case 'uptime': return ` ${new Date().toTimeString().slice(0, 8)} up 42 days,  1 user,  load average: 0.15, 0.10, 0.05\r\n`;
    case 'echo': return rest.join(' ') + '\r\n';
    case 'whoami': return USERNAME + '\r\n';
    case 'cat': return rest[0] === 'README.md' ? 'This is a mock telnet server for NovoTerminal testing.\r\n' : `cat: ${rest[0] || ''}: No such file\r\n`;
    case 'ps': return '  PID TTY      TIME CMD\r\n    1 ?        0:01 /sbin/init\r\n  128 pts/0    0:00 -bash\r\n';
    case 'exit':
    case 'logout': return null;
    default: return `${name}: command not found (try 'help')\r\n`;
  }
}

// ---- 连接处理 ----
const server = net.createServer((sock) => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  log(`[+] 新连接 ${peer}`);
  sock.setNoDelay(true);
  const parse = createParser(sock);

  const write = (data) => {
    if (SLOW) {
      setTimeout(() => { if (!sock.destroyed && !sock.writableEnded) sock.write(data); }, SLOW);
    } else if (!sock.destroyed && !sock.writableEnded) {
      sock.write(data);
    }
  };
  const writeLine = (s) => write(encodeText(s));

  if (NEGOTIATE) {
    // 主动协商：本端 WILL ECHO / WILL SGA；请求对端 TTYPE / NAWS
    sock.write(Buffer.from([
      IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA,
      IAC, DO, OPT_TTYPE, IAC, DO, OPT_NAWS,
    ]));
  }
  // 统一状态机：login → password → shell
  let state = 'login'; // login | password | shell
  let failures = 0;
  let lineBuf = '';

  const promptLogin = () => writeLine('mock login: ');
  // 连接建立后立即发出登录提示（真实 telnetd 行为）
  promptLogin();

  sock.on('data', (chunk) => {
    if (sock.destroyed || sock.writableEnded) return; // 已关闭/半关闭后不再回应，避免 write after end
    // 应答客户端 IAC 协商：对 echo/sga/ttype/naws 回 WILL，对其余 DO 回 WONT；对 WILL 只放行 echo/sga
    for (let i = 0; i + 2 < chunk.length; i += 1) {
      if (chunk[i] === IAC && chunk[i + 1] === DO) {
        const o = chunk[i + 2];
        const accept = o === OPT_ECHO || o === OPT_SGA || o === OPT_TTYPE || o === OPT_NAWS;
        sock.write(Buffer.from([IAC, accept ? WILL : WONT, o]));
      } else if (chunk[i] === IAC && chunk[i + 1] === WILL) {
        const o = chunk[i + 2];
        sock.write(Buffer.from([IAC, o === OPT_ECHO || o === OPT_SGA ? DO : DONT, o]));
      }
    }
    const text = parse(chunk);
    if (!text.length) return;
    const decoded = GBK ? iconv.decode(text, 'gbk') : text.toString('utf8');
    lineBuf += decoded;
    // 按行处理（回车/换行结尾视为提交）
    while (/[\r\n]/.test(lineBuf)) {
      const idx = lineBuf.search(/[\r\n]/);
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (lineBuf.startsWith('\n')) lineBuf = lineBuf.slice(1);
      handleLine(line);
    }
  });

  function handleLine(line) {
    if (state === 'shell') {
      log(`  [exec] ${JSON.stringify(line)}`);
      const result = fakeShell(line);
      if (result === null) {
        writeLine('\r\nConnection closed by foreign host.\r\n');
        sock.end();
        return;
      }
      if (result) writeLine(result); // 必须走编码：GBK 模式下裸写字符串会按 UTF-8 发送导致乱码
      writeLine('mock@server:~# ');
      return;
    }
    if (state === 'login') {
      const user = line.trim();
      log(`  [login] username: ${user}`);
      if (user !== USERNAME) {
        failures += 1;
        if (failures >= 3) {
          writeLine('\r\nToo many failures. Connection closed.\r\n');
          sock.end();
          return;
        }
        writeLine(`Login incorrect (user ${user})\r\n`);
        promptLogin();
        return;
      }
      state = 'password';
      writeLine('Password: ');
      return;
    }
    // state === 'password'
    const pass = line.trim();
    state = 'login';
    if (pass !== PASSWORD) {
      failures += 1;
      log(`  [login] password wrong (第 ${failures} 次)`);
      if (failures >= 3) {
        writeLine('\r\nToo many failures. Connection closed.\r\n');
        sock.end();
        return;
      }
      writeLine('\r\nLogin incorrect\r\n');
      promptLogin();
      return;
    }
    log(`  [login] 登录成功 ${peer}`);
    state = 'shell';
    writeLine(`\r\nWelcome to Mock Telnet Server (${GBK ? 'GBK' : 'UTF-8'} mode)\r\nType 'help' for commands.\r\n`);
    writeLine('mock@server:~# ');
  }

  sock.on('error', (err) => log(`[-] 错误 ${peer}: ${err.message}`));
  sock.on('close', () => log(`[-] 断开 ${peer}`));
});

server.listen(PORT, HOST, () => {
  log(`Mock Telnet server 已启动`);
  log(`  地址: telnet://${HOST}:${PORT}`);
  log(`  账号: ${USERNAME} / ${PASSWORD}`);
  log(`  编码: ${GBK ? 'GBK' : 'UTF-8'}  协商: ${NEGOTIATE ? '开' : '关'}  慢速: ${SLOW}ms`);
  log(`  在 NovoTerminal 中添加资产: 主机 ${HOST}，端口 ${PORT}，凭证 ${USERNAME}/${PASSWORD}`);
});
