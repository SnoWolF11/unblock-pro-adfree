#!/usr/bin/env node
/**
 * Test WebSocket handshake to Discord gateway (wss://gateway.discord.gg).
 * Exit 0 if OK, 1 if fail. Used by elevated batch to verify strategy allows Discord app to load.
 * Uses only Node built-in modules.
 */
const tls = require('tls');
const net = require('net');

const host = 'gateway.discord.gg';
const port = 443;
const timeoutMs = (process.env.TIMEOUT_SEC || 12) * 1000;

function generateWsKey() {
  const buf = Buffer.allocUnsafe(16);
  for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf.toString('base64');
}

function test() {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true
    }, () => {
      const key = generateWsKey();
      const request =
        `GET /?v=10&encoding=json HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`;
      socket.write(request);
    });

    let resolved = false;
    const done = (ok) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setEncoding('utf8');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\r\n\r\n')) {
        const statusLine = data.split('\r\n')[0];
        if (statusLine.includes('101')) {
          done(true);
        } else {
          done(false);
        }
      }
    });
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
    socket.setTimeout(timeoutMs);
  });
}

test()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch(() => process.exit(1));
