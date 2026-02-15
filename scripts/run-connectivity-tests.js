#!/usr/bin/env node
/**
 * Run connectivity tests (YouTube, Discord API, Discord WebSocket).
 * Run this while winws is active to verify the current strategy.
 * Usage: node scripts/run-connectivity-tests.js
 */
const https = require('https');
const tls = require('tls');

const TIMEOUT = 12000;

function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      timeout: TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
    }, (res) => {
      res.resume();
      resolve(res.statusCode > 0 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function testGatewayWs() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) {}
      resolve(ok);
    };
    let s;
    try {
      s = tls.connect({
        host: 'gateway.discord.gg',
        port: 443,
        servername: 'gateway.discord.gg',
        rejectUnauthorized: true
      }, () => {
        const key = Buffer.allocUnsafe(16);
        for (let i = 0; i < 16; i++) key[i] = Math.floor(Math.random() * 256);
        const req = `GET /?v=10&encoding=json HTTP/1.1\r\nHost: gateway.discord.gg\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key.toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
        s.write(req);
      });
      s.setEncoding('utf8');
      let data = '';
      s.on('data', (chunk) => {
        data += chunk;
        if (data.includes('\r\n\r\n')) finish(data.split('\r\n')[0].includes('101'));
      });
      s.on('error', () => finish(false));
      s.on('timeout', () => finish(false));
      s.setTimeout(TIMEOUT);
    } catch (e) {
      resolve(false);
    }
  });
}

async function main() {
  console.log('Connectivity tests (run with winws active)\n');
  const yt = await get('https://www.youtube.com/');
  console.log('YouTube:        ', yt ? 'OK' : 'FAIL');
  const dcApi = await get('https://discord.com/api/v10/gateway');
  console.log('Discord API:    ', dcApi ? 'OK' : 'FAIL');
  const dcWs = await testGatewayWs();
  console.log('Discord Gateway (WebSocket):', dcWs ? 'OK' : 'FAIL');
  console.log('');
  if (yt && dcApi && dcWs) {
    console.log('All passed — strategy is OK for Discord app + YouTube.');
  } else {
    console.log('Some tests failed — try another strategy or reconnect.');
  }
}

main().catch(console.error);
