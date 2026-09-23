'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => { this.alive = false; this.emit('close'); });
    socket.on('error', () => { this.alive = false; this.emit('close'); });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (true) {
      const frame = this._tryParseFrame(this._buf);
      if (!frame) break;
      this._buf = this._buf.subarray(frame.total);
      this._handleFrame(frame);
    }
  }

  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const hi = buf.readUInt32BE(offset);
      const lo = buf.readUInt32BE(offset + 4);
      len = hi * 0x100000000 + lo;
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    return { fin, opcode, payload, total: offset + len };
  }

  _handleFrame(frame) {
    if (frame.opcode === 0x8) {
      this.close();
      return;
    }
    if (frame.opcode === 0x9) {
      this._sendFrame(0xA, frame.payload);
      return;
    }
    if (frame.opcode === 0xA) return;
    if (frame.opcode === 0x1) {
      this.emit('message', frame.payload.toString('utf8'));
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.alive) return;
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, payloadBuf]));
    } catch (e) {
      this.alive = false;
    }
  }

  send(str) {
    this._sendFrame(0x1, Buffer.from(str, 'utf8'));
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (e) {}
    try { this.socket.end(); } catch (e) {}
    this.emit('close');
  }
}

function attachWebSocketServer(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = acceptKey(key);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '', ''
    ].join('\r\n');
    socket.write(responseHeaders);
    const conn = new WSConnection(socket);
    onConnection(conn, req);
  });
}

module.exports = { attachWebSocketServer };
