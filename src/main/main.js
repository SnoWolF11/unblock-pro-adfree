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

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// ============= SETTINGS =============

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (e) {}
  return { autoStart: false, autoConnect: false };
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
  return path.join(process.resourcesPath, 'bin');
}

function getBinDir() {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'bin');
  }
  return path.join(process.resourcesPath, 'bin');
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

// DPI bypass strategies — based on Flowseal/zapret-discord-youtube (22k+ stars)
const STRATEGIES = {
  darwin: [
    // === BASIC (work on most ISPs) ===
    {
      name: 'split+disorder',
      args: ['--port', '1080', '--socks', '--split-pos=1', '--disorder', '--hostcase']
    },
    {
      name: 'split-midsld+disorder',
      args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder', '--hostcase']
    },
    {
      name: 'split2+disorder',
      args: ['--port', '1080', '--socks', '--split-pos=2', '--disorder', '--hostcase']
    },
    // === TLS-AWARE ===
    {
      name: 'tlsrec+split+disorder',
      args: ['--port', '1080', '--socks', '--tlsrec=sni', '--split-pos=1', '--disorder', '--hostcase']
    },
    {
      name: 'split-tls+disorder',
      args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder=tls', '--hostcase']
    },
    // === HOST MANIPULATION ===
    {
      name: 'methodeol+split',
      args: ['--port', '1080', '--socks', '--methodeol', '--split-pos=1', '--hostcase']
    },
    {
      name: 'hostdot+split+disorder',
      args: ['--port', '1080', '--socks', '--hostdot', '--split-pos=1,midsld', '--disorder']
    },
    {
      name: 'hostpad+split+disorder',
      args: ['--port', '1080', '--socks', '--hostpad=256', '--split-pos=1', '--disorder', '--hostcase']
    },
    // === OOB ===
    {
      name: 'oob+split+disorder',
      args: ['--port', '1080', '--socks', '--oob', '--split-pos=1', '--disorder']
    },
    {
      name: 'oob+methodeol+split',
      args: ['--port', '1080', '--socks', '--oob', '--methodeol', '--split-pos=1', '--hostcase']
    },
    // === COMBINED (aggressive) ===
    {
      name: 'combined-v1',
      args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder', '--hostcase', '--methodeol']
    },
    {
      name: 'combined-v2',
      args: ['--port', '1080', '--socks', '--oob', '--methodeol', '--split-pos=1,midsld', '--disorder', '--hostcase', '--hostdot']
    },
    {
      name: 'combined-v3',
      args: ['--port', '1080', '--socks', '--tlsrec=sni', '--hostpad=256', '--split-pos=2', '--disorder', '--hostcase']
    },
    // === EXTENDED SPLIT POSITIONS ===
    {
      name: 'split3+disorder',
      args: ['--port', '1080', '--socks', '--split-pos=3', '--disorder', '--hostcase']
    },
    {
      name: 'split-sniext+disorder',
      args: ['--port', '1080', '--socks', '--split-pos=1,sniext', '--disorder', '--hostcase']
    },
    // === HOST MANIPULATION VARIANTS ===
    {
      name: 'hosttab+split+disorder',
      args: ['--port', '1080', '--socks', '--hosttab', '--split-pos=1', '--disorder', '--hostcase']
    },
    {
      name: 'hostspell+split',
      args: ['--port', '1080', '--socks', '--hostspell', '--split-pos=1', '--disorder']
    },
    // === LARGE HOSTPAD VARIANTS ===
    {
      name: 'hostpad512+split+disorder',
      args: ['--port', '1080', '--socks', '--hostpad=512', '--split-pos=1', '--disorder', '--hostcase']
    },
    {
      name: 'hostpad1024+split',
      args: ['--port', '1080', '--socks', '--hostpad=1024', '--split-pos=1,midsld', '--hostcase']
    },
    // === TLS RECORD MANIPULATION ===
    {
      name: 'tlsrec+disorder',
      args: ['--port', '1080', '--socks', '--tlsrec=sni', '--disorder', '--hostcase']
    },
    {
      name: 'tlsrec+oob+split',
      args: ['--port', '1080', '--socks', '--tlsrec=sni', '--oob', '--split-pos=1', '--hostcase']
    },
    // === AGGRESSIVE COMBINED ===
    {
      name: 'combined-v4',
      args: ['--port', '1080', '--socks', '--oob', '--hostpad=256', '--split-pos=1,midsld', '--disorder', '--hostcase', '--methodeol']
    },
    {
      name: 'combined-v5',
      args: ['--port', '1080', '--socks', '--tlsrec=sni', '--methodeol', '--hostdot', '--split-pos=2', '--disorder', '--hostcase']
    },
    // === MINIMAL (last resort) ===
    {
      name: 'split-only',
      args: ['--port', '1080', '--socks', '--split-pos=1']
    },
    {
      name: 'disorder-only',
      args: ['--port', '1080', '--socks', '--disorder']
    }
  ],
  // Windows strategies based on Flowseal/zapret-discord-youtube
  win32: [
    // Strategy: general.bat — multisplit seqovl=568 (Flowseal default)
    {
      name: 'multisplit-568',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=568',
        '--dpi-desync-split-pos=1']
    },
    // Strategy: general (ALT).bat — fake+fakedsplit with fooling=ts
    {
      name: 'fake+fakedsplit-ts',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake,fakedsplit', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00']
    },
    // Strategy: general (ALT2).bat — multisplit seqovl=652 pos=2
    {
      name: 'multisplit-652',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=652',
        '--dpi-desync-split-pos=2']
    },
    // Strategy: fake+multidisorder (classic)
    {
      name: 'fake+multidisorder',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake,multidisorder', '--dpi-desync-split-pos=1,midsld',
        '--dpi-desync-fooling=badseq,md5sig']
    },
    // Strategy: multisplit seqovl=681 (for Google/YT)
    {
      name: 'multisplit-681',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=681',
        '--dpi-desync-split-pos=1']
    },
    // Strategy: fake with repeats
    {
      name: 'fake-repeat6',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=badseq']
    },
    // Strategy: fake+split2 (fallback)
    {
      name: 'fake+split2',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake,split2', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=badseq']
    },
    // Strategy: multidisorder only (simple)
    {
      name: 'multidisorder',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multidisorder', '--dpi-desync-split-pos=1,midsld']
    },
    // Strategy: different seqovl values (ISP-specific)
    {
      name: 'multisplit-1',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=1',
        '--dpi-desync-split-pos=1']
    },
    {
      name: 'multisplit-2',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=2',
        '--dpi-desync-split-pos=2']
    },
    {
      name: 'multisplit-336',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=336',
        '--dpi-desync-split-pos=1']
    },
    // Strategy: fake with TTL manipulation
    {
      name: 'fake-ttl3',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake', '--dpi-desync-ttl=3',
        '--dpi-desync-fooling=md5sig']
    },
    {
      name: 'fake-autottl',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake', '--dpi-desync-autottl=2',
        '--dpi-desync-fooling=md5sig']
    },
    // Strategy: disorder2 variants
    {
      name: 'fake+disorder2',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake,disorder2', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=badseq']
    },
    {
      name: 'disorder2+split2',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=disorder2,split2', '--dpi-desync-split-pos=1,midsld']
    },
    // Strategy: fakedsplit variants
    {
      name: 'fakedsplit-md5sig',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake,fakedsplit', '--dpi-desync-repeats=6',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-fakedsplit-pattern=0x00']
    },
    // Strategy: combined TCP+QUIC approaches
    {
      name: 'multisplit-midsld',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=2',
        '--dpi-desync-split-pos=midsld']
    },
    {
      name: 'fake+multisplit',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-seqovl=1',
        '--dpi-desync-split-pos=1', '--dpi-desync-fooling=badseq']
    },
    // Strategy: syndata (last resort)
    {
      name: 'syndata',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443',
        '--dpi-desync=syndata', '--dpi-desync-fake-tls=0x00000000']
    },
    // Strategy: syndata with TTL
    {
      name: 'syndata+ttl',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443',
        '--dpi-desync=syndata', '--dpi-desync-fake-tls=0x00000000',
        '--dpi-desync-ttl=5']
    }
  ]
};

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
  // Test multiple endpoints — some may be blocked differently
  const endpoints = [
    'https://discord.com/api/v10/gateway',
    'https://www.youtube.com/',
    'https://clients3.google.com/generate_204'
  ];
  
  // Try each endpoint, succeed on first working one
  for (const url of endpoints) {
    const works = await testSingleConnection(port, timeoutSec, url);
    if (works) return true;
  }
  
  // Retry first endpoint once more (network can be flaky)
  return await testSingleConnection(port, timeoutSec, endpoints[0]);
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

  const strategies = STRATEGIES[process.platform] || [];
  const totalStrategies = strategies.length;
  
  sendLog({ type: 'info', message: `Начинаю перебор ${totalStrategies} стратегий...` });
  
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
        
        // Pre-flight check: verify WinDivert driver files exist
        const driverFile = path.join(binDirectory, 'WinDivert64.sys');
        const dllFile = path.join(binDirectory, 'WinDivert.dll');
        if (!fs.existsSync(driverFile) || !fs.existsSync(dllFile)) {
          sendLog({ type: 'warning', message: 'WinDivert файлы отсутствуют, перекачиваю бинарники...' });
          // Force re-download — files may have been deleted by antivirus
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
          // Check again after re-download
          if (!fs.existsSync(driverFile)) {
            lastError = 'WinDivert64.sys удалён антивирусом. Добавьте папку в исключения Windows Defender:\n' + binDirectory;
            lastErrorCode = 'WINDIVERT_BLOCKED';
            sendLog({ type: 'error', message: lastError });
            strategyProgress = null;
            sendStatus({ searching: false });
            return { success: false, error: lastError };
          }
        }
        
        // cd to binary directory so WinDivert can find its driver files
        const command = `cd /d "${binDirectory}" && "${finalBinaryPath}" ${strategy.args.join(' ')}`;
        
        return new Promise((resolve) => {
          sudo.exec(command, { name: 'UnblockPro' }, (error) => {
            if (error) {
              const isPermDenied = error.message && (
                error.message.includes('canceled') || 
                error.message.includes('cancelled') || 
                error.message.includes('User did not grant')
              );
              const isWinDivertError = error.message && (
                error.message.includes('windivert') ||
                error.message.includes('cannot find the file')
              );
              if (isPermDenied) {
                lastError = 'Требуются права администратора для обхода DPI';
                lastErrorCode = 'PERMISSION_DENIED';
              } else if (isWinDivertError) {
                lastError = 'WinDivert не может загрузить драйвер. Добавьте папку в исключения Windows Defender:\n' + binDirectory;
                lastErrorCode = 'WINDIVERT_BLOCKED';
              } else {
                lastError = `Ошибка запуска: ${error.message}`;
                lastErrorCode = 'PROCESS_CRASHED';
              }
              sendLog({ type: 'error', message: lastError });
              strategyProgress = null;
              sendStatus({ searching: false });
              resolve({ success: false, error: lastError });
              return;
            }
            
            isConnected = true;
            currentStrategy = strategy.name;
            connectedSince = Date.now();
            strategyProgress = null;
            clearError();
            updateTrayMenu();
            sendLog({ type: 'success', message: `Стратегия ${strategy.name} работает!` });
            sendStatus({ searching: false });
            resolve({ success: true, strategy: strategy.name });
          });
          
          // Also try direct spawn for process tracking
          try {
            proxyProcess = spawn(finalBinaryPath, strategy.args, {
              cwd: binDirectory,
              detached: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true
            });
            
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
          } catch (e) {}
        });
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
  
  if (proxyProcess) {
    try { proxyProcess.kill('SIGTERM'); } catch (e) {}
    proxyProcess = null;
  }

  // Kill all related processes
  if (process.platform === 'darwin') {
    exec('pkill -f tpws 2>/dev/null', () => {});
  } else if (process.platform === 'win32') {
    exec('taskkill /F /IM winws.exe 2>nul', () => {});
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
  try { if (proxyProcess) proxyProcess.kill(); } catch (e) {}
  if (process.platform === 'darwin') {
    try { execSync('pkill -f tpws 2>/dev/null', { stdio: 'pipe' }); } catch (e) {}
  }
}

process.on('exit', emergencyCleanup);
process.on('SIGTERM', () => { emergencyCleanup(); process.exit(0); });
process.on('SIGINT', () => { emergencyCleanup(); process.exit(0); });

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
}
