#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const https = require('https');
const dgram = require('dgram');
const { execSync, spawn, exec } = require('child_process');
const os = require('os');

// ============= CONFIG =============

const DOMAINS_DISCORD = [
  'discord.com', 'cdn.discordapp.com', 'gateway.discord.gg',
  'media.discordapp.net', 'images-ext-1.discordapp.net',
  'dl.discordapp.net', 'discordapp.com'
];
const DOMAINS_YOUTUBE = [
  'youtube.com', 'www.youtube.com', 'googlevideo.com',
  'i.ytimg.com', 'youtubei.googleapis.com'
];
const ALL_DOMAINS = [...DOMAINS_DISCORD, ...DOMAINS_YOUTUBE];

const DNS_SERVERS = [
  { name: 'ISP (system)', server: null },
  { name: '1.1.1.1 (Cloudflare)', server: '1.1.1.1' },
  { name: '8.8.8.8 (Google)', server: '8.8.8.8' },
];

const TEST_PORTS = [80, 443, 2053, 2083, 2087, 2096, 8443];

const CURL_TIMEOUT = 8;
const STRATEGY_INIT_DELAY = 3500;

const TEST_URLS = {
  discordApi:  'https://discord.com/api/v10/gateway',
  discordCdn:  'https://cdn.discordapp.com/',
  discordMedia:'https://media.discordapp.net/',
  youtube:     'https://www.youtube.com/',
  youtubeImg:  'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
};

// ============= LOGGING =============

let logLines = [];
const startTime = new Date();

function log(msg) {
  const line = msg;
  console.log(line);
  logLines.push(line);
}

function logSection(title) {
  log('');
  log(`--- ${title} ---`);
  log('');
}

// ============= UTILITIES =============

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function timestamp() {
  const d = startTime;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function findBinary() {
  const candidates = [
    path.join(__dirname, '..', 'bin', 'win32', 'winws.exe'),
    path.join(process.env.APPDATA || '', 'UnblockPro', 'bin', 'win32', 'winws.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'UnblockPro', 'bin', 'win32', 'winws.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findListsDir() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'UnblockPro', 'lists'),
    path.join(__dirname, '..', 'lists'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'list-general.txt'))) return p;
  }
  // Auto-generate if not found
  const genScript = path.join(__dirname, 'generate-lists.js');
  if (fs.existsSync(genScript)) {
    try { execSync(`node "${genScript}"`, { stdio: 'pipe' }); } catch (e) {}
    const fallback = path.join(__dirname, '..', 'lists');
    if (fs.existsSync(fallback) && fs.existsSync(path.join(fallback, 'list-general.txt'))) return fallback;
  }
  return null;
}

function killWinws() {
  try { execSync('taskkill /F /IM winws.exe 2>nul', { stdio: 'pipe' }); } catch (e) {}
}

function curlTest(url, timeout = CURL_TIMEOUT) {
  return new Promise(resolve => {
    const start = Date.now();
    exec(
      `curl --connect-timeout ${timeout} -s -o nul -w "%{http_code}" "${url}"`,
      { timeout: (timeout + 5) * 1000 },
      (err, stdout) => {
        const elapsed = Date.now() - start;
        if (err) { resolve({ ok: false, code: 0, ms: elapsed, error: err.message.substring(0, 80) }); return; }
        const code = parseInt(stdout.trim(), 10);
        resolve({ ok: code > 0 && code < 500, code, ms: elapsed });
      }
    );
  });
}

// ============= STAGE 1: DNS =============

function resolveDns(domain, server) {
  return new Promise(resolve => {
    const start = Date.now();
    if (!server) {
      dns.resolve4(domain, (err, addresses) => {
        resolve({ addresses: addresses || [], ms: Date.now() - start, error: err ? err.code : null });
      });
    } else {
      const resolver = new dns.Resolver();
      resolver.setServers([server]);
      resolver.resolve4(domain, (err, addresses) => {
        resolve({ addresses: addresses || [], ms: Date.now() - start, error: err ? err.code : null });
      });
    }
  });
}

async function stageDns() {
  logSection('STAGE 1: DNS RESOLUTION');
  log('Comparing DNS responses from ISP vs clean DNS servers.');
  log('If ISP returns different IPs, DNS is being poisoned.');
  log('');

  let poisonCount = 0;
  const results = {};

  for (const domain of ALL_DOMAINS) {
    results[domain] = {};
    const row = [];
    for (const { name, server } of DNS_SERVERS) {
      const r = await resolveDns(domain, server);
      results[domain][name] = r;
      const ips = r.addresses.length > 0 ? r.addresses.join(', ') : `ERROR(${r.error})`;
      row.push({ name, ips, ms: r.ms });
    }

    log(`  ${domain}`);
    for (const r of row) {
      log(`    ${r.name.padEnd(25)} → ${r.ips.padEnd(40)} (${r.ms}ms)`);
    }

    const ispIps = (results[domain]['ISP (system)'].addresses || []).sort().join(',');
    const cfIps = (results[domain]['1.1.1.1 (Cloudflare)'].addresses || []).sort().join(',');
    const gIps = (results[domain]['8.8.8.8 (Google)'].addresses || []).sort().join(',');

    if (ispIps && cfIps && ispIps !== cfIps) {
      log(`    ** DNS POISONED — ISP returns different IPs than Cloudflare **`);
      poisonCount++;
    } else if (!ispIps && cfIps) {
      log(`    ** DNS BLOCKED — ISP fails to resolve, Cloudflare works **`);
      poisonCount++;
    } else {
      log(`    OK`);
    }
    log('');
  }

  log(`DNS Summary: ${poisonCount > 0 ? `${poisonCount} domains POISONED/BLOCKED` : 'No DNS poisoning detected'}`);
  return { poisonCount, results };
}

// ============= STAGE 2: TCP CONNECTIVITY =============

function tcpConnect(host, port, timeout = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve({ ok: true, ms: Date.now() - start }); });
    socket.on('error', (err) => { socket.destroy(); resolve({ ok: false, ms: Date.now() - start, error: err.code }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, ms: Date.now() - start, error: 'TIMEOUT' }); });
    socket.connect(port, host);
  });
}

function udpTest(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const start = Date.now();
    const client = dgram.createSocket('udp4');
    const timer = setTimeout(() => { client.close(); resolve({ ok: false, ms: Date.now() - start, error: 'TIMEOUT' }); }, timeout);
    client.on('message', () => { clearTimeout(timer); client.close(); resolve({ ok: true, ms: Date.now() - start }); });
    client.on('error', (err) => { clearTimeout(timer); client.close(); resolve({ ok: false, ms: Date.now() - start, error: err.code }); });
    const buf = Buffer.alloc(32, 0);
    client.send(buf, 0, buf.length, port, host);
  });
}

async function stageTcp() {
  logSection('STAGE 2: TCP/UDP CONNECTIVITY');
  log('Testing raw TCP connections to Discord/YouTube endpoints.');
  log('');

  const hosts = ['discord.com', 'cdn.discordapp.com', 'gateway.discord.gg', 'youtube.com', 'www.youtube.com'];
  const resolvedIps = {};

  for (const host of hosts) {
    try {
      const cfResolver = new dns.Resolver();
      cfResolver.setServers(['1.1.1.1']);
      const ips = await new Promise((res, rej) => cfResolver.resolve4(host, (e, a) => e ? rej(e) : res(a)));
      resolvedIps[host] = ips[0];
    } catch (e) {
      try {
        const ips = await new Promise((res, rej) => dns.resolve4(host, (e, a) => e ? rej(e) : res(a)));
        resolvedIps[host] = ips[0];
      } catch (e2) {
        resolvedIps[host] = null;
      }
    }
  }

  for (const host of hosts) {
    const ip = resolvedIps[host];
    if (!ip) { log(`  ${host}: CANNOT RESOLVE`); continue; }
    log(`  ${host} (${ip}):`);

    for (const port of TEST_PORTS) {
      const r = await tcpConnect(ip, port, 5000);
      const status = r.ok ? 'OK' : `FAIL(${r.error})`;
      log(`    TCP :${String(port).padEnd(5)} → ${status.padEnd(20)} (${r.ms}ms)`);
    }

    const udp = await udpTest(ip, 443, 3000);
    log(`    UDP :443   → ${udp.ok ? 'RESPONSE' : `NO RESPONSE(${udp.error})`} (${udp.ms}ms)`);
    log('');
  }
}

// ============= STAGE 3: TLS HANDSHAKE =============

function tlsHandshake(host, ip, servername, timeout = 8000) {
  return new Promise(resolve => {
    const start = Date.now();
    let done = false;
    const finish = (result) => { if (done) return; done = true; resolve({ ...result, ms: Date.now() - start }); };

    try {
      const socket = tls.connect({
        host: ip || host,
        port: 443,
        servername: servername,
        timeout: timeout,
        rejectUnauthorized: false,
      }, () => {
        const proto = socket.getProtocol();
        const cipher = socket.getCipher();
        socket.destroy();
        finish({ ok: true, proto, cipher: cipher ? cipher.name : 'unknown' });
      });
      socket.on('error', (err) => { socket.destroy(); finish({ ok: false, error: err.code || err.message }); });
      socket.on('timeout', () => { socket.destroy(); finish({ ok: false, error: 'TIMEOUT' }); });
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

async function stageTls() {
  logSection('STAGE 3: TLS HANDSHAKE ANALYSIS');
  log('Testing TLS connections with real vs spoofed SNI.');
  log('If real SNI fails but spoofed works → DPI blocks by SNI inspection.');
  log('');

  const targets = [
    { host: 'discord.com', sni: 'discord.com', label: 'Discord (real SNI)' },
    { host: 'discord.com', sni: 'www.google.com', label: 'Discord IP (spoofed SNI: google)' },
    { host: 'cdn.discordapp.com', sni: 'cdn.discordapp.com', label: 'Discord CDN (real SNI)' },
    { host: 'cdn.discordapp.com', sni: 'www.google.com', label: 'Discord CDN (spoofed SNI: google)' },
    { host: 'gateway.discord.gg', sni: 'gateway.discord.gg', label: 'Discord Gateway (real SNI)' },
    { host: 'gateway.discord.gg', sni: 'www.google.com', label: 'Discord Gateway (spoofed SNI: google)' },
    { host: 'youtube.com', sni: 'youtube.com', label: 'YouTube (real SNI)' },
    { host: 'youtube.com', sni: 'www.google.com', label: 'YouTube (spoofed SNI: google)' },
    { host: 'media.discordapp.net', sni: 'media.discordapp.net', label: 'Discord Media (real SNI)' },
    { host: 'media.discordapp.net', sni: 'www.google.com', label: 'Discord Media (spoofed SNI: google)' },
  ];

  const resolvedCache = {};
  let sniBlocked = 0;

  for (const t of targets) {
    let ip = resolvedCache[t.host];
    if (!ip) {
      try {
        const resolver = new dns.Resolver();
        resolver.setServers(['1.1.1.1']);
        const ips = await new Promise((res, rej) => resolver.resolve4(t.host, (e, a) => e ? rej(e) : res(a)));
        ip = ips[0];
        resolvedCache[t.host] = ip;
      } catch (e) {
        log(`  ${t.label}: CANNOT RESOLVE HOST`);
        continue;
      }
    }

    const r = await tlsHandshake(t.host, ip, t.sni);
    if (r.ok) {
      log(`  ${t.label.padEnd(50)} → OK (${r.proto}, ${r.cipher}) [${r.ms}ms]`);
    } else {
      log(`  ${t.label.padEnd(50)} → BLOCKED (${r.error}) [${r.ms}ms]`);
      if (t.sni === t.host) sniBlocked++;
    }
  }

  log('');
  if (sniBlocked > 0) {
    log(`TLS Summary: ${sniBlocked} real SNI connections blocked — DPI is inspecting SNI field`);
  } else {
    log('TLS Summary: All TLS connections succeeded — blocking may be deeper than SNI');
  }

  return { sniBlocked };
}

// ============= STRATEGY BUILDER (standalone copy) =============

function buildStrategies(binDir, listsDir) {
  const q = (f) => path.join(binDir, f);
  const l = (f) => path.join(listsDir, f);

  const WF = ['--wf-tcp=80,443,2053,2083,2087,2096,8443', '--wf-udp=443,19294-19344,50000-50100'];

  function r1(reps = 6) {
    return ['--filter-udp=443', `--hostlist=${l('list-general.txt')}`, `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake', `--dpi-desync-repeats=${reps}`, `--dpi-desync-fake-quic=${q('quic_initial_www_google_com.bin')}`, '--new'];
  }
  function r2() {
    return ['--filter-udp=19294-19344,50000-50100', '--filter-l7=discord,stun', '--dpi-desync=fake', '--dpi-desync-repeats=6', '--new'];
  }
  function r3(method, extra = []) {
    return ['--filter-tcp=2053,2083,2087,2096,8443', '--hostlist-domains=discord.media', `--dpi-desync=${method}`, ...extra, '--new'];
  }
  function r4(method, extra = []) {
    return ['--filter-tcp=443', `--hostlist=${l('list-google.txt')}`, '--ip-id=zero', `--dpi-desync=${method}`, ...extra, '--new'];
  }
  function r5(method, extra = []) {
    return ['--filter-tcp=80,443', `--hostlist=${l('list-general.txt')}`, `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      `--dpi-desync=${method}`, ...extra, '--new'];
  }
  function r6(reps = 6) {
    return ['--filter-udp=443', `--ipset=${l('ipset-all.txt')}`, `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake', `--dpi-desync-repeats=${reps}`, `--dpi-desync-fake-quic=${q('quic_initial_www_google_com.bin')}`, '--new'];
  }
  function r7(method, extra = []) {
    return ['--filter-tcp=80,443', `--ipset=${l('ipset-all.txt')}`, `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      `--dpi-desync=${method}`, ...extra, '--new'];
  }
  function r8(reps = 12, cut = 'n2') {
    return ['--filter-udp=12', `--ipset=${l('ipset-all.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake', `--dpi-desync-repeats=${reps}`, '--dpi-desync-any-protocol=1',
      `--dpi-desync-fake-unknown-udp=${q('quic_initial_www_google_com.bin')}`, `--dpi-desync-cutoff=${cut}`];
  }
  function discTcp(method, extra = []) {
    return ['--filter-tcp=443', `--hostlist=${l('list-discord.txt')}`, `--dpi-desync=${method}`, ...extra, '--new'];
  }
  function std8(method, e3, e4, e5, e7, opts = {}) {
    const qr = opts.quicRepeats || 6; const gr = opts.gameRepeats || 12; const co = opts.cutoff || 'n2';
    return [...WF, ...r1(qr), ...r2(), ...r3(method, e3), ...r4(method, e4), ...r5(method, e5), ...r6(qr), ...r7(method, e7), ...r8(gr, co)];
  }

  const tG = q('tls_clienthello_www_google_com.bin');
  const t4 = q('tls_clienthello_4pda_to.bin');
  const tM = q('tls_clienthello_max_ru.bin');

  return [
    { name: 'general', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=568','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${t4}`],
      ['--dpi-desync-split-seqovl=568','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${t4}`],
      {cutoff:'n2'}) },
    { name: 'ALT', args: std8('fake,fakedsplit',
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n3'}) },
    { name: 'ALT2', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2',`--dpi-desync-split-seqovl-pattern=${tG}`],
      {cutoff:'n2'}) },
    { name: 'ALT3', args: [...WF,...r1(6),...r2(),
      ...r3('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com','--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1','--dpi-desync-fooling=ts']),
      ...r4('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com','--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1','--dpi-desync-fooling=ts']),
      ...r5('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru','--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1','--dpi-desync-fooling=ts',`--dpi-desync-fake-http=${tM}`]),
      ...r6(6),
      ...r7('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru','--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1','--dpi-desync-fooling=ts',`--dpi-desync-fake-http=${tM}`]),
      ...r8(10,'n4')] },
    { name: 'ALT4', args: std8('fake,multisplit',
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=1000',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=1000',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=1000',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=1000',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n2'}) },
    { name: 'ALT5 (syndata)', args: [...WF,...r1(6),...r2(),
      '--filter-l3=ipv4','--filter-tcp=443,2053,2083,2087,2096,8443',
      `--hostlist-exclude=${l('list-exclude.txt')}`,`--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=syndata,multidisorder','--new',
      ...r6(6),...r8(14,'n3')] },
    { name: 'ALT6', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      {cutoff:'n2'}) },
    { name: 'ALT7', args: std8('fake',
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n2'}) },
    { name: 'ALT8', args: std8('fake',
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=10000000',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=10000000',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=10000000',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=10000000',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n2'}) },
    { name: 'ALT9', args: std8('hostfakesplit',
      ['--dpi-desync-repeats=4','--dpi-desync-fooling=ts','--dpi-desync-hostfakesplit-mod=host=www.google.com'],
      ['--dpi-desync-repeats=4','--dpi-desync-fooling=ts','--dpi-desync-hostfakesplit-mod=host=www.google.com'],
      ['--dpi-desync-repeats=4','--dpi-desync-fooling=ts,md5sig','--dpi-desync-hostfakesplit-mod=host=ozon.ru'],
      ['--dpi-desync-repeats=4','--dpi-desync-fooling=ts','--dpi-desync-hostfakesplit-mod=host=ozon.ru'],
      {cutoff:'n2'}) },
    { name: 'ALT10', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=652','--dpi-desync-split-pos=2'],
      {cutoff:'n2'}) },
    { name: 'ALT11', args: [...WF,...r1(11),...r2(),
      ...r3('fake,multisplit',['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=8',`--dpi-desync-split-seqovl-pattern=${tG}`,`--dpi-desync-fake-tls=${tG}`]),
      ...r4('fake,multisplit',['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=8',`--dpi-desync-split-seqovl-pattern=${tG}`,`--dpi-desync-fake-tls=${tG}`]),
      ...r5('fake,multisplit',['--dpi-desync-split-seqovl=664','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=8',`--dpi-desync-split-seqovl-pattern=${tM}`,`--dpi-desync-fake-tls=${tM}`,`--dpi-desync-fake-http=${tM}`]),
      ...r6(11),
      ...r7('fake,multisplit',['--dpi-desync-split-seqovl=664','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=8',`--dpi-desync-split-seqovl-pattern=${tM}`,`--dpi-desync-fake-tls=${tM}`,`--dpi-desync-fake-http=${tM}`]),
      ...r8(10,'n4')] },
    { name: 'SIMPLE FAKE', args: std8('fake',
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n3'}) },
    { name: 'SIMPLE FAKE ALT', args: std8('fake,fakedsplit',
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=ts','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n3'}) },
    { name: 'SIMPLE FAKE ALT2', args: std8('fake',
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n3'}) },
    { name: 'FAKE TLS AUTO', args: [...WF,...r1(11),...r2(),
      ...r3('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...r4('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...r5('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',`--dpi-desync-fake-http=${tM}`]),
      ...r6(11),
      ...r7('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',`--dpi-desync-fake-http=${tM}`]),
      ...r8(10,'n2')] },
    { name: 'FAKE TLS AUTO ALT3', args: [...WF,...r1(11),...r2(),
      ...r3('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...r4('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...r5('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',`--dpi-desync-fake-http=${tM}`]),
      ...r6(11),
      ...r7('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',`--dpi-desync-fake-http=${tM}`]),
      ...r8(11,'n2')] },
    { name: 'combo:syndata+badseq', args: [...WF,...r1(6),...r2(),
      ...r3('fake',['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2']),
      ...discTcp('fake',['--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--dpi-desync-badseq-increment=2']),
      '--filter-l3=ipv4','--filter-tcp=443','--dpi-desync=syndata,multidisorder','--new',
      '--filter-tcp=80','--dpi-desync=fake','--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--new',
      ...r6(6),...r8(12,'n2')] },
    { name: 'combo:syndata+multisplit', args: [...WF,...r1(6),...r2(),
      ...r3('multisplit',['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1']),
      ...discTcp('multisplit',['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1']),
      '--filter-l3=ipv4','--filter-tcp=443','--dpi-desync=syndata,multidisorder','--new',
      '--filter-tcp=80','--dpi-desync=multisplit','--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1','--new',
      ...r6(6),...r8(12,'n2')] },
    { name: 'syndata-only', args: [...WF,...r1(6),...r2(),
      '--filter-l3=ipv4','--filter-tcp=443,2053,2083,2087,2096,8443',
      `--hostlist-exclude=${l('list-exclude.txt')}`,`--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=syndata,multidisorder','--new',
      '--filter-tcp=80',`--hostlist=${l('list-general.txt')}`,
      `--hostlist-exclude=${l('list-exclude.txt')}`,`--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake','--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--new',
      ...r6(6),...r8(14,'n3')] },
    { name: 'fake-multidisorder-tlsmod', args: [...WF,...r1(11),...r2(),
      ...r3('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...r4('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...r5('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru',`--dpi-desync-fake-http=${tM}`]),
      ...r6(11),
      ...r7('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru',`--dpi-desync-fake-http=${tM}`]),
      ...r8(11,'n2')] },
    { name: 'multisplit-900', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=900','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=900','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=900','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${t4}`],
      ['--dpi-desync-split-seqovl=900','--dpi-desync-split-pos=1',`--dpi-desync-split-seqovl-pattern=${t4}`],
      {cutoff:'n2'}) },
    { name: 'fake+multisplit-ts', args: std8('fake,multisplit',
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=6',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=6',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=568','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=6',`--dpi-desync-fake-tls=${t4}`,`--dpi-desync-split-seqovl-pattern=${t4}`],
      ['--dpi-desync-split-seqovl=568','--dpi-desync-split-pos=1','--dpi-desync-fooling=ts','--dpi-desync-repeats=6',`--dpi-desync-fake-tls=${t4}`,`--dpi-desync-split-seqovl-pattern=${t4}`],
      {cutoff:'n3'}) },
    { name: 'combo:syndata+hostfakesplit', args: [...WF,...r1(6),...r2(),
      ...r3('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com','--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1','--dpi-desync-fooling=ts']),
      ...discTcp('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com','--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1','--dpi-desync-fooling=ts']),
      '--filter-l3=ipv4','--filter-tcp=443','--dpi-desync=syndata,multidisorder','--new',
      '--filter-tcp=80','--dpi-desync=fake,hostfakesplit','--dpi-desync-fooling=ts','--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1','--new',
      ...r6(6),...r8(12,'n2')] },
    { name: 'combo:syndata+faketls', args: [...WF,...r1(11),...r2(),
      ...r3('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...discTcp('fake,multidisorder',['--dpi-desync-split-pos=1,midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=badseq','--dpi-desync-fake-tls=0x00000000','--dpi-desync-fake-tls=!','--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      '--filter-l3=ipv4','--filter-tcp=443','--dpi-desync=syndata,multidisorder','--new',
      '--filter-tcp=80','--dpi-desync=fake','--dpi-desync-repeats=6','--dpi-desync-fooling=badseq','--new',
      ...r6(11),...r8(11,'n2')] },
    { name: 'fake-md5sig', args: std8('fake',
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n2'}) },
    { name: 'fake-md5sig+badseq', args: std8('fake',
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig,badseq','--dpi-desync-badseq-increment=1',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig,badseq','--dpi-desync-badseq-increment=1',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig,badseq','--dpi-desync-badseq-increment=1',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig,badseq','--dpi-desync-badseq-increment=1',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n2'}) },
    { name: 'disorder-midsld', args: std8('multidisorder',
      ['--dpi-desync-split-pos=1,midsld'],['--dpi-desync-split-pos=1,midsld'],
      ['--dpi-desync-split-pos=1,midsld'],['--dpi-desync-split-pos=1,midsld'],
      {cutoff:'n2'}) },
    { name: 'multisplit-seqovl-2', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=2','--dpi-desync-split-pos=2'],['--dpi-desync-split-seqovl=2','--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=2','--dpi-desync-split-pos=2'],['--dpi-desync-split-seqovl=2','--dpi-desync-split-pos=2'],
      {cutoff:'n2'}) },
    { name: 'fake-disorder-tlsmod', args: [...WF,...r1(11),...r2(),
      ...r3('fake,multidisorder',['--dpi-desync-split-pos=midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fake-tls-mod=rnd,sni=www.google.com']),
      ...r4('fake,multidisorder',['--dpi-desync-split-pos=midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fake-tls-mod=rnd,sni=www.google.com']),
      ...r5('fake,multidisorder',['--dpi-desync-split-pos=midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fake-tls-mod=rnd,sni=ya.ru',`--dpi-desync-fake-http=${tM}`]),
      ...r6(11),
      ...r7('fake,multidisorder',['--dpi-desync-split-pos=midsld','--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fake-tls-mod=rnd,sni=ya.ru',`--dpi-desync-fake-http=${tM}`]),
      ...r8(11,'n2')] },
    { name: 'combo:syndata+md5sig', args: [...WF,...r1(6),...r2(),
      ...r3('fake',['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig',`--dpi-desync-fake-tls=${tG}`]),
      ...discTcp('fake',['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig',`--dpi-desync-fake-tls=${tG}`]),
      '--filter-l3=ipv4','--filter-tcp=443','--dpi-desync=syndata,multidisorder','--new',
      '--filter-tcp=80','--dpi-desync=fake','--dpi-desync-repeats=6','--dpi-desync-fooling=md5sig','--new',
      ...r6(6),...r8(12,'n2')] },
    { name: 'fakedsplit-md5sig', args: std8('fake,fakedsplit',
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=md5sig','--dpi-desync-fakedsplit-pattern=0x00',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n3'}) },
    { name: 'fake-triple-fooling', args: std8('fake',
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq,md5sig',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq,md5sig',`--dpi-desync-fake-tls=${tG}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq,md5sig',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      ['--dpi-desync-repeats=11','--dpi-desync-fooling=ts,badseq,md5sig',`--dpi-desync-fake-tls=${tG}`,`--dpi-desync-fake-http=${tM}`],
      {cutoff:'n2'}) },
    { name: 'combo:syndata+hostfake-md5sig', args: [...WF,...r1(6),...r2(),
      ...r3('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com','--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1','--dpi-desync-fooling=md5sig']),
      ...discTcp('fake,hostfakesplit',['--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com','--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1','--dpi-desync-fooling=md5sig']),
      '--filter-l3=ipv4','--filter-tcp=443','--dpi-desync=syndata,multidisorder','--new',
      '--filter-tcp=80','--dpi-desync=fake,hostfakesplit','--dpi-desync-fooling=md5sig','--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1','--new',
      ...r6(6),...r8(12,'n2')] },
    { name: 'multisplit-midsld', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=midsld',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=681','--dpi-desync-split-pos=midsld',`--dpi-desync-split-seqovl-pattern=${tG}`],
      ['--dpi-desync-split-seqovl=568','--dpi-desync-split-pos=midsld',`--dpi-desync-split-seqovl-pattern=${t4}`],
      ['--dpi-desync-split-seqovl=568','--dpi-desync-split-pos=midsld',`--dpi-desync-split-seqovl-pattern=${t4}`],
      {cutoff:'n2'}) },
  ];
}

// ============= STAGE 4: STRATEGY TESTING =============

async function stageStrategies(winwsPath, strategies) {
  logSection('STAGE 4: STRATEGY TESTING (winws.exe)');
  log(`Binary: ${winwsPath}`);
  log(`Strategies: ${strategies.length}`);
  log('Testing each strategy against Discord API, Discord CDN, and YouTube.');
  log('This will take several minutes...');
  log('');

  const tableHeader = `${'#'.padStart(3)}  ${'Strategy'.padEnd(30)} ${'DC-API'.padEnd(10)} ${'DC-CDN'.padEnd(10)} ${'YouTube'.padEnd(10)} Time`;
  log(tableHeader);
  log('-'.repeat(tableHeader.length));

  const results = [];
  const binDir = path.dirname(winwsPath);

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const idx = String(i + 1).padStart(3);

    killWinws();
    await sleep(500);

    let proc;
    try {
      proc = spawn(winwsPath, s.args, { cwd: binDir, detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      log(`${idx}  ${s.name.padEnd(30)} SPAWN ERROR: ${e.message}`);
      results.push({ name: s.name, dcApi: false, dcCdn: false, yt: false, ms: 0 });
      continue;
    }

    let procDied = false;
    proc.on('close', () => { procDied = true; });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});

    await sleep(STRATEGY_INIT_DELAY);

    if (procDied) {
      log(`${idx}  ${s.name.padEnd(30)} PROCESS DIED before test`);
      results.push({ name: s.name, dcApi: false, dcCdn: false, yt: false, ms: 0 });
      continue;
    }

    const t0 = Date.now();
    const [dcApi, dcCdn, yt] = await Promise.all([
      curlTest(TEST_URLS.discordApi),
      curlTest(TEST_URLS.discordCdn),
      curlTest(TEST_URLS.youtube),
    ]);
    const totalMs = Date.now() - t0;

    const r = { name: s.name, dcApi: dcApi.ok, dcCdn: dcCdn.ok, yt: yt.ok, ms: totalMs };
    results.push(r);

    const dcApiS = dcApi.ok ? 'PASS' : 'FAIL';
    const dcCdnS = dcCdn.ok ? 'PASS' : 'FAIL';
    const ytS = yt.ok ? 'PASS' : 'FAIL';
    const timeS = `${(totalMs / 1000).toFixed(1)}s`;

    log(`${idx}  ${s.name.padEnd(30)} ${dcApiS.padEnd(10)} ${dcCdnS.padEnd(10)} ${ytS.padEnd(10)} ${timeS}`);

    try { proc.kill(); } catch (e) {}
  }

  killWinws();
  return results;
}

// ============= STAGE 5: SUMMARY =============

function stageSummary(dnsResult, tlsResult, strategyResults) {
  logSection('STAGE 5: SUMMARY & RECOMMENDATIONS');

  // Block type analysis
  const blockTypes = [];
  if (dnsResult.poisonCount > 0) blockTypes.push('DNS poisoning');
  if (tlsResult.sniBlocked > 0) blockTypes.push('DPI SNI filtering');
  if (blockTypes.length === 0) blockTypes.push('Unknown (possibly deep DPI or IP-based)');

  log(`Block type detected: ${blockTypes.join(' + ')}`);
  log(`DNS poisoned domains: ${dnsResult.poisonCount}`);
  log(`TLS SNI-blocked endpoints: ${tlsResult.sniBlocked}`);
  log('');

  // Strategy winners
  const bothWinners = strategyResults.filter(r => r.dcApi && r.dcCdn && r.yt);
  const discordWinners = strategyResults.filter(r => r.dcApi && r.dcCdn);
  const youtubeWinners = strategyResults.filter(r => r.yt);
  const dcApiOnly = strategyResults.filter(r => r.dcApi);
  const dcCdnOnly = strategyResults.filter(r => r.dcCdn);

  log(`Strategies that work for BOTH Discord+YouTube: ${bothWinners.length}`);
  if (bothWinners.length > 0) {
    const best = bothWinners.sort((a, b) => a.ms - b.ms)[0];
    for (const w of bothWinners) log(`  * ${w.name} (${(w.ms/1000).toFixed(1)}s)`);
    log(`  >> BEST: ${best.name} (${(best.ms/1000).toFixed(1)}s)`);
  }
  log('');

  log(`Strategies that work for Discord (API+CDN): ${discordWinners.length}`);
  if (discordWinners.length > 0) {
    for (const w of discordWinners.slice(0, 10)) log(`  * ${w.name}`);
    if (discordWinners.length > 10) log(`  ... and ${discordWinners.length - 10} more`);
  }
  log('');

  log(`Strategies that work for YouTube: ${youtubeWinners.length}`);
  if (youtubeWinners.length > 0) {
    for (const w of youtubeWinners.slice(0, 10)) log(`  * ${w.name}`);
    if (youtubeWinners.length > 10) log(`  ... and ${youtubeWinners.length - 10} more`);
  }
  log('');

  if (bothWinners.length === 0) {
    log('!! NO strategy works for both Discord and YouTube !!');
    log('');
    if (discordWinners.length > 0 && youtubeWinners.length > 0) {
      log('Different strategies needed for Discord vs YouTube.');
      log(`Discord best: ${discordWinners[0].name}`);
      log(`YouTube best: ${youtubeWinners[0].name}`);
    } else if (dcApiOnly.length > 0 && !dcCdnOnly.length) {
      log('Discord API works but CDN does not — CDN may need separate strategy or DNS fix.');
    } else {
      log('Consider: VPN for initial setup, or try running with clean DNS (1.1.1.1).');
    }
  }

  log('');
  log('Send this log file to the developer for analysis.');
}

// ============= MAIN =============

async function main() {
  log('========================================================');
  log('     UNBLOCK PRO — NETWORK DIAGNOSTICS (Windows)');
  log('========================================================');
  log('');
  log(`Date:     ${startTime.toISOString()}`);
  log(`OS:       ${os.type()} ${os.release()} (${os.arch()})`);
  log(`Node:     ${process.version}`);
  log(`Hostname: ${os.hostname()}`);
  log('');

  // Check admin
  let isAdmin = false;
  try {
    execSync('net session >nul 2>&1', { stdio: 'pipe' });
    isAdmin = true;
  } catch (e) {}
  log(`Admin rights: ${isAdmin ? 'YES' : 'NO (strategy testing will fail!)'}`);

  // Find binaries
  const winwsPath = findBinary();
  log(`winws.exe:  ${winwsPath || 'NOT FOUND'}`);
  const listsDir = findListsDir();
  log(`Lists dir:  ${listsDir || 'NOT FOUND'}`);

  if (!winwsPath) {
    log('');
    log('ERROR: winws.exe not found. Run the app once to download binaries first.');
    log('Looked in:');
    log(`  - ${path.join(__dirname, '..', 'bin', 'win32')}`);
    log(`  - ${path.join(process.env.APPDATA || '', 'UnblockPro', 'bin', 'win32')}`);
  }
  if (!listsDir) {
    log('');
    log('ERROR: Host lists not found. Run the app once to generate them.');
    log('Looked in:');
    log(`  - ${path.join(process.env.APPDATA || '', 'UnblockPro', 'lists')}`);
  }

  // Stage 1
  const dnsResult = await stageDns();

  // Stage 2
  await stageTcp();

  // Stage 3
  const tlsResult = await stageTls();

  // Stage 4
  let strategyResults = [];
  if (winwsPath && listsDir && isAdmin) {
    killWinws();
    const strategies = buildStrategies(path.dirname(winwsPath), listsDir);
    strategyResults = await stageStrategies(winwsPath, strategies);
  } else {
    logSection('STAGE 4: STRATEGY TESTING — SKIPPED');
    if (!isAdmin) log('Run this script as Administrator to test strategies.');
    if (!winwsPath) log('winws.exe not found — run UnblockPro app first to download.');
    if (!listsDir) log('Host lists not found — run UnblockPro app first.');
  }

  // Stage 5
  stageSummary(dnsResult, tlsResult, strategyResults);

  // Write log
  const logFileName = `diagnose-${timestamp()}.log`;
  const logPath = path.join(__dirname, logFileName);
  fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');

  log('');
  log(`Log saved to: ${logPath}`);
  log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
