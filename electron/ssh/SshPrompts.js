const crypto = require('crypto');

class SshPrompts {
  constructor() {
    this.pending = new Map();
  }

  request(sender, details) {
    const prompts = details.prompts;
    if (sender.isDestroyed() || details.signal?.aborted || (details.isActive && !details.isActive())) return Promise.resolve(null);
    if (!Array.isArray(prompts) || prompts.length > 32 || Array.from(prompts).some((p) => !p || typeof p.prompt !== 'string' || p.prompt.length > 4096)) {
      return Promise.reject(Object.assign(new Error('Invalid SSH authentication challenge'), { code: 'SSH_AUTH_PROMPT' }));
    }
    if (!prompts.length) return Promise.resolve([]);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (answers) => {
        const rec = this.pending.get(requestId);
        if (!rec) return;
        clearTimeout(rec.timer);
        clearInterval(rec.activeTimer);
        if (details.signal) details.signal.removeEventListener('abort', onAbort);
        this.pending.delete(requestId);
        if (!sender.isDestroyed()) sender.send('ssh:auth-cancel', { requestId });
        resolve(answers);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(onAbort, 120000);
      const activeTimer = !details.signal && details.isActive ? setInterval(() => {
        if (!details.isActive()) finish(null);
      }, 250) : null;
      this.pending.set(requestId, { ownerId: sender.id, count: prompts.length, finish, timer, activeTimer });
      if (details.signal) details.signal.addEventListener('abort', onAbort, { once: true });
      sender.send('ssh:auth-prompt', {
        requestId, host: details.host || '', port: details.port || 22,
        name: String(details.name || '').slice(0, 4096), instructions: String(details.instructions || '').slice(0, 4096),
        prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
      });
    });
  }

  reply(ownerId, requestId, answers) {
    const rec = this.pending.get(requestId);
    if (!rec || rec.ownerId !== ownerId) return false;
    if (answers !== null && (!Array.isArray(answers) || answers.length !== rec.count || Array.from(answers).some((s) => typeof s !== 'string' || s.length > 65536))) {
      throw Object.assign(new Error('Invalid SSH authentication response'), { code: 'SSH_AUTH_RESPONSE' });
    }
    rec.finish(answers);
    return true;
  }

  closeOwner(ownerId) {
    for (const rec of this.pending.values()) {
      if (rec.ownerId === ownerId) rec.finish(null);
    }
  }

  destroyAll() {
    for (const rec of this.pending.values()) rec.finish(null);
  }
}

module.exports = { SshPrompts };
