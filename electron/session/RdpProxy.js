const net = require('net');
const tls = require('tls');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

/**
 * RDCleanPath WebSocket-to-RDP proxy for IronRDP-WASM sessions.
 *
 * Embedding ironrdp-wasm cannot speak raw TCP/TLS from the browser, so it uses the
 * RDCleanPath proxy protocol (Microsoft, used by IronRDP): the WASM client opens a
 * WebSocket and sends an ASN.1/DER "RDCleanPath Request" that carries the target
 * destination plus a proposed X.224 connection request. The proxy performs the
 * TCP + X.224 + TLS handshake on behalf of the client, answers with an
 * "RDCleanPath Response" holding the X.224 confirm + server certificate chain,
 * then relays the (now TLS-encrypted) RDP stream between the WebSocket and the
 * server. Credentials are never handled here — they travel inside the TLS stream.
 *
 * This is a byte-for-byte port of the reference `rdp-proxy.js` shipped with the
 * electerm/ironrdp-wasm example, trimmed to the proxy-only portion.
 */
class RdpProxy {
  constructor({ onState, onEnd }) {
    this.onState = onState || (() => {});
    this.onEnd = onEnd || (() => {});
    this._server = null;
    this._httpServer = null;
    this._wsPort = 0;
    this._closed = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      this._httpServer = http.createServer();
      this._server = new WebSocketServer({ server: this._httpServer });
      this._server.on('connection', (ws) => this._onWsConnection(ws));
      this._server.on('error', (err) => this._fail(err));

      const onListenError = (err) => {
        this.stop();
        reject(err);
      };
      this._httpServer.once('error', onListenError);

      this._httpServer.listen(0, '127.0.0.1', () => {
        this._httpServer.removeListener('error', onListenError);
        const addr = this._httpServer.address();
        this._wsPort = addr.port;
        resolve({ wsUrl: `ws://127.0.0.1:${this._wsPort}`, port: this._wsPort });
      });
    });
  }

  _onWsConnection(ws) {
    // Exactly one browser RDP client per session.
    if (this._ws) {
      ws.close(1008, 'only one RDP client allowed');
      return;
    }
    this._ws = ws;
    this.onState('connecting');

    // The first binary message is the RDCleanPath Request PDU.
    ws.once('message', async (data) => {
      if (this._closed) return;
      try {
        const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const request = parseRDCleanPathRequest(incoming);
        const { host, port } = parseDestination(request.destination);
        const { x224Response, certChain, tlsSocket } = await performRDPHandshake(
          host,
          port,
          request.x224ConnectionRequest
        );
        if (this._closed || ws.readyState !== WebSocket.OPEN) {
          tlsSocket.destroy();
          return;
        }
        const response = buildRDCleanPathResponse(
          request.destination,
          x224Response,
          certChain
        );
        // Record target for state/log metadata.
        this._host = host;
        this._port = port;
        try {
          ws.send(response);
        } catch (_) {
          tlsSocket.destroy();
          return;
        }
        this.onState('connected', { host, port });
        this._setupRelay(ws, tlsSocket);
      } catch (err) {
        this.onState('error', { message: err.message || String(err), code: 'RDCLEANPATH_FAILED' });
        try {
          ws.send(buildRDCleanPathError(1));
        } catch (_) {}
        this._teardown(null, 'handshake-error');
      }
    });

    ws.on('error', () => this._onWSEnd('ws-error'));
    ws.on('close', () => this._onWSEnd('ws-close'));
  }

  _onWSEnd(origin) {
    if (this._closed) return;
    // The WASM client may hang up at any time; release our side quietly.
    if (this._tlsSock && !this._tlsSock.destroyed) {
      try {
        this._tlsSock.destroy();
      } catch (_) {}
    }
    this._tlsSock = null;
    this._teardown(null, origin);
  }

  _setupRelay(ws, tlsSocket) {
    this._tlsSock = tlsSocket;
    tlsSocket.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
    // Forward client frames toward the TLS server socket. Without this the
    // RDP session data is silently dropped and IronRDP never receives the
    // desktop bitmap (black screen, no error, run() hangs).
    ws.on('message', (data) => {
      if (this._tlsSock !== tlsSocket || tlsSocket.destroyed) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      tlsSocket.write(buf);
    });
    // Relay cleanup.
    tlsSocket.on('end', () => this._onTlsEnd('tls-end'));
    tlsSocket.on('error', () => this._onTlsEnd('tls-error'));
  }

  _onTlsEnd(origin) {
    if (this._closed) return;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.close();
      } catch (_) {}
    }
    this._tlsSock = null;
    this._teardown(null, origin);
  }

  _teardown(errOrigin, origin) {
    if (this._closed) return;
    this._closed = true;
    if (errOrigin) {
      this.onState('error', { origin: errOrigin });
    }
    this.onEnd(origin || errOrigin || 'closed');
  }

  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    this.onState('error', { message: err.message || String(err) });
    this.stop();
    this.onEnd('proxy-error');
  }

  stop() {
    this._closed = true;
    try {
      if (this._ws) this._ws.close();
    } catch (_) {}
    try {
      if (this._tlsSock) this._tlsSock.destroy();
    } catch (_) {}
    try {
      if (this._server) this._server.close();
    } catch (_) {}
    try {
      if (this._httpServer) this._httpServer.close();
    } catch (_) {}
    this._ws = null;
    this._tlsSock = null;
    this._server = null;
    this._httpServer = null;
  }

  get wsPort() {
    return this._wsPort;
  }
}

// ── RDCleanPath ASN.1 DER constants ──
const VERSION_1 = 3390; // 3389 + 1
const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8STRING = 0x0c;
const CTX_TAG = (n) => 0xa0 + n;

function derEncodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content]);
}

function derEncodeInteger(value) {
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]));
  const bytes = [];
  let temp = value;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return derWrap(TAG_INTEGER, Buffer.from(bytes));
}

function derEncodeUtf8String(str) {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, 'utf-8'));
}

function derEncodeOctetString(buf) {
  return derWrap(TAG_OCTET_STRING, buf);
}

function derDecodeLength(buf, offset) {
  const first = buf[offset];
  if (first < 0x80) return { length: first, bytesRead: 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | buf[offset + 1 + i];
  }
  return { length, bytesRead: 1 + numBytes };
}

function derDecodeTLV(buf, offset) {
  const tag = buf[offset];
  const { length, bytesRead } = derDecodeLength(buf, offset + 1);
  const headerLen = 1 + bytesRead;
  return {
    tag,
    value: buf.slice(offset + headerLen, offset + headerLen + length),
    totalLength: headerLen + length,
  };
}

function derDecodeInteger(buf) {
  let val = 0;
  for (let i = 0; i < buf.length; i++) val = (val << 8) | buf[i];
  return val;
}

function derDecodeChildren(buf) {
  const children = [];
  let offset = 0;
  while (offset < buf.length) {
    const tlv = derDecodeTLV(buf, offset);
    children.push(tlv);
    offset += tlv.totalLength;
  }
  return children;
}

function parseRDCleanPathRequest(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const outer = derDecodeTLV(buf, 0);
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected SEQUENCE, got 0x${outer.tag.toString(16)}`);
  }
  let version = null;
  let destination = null;
  let x224ConnectionRequest = null;
  for (const child of derDecodeChildren(outer.value)) {
    const ctxTag = child.tag & 0x1f;
    if (ctxTag === 0) {
      version = derDecodeInteger(derDecodeTLV(child.value, 0).value);
    } else if (ctxTag === 2) {
      destination = derDecodeTLV(child.value, 0).value.toString('utf-8');
    } else if (ctxTag === 6) {
      x224ConnectionRequest = derDecodeTLV(child.value, 0).value;
    }
  }
  if (version !== VERSION_1) {
    throw new Error(`Unsupported RDCleanPath version: ${version}`);
  }
  if (!destination) throw new Error('Missing destination in RDCleanPath request');
  if (!x224ConnectionRequest) throw new Error('Missing x224 connection PDU');
  return { destination, x224ConnectionRequest };
}

function buildRDCleanPathResponse(serverAddr, x224Response, certChain) {
  const parts = [];
  parts.push(derWrap(CTX_TAG(0), derEncodeInteger(VERSION_1)));
  parts.push(derWrap(CTX_TAG(6), derEncodeOctetString(x224Response)));
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map(derEncodeOctetString)));
  parts.push(derWrap(CTX_TAG(7), certSeq));
  parts.push(derWrap(CTX_TAG(9), derEncodeUtf8String(serverAddr)));
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

function buildRDCleanPathError(errorCode) {
  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      derWrap(CTX_TAG(0), derEncodeInteger(VERSION_1)),
      derWrap(CTX_TAG(1), derWrap(TAG_SEQUENCE, derWrap(CTX_TAG(0), derEncodeInteger(errorCode)))),
    ])
  );
}

function parseDestination(destination) {
  if (destination.startsWith('[')) {
    const bracketEnd = destination.indexOf(']');
    if (bracketEnd === -1) throw new Error(`Invalid IPv6 destination: ${destination}`);
    const rest = destination.slice(bracketEnd + 1);
    const port = rest.startsWith(':') ? parseInt(rest.slice(1), 10) : 3389;
    return { host: destination.slice(1, bracketEnd), port };
  }
  const lastColon = destination.lastIndexOf(':');
  if (lastColon === -1) return { host: destination, port: 3389 };
  const port = parseInt(destination.slice(lastColon + 1), 10);
  return { host: destination.slice(0, lastColon), port: Number.isNaN(port) ? 3389 : port };
}

function performRDPHandshake(host, port, x224Request) {
  return tryRDPHandshake(host, port, x224Request)
    .catch((err) => {
      // BoringSSL 严格校验证书 keyUsage：自签 RDP 证书缺少 digitalSignature 位时，
      // TLS 1.3 握手会报 KEY_USAGE_BIT_INCORRECT（mstsc 等用系统 TLS 不拦截）。
      // 回退到 TLS 1.2 重试以兼容这类 RDP 网关证书；不影响正常服务器（保持默认版本优先）。
      if (!/KEY_USAGE_BIT_INCORRECT/.test((err && err.message) || '')) throw err;
      return tryRDPHandshake(host, port, x224Request, true);
    });
}

function tryRDPHandshake(host, port, x224Request, tls12only) {
  return new Promise((resolve, reject) => {
    const tcpSocket = net.createConnection({ host, port }, () => {
      tcpSocket.write(x224Request);
    });
    tcpSocket.once('error', (err) => {
      reject(new Error(`TCP connection failed: ${err.message}`));
    });
    tcpSocket.setTimeout(15000, () => {
      tcpSocket.destroy();
      reject(new Error('Connection timed out'));
    });
    tcpSocket.once('data', (x224Response) => {
      if (x224Response.length === 0) {
        tcpSocket.destroy();
        reject(new Error('RDP server closed without X.224 response'));
        return;
      }
      tcpSocket.removeAllListeners('error');
      tcpSocket.removeAllListeners('data');
      tcpSocket.setTimeout(0);
      const tlsOpts = {
        socket: tcpSocket,
        servername: host,
        rejectUnauthorized: false, // RDP servers use self-signed certs
      };
      if (tls12only) {
        tlsOpts.minVersion = 'TLSv1.2';
        tlsOpts.maxVersion = 'TLSv1.2';
      }
      const tlsSocket = tls.connect(tlsOpts, () => {
        const peerCert = tlsSocket.getPeerCertificate(true);
        resolve({
          x224Response: Buffer.from(x224Response),
          certChain: extractCertChain(peerCert),
          tlsSocket,
        });
      });
      tlsSocket.once('error', (err) => {
        reject(new Error(`TLS handshake failed: ${err.message}`));
      });
    });
  });
}

function extractCertChain(peerCert) {
  const certs = [];
  if (!peerCert || !peerCert.raw) return certs;
  const seen = new Set();
  let current = peerCert;
  while (current && current.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString('hex');
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    certs.push(Buffer.from(current.raw));
    if (current.issuerCertificate && current.issuerCertificate !== current) {
      current = current.issuerCertificate;
    } else {
      break;
    }
  }
  return certs;
}

module.exports = { RdpProxy, parseDestination };