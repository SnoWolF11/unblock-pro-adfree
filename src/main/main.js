const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const sudo = require('sudo-prompt');

let mainWindow;
let tray;
let proxyProcess = null;
let isConnected = false;
let isDownloading = false;
let currentStrategy = null;

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

const ZAPRET_VERSION = 'v72.9';

// Different URLs for different platforms
const DOWNLOAD_URLS = {
  win32: `https://github.com/bol-van/zapret/releases/download/${ZAPRET_VERSION}/zapret-win-x86_64-${ZAPRET_VERSION}.zip`,
  // For macOS we'll use the full zapret archive and compile or use prebuilt from alternative source
  darwin: `https://github.com/bol-van/zapret/releases/download/${ZAPRET_VERSION}/zapret-${ZAPRET_VERSION}.zip`
};

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

// DPI bypass strategies to try (ordered by success rate)
const STRATEGIES = {
  darwin: [
    // Strategy 1: Split + disorder (most common)
    {
      name: 'split+disorder',
      args: ['--port', '1080', '--socks', '--split-pos=1', '--disorder', '--hostcase']
    },
    // Strategy 2: Split at TLS position
    {
      name: 'split-tls',
      args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder=tls', '--hostcase']
    },
    // Strategy 3: Method EOL
    {
      name: 'methodeol',
      args: ['--port', '1080', '--socks', '--methodeol', '--split-pos=1', '--hostcase']
    },
    // Strategy 4: OOB byte
    {
      name: 'oob',
      args: ['--port', '1080', '--socks', '--oob', '--split-pos=1', '--disorder']
    },
    // Strategy 5: All combined
    {
      name: 'combined',
      args: ['--port', '1080', '--socks', '--split-pos=1,midsld', '--disorder', '--hostcase', '--methodeol']
    }
  ],
  win32: [
    // Strategy 1: Fake + multidisorder
    {
      name: 'fake+multidisorder',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--wf-udp=443', '--dpi-desync=fake,multidisorder', '--dpi-desync-split-pos=1,midsld', '--dpi-desync-fooling=badseq,md5sig']
    },
    // Strategy 2: Fake + split2
    {
      name: 'fake+split2',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=badseq']
    },
    // Strategy 3: Fake + fakedsplit
    {
      name: 'fake+fakedsplit',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--dpi-desync=fake,fakedsplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig']
    },
    // Strategy 4: Disorder only
    {
      name: 'disorder',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--dpi-desync=multidisorder', '--dpi-desync-split-pos=1,midsld']
    },
    // Strategy 5: Syndata
    {
      name: 'syndata',
      args: ['--wf-l3=ipv4,ipv6', '--wf-tcp=80,443', '--dpi-desync=syndata', '--dpi-desync-fake-tls=0x00000000']
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
      ...extra
    });
  }
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
    const file = fs.createWriteStream(dest);
    
    const request = https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        downloadFileDirect(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
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
      fs.unlink(dest, () => {});
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
    // Create directories
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    
    const downloadUrl = DOWNLOAD_URLS[process.platform];
    if (!downloadUrl) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    const zipPath = path.join(tempDir, 'zapret.zip');
    
    // Download
    await downloadFile(downloadUrl, zipPath);
    
    // Extract
    // Extract
    
    if (process.platform === 'win32') {
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'pipe' });
      
      // Windows archive structure: zapret-win-x86_64-v72.9/
      
      // Find winws.exe recursively
      let winwsPath = null;
      const findWinws = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            findWinws(fullPath);
          } else if (file === 'winws.exe' && !winwsPath) {
            winwsPath = fullPath;
          }
        }
      };
      findWinws(tempDir);
      
      if (winwsPath) {
        fs.copyFileSync(winwsPath, path.join(platformDir, 'winws.exe'));
        
        // Copy WinDivert files from same directory
        const winwsDir = path.dirname(winwsPath);
        const divertFiles = ['WinDivert.dll', 'WinDivert64.sys', 'WinDivert32.sys'];
        
        for (const file of divertFiles) {
          const src = path.join(winwsDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(platformDir, file));
          }
        }
      } else {
        throw new Error('winws.exe not found in archive');
      }
      
    } else if (process.platform === 'darwin') {
      execSync(`unzip -o "${zipPath}" -d "${tempDir}"`, { stdio: 'pipe' });
      
      // For macOS, the release archive contains prebuilt binaries
      const zapretDir = path.join(tempDir, `zapret-${ZAPRET_VERSION}`);
      
      // Try multiple possible binary locations
      const possiblePaths = [
        // Official release locations
        path.join(zapretDir, 'binaries', 'mach-o', 'tpws'),
        path.join(zapretDir, 'binaries', 'macos', 'tpws'),
        path.join(zapretDir, 'binaries', `mach-o-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`, 'tpws'),
        // FreeBSD binaries might work
        path.join(zapretDir, 'binaries', 'freebsd-x64', 'tpws'),
      ];
      
      let found = false;
      
      // Check available architectures
      const binariesDir = path.join(zapretDir, 'binaries');
      if (fs.existsSync(binariesDir)) {
        const archs = fs.readdirSync(binariesDir);
        
        // Try each available architecture
        for (const arch of archs) {
          const tpwsPath = path.join(binariesDir, arch, 'tpws');
          if (fs.existsSync(tpwsPath)) {
            possiblePaths.unshift(tpwsPath);
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
    sendStatus();
    
    // Cleanup on error
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    
    return { success: false, error: error.message };
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

function testProxyConnection(port = 1080, timeoutSec = 7) {
  return new Promise((resolve) => {
    // Test Discord API through the SOCKS proxy — validates DPI bypass end-to-end
    exec(
      `curl --socks5-hostname 127.0.0.1:${port} --connect-timeout ${timeoutSec} -s -o /dev/null -w "%{http_code}" https://discord.com/api/v10/gateway`,
      { timeout: (timeoutSec + 3) * 1000 },
      (error, stdout) => {
        if (error) { resolve(false); return; }
        const code = parseInt(stdout.trim(), 10);
        // 200 = OK, 401 = Unauthorized (expected without token), both mean connection worked
        resolve(code > 0 && code < 500);
      }
    );
  });
}

// ============= PROXY CONTROL =============

async function startProxy() {
  if (isConnected || proxyProcess) {
    return { success: false, error: 'Already running' };
  }

  const binaryPath = getBinaryPath();
  
  // Auto-download if binary not found
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    const downloadResult = await downloadAndExtractBinaries();
    if (!downloadResult.success) {
      return { success: false, error: 'Failed to download binaries' };
    }
  }
  
  // Verify binary exists after download
  const finalBinaryPath = getBinaryPath();
  if (!finalBinaryPath || !fs.existsSync(finalBinaryPath)) {
    return { success: false, error: 'Binary not found' };
  }

  sendStatus({ searching: true });

  const strategies = STRATEGIES[process.platform] || [];
  
  for (const strategy of strategies) {
    
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
        
        proxyProcess.on('close', () => {
          proxyProcess = null;
          if (isConnected) {
            isConnected = false;
            currentStrategy = null;
            disableSystemProxy();
            updateTrayMenu();
            sendStatus();
          }
        });
        
        // Wait for tpws to start listening
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        if (!proxyProcess || proxyProcess.killed || proxyProcess.exitCode !== null) {
          continue; // Process died, try next strategy
        }
        
        // Enable system SOCKS proxy so all traffic goes through tpws
        enableSystemProxy(1080);
        
        // Actually test if connection works through the proxy
        const works = await testProxyConnection(1080, 7);
        
        if (works) {
          // Strategy verified working
          isConnected = true;
          currentStrategy = strategy.name;
          updateTrayMenu();
          sendStatus({ searching: false });
          return { success: true, strategy: strategy.name };
        } else {
          // Strategy didn't work — clean up and try next
          disableSystemProxy();
          try { proxyProcess.kill(); } catch (e) {}
          proxyProcess = null;
          continue;
        }
        
      } else if (process.platform === 'win32') {
        // Windows - winws.exe intercepts traffic at driver level via WinDivert
        // No proxy configuration needed — it modifies packets in-flight
        const command = `"${finalBinaryPath}" ${strategy.args.join(' ')}`;
        
        return new Promise((resolve) => {
          sudo.exec(command, { name: 'UnblockPro' }, (error) => {
            if (error) {
              resolve({ success: false, error: error.message });
              return;
            }
            
            isConnected = true;
            currentStrategy = strategy.name;
            updateTrayMenu();
            sendStatus({ searching: false });
            resolve({ success: true, strategy: strategy.name });
          });
          
          // Also try direct spawn for process tracking
          try {
            proxyProcess = spawn(finalBinaryPath, strategy.args, {
              detached: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true
            });
            
            proxyProcess.on('close', () => {
              proxyProcess = null;
              isConnected = false;
              currentStrategy = null;
              updateTrayMenu();
              sendStatus();
            });
          } catch (e) {}
        });
      }
      
    } catch (error) {
      // Strategy failed, try next
    }
  }
  
  sendStatus({ searching: false });
  return { success: false, error: 'No working strategy found' };
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
  updateTrayMenu();
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
    binaryExists: fs.existsSync(getBinaryPath() || '')
  };
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
  sendStatus({ binaryExists });
  
  // Apply saved auto-start setting
  const settings = loadSettings();
  applyAutoStart(settings.autoStart);
  
  // Auto-connect if enabled
  if (settings.autoConnect) {
    // Small delay to let the window fully load
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
