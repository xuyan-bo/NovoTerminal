const net = require('net');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

/**
 * Lightweight WebSocket-to-TCP proxy for VNC (RFB) sessions.
 *
 * noVNC (renderer) speaks RFB over WebSocket.
 * Standard VNC servers (x11vnc, TigerVNC …) speak RFB over raw TCP.
 * This proxy bridges the two: it listens on a local WebSocket port
 * and forwards every frame to a TCP socket connected to the remote VNC server.
 */
class VncProxy {
  constructor({ host, port, onState, onEnd }) {
    this.host = host;
    this.port = Number(port) || 5900;
    this.onState = onState || (() => {});
    this.onEnd = onEnd || (() => {});

    this._server = null;
    this._httpServer = null;
    this._wsPort = 0;
    this._tcpSock = null;
    this._wsClient = null;
    this._closed = false;
  }

  /** Start the WebSocket server and return the local ws:// URL */
  start() {
    return new Promise((resolve, reject) => {
      this._httpServer = http.createServer();
      this._server = new WebSocketServer({ server: this._httpServer });

      this._server.on('connection', (ws) => this._onWsConnection(ws));
      this._server.on('error', (err) => this._fail(err));

      this._httpServer.once('error', (err) => {
        reject(err);
      });

      this._httpServer.listen(0, '127.0.0.1', () => {
        this._httpServer.removeAllListeners('error');
        // A later listener failure has no pending promise to reject, so it must end the session.
        this._httpServer.on('error', (err) => this._fail(err));
        const addr = this._httpServer.address();
        this._wsPort = addr.port;
        resolve({ wsUrl: `ws://127.0.0.1:${this._wsPort}`, port: this._wsPort });
      });
    });
  }

  _onWsConnection(ws) {
    if (this._wsClient) {
      ws.close(1008, 'only one VNC client allowed');
      return;
    }
    this._wsClient = ws;
    this.onState('connecting');

    const tcp = net.createConnection({ host: this.host, port: this.port }, () => {
      this._tcpSock = tcp;
      this.onState('ready');
    });

    tcp.setNoDelay(true);
    ws._socket.setNoDelay(true);

    tcp.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    });

    ws.on('message', (data) => {
      if (tcp.writable) {
        tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
    });

    const cleanup = (origin) => {
      if (this._closed) return;
      this._closed = true;
      try { tcp.destroy(); } catch (_) {}
      try { ws.close(); } catch (_) {}
      this._tcpSock = null;
      this._wsClient = null;
      this.onEnd(origin);
    };

    tcp.on('error', (err) => {
      this.onState('error', { message: err.message || 'TCP error' });
      cleanup('tcp-error');
    });

    tcp.on('close', () => cleanup('tcp-close'));

    ws.on('error', () => cleanup('ws-error'));
    ws.on('close', () => cleanup('ws-close'));
  }

  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    this.onState('error', { message: err.message || String(err) });
    this.stop();
    this.onEnd('proxy-error');
  }

  stop() {
    if (this._closed && !this._server) return;
    this._closed = true;
    try {
      if (this._wsClient) this._wsClient.close();
    } catch (_) {}
    try {
      if (this._tcpSock) this._tcpSock.destroy();
    } catch (_) {}
    try {
      this._server && this._server.close();
    } catch (_) {}
    try {
      this._httpServer && this._httpServer.close();
    } catch (_) {}
    this._wsClient = null;
    this._tcpSock = null;
    this._server = null;
    this._httpServer = null;
  }

  get wsPort() {
    return this._wsPort;
  }
}

module.exports = { VncProxy };
