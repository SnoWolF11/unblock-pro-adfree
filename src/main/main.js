const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const sudo = require('sudo-prompt');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let tray;
let proxyProcess = null;
let isConnected = false;
let isDownloading = false;
let currentStrategy = null;
let lastError = null;
let lastErrorCode = null;
let disconnectReason = null;
let connectedSince = null; // timestamp when connected
let strategyProgress = null; // { current: N, total: M, name: '...' }
let logEntries = []; // strategy testing log for UI
let hostListsDir = null; // directory with host list files for strategies

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// ============= SETTINGS =============

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (e) {}
  return { autoStart: false, autoConnect: false, selectedStrategy: 'auto', lastWorkingStrategy: null };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {}
}

function applyAutoStart(enabled) {
  if (isDev) return; // Don't set login items in dev mode
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true
  });
}

// Dynamically fetch the latest zapret release URL from GitHub API
function getLatestZapretUrl() {
  return new Promise((resolve, reject) => {
    https.get('https://api.github.com/repos/bol-van/zapret/releases/latest', {
      headers: { 'User-Agent': 'UnblockPro' }
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, { headers: { 'User-Agent': 'UnblockPro' } }, (r) => {
          let data = '';
          r.on('data', chunk => data += chunk);
          r.on('end', () => {
            try { resolve(findZipAsset(JSON.parse(data))); } catch (e) { reject(e); }
          });
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(findZipAsset(JSON.parse(data))); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function findZipAsset(release) {
  // Find the main zapret-*.zip (not openwrt, not tar.gz)
  const assets = release.assets || [];
  const zipAsset = assets.find(a =>
    a.name.endsWith('.zip') &&
    !a.name.includes('openwrt') &&
    a.name.startsWith('zapret-')
  );
  if (zipAsset) return zipAsset.browser_download_url;
  // Fallback: construct URL from tag name
  const tag = release.tag_name;
  return `https://github.com/bol-van/zapret/releases/download/${tag}/zapret-${tag}.zip`;
}

function getResourcePath() {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'bin', process.platform);
  }
  // Use writable userData directory instead of app bundle Resources.
  // On macOS, App Translocation makes the .app bundle read-only when
  // the app is downloaded and quarantined, so we can't write to
  // process.resourcesPath. Using userData (~/.../UnblockPro/) is always writable.
  return path.join(app.getPath('userData'), 'bin', process.platform);
}

function getBinDir() {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'bin');
  }
  return path.join(app.getPath('userData'), 'bin');
}

function getBinaryPath() {
  const binDir = getResourcePath();
  
  if (process.platform === 'darwin') {
    // Check for architecture-specific binary
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const archBinary = path.join(binDir, `tpws_${arch}`);
    if (fs.existsSync(archBinary)) return archBinary;
    return path.join(binDir, 'tpws');
  } else if (process.platform === 'win32') {
    return path.join(binDir, 'winws.exe');
  }
  
  return null;
}

// ============= HOST LISTS & PATTERN FILES =============

// Domain lists matching Flowseal/zapret-discord-youtube
const HOST_LIST_GENERAL = [
  'cloudflare-ech.com', 'encryptedsni.com', 'cloudflareaccess.com', 'cloudflareapps.com',
  'cloudflarebolt.com', 'cloudflareclient.com', 'cloudflareinsights.com', 'cloudflareok.com',
  'cloudflarepartners.com', 'cloudflareportal.com', 'cloudflarepreview.com', 'cloudflareresolve.com',
  'cloudflaressl.com', 'cloudflarestatus.com', 'cloudflarestorage.com', 'cloudflarestream.com',
  'cloudflaretest.com', 'dis.gd', 'discord-attachments-uploads-prd.storage.googleapis.com',
  'discord.app', 'discord.co', 'discord.com', 'discord.design', 'discord.dev', 'discord.gift',
  'discord.gifts', 'discord.gg', 'discord.media', 'discord.new', 'discord.store', 'discord.status',
  'discord-activities.com', 'discordactivities.com', 'discordapp.com', 'discordapp.net',
  'discordcdn.com', 'discordmerch.com', 'discordpartygames.com', 'discordsays.com',
  'discordsez.com', 'discordstatus.com', 'frankerfacez.com', 'ffzap.com', 'betterttv.net',
  '7tv.app', '7tv.io', 'localizeapi.com',
  // YouTube / Google
  'youtube.com', 'youtu.be', 'yt.be', 'ytimg.com', 'googlevideo.com', 'youtube-nocookie.com',
  'youtubei.googleapis.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com',
  'youtube-ui.l.google.com', 'youtubeembeddedplayer.googleapis.com'
].join('\n');

const HOST_LIST_GOOGLE = [
  'youtube.com', 'youtu.be', 'yt.be', 'ytimg.com', 'googlevideo.com', 'youtube-nocookie.com',
  'youtubei.googleapis.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com',
  'youtube-ui.l.google.com', 'youtubeembeddedplayer.googleapis.com',
  'googleapis.com', 'gstatic.com', 'ggpht.com', 'googleusercontent.com'
].join('\n');

function ensureHostLists() {
  if (hostListsDir && fs.existsSync(hostListsDir)) return hostListsDir;
  
  hostListsDir = path.join(app.getPath('userData'), 'lists');
  fs.mkdirSync(hostListsDir, { recursive: true });
  
  fs.writeFileSync(path.join(hostListsDir, 'list-general.txt'), HOST_LIST_GENERAL, 'utf8');
  fs.writeFileSync(path.join(hostListsDir, 'list-google.txt'), HOST_LIST_GOOGLE, 'utf8');
  
  return hostListsDir;
}

// Generate fake QUIC initial packet (standard QUIC Initial packet for google.com)
// This is what Flowseal ships as quic_initial_www_google_com.bin
function generateFakeQuicInitial() {
  // QUIC Initial packet header: long header form, version 1
  // This is a minimal valid-looking QUIC Initial packet
  const buf = Buffer.alloc(256);
  let offset = 0;
  
  // Flags: Long Header, Initial packet type (0xc0)
  buf[offset++] = 0xc3;
  // Version: QUIC v1 (0x00000001)
  buf.writeUInt32BE(0x00000001, offset); offset += 4;
  // DCID Length + DCID (8 bytes random)
  buf[offset++] = 0x08;
  for (let i = 0; i < 8; i++) buf[offset++] = Math.floor(Math.random() * 256);
  // SCID Length + SCID (0 bytes)
  buf[offset++] = 0x00;
  // Token Length (0)
  buf[offset++] = 0x00;
  // Length (2 bytes, remaining)
  const remaining = 256 - offset - 2;
  buf.writeUInt16BE(0x4000 | remaining, offset); offset += 2;
  // Packet Number (4 bytes)
  buf.writeUInt32BE(0x00000001, offset); offset += 4;
  // Fill rest with random data to look like encrypted payload
  for (let i = offset; i < 256; i++) buf[i] = Math.floor(Math.random() * 256);
  
  return buf;
}

// Generate fake TLS ClientHello packet
function generateFakeTlsClientHello(sni = 'www.google.com') {
  // Minimal TLS 1.2 ClientHello with SNI extension
  const sniBytes = Buffer.from(sni, 'ascii');
  
  // Build SNI extension
  const sniExtension = Buffer.alloc(9 + sniBytes.length);
  let off = 0;
  // Extension type: server_name (0x0000)
  sniExtension.writeUInt16BE(0x0000, off); off += 2;
  // Extension data length
  sniExtension.writeUInt16BE(5 + sniBytes.length, off); off += 2;
  // Server Name List Length
  sniExtension.writeUInt16BE(3 + sniBytes.length, off); off += 2;
  // Server Name Type: host_name (0)
  sniExtension[off++] = 0x00;
  // Server Name Length
  sniExtension.writeUInt16BE(sniBytes.length, off); off += 2;
  // Server Name
  sniBytes.copy(sniExtension, off);
  
  // Build ClientHello
  const random = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) random[i] = Math.floor(Math.random() * 256);
  
  // Cipher suites (common ones)
  const cipherSuites = Buffer.from([
    0x00, 0x04, // length: 2 suites
    0x13, 0x01, // TLS_AES_128_GCM_SHA256
    0x13, 0x02  // TLS_AES_256_GCM_SHA384
  ]);
  
  // Compression methods
  const compression = Buffer.from([0x01, 0x00]); // 1 method: null
  
  // Extensions length + data
  const extensionsLen = Buffer.alloc(2);
  extensionsLen.writeUInt16BE(sniExtension.length, 0);
  
  // ClientHello body
  const clientHelloBody = Buffer.concat([
    Buffer.from([0x03, 0x03]), // TLS 1.2
    random,
    Buffer.from([0x00]), // Session ID length: 0
    cipherSuites,
    compression,
    extensionsLen,
    sniExtension
  ]);
  
  // Handshake header
  const handshake = Buffer.alloc(4 + clientHelloBody.length);
  handshake[0] = 0x01; // ClientHello
  handshake[1] = 0x00;
  handshake.writeUInt16BE(clientHelloBody.length, 2);
  clientHelloBody.copy(handshake, 4);
  
  // TLS record
  const record = Buffer.alloc(5 + handshake.length);
  record[0] = 0x16; // Handshake
  record.writeUInt16BE(0x0301, 1); // TLS 1.0 (record layer)
  record.writeUInt16BE(handshake.length, 3);
  handshake.copy(record, 5);
  
  return record;
}

function ensureBinPatternFiles(platformDir) {
  const files = {
    'quic_initial_www_google_com.bin': () => generateFakeQuicInitial(),
    'tls_clienthello_www_google_com.bin': () => generateFakeTlsClientHello('www.google.com'),
    'tls_clienthello_4pda_to.bin': () => generateFakeTlsClientHello('4pda.to'),
    'tls_clienthello_max_ru.bin': () => generateFakeTlsClientHello('max.ru')
  };
  
  // Ensure the directory exists before writing pattern files
  try { fs.mkdirSync(platformDir, { recursive: true }); } catch (e) {}
  
  for (const [filename, generator] of Object.entries(files)) {
    const filePath = path.join(platformDir, filename);
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, generator());
      } catch (e) {
        // Non-critical: some strategies just won't use pattern files
      }
    }
  }
}

// Build strategy args with resolved bin/list paths
// NOTE: paths are NOT quoted here — spawn() handles quoting automatically.
// The batch-file elevated path also handles quoting via its own logic.
function buildWin32Strategies(binDir, listsDir) {
  const q = (f) => path.join(binDir, f);  // bin file path
  const l = (f) => path.join(listsDir, f); // list file path
  
  // Common prefix for all strategies: port filters
  const WF_FULL = ['--wf-tcp=80,443,2053,2083,2087,2096,8443', '--wf-udp=443,19294-19344,50000-50100'];
  const WF_TCP443 = ['--wf-tcp=443', '--wf-udp=443,19294-19344,50000-50100'];
  
  // Common UDP rules (same across all Flowseal strategies)
  function udpRules(quicRepeats = 6) {
    return [
      '--filter-udp=443', `--hostlist=${l('list-general.txt')}`, '--dpi-desync=fake',
      `--dpi-desync-repeats=${quicRepeats}`, `--dpi-desync-fake-quic=${q('quic_initial_www_google_com.bin')}`, '--new',
      '--filter-udp=19294-19344,50000-50100', '--filter-l7=discord,stun',
      '--dpi-desync=fake', '--dpi-desync-repeats=6', '--new'
    ];
  }
  
  // Discord media TCP rule (ports 2053,2083,2087,2096,8443)
  function discordMediaRule(method, extraArgs = []) {
    return [
      '--filter-tcp=2053,2083,2087,2096,8443', '--hostlist-domains=discord.media',
      `--dpi-desync=${method}`, ...extraArgs, '--new'
    ];
  }
  
  // Google-specific TCP 443 rule
  function googleRule(method, extraArgs = []) {
    return [
      '--filter-tcp=443', `--hostlist=${l('list-google.txt')}`, '--ip-id=zero',
      `--dpi-desync=${method}`, ...extraArgs, '--new'
    ];
  }
  
  // General TCP rule
  function generalTcpRule(method, extraArgs = []) {
    return [
      '--filter-tcp=80,443', `--hostlist=${l('list-general.txt')}`,
      `--dpi-desync=${method}`, ...extraArgs
    ];
  }

  return [
    // Strategies are ordered by real-world effectiveness (tested on multiple ISPs).
    // The first 5 have the highest success rate; the rest are fallbacks.

    // === #1 syndata+multidisorder — most aggressive, no hostlist needed, works on strictest ISPs ===
    { name: 'syndata+multidisorder', args: [
      ...WF_TCP443,
      ...udpRules(6),
      '--filter-l3=ipv4', '--filter-tcp=443', '--dpi-desync=syndata,multidisorder'
    ]},
    // === #2 fake badseq increment=2 — excellent compatibility ===
    { name: 'fake-badseq', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake', ['--dpi-desync-fake-tls-mod=none', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2']),
      ...googleRule('fake', ['--dpi-desync-fake-tls-mod=none', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2']),
      ...generalTcpRule('fake', ['--dpi-desync-fake-tls-mod=none', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2'])
    ]},
    // === #3 multisplit seqovl=681 — high overlap, works on many ISPs ===
    { name: 'multisplit-681', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('multisplit', ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1']),
      ...googleRule('multisplit', ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1']),
      ...generalTcpRule('multisplit', ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1'])
    ]},
    // === #4 fake+split2 autottl md5sig — good alternative ===
    { name: 'fake+split2-autottl', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake,split2', ['--dpi-desync-autottl=5', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=md5sig']),
      ...googleRule('fake,split2', ['--dpi-desync-autottl=5', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=md5sig']),
      ...generalTcpRule('fake,split2', ['--dpi-desync-autottl=5', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=md5sig'])
    ]},
    // === #5 fake md5sig+ts with TLS pattern files ===
    { name: 'fake-md5sig-tls', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts,md5sig',
        `--dpi-desync-fake-tls=${q('tls_clienthello_www_google_com.bin')}`]),
      ...googleRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts,md5sig',
        `--dpi-desync-fake-tls=${q('tls_clienthello_www_google_com.bin')}`]),
      ...generalTcpRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts,md5sig',
        `--dpi-desync-fake-tls=${q('tls_clienthello_www_google_com.bin')}`,
        `--dpi-desync-fake-http=${q('tls_clienthello_max_ru.bin')}`])
    ]},
    // === #6 multisplit pos=2,sniext+1 seqovl=679 ===
    { name: 'multisplit-679', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('multisplit', ['--dpi-desync-split-pos=2,sniext+1', '--dpi-desync-split-seqovl=679']),
      ...googleRule('multisplit', ['--dpi-desync-split-pos=2,sniext+1', '--dpi-desync-split-seqovl=679']),
      ...generalTcpRule('multisplit', ['--dpi-desync-split-pos=2,sniext+1', '--dpi-desync-split-seqovl=679'])
    ]},
    // === #7 fake+multisplit seqovl=664 ts repeats=8 ===
    { name: 'fake+multisplit-664', args: [
      ...WF_FULL,
      ...udpRules(11),
      ...discordMediaRule('fake,multisplit', ['--dpi-desync-split-seqovl=664', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=ts', '--dpi-desync-repeats=8']),
      ...googleRule('fake,multisplit', ['--dpi-desync-split-seqovl=664', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=ts', '--dpi-desync-repeats=8']),
      ...generalTcpRule('fake,multisplit', ['--dpi-desync-split-seqovl=664', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=ts', '--dpi-desync-repeats=8'])
    ]},
    // === #8 fake+multidisorder badseq+md5sig ===
    { name: 'fake+multidisorder', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake,multidisorder', ['--dpi-desync-split-pos=1,midsld',
        '--dpi-desync-fooling=badseq,md5sig']),
      ...googleRule('fake,multidisorder', ['--dpi-desync-split-pos=1,midsld',
        '--dpi-desync-fooling=badseq,md5sig']),
      ...generalTcpRule('fake,multidisorder', ['--dpi-desync-split-pos=1,midsld',
        '--dpi-desync-fooling=badseq,md5sig'])
    ]},
    // === #9 multisplit seqovl=652 pos=2 ===
    { name: 'multisplit-652', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('multisplit', ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2']),
      ...googleRule('multisplit', ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2']),
      ...generalTcpRule('multisplit', ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2'])
    ]},
    // === #10 fake+multisplit badseq increment=1000 ===
    { name: 'fake+multisplit-badseq', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake,multisplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq',
        '--dpi-desync-badseq-increment=1000']),
      ...googleRule('fake,multisplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq',
        '--dpi-desync-badseq-increment=1000']),
      ...generalTcpRule('fake,multisplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq',
        '--dpi-desync-badseq-increment=1000'])
    ]},
    // === #11 fake ts with TLS pattern files (simpler) ===
    { name: 'fake-ts-tls', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        `--dpi-desync-fake-tls=${q('tls_clienthello_www_google_com.bin')}`]),
      ...googleRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        `--dpi-desync-fake-tls=${q('tls_clienthello_www_google_com.bin')}`]),
      ...generalTcpRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        `--dpi-desync-fake-tls=${q('tls_clienthello_www_google_com.bin')}`,
        `--dpi-desync-fake-http=${q('tls_clienthello_max_ru.bin')}`])
    ]},
    // === #12 general — multisplit seqovl=568 (Flowseal default) ===
    { name: 'general', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('multisplit', ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1',
        `--dpi-desync-split-seqovl-pattern=${q('tls_clienthello_www_google_com.bin')}`]),
      ...googleRule('multisplit', ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1',
        `--dpi-desync-split-seqovl-pattern=${q('tls_clienthello_www_google_com.bin')}`]),
      ...generalTcpRule('multisplit', ['--dpi-desync-split-seqovl=568', '--dpi-desync-split-pos=1',
        `--dpi-desync-split-seqovl-pattern=${q('tls_clienthello_4pda_to.bin')}`])
    ]},
    // === #13 fake+fakedsplit ts ===
    { name: 'fake+fakedsplit', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake,fakedsplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        '--dpi-desync-fakedsplit-pattern=0x00']),
      ...googleRule('fake,fakedsplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        '--dpi-desync-fakedsplit-pattern=0x00']),
      ...generalTcpRule('fake,fakedsplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        '--dpi-desync-fakedsplit-pattern=0x00'])
    ]},
    // === #14 hostfakesplit ts (ALT9-style, works on some ISPs) ===
    { name: 'hostfakesplit', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('hostfakesplit', ['--dpi-desync-repeats=4', '--dpi-desync-fooling=ts',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com']),
      ...googleRule('hostfakesplit', ['--dpi-desync-repeats=4', '--dpi-desync-fooling=ts',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com']),
      ...generalTcpRule('hostfakesplit', ['--dpi-desync-repeats=4', '--dpi-desync-fooling=ts,md5sig',
        '--dpi-desync-hostfakesplit-mod=host=ozon.ru'])
    ]},
    // === #15 fakedsplit badseq ===
    { name: 'fakedsplit-badseq', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake,fakedsplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fakedsplit-pattern=0x00']),
      ...googleRule('fake,fakedsplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fakedsplit-pattern=0x00']),
      ...generalTcpRule('fake,fakedsplit', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fakedsplit-pattern=0x00'])
    ]},
    // === #16 fake ts only (simplest, for lenient ISPs) ===
    { name: 'fake-ts', args: [
      ...WF_FULL,
      ...udpRules(6),
      ...discordMediaRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        '--dpi-desync-fake-tls-mod=none']),
      ...googleRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        '--dpi-desync-fake-tls-mod=none']),
      ...generalTcpRule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts',
        '--dpi-desync-fake-tls-mod=none'])
    ]}
  ];
}

// DPI bypass strategies — based on Flowseal/zapret-discord-youtube (22k+ stars)
// macOS strategies are static (tpws SOCKS proxy), Windows strategies are built dynamically
// because they need runtime paths to .bin pattern files and host list files
const STRATEGIES_DARWIN = [
  // === BASIC (work on most ISPs) ===
  { name: 'split+disorder', args: ['--port', '1080', '--socks', '--split-pos=1', '--disorder', '--hostcase'] },
  { name: 'split-midsld+disorder', args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder', '--hostcase'] },
  { name: 'split2+disorder', args: ['--port', '1080', '--socks', '--split-pos=2', '--disorder', '--hostcase'] },
  // === TLS-AWARE ===
  { name: 'tlsrec+split+disorder', args: ['--port', '1080', '--socks', '--tlsrec=sni', '--split-pos=1', '--disorder', '--hostcase'] },
  { name: 'split-tls+disorder', args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder=tls', '--hostcase'] },
  // === HOST MANIPULATION ===
  { name: 'methodeol+split', args: ['--port', '1080', '--socks', '--methodeol', '--split-pos=1', '--hostcase'] },
  { name: 'hostdot+split+disorder', args: ['--port', '1080', '--socks', '--hostdot', '--split-pos=1,midsld', '--disorder'] },
  { name: 'hostpad+split+disorder', args: ['--port', '1080', '--socks', '--hostpad=256', '--split-pos=1', '--disorder', '--hostcase'] },
  // === OOB ===
  { name: 'oob+split+disorder', args: ['--port', '1080', '--socks', '--oob', '--split-pos=1', '--disorder'] },
  { name: 'oob+methodeol+split', args: ['--port', '1080', '--socks', '--oob', '--methodeol', '--split-pos=1', '--hostcase'] },
  // === COMBINED (aggressive) ===
  { name: 'combined-v1', args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder', '--hostcase', '--methodeol'] },
  { name: 'combined-v2', args: ['--port', '1080', '--socks', '--oob', '--methodeol', '--split-pos=1,midsld', '--disorder', '--hostcase', '--hostdot'] },
  { name: 'combined-v3', args: ['--port', '1080', '--socks', '--tlsrec=sni', '--hostpad=256', '--split-pos=2', '--disorder', '--hostcase'] },
  // === EXTENDED SPLIT POSITIONS ===
  { name: 'split3+disorder', args: ['--port', '1080', '--socks', '--split-pos=3', '--disorder', '--hostcase'] },
  { name: 'split-sniext+disorder', args: ['--port', '1080', '--socks', '--split-pos=1,sniext', '--disorder', '--hostcase'] },
  // === HOST MANIPULATION VARIANTS ===
  { name: 'hosttab+split+disorder', args: ['--port', '1080', '--socks', '--hosttab', '--split-pos=1', '--disorder', '--hostcase'] },
  { name: 'hostspell+split', args: ['--port', '1080', '--socks', '--hostspell', '--split-pos=1', '--disorder'] },
  // === LARGE HOSTPAD VARIANTS ===
  { name: 'hostpad512+split+disorder', args: ['--port', '1080', '--socks', '--hostpad=512', '--split-pos=1', '--disorder', '--hostcase'] },
  { name: 'hostpad1024+split', args: ['--port', '1080', '--socks', '--hostpad=1024', '--split-pos=1,midsld', '--hostcase'] },
  // === TLS RECORD MANIPULATION ===
  { name: 'tlsrec+disorder', args: ['--port', '1080', '--socks', '--tlsrec=sni', '--disorder', '--hostcase'] },
  { name: 'tlsrec+oob+split', args: ['--port', '1080', '--socks', '--tlsrec=sni', '--oob', '--split-pos=1', '--hostcase'] },
  // === AGGRESSIVE COMBINED ===
  { name: 'combined-v4', args: ['--port', '1080', '--socks', '--oob', '--hostpad=256', '--split-pos=1,midsld', '--disorder', '--hostcase', '--methodeol'] },
  { name: 'combined-v5', args: ['--port', '1080', '--socks', '--tlsrec=sni', '--methodeol', '--hostdot', '--split-pos=2', '--disorder', '--hostcase'] },
  // === MINIMAL (last resort) ===
  { name: 'split-only', args: ['--port', '1080', '--socks', '--split-pos=1'] },
  { name: 'disorder-only', args: ['--port', '1080', '--socks', '--disorder'] }
];

// Get strategies for current platform (Windows strategies are built dynamically with paths)
function getStrategiesForPlatform() {
  if (process.platform === 'darwin') {
    return STRATEGIES_DARWIN;
  } else if (process.platform === 'win32') {
    const binDir = getResourcePath();
    const listsDir = ensureHostLists();
    ensureBinPatternFiles(binDir);
    return buildWin32Strategies(binDir, listsDir);
  }
  return [];
}

function sendStatus(extra = {}) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('status', { 
      connected: isConnected,
      downloading: isDownloading,
      strategy: currentStrategy,
      binaryExists: fs.existsSync(getBinaryPath() || ''),
      error: lastError,
      errorCode: lastErrorCode,
      disconnectReason: disconnectReason,
      connectedSince: connectedSince,
      strategyProgress: strategyProgress,
      ...extra
    });
  }
}

function sendLog(entry) {
  // entry: { type: 'info'|'success'|'error'|'warning', message: string, timestamp: number }
  console.log(`[${entry.type}] ${entry.message}`);
  const logEntry = { ...entry, timestamp: Date.now() };
  logEntries.push(logEntry);
  // Keep only last 100 entries
  if (logEntries.length > 100) logEntries.shift();
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('log-entry', logEntry);
  }
}

function clearError() {
  lastError = null;
  lastErrorCode = null;
  disconnectReason = null;
}

function updateTrayMenu() {
  if (!tray) return;
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Открыть', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: isConnected ? '● Подключено' : '○ Отключено', enabled: false },
    { label: 'Подключить', click: () => startProxy(), enabled: !isConnected && !isDownloading },
    { label: 'Отключить', click: () => stopProxy(), enabled: isConnected },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; stopProxy(); app.quit(); }}
  ]);
  
  tray.setContextMenu(contextMenu);
}

// ============= BINARY DOWNLOAD =============

function downloadFileDirect(url, dest) {
  return new Promise((resolve, reject) => {
    let file;
    try {
      file = fs.createWriteStream(dest);
    } catch (err) {
      // EPERM / EBUSY — file locked by antivirus or previous process
      reject(new Error(`Cannot write to ${dest}: ${err.message}`));
      return;
    }
    
    file.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch (e) {}
      reject(err);
    });
    
    const request = https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) {}
        downloadFileDirect(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) {}
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-progress', { percent, downloaded: downloadedSize, total: totalSize });
        }
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });
    
    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch (e) {}
      reject(err);
    });
    
    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function downloadFile(url, dest) {
  return downloadFileDirect(url, dest);
}

async function downloadAndExtractBinaries() {
  if (isDownloading) return { success: false, error: 'Already downloading' };
  
  isDownloading = true;
  sendStatus();
  
  const binDir = getBinDir();
  const platformDir = getResourcePath();
  const tempDir = path.join(app.getPath('temp'), 'unblock-pro-temp');
  
  try {
    // On Windows, try to add Defender exclusion so WinDivert driver isn't deleted
    if (process.platform === 'win32') {
      try {
        execSync(`powershell -command "Add-MpPreference -ExclusionPath '${platformDir}'" `, { stdio: 'pipe' });
      } catch (e) {
        // May fail without admin — non-critical
      }
    }
    
    // Clean up any leftover temp files from previous attempts (fixes EPERM on Windows)
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    
    // Create directories
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    // Get latest zapret release URL dynamically
    const downloadUrl = await getLatestZapretUrl();
    
    const zipPath = path.join(tempDir, 'zapret.zip');
    
    // Remove stale zip if it exists (Windows file locking)
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e) {}
    
    // Download
    await downloadFile(downloadUrl, zipPath);
    
    // Extract
    if (process.platform === 'win32') {
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'pipe' });
      
      // Archive has windows-x86_64/ (WinDivert64.sys) and windows-x86/ (WinDivert32.sys).
      // On 64-bit Windows we MUST use x86_64 — otherwise WinDivert64.sys is missing.
      const candidates = [];
      const findWinws = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) findWinws(fullPath);
          else if (file === 'winws.exe') candidates.push(fullPath);
        }
      };
      findWinws(tempDir);
      // Prefer path containing x86_64 (64-bit driver)
      const winwsPath = candidates.find(p => path.dirname(p).toLowerCase().includes('x86_64'))
        || candidates.find(p => path.dirname(p).toLowerCase().includes('x64'))
        || candidates[0];
      
      if (winwsPath) {
        fs.copyFileSync(winwsPath, path.join(platformDir, 'winws.exe'));
        
        // Copy ALL required files from the same directory as winws.exe:
        // - WinDivert driver files (WinDivert.dll, WinDivert64.sys, WinDivert32.sys)
        // - Cygwin runtime DLLs (cygwin1.dll, cygstdc++-6.dll, cyggcc_s-seh-1.dll, etc.)
        const winwsDir = path.dirname(winwsPath);
        const dirFiles = fs.readdirSync(winwsDir);
        
        for (const file of dirFiles) {
          if (file === 'winws.exe') continue; // already copied
          const src = path.join(winwsDir, file);
          const stat = fs.statSync(src);
          if (stat.isFile()) {
            fs.copyFileSync(src, path.join(platformDir, file));
          }
        }
        
        // Unblock all files — Windows marks downloaded files with Zone.Identifier ADS
        // which prevents kernel drivers (WinDivert64.sys) from loading
        try {
          execSync(`powershell -command "Get-ChildItem -Path '${platformDir}' | Unblock-File"`, { stdio: 'pipe' });
        } catch (e) {
          // Non-critical: unblock may fail if not needed
        }
        
        // Verify WinDivert files were copied
        const driverExists = fs.existsSync(path.join(platformDir, 'WinDivert64.sys'));
        const dllExists = fs.existsSync(path.join(platformDir, 'WinDivert.dll'));
        if (!driverExists || !dllExists) {
          sendLog({ type: 'warning', message: `WinDivert файлы: driver=${driverExists}, dll=${dllExists}` });
        }
        
        // Extract .bin pattern files from zapret archive (files/fake/ directory)
        const extractBinPatterns = (dir) => {
          if (!fs.existsSync(dir)) return;
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              // Look inside 'fake' or 'files' subdirectories
              if (item === 'fake' || item === 'files') extractBinPatterns(fullPath);
            } else if (item.endsWith('.bin')) {
              const destFile = path.join(platformDir, item);
              if (!fs.existsSync(destFile)) {
                try { fs.copyFileSync(fullPath, destFile); } catch(e) {}
              }
            }
          }
        };
        extractBinPatterns(tempDir);
        
        // Generate any missing pattern files
        ensureBinPatternFiles(platformDir);
      } else {
        throw new Error('winws.exe not found in archive');
      }
      
    } else if (process.platform === 'darwin') {
      execSync(`unzip -o "${zipPath}" -d "${tempDir}"`, { stdio: 'pipe' });
      
      // Find the zapret-* directory dynamically (version-independent)
      const zapretDirs = fs.readdirSync(tempDir).filter(f => 
        f.startsWith('zapret-') && fs.statSync(path.join(tempDir, f)).isDirectory()
      );
      const zapretDir = zapretDirs.length > 0 
        ? path.join(tempDir, zapretDirs[0]) 
        : tempDir;
      
      // Find tpws binary dynamically via recursive search
      const possiblePaths = [];
      let found = false;
      
      const binariesDir = path.join(zapretDir, 'binaries');
      if (fs.existsSync(binariesDir)) {
        const archs = fs.readdirSync(binariesDir);
        // Prioritize macOS binary (mac64 = universal arm64+x86_64)
        const sorted = archs.sort((a, b) => {
          const aMatch = a.includes('mac') || a.includes('mach') || a.includes('darwin') ? -1 : 1;
          const bMatch = b.includes('mac') || b.includes('mach') || b.includes('darwin') ? -1 : 1;
          return aMatch - bMatch;
        });
        for (const arch of sorted) {
          const tpwsPath = path.join(binariesDir, arch, 'tpws');
          if (fs.existsSync(tpwsPath)) {
            possiblePaths.push(tpwsPath);
          }
        }
      }
      
      for (const srcPath of possiblePaths) {
        if (fs.existsSync(srcPath)) {
          const destPath = path.join(platformDir, 'tpws');
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, '755');
          found = true;
          break;
        }
      }
      
      if (!found) {
        // Try to compile from source as fallback
        const tpwsSrcDir = path.join(zapretDir, 'tpws');
        if (fs.existsSync(tpwsSrcDir)) {
          try {
            execSync('make', { cwd: tpwsSrcDir, stdio: 'pipe' });
            const compiledPath = path.join(tpwsSrcDir, 'tpws');
            if (fs.existsSync(compiledPath)) {
              fs.copyFileSync(compiledPath, path.join(platformDir, 'tpws'));
              fs.chmodSync(path.join(platformDir, 'tpws'), '755');
              found = true;
            }
          } catch (e) {
            // Compilation failed silently
          }
        }
      }
      
      if (!found) {
        throw new Error('tpws binary not found and compilation failed. Please install Xcode Command Line Tools.');
      }
    }
    
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    isDownloading = false;
    sendStatus();
    return { success: true };
    
  } catch (error) {
    isDownloading = false;
    
    // Categorize download errors
    let errorMsg = error.message;
    if (error.message.includes('Timeout')) {
      errorMsg = 'Таймаут при скачивании — проверьте интернет-соединение';
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
      errorMsg = 'Нет доступа к серверу — проверьте интернет-соединение';
    } else if (error.message.includes('EPERM') || error.message.includes('EACCES')) {
      errorMsg = 'Нет прав для записи файлов — запустите от администратора';
    } else if (error.message.includes('Cannot write')) {
      errorMsg = 'Файл заблокирован — закройте антивирус и попробуйте снова';
    } else if (error.message.includes('not found')) {
      errorMsg = 'Бинарник не найден в архиве';
    }
    
    sendLog({ type: 'error', message: `Ошибка скачивания: ${errorMsg}` });
    sendStatus();
    
    // Cleanup on error
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    
    return { success: false, error: errorMsg };
  }
}

// ============= SYSTEM PROXY (macOS) =============

let proxyEnabledServices = [];

function getActiveNetworkServices() {
  if (process.platform !== 'darwin') return [];
  try {
    const output = execSync('networksetup -listallnetworkservices', { encoding: 'utf8', stdio: 'pipe' });
    const allServices = output.split('\n')
      .filter(line => line.trim() && !line.startsWith('An asterisk'))
      .map(line => line.trim());
    
    const active = [];
    for (const service of allServices) {
      try {
        const info = execSync(`networksetup -getinfo "${service}"`, { encoding: 'utf8', stdio: 'pipe' });
        // Service is active if it has a real IP address
        if (/IP address:\s*\d+\.\d+\.\d+\.\d+/.test(info)) {
          active.push(service);
        }
      } catch (e) {}
    }
    return active.length > 0 ? active : allServices.filter(s => /wi-fi|ethernet|usb/i.test(s));
  } catch (e) {
    return ['Wi-Fi'];
  }
}

function enableSystemProxy(port = 1080) {
  if (process.platform !== 'darwin') return;
  const services = getActiveNetworkServices();
  proxyEnabledServices = [];
  
  for (const service of services) {
    try {
      execSync(`networksetup -setsocksfirewallproxy "${service}" 127.0.0.1 ${port}`, { stdio: 'pipe' });
      execSync(`networksetup -setsocksfirewallproxystate "${service}" on`, { stdio: 'pipe' });
      proxyEnabledServices.push(service);
    } catch (e) {}
  }
}

function disableSystemProxy() {
  if (process.platform !== 'darwin') return;
  // Disable on all services we touched + currently active ones (covers network switch)
  const services = [...new Set([...proxyEnabledServices, ...getActiveNetworkServices()])];
  
  for (const service of services) {
    try {
      execSync(`networksetup -setsocksfirewallproxystate "${service}" off`, { stdio: 'pipe' });
    } catch (e) {}
  }
  proxyEnabledServices = [];
}

function testSingleConnection(port, timeoutSec, url) {
  return new Promise((resolve) => {
    exec(
      `curl --socks5-hostname 127.0.0.1:${port} --connect-timeout ${timeoutSec} -s -o /dev/null -w "%{http_code}" ${url}`,
      { timeout: (timeoutSec + 5) * 1000 },
      (error, stdout) => {
        if (error) { resolve(false); return; }
        const code = parseInt(stdout.trim(), 10);
        resolve(code > 0 && code < 500);
      }
    );
  });
}

async function testProxyConnection(port = 1080, timeoutSec = 10) {
  // Discord app uses gateway + CDN + updater; strategy must work for at least one Discord host
  const discordEndpoints = [
    'https://discord.com/api/v10/gateway',
    'https://cdn.discordapp.com/',
    'https://dl.discordapp.net/apps/linux'
  ];
  const otherEndpoints = [
    'https://www.youtube.com/',
    'https://clients3.google.com/generate_204'
  ];
  const allEndpoints = [...discordEndpoints, ...otherEndpoints];

  let discordOk = false;
  let anyOk = false;
  for (const url of allEndpoints) {
    const works = await testSingleConnection(port, timeoutSec, url);
    if (works) {
      anyOk = true;
      if (discordEndpoints.includes(url)) discordOk = true;
    }
  }
  // Require at least one Discord endpoint so app/updater don't hang
  if (discordOk && anyOk) return true;
  // Retry first Discord endpoint once (flaky network)
  if (anyOk && !discordOk) {
    const retry = await testSingleConnection(port, timeoutSec, discordEndpoints[0]);
    if (retry) return true;
  }
  return false;
}

// ============= DIRECT CONNECTION TEST (Windows) =============

function testSingleDirectConnection(url, timeoutSec = 10) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const req = https.get({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        timeout: timeoutSec * 1000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
      }, (res) => {
        // Consume response data to free up memory
        res.resume();
        resolve(res.statusCode > 0 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (e) {
      resolve(false);
    }
  });
}

async function testDirectConnection(timeoutSec = 10) {
  // winws works at driver level — test with direct HTTPS requests (no SOCKS proxy)
  // IMPORTANT: Must verify BOTH Discord AND YouTube TLS work.
  // Many strategies fix Discord (which uses Cloudflare and is easier to unblock)
  // but fail for YouTube (which needs stronger DPI bypass). A strategy that only
  // unblocks Discord is useless — YouTube TLS must also pass.
  
  const youtubeEndpoints = [
    'https://www.youtube.com/',
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    'https://youtubei.googleapis.com/youtubei/v1/player'
  ];
  
  const discordEndpoints = [
    'https://discord.com/api/v10/gateway',
    'https://cdn.discordapp.com/',
    'https://discord.com/app'
  ];
  
  // Test YouTube FIRST (it's the harder one to unblock)
  let youtubeOk = false;
  for (const url of youtubeEndpoints) {
    if (await testSingleDirectConnection(url, timeoutSec)) {
      youtubeOk = true;
      break;
    }
  }
  
  // If YouTube fails, this strategy is no good — skip Discord test
  if (!youtubeOk) {
    sendLog({ type: 'warning', message: 'YouTube TLS не прошёл — стратегия не подходит' });
    return false;
  }
  
  // Test Discord
  let discordOk = false;
  for (const url of discordEndpoints) {
    if (await testSingleDirectConnection(url, timeoutSec)) {
      discordOk = true;
      break;
    }
  }
  
  // Require BOTH to pass
  if (youtubeOk && discordOk) return true;
  
  // Discord failed but YouTube worked — retry Discord once
  if (!discordOk) {
    discordOk = await testSingleDirectConnection(discordEndpoints[0], timeoutSec);
  }
  
  return youtubeOk && discordOk;
}

// ============= WINDOWS ELEVATION & MONITORING =============

let winwsMonitorInterval = null;

function isRunningAsAdmin() {
  if (process.platform !== 'win32') return true;
  try {
    execSync('net session', { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

function startWinwsMonitor() {
  stopWinwsMonitor();
  winwsMonitorInterval = setInterval(() => {
    try {
      const output = execSync('tasklist /FI "IMAGENAME eq winws.exe" /NH', { encoding: 'utf8', stdio: 'pipe' });
      if (!output.includes('winws.exe')) {
        stopWinwsMonitor();
        if (isConnected) {
          isConnected = false;
          const prevStrategy = currentStrategy;
          currentStrategy = null;
          connectedSince = null;
          disconnectReason = 'PROCESS_CRASHED';
          lastError = 'Процесс обхода завершился неожиданно';
          lastErrorCode = 'PROCESS_CRASHED';
          updateTrayMenu();
          sendLog({ type: 'error', message: `Стратегия ${prevStrategy} прекратила работу` });
          sendStatus();
        }
      }
    } catch (e) {}
  }, 5000);
}

function stopWinwsMonitor() {
  if (winwsMonitorInterval) {
    clearInterval(winwsMonitorInterval);
    winwsMonitorInterval = null;
  }
}

async function startProxyWindowsElevated(finalBinaryPath, strategies, totalStrategies) {
  const binDirectory = path.dirname(finalBinaryPath);
  const tempDir = app.getPath('temp');
  const resultFile = path.join(tempDir, 'unblock-result.txt');
  const progressFile = path.join(tempDir, 'unblock-progress.txt');
  const batchFile = path.join(tempDir, 'unblock-test.bat');

  // Clean old temp files
  try { fs.unlinkSync(resultFile); } catch(e) {}
  try { fs.unlinkSync(progressFile); } catch(e) {}

  // Generate batch script that tests all strategies with one UAC prompt
  let bat = '@echo off\r\n';
  bat += 'setlocal EnableDelayedExpansion\r\n';
  bat += `set "RESULT=${resultFile}"\r\n`;
  bat += `set "PROGRESS=${progressFile}"\r\n`;
  bat += 'taskkill /F /IM winws.exe >nul 2>&1\r\n';
  bat += 'timeout /t 1 /nobreak >nul\r\n';
  bat += '\r\n';

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    // Quote args that contain spaces or path separators with spaces
    const quotedArgs = s.args.map(a => {
      // If arg contains = with a path value, quote the path part
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        const key = a.substring(0, eqIdx + 1);
        const val = a.substring(eqIdx + 1);
        if (val.includes(' ') || val.includes('\\')) {
          return `${key}"${val}"`;
        }
      }
      return a;
    }).join(' ');
    bat += `:: Strategy ${i + 1}: ${s.name}\r\n`;
    bat += `echo ${i + 1}/${totalStrategies}:${s.name}> "%PROGRESS%"\r\n`;
    bat += `cd /d "${binDirectory}"\r\n`;
    bat += `start "" /b "${finalBinaryPath}" ${quotedArgs}\r\n`;
    bat += 'timeout /t 4 /nobreak >nul\r\n';
    // Test connectivity: YouTube TLS FIRST (harder to unblock), then Discord.
    // A strategy must unblock YouTube to be accepted — Discord alone is not enough.
    bat += 'set "YT_OK=0"\r\n';
    bat += `powershell -command "try { $r = Invoke-WebRequest -Uri 'https://www.youtube.com/' -TimeoutSec 12 -UseBasicParsing; if ($r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }"\r\n`;
    bat += 'if !errorlevel! equ 0 set "YT_OK=1"\r\n';
    bat += 'if "!YT_OK!"=="0" (\r\n';
    // YouTube main failed, try thumbnail CDN
    bat += `  powershell -command "try { $r = Invoke-WebRequest -Uri 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' -TimeoutSec 12 -UseBasicParsing; if ($r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }"\r\n`;
    bat += '  if !errorlevel! equ 0 set "YT_OK=1"\r\n';
    bat += ')\r\n';
    // If YouTube failed completely, skip this strategy
    bat += 'if "!YT_OK!"=="0" (\r\n';
    bat += '  taskkill /F /IM winws.exe >nul 2>&1\r\n';
    bat += '  timeout /t 1 /nobreak >nul\r\n';
    bat += '  goto :strat_next_' + i + '\r\n';
    bat += ')\r\n';
    // YouTube works! Now check Discord too
    bat += `powershell -command "try { $r = Invoke-WebRequest -Uri 'https://discord.com/api/v10/gateway' -TimeoutSec 10 -UseBasicParsing; if ($r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }"\r\n`;
    bat += 'if !errorlevel! equ 0 (\r\n';
    bat += `  echo WORKS:${s.name}> "%RESULT%"\r\n`;
    bat += '  goto :end\r\n';
    bat += ')\r\n';
    // Discord failed but YouTube works — still accept (Discord may work at network level)
    bat += `echo WORKS:${s.name}> "%RESULT%"\r\n`;
    bat += 'goto :end\r\n';
    bat += ':strat_next_' + i + '\r\n';
    bat += 'taskkill /F /IM winws.exe >nul 2>&1\r\n';
    bat += 'timeout /t 1 /nobreak >nul\r\n';
    bat += '\r\n';
  }

  bat += 'echo NONE> "%RESULT%"\r\n';
  bat += 'taskkill /F /IM winws.exe >nul 2>&1\r\n';
  bat += 'goto :realend\r\n';
  bat += ':end\r\n';
  bat += ':: Strategy found — winws stays running\r\n';
  bat += ':realend\r\n';
  bat += 'endlocal\r\n';

  fs.writeFileSync(batchFile, bat, { encoding: 'utf8' });

  // Poll progress file to update UI
  let lastProgress = '';
  const progressInterval = setInterval(() => {
    try {
      const content = fs.readFileSync(progressFile, 'utf8').trim();
      if (content && content !== lastProgress) {
        lastProgress = content;
        const match = content.match(/^(\d+)\/(\d+):(.+)$/);
        if (match) {
          const current = parseInt(match[1]);
          const total = parseInt(match[2]);
          const name = match[3];
          strategyProgress = { current, total, name };
          sendStatus({ searching: true });
          sendLog({ type: 'info', message: `[${current}/${total}] Тестирование: ${name}` });
        }
      }
    } catch (e) {}
  }, 1500);

  sendLog({ type: 'info', message: 'Запуск с повышением прав (UAC)...' });

  // Run elevated batch — single UAC dialog for all strategies
  const result = await new Promise((resolve) => {
    sudo.exec(`"${batchFile}"`, { name: 'UnblockPro' }, (error) => {
      clearInterval(progressInterval);

      // Permission denied?
      if (error && error.message && (
        error.message.includes('canceled') ||
        error.message.includes('cancelled') ||
        error.message.includes('User did not grant')
      )) {
        resolve({ success: false, error: 'Требуются права администратора для обхода DPI', errorCode: 'PERMISSION_DENIED' });
        return;
      }

      // Read result file
      try {
        const resultContent = fs.readFileSync(resultFile, 'utf8').trim();
        if (resultContent.startsWith('WORKS:')) {
          const strategyName = resultContent.substring(6).trim();
          resolve({ success: true, strategy: strategyName });
        } else {
          resolve({ success: false, error: 'Ни одна стратегия не сработала', errorCode: 'ALL_STRATEGIES_FAILED' });
        }
      } catch (e) {
        resolve({ success: false, error: error ? error.message : 'Не удалось прочитать результат', errorCode: 'READ_ERROR' });
      }
    });
  });

  // Cleanup temp files
  try { fs.unlinkSync(batchFile); } catch(e) {}
  try { fs.unlinkSync(progressFile); } catch(e) {}
  try { fs.unlinkSync(resultFile); } catch(e) {}

  if (result.success) {
    isConnected = true;
    currentStrategy = result.strategy;
    connectedSince = Date.now();
    strategyProgress = null;
    clearError();
    // Save as last working strategy
    const s = loadSettings(); s.lastWorkingStrategy = result.strategy; saveSettings(s);
    updateTrayMenu();
    sendLog({ type: 'success', message: `Стратегия ${result.strategy} работает!` });
    sendStatus({ searching: false });
    // Monitor winws.exe since we can't track the elevated process directly
    startWinwsMonitor();
    return { success: true, strategy: result.strategy };
  } else {
    lastError = result.error;
    lastErrorCode = result.errorCode || 'ALL_STRATEGIES_FAILED';
    strategyProgress = null;
    sendLog({ type: 'error', message: result.error });
    sendStatus({ searching: false });
    return { success: false, error: result.error };
  }
}

// ============= PROXY CONTROL =============

async function startProxy() {
  if (isConnected || proxyProcess) {
    lastError = 'Подключение уже активно';
    lastErrorCode = 'ALREADY_RUNNING';
    sendStatus();
    return { success: false, error: 'Already running' };
  }

  // Clear previous errors
  clearError();
  strategyProgress = null;
  sendLog({ type: 'info', message: 'Начало подключения...' });

  const binaryPath = getBinaryPath();
  
  // Auto-download if binary not found
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    sendLog({ type: 'info', message: 'Бинарник не найден, начинаю скачивание...' });
    const downloadResult = await downloadAndExtractBinaries();
    if (!downloadResult.success) {
      lastError = `Не удалось скачать бинарники: ${downloadResult.error}`;
      lastErrorCode = 'DOWNLOAD_FAILED';
      sendLog({ type: 'error', message: lastError });
      sendStatus();
      return { success: false, error: lastError };
    }
    sendLog({ type: 'success', message: 'Бинарники скачаны успешно' });
  }
  
  // Verify binary exists after download
  const finalBinaryPath = getBinaryPath();
  if (!finalBinaryPath || !fs.existsSync(finalBinaryPath)) {
    lastError = 'Бинарник не найден после скачивания';
    lastErrorCode = 'NO_BINARY';
    sendLog({ type: 'error', message: lastError });
    sendStatus();
    return { success: false, error: lastError };
  }

  // Check network availability on macOS
  if (process.platform === 'darwin') {
    const services = getActiveNetworkServices();
    if (services.length === 0) {
      lastError = 'Не обнаружено активных сетевых подключений';
      lastErrorCode = 'NETWORK_UNAVAILABLE';
      sendLog({ type: 'error', message: lastError });
      sendStatus();
      return { success: false, error: lastError };
    }
  }

  sendStatus({ searching: true });

  const allStrategies = getStrategiesForPlatform();
  
  // Check if user selected a specific strategy
  const settings = loadSettings();
  let strategies = allStrategies;
  let singleStrategy = false;
  
  if (settings.selectedStrategy && settings.selectedStrategy !== 'auto') {
    const selected = allStrategies.find(s => s.name === settings.selectedStrategy);
    if (selected) {
      strategies = [selected];
      singleStrategy = true;
      sendLog({ type: 'info', message: `Выбрана стратегия: ${selected.name}` });
    }
  } else if (settings.lastWorkingStrategy) {
    // Try last working strategy first, then all others
    const lastWorking = allStrategies.find(s => s.name === settings.lastWorkingStrategy);
    if (lastWorking) {
      const rest = allStrategies.filter(s => s.name !== settings.lastWorkingStrategy);
      strategies = [lastWorking, ...rest];
      sendLog({ type: 'info', message: `Сначала пробуем последнюю рабочую: ${lastWorking.name}` });
    }
  }
  
  const totalStrategies = strategies.length;
  
  sendLog({ type: 'info', message: `Начинаю перебор ${totalStrategies} стратегий...` });

  // Windows: check admin rights, kill existing winws.exe, verify WinDivert
  if (process.platform === 'win32') {
    // If not running as admin, use elevated batch approach (single UAC prompt)
    if (!isRunningAsAdmin()) {
      sendLog({ type: 'info', message: 'Нет прав администратора — запуск через UAC...' });
      return await startProxyWindowsElevated(finalBinaryPath, strategies, totalStrategies);
    }

    try {
      execSync('taskkill /F /IM winws.exe', { stdio: 'pipe' });
      await new Promise(resolve => setTimeout(resolve, 1500));
      sendLog({ type: 'info', message: 'Завершён предыдущий процесс winws.exe' });
    } catch (e) {
      // No existing process — that's fine
    }

    // Pre-flight check: verify WinDivert driver files exist
    const binDirectory = path.dirname(finalBinaryPath);
    const driverFile = path.join(binDirectory, 'WinDivert64.sys');
    const dllFile = path.join(binDirectory, 'WinDivert.dll');
    if (!fs.existsSync(driverFile) || !fs.existsSync(dllFile)) {
      sendLog({ type: 'warning', message: 'WinDivert файлы отсутствуют, перекачиваю бинарники...' });
      try { fs.unlinkSync(finalBinaryPath); } catch(e) {}
      const dlResult = await downloadAndExtractBinaries();
      if (!dlResult.success) {
        lastError = 'Не удалось скачать WinDivert. Добавьте папку приложения в исключения антивируса.';
        lastErrorCode = 'WINDIVERT_MISSING';
        sendLog({ type: 'error', message: lastError });
        strategyProgress = null;
        sendStatus({ searching: false });
        return { success: false, error: lastError };
      }
      if (!fs.existsSync(driverFile)) {
        lastError = 'WinDivert64.sys удалён антивирусом. Добавьте папку в исключения Windows Defender:\n' + binDirectory;
        lastErrorCode = 'WINDIVERT_BLOCKED';
        sendLog({ type: 'error', message: lastError });
        strategyProgress = null;
        sendStatus({ searching: false });
        return { success: false, error: lastError };
      }
    }
  }

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    
    // Update strategy progress
    strategyProgress = { current: i + 1, total: totalStrategies, name: strategy.name };
    sendStatus({ searching: true });
    sendLog({ type: 'info', message: `[${i + 1}/${totalStrategies}] Тестирование: ${strategy.name}` });
    
    // Stop any previous test process
    if (proxyProcess) {
      try { proxyProcess.kill(); } catch (e) {}
      proxyProcess = null;
    }
    
    try {
      if (process.platform === 'darwin') {
        // macOS - run tpws as SOCKS proxy
        proxyProcess = spawn(finalBinaryPath, strategy.args, {
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        proxyProcess.stdout.on('data', () => {});
        proxyProcess.stderr.on('data', () => {});
        proxyProcess.on('error', () => {});
        
        proxyProcess.on('close', (code) => {
          proxyProcess = null;
          if (isConnected) {
            isConnected = false;
            const prevStrategy = currentStrategy;
            currentStrategy = null;
            connectedSince = null;
            disconnectReason = code === 0 ? 'PROCESS_EXITED' : 'PROCESS_CRASHED';
            lastError = code === 0 
              ? 'Процесс обхода завершился' 
              : `Процесс обхода завершился с ошибкой (код: ${code})`;
            lastErrorCode = 'PROCESS_CRASHED';
            disableSystemProxy();
            updateTrayMenu();
            sendLog({ type: 'error', message: `Стратегия ${prevStrategy} прекратила работу (код: ${code})` });
            sendStatus();
          }
        });
        
        // Wait for tpws to start listening
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!proxyProcess || proxyProcess.killed || proxyProcess.exitCode !== null) {
          sendLog({ type: 'warning', message: `${strategy.name}: процесс не запустился` });
          continue; // Process died, try next strategy
        }
        
        // Quick check: verify tpws is actually listening on the port
        const portOpen = await new Promise((resolve) => {
          const net = require('net');
          const socket = new net.Socket();
          socket.setTimeout(2000);
          socket.on('connect', () => { socket.destroy(); resolve(true); });
          socket.on('error', () => resolve(false));
          socket.on('timeout', () => { socket.destroy(); resolve(false); });
          socket.connect(1080, '127.0.0.1');
        });
        
        if (!portOpen) {
          sendLog({ type: 'warning', message: `${strategy.name}: порт 1080 не доступен` });
          try { proxyProcess.kill(); } catch (e) {}
          proxyProcess = null;
          continue; // tpws not listening, skip this strategy
        }
        
        // Enable system SOCKS proxy so all traffic goes through tpws
        enableSystemProxy(1080);
        
        // Actually test if connection works through the proxy
        const works = await testProxyConnection(1080, 10);
        
        if (works) {
          // Strategy verified working
          isConnected = true;
          currentStrategy = strategy.name;
          connectedSince = Date.now();
          strategyProgress = null;
          clearError();
          // Save as last working strategy
          const s = loadSettings(); s.lastWorkingStrategy = strategy.name; saveSettings(s);
          updateTrayMenu();
          sendLog({ type: 'success', message: `Стратегия ${strategy.name} работает!` });
          sendStatus({ searching: false });
          return { success: true, strategy: strategy.name };
        } else {
          // Strategy didn't work — clean up and try next
          sendLog({ type: 'warning', message: `${strategy.name}: не прошла проверку соединения` });
          disableSystemProxy();
          try { proxyProcess.kill(); } catch (e) {}
          proxyProcess = null;
          continue;
        }
        
      } else if (process.platform === 'win32') {
        // Windows - winws.exe intercepts traffic at driver level via WinDivert
        // No proxy configuration needed — it modifies packets in-flight
        const binDirectory = path.dirname(finalBinaryPath);

        // Kill any leftover winws from previous strategy iteration
        try { execSync('taskkill /F /IM winws.exe', { stdio: 'pipe' }); } catch(e) {}
        await new Promise(resolve => setTimeout(resolve, 500));

        // Start winws.exe directly (app runs as admin via manifest)
        let spawnError = null;
        let winwsStderr = '';
        
        try {
          proxyProcess = spawn(finalBinaryPath, strategy.args, {
            cwd: binDirectory,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          });
        } catch (e) {
          sendLog({ type: 'warning', message: `${strategy.name}: не удалось запустить — ${e.message}` });
          proxyProcess = null;
          continue;
        }

        proxyProcess.stderr.on('data', (data) => { winwsStderr += data.toString(); });
        proxyProcess.stdout.on('data', () => {});
        
        let earlyExitCode = null;
        proxyProcess.on('error', (err) => { spawnError = err; });
        proxyProcess.on('close', (code) => { earlyExitCode = code; });

        // Wait for winws to start up and set up WinDivert filters
        await new Promise(resolve => setTimeout(resolve, 3000));

        if (spawnError || earlyExitCode !== null || !proxyProcess || proxyProcess.killed) {
          const errMsg = spawnError ? spawnError.message : winwsStderr.trim() || `код выхода: ${earlyExitCode}`;
          sendLog({ type: 'warning', message: `${strategy.name}: процесс не запустился — ${errMsg}` });
          proxyProcess = null;
          continue;
        }

        // winws is running — test if DPI bypass actually works
        const works = await testDirectConnection(10);
        
        if (works) {
          // Strategy verified working!
          isConnected = true;
          currentStrategy = strategy.name;
          connectedSince = Date.now();
          strategyProgress = null;
          clearError();
          // Save as last working strategy
          const s = loadSettings(); s.lastWorkingStrategy = strategy.name; saveSettings(s);
          
          // Set up close handler for the connected process
          proxyProcess.removeAllListeners('close');
          proxyProcess.on('close', (code) => {
            proxyProcess = null;
            if (isConnected) {
              isConnected = false;
              const prevStrategy = currentStrategy;
              currentStrategy = null;
              connectedSince = null;
              disconnectReason = 'PROCESS_CRASHED';
              lastError = `Процесс обхода завершился неожиданно (код: ${code})`;
              lastErrorCode = 'PROCESS_CRASHED';
              updateTrayMenu();
              sendLog({ type: 'error', message: `Стратегия ${prevStrategy} прекратила работу` });
              sendStatus();
            }
          });

          updateTrayMenu();
          sendLog({ type: 'success', message: `Стратегия ${strategy.name} работает!` });
          sendStatus({ searching: false });
          return { success: true, strategy: strategy.name };
        } else {
          // Strategy didn't work — kill it and try next
          sendLog({ type: 'warning', message: `${strategy.name}: не прошла проверку соединения` });
          try { proxyProcess.kill(); } catch(e) {}
          proxyProcess = null;
          continue;
        }
      }
      
    } catch (error) {
      sendLog({ type: 'warning', message: `${strategy.name}: ошибка — ${error.message}` });
      // Strategy failed, try next
    }
  }
  
  // All strategies failed
  lastError = 'Ни одна стратегия не сработала. Попробуйте позже или обратитесь в поддержку';
  lastErrorCode = 'ALL_STRATEGIES_FAILED';
  strategyProgress = null;
  sendLog({ type: 'error', message: `Все ${totalStrategies} стратегий не сработали` });
  sendStatus({ searching: false });
  return { success: false, error: lastError };
}

function stopProxy() {
  // Disable system proxy FIRST (before killing tpws)
  disableSystemProxy();
  
  // Stop winws monitor if running
  stopWinwsMonitor();
  
  if (proxyProcess) {
    try { proxyProcess.kill('SIGTERM'); } catch (e) {}
    proxyProcess = null;
  }

  // Kill all related processes synchronously for reliable cleanup
  if (process.platform === 'darwin') {
    try { execSync('pkill -f tpws 2>/dev/null', { stdio: 'pipe' }); } catch (e) {}
  } else if (process.platform === 'win32') {
    try {
      execSync('taskkill /F /IM winws.exe', { stdio: 'pipe' });
    } catch (e) {
      // If direct kill fails (elevated process), try via sudo
      try { sudo.exec('taskkill /F /IM winws.exe', { name: 'UnblockPro' }, () => {}); } catch (e2) {}
    }
  }

  isConnected = false;
  currentStrategy = null;
  connectedSince = null;
  strategyProgress = null;
  clearError();
  updateTrayMenu();
  sendLog({ type: 'info', message: 'Отключено пользователем' });
  sendStatus();
  
  return { success: true };
}

// ============= WINDOW & TRAY =============

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 380,
    minHeight: 480,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const size = 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="3" fill="#3b82f6"/>
    <text x="${size/2}" y="${size*0.7}" font-family="Arial" font-size="10" font-weight="bold" fill="white" text-anchor="middle">U</text>
  </svg>`;
  
  let trayIcon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  );
  
  if (process.platform === 'darwin') {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
    trayIcon.setTemplateImage(true);
  }
  
  tray = new Tray(trayIcon);
  tray.setToolTip('UnblockPro');
  
  updateTrayMenu();
  
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

// ============= AUTO-UPDATER =============

function setupAutoUpdater() {
  if (isDev) return; // Don't check for updates in dev mode
  
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  
  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking');
  });
  
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('available', info.version);
  });
  
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus('not-available');
  });
  
  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('update-download-progress', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total
      });
    }
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus('downloaded', info.version);
  });
  
  autoUpdater.on('error', () => {
    sendUpdateStatus('error');
  });
  
  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}

function sendUpdateStatus(status, version = null) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update-status', { status, version });
  }
}

// ============= IPC HANDLERS =============

ipcMain.handle('start-proxy', async () => {
  return await startProxy();
});

ipcMain.handle('stop-proxy', () => {
  return stopProxy();
});

ipcMain.handle('download-binaries', async () => {
  return await downloadAndExtractBinaries();
});

ipcMain.handle('get-status', () => {
  return { 
    connected: isConnected,
    downloading: isDownloading,
    strategy: currentStrategy,
    binaryExists: fs.existsSync(getBinaryPath() || ''),
    error: lastError,
    errorCode: lastErrorCode,
    disconnectReason: disconnectReason,
    connectedSince: connectedSince,
    strategyProgress: strategyProgress
  };
});

ipcMain.handle('get-logs', () => {
  return logEntries;
});

ipcMain.handle('clear-error', () => {
  clearError();
  sendStatus();
  return { success: true };
});

ipcMain.handle('minimize-window', () => mainWindow.minimize());
ipcMain.handle('close-window', () => mainWindow.hide());

ipcMain.handle('open-external', (event, url) => {
  const { shell } = require('electron');
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

ipcMain.handle('get-system-info', () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
  binaryExists: fs.existsSync(getBinaryPath() || ''),
  binaryPath: getBinaryPath()
}));

ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('check-for-updates', () => {
  if (!isDev) autoUpdater.checkForUpdates().catch(() => {});
});

ipcMain.handle('set-auto-start', (event, enabled) => {
  const settings = loadSettings();
  settings.autoStart = enabled;
  saveSettings(settings);
  applyAutoStart(enabled);
  return { success: true };
});

ipcMain.handle('set-auto-connect', (event, enabled) => {
  const settings = loadSettings();
  settings.autoConnect = enabled;
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle('get-strategies', () => {
  const strategies = getStrategiesForPlatform();
  return strategies.map(s => s.name);
});

ipcMain.handle('set-selected-strategy', (event, strategyName) => {
  const settings = loadSettings();
  settings.selectedStrategy = strategyName; // 'auto' or strategy name
  saveSettings(settings);
  return { success: true };
});

// ============= SINGLE INSTANCE LOCK =============
// MUST be checked BEFORE any app.whenReady() or event handlers are registered.
// Otherwise app.quit() races with already-queued callbacks and the window
// briefly appears then disappears.

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ============= APP LIFECYCLE =============

  app.whenReady().then(async () => {
    // Clean up stale proxy settings from previous crash
    disableSystemProxy();
    
    createWindow();
    createTray();
    
    // Send initial status
    const binaryExists = fs.existsSync(getBinaryPath() || '');
    sendLog({ type: 'info', message: 'Приложение запущено' });
    sendStatus({ binaryExists });
    
    // Setup auto-updater
    setupAutoUpdater();
    
    // Apply saved auto-start setting
    const settings = loadSettings();
    applyAutoStart(settings.autoStart);
    
    // Auto-connect if enabled
    if (settings.autoConnect) {
      setTimeout(() => {
        startProxy();
      }, 1500);
    }
    
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        mainWindow.show();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    stopProxy();
  });

  // Ensure proxy cleanup on any exit scenario
  function emergencyCleanup() {
    try { disableSystemProxy(); } catch (e) {}
    try { stopWinwsMonitor(); } catch (e) {}
    try { if (proxyProcess) proxyProcess.kill(); } catch (e) {}
    if (process.platform === 'darwin') {
      try { execSync('pkill -f tpws 2>/dev/null', { stdio: 'pipe' }); } catch (e) {}
    } else if (process.platform === 'win32') {
      try { execSync('taskkill /F /IM winws.exe', { stdio: 'pipe' }); } catch (e) {}
    }
  }

  process.on('exit', emergencyCleanup);
  process.on('SIGTERM', () => { emergencyCleanup(); process.exit(0); });
  process.on('SIGINT', () => { emergencyCleanup(); process.exit(0); });

} // end of gotTheLock else block
