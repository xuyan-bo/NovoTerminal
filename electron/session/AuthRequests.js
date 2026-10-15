const crypto = require('crypto');

/** 等用户填凭证的时限；超时按取消处理，连接照原样失败 */
const REQUEST_TIMEOUT_MS = 120000;

const USER_MAX = 256;
const SECRET_MAX = 8192;
const ID_MAX = 64;

function text(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

/** 回包来自渲染进程，逐字段收敛；结构不对就当作没有答案 */
function sanitize(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (answer.mode !== 'credential' && answer.mode !== 'inline') return null;
  return {
    mode: answer.mode,
    credentialId: text(answer.credentialId, ID_MAX),
    user: text(answer.user, USER_MAX),
    pass: text(answer.pass, SECRET_MAX),
    remember: !!answer.remember,
  };
}

/**
 * 连接时向发起连接的那个窗口要一次凭证。与 SshPrompts 同一套按渲染进程归属的等待与回收语义，
 * 区别只在载荷是结构化的（选择凭证或手填），回包不是服务器 prompt 的字符串数组。
 */
class AuthRequests {
  constructor() {
    this.pending = new Map();
  }

  request(sender, details) {
    if (sender.isDestroyed()) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (answer) => {
        const rec = this.pending.get(requestId);
        if (!rec) return;
        clearTimeout(rec.timer);
        this.pending.delete(requestId);
        if (!sender.isDestroyed()) sender.send('session:auth-cancel', { requestId });
        resolve(answer);
      };
      const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { ownerId: sender.id, finish, timer });
      sender.send('session:auth-request', {
        requestId,
        title: text(details.title, 256),
        hint: text(details.hint, 512),
        kinds: Array.isArray(details.kinds) ? details.kinds.slice(0, 4) : ['password'],
      });
    });
  }

  reply(ownerId, requestId, answer) {
    const rec = this.pending.get(requestId);
    if (!rec || rec.ownerId !== ownerId) return false;
    rec.finish(sanitize(answer));
    return true;
  }

  closeOwner(ownerId) {
    for (const rec of Array.from(this.pending.values())) {
      if (rec.ownerId === ownerId) rec.finish(null);
    }
  }

  destroyAll() {
    for (const rec of Array.from(this.pending.values())) rec.finish(null);
  }
}

module.exports = { AuthRequests };
