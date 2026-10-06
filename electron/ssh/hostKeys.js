const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function hostKeyError(code, message, cause) {
  return Object.assign(new Error(message), { code }, cause ? { cause } : {});
}

function checkActive(isActive, signal) {
  if ((signal && signal.aborted) || (isActive && !isActive())) {
    throw hostKeyError('SSH_CANCELED', 'SSH host verification canceled');
  }
}

function readKnownHosts(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw hostKeyError('SSH_HOST_KEY_READ', 'Unable to read SSH known hosts', error);
  }
  try {
    const known = JSON.parse(text);
    if (!known || typeof known !== 'object' || Array.isArray(known)) throw new Error('Invalid host map');
    for (const record of Object.values(known)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.fp !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(record.fp)) {
        throw new Error('Invalid host key record');
      }
    }
    return known;
  } catch (error) {
    throw hostKeyError('SSH_HOST_KEY_READ', 'Invalid SSH known hosts file', error);
  }
}

function getKeyType(key) {
  if (!Buffer.isBuffer(key) || key.length < 5) throw hostKeyError('SSH_HOST_KEY_INVALID', 'Invalid SSH host key');
  const length = key.readUInt32BE(0);
  if (!length || length >= key.length - 4) throw hostKeyError('SSH_HOST_KEY_INVALID', 'Invalid SSH host key');
  const keyType = key.subarray(4, 4 + length).toString('ascii');
  if (!/^[A-Za-z0-9@._+-]+$/.test(keyType)) throw hostKeyError('SSH_HOST_KEY_INVALID', 'Invalid SSH host key type');
  return keyType;
}

function createHostKeyVerifier({ file = path.join(os.homedir(), '.novoterminal', 'ssh_known_hosts.json'),
  confirm, log } = {}) {
  file = path.resolve(file);

  function writeLog(level, message, meta) {
    try {
      if (log && typeof log[level] === 'function') log[level]('ssh', message, meta);
    } catch (_) {
      // A logger failure must not change the host key trust decision.
    }
  }

  function matchKnown(known, id, fp, meta) {
    if (!Object.prototype.hasOwnProperty.call(known, id)) return false;
    if (known[id].fp !== fp) {
      writeLog('warn', 'ssh host key mismatch', meta);
      throw hostKeyError('SSH_HOST_KEY_MISMATCH', 'SSH host key changed');
    }
    return true;
  }

  function save(id, record, meta, isActive, signal) {
    // Keep reread/merge/rename synchronous: concurrent verifiers cannot lose updates.
    checkActive(isActive, signal);
    const known = readKnownHosts(file);
    if (matchKnown(known, id, record.fp, meta)) return;
    Object.defineProperty(known, id, { value: record, enumerable: true, configurable: true, writable: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    let created = false;
    try {
      checkActive(isActive, signal);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, JSON.stringify(known, null, 2), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      checkActive(isActive, signal);
      fs.renameSync(temporary, file);
      created = false;
    } catch (error) {
      if (error.code === 'SSH_CANCELED') throw error;
      throw hostKeyError('SSH_HOST_KEY_WRITE', 'Unable to save SSH known host', error);
    } finally {
      if (created) {
        try {
          fs.unlinkSync(temporary);
        } catch (error) {
          writeLog('warn', 'ssh known hosts temporary cleanup failed', { code: error.code });
        }
      }
    }
    writeLog('info', 'ssh host key saved', meta);
  }

  return async function verifyHostKey({ host, port, key, policy = 'ask', isActive, signal }) {
    const meta = { host, port, policy };
    try {
      checkActive(isActive, signal);
      if (!['ask', 'accept-new', 'strict'].includes(policy)) {
        throw hostKeyError('SSH_CONFIG', 'Invalid SSH host key policy');
      }
      if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw hostKeyError('SSH_CONFIG', 'Invalid SSH host key address');
      }
      const keyType = getKeyType(key);
      const fingerprint = crypto.createHash('sha256').update(key).digest('base64');
      Object.assign(meta, { fingerprint, keyType });
      const id = `${host}:${port}`;
      if (matchKnown(readKnownHosts(file), id, fingerprint, meta)) {
        checkActive(isActive, signal);
        return true;
      }
      if (policy === 'strict') throw hostKeyError('SSH_HOST_KEY_UNKNOWN', 'SSH host key is not trusted');
      if (policy === 'ask') {
        if (typeof confirm !== 'function') {
          throw hostKeyError('SSH_HOST_KEY_CONFIRM_REQUIRED', 'SSH host key requires confirmation');
        }
        const accepted = await confirm({ host, port, fingerprint, keyType, signal });
        checkActive(isActive, signal);
        if (accepted !== true) throw hostKeyError('SSH_HOST_KEY_REJECTED', 'SSH host key was rejected');
      }
      checkActive(isActive, signal);
      save(id, { fp: fingerprint, type: keyType, savedAt: Date.now() }, meta, isActive, signal);
      return true;
    } catch (error) {
      writeLog('warn', 'ssh host verification failed', { ...meta, code: error.code });
      throw error;
    }
  };
}

module.exports = { createHostKeyVerifier };
