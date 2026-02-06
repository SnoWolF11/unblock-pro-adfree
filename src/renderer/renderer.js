// DOM Elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const strategyText = document.getElementById('strategyText');
const connectBtn = document.getElementById('connectBtn');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');
const platformBadge = document.getElementById('platformBadge');
const binaryStatus = document.getElementById('binaryStatus');
const downloadSection = document.getElementById('downloadSection');
const downloadText = document.getElementById('downloadText');
const progressFill = document.getElementById('progressFill');
const downloadPercent = document.getElementById('downloadPercent');
const autostartToggle = document.getElementById('autostartToggle');
const autoconnectToggle = document.getElementById('autoconnectToggle');

// State
let isConnected = false;
let isConnecting = false;
let isDownloading = false;

// Initialize
async function init() {
  setupEventListeners();
  await loadSystemInfo();
  await loadStatus();
  await loadSettings();
  
  // Listen for updates
  window.api.onStatus(handleStatusUpdate);
  window.api.onDownloadProgress(handleDownloadProgress);
}

function setupEventListeners() {
  minimizeBtn.addEventListener('click', () => window.api.minimizeWindow());
  closeBtn.addEventListener('click', () => window.api.closeWindow());
  connectBtn.addEventListener('click', handleConnectClick);
  
  autostartToggle.addEventListener('change', async () => {
    await window.api.setAutoStart(autostartToggle.checked);
  });
  
  autoconnectToggle.addEventListener('change', async () => {
    await window.api.setAutoConnect(autoconnectToggle.checked);
  });
}

async function loadSystemInfo() {
  try {
    const info = await window.api.getSystemInfo();
    
    const platformNames = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux'
    };
    
    platformBadge.textContent = platformNames[info.platform] || info.platform;
    
    updateBinaryStatus(info.binaryExists);
  } catch (error) {
    // silently handle
  }
}

function updateBinaryStatus(exists, downloading = false) {
  const binaryTextEl = binaryStatus.querySelector('.binary-text');
  
  binaryStatus.classList.remove('ready', 'error', 'downloading');
  
  if (downloading) {
    binaryStatus.classList.add('downloading');
    binaryTextEl.textContent = 'Скачивание...';
  } else if (exists) {
    binaryStatus.classList.add('ready');
    binaryTextEl.textContent = 'Готов';
  } else {
    binaryStatus.classList.add('error');
    binaryTextEl.textContent = 'Нет бинарника';
  }
}

async function loadStatus() {
  try {
    const status = await window.api.getStatus();
    handleStatusUpdate(status);
  } catch (error) {
    // silently handle
  }
}

async function loadSettings() {
  try {
    const settings = await window.api.getSettings();
    autostartToggle.checked = settings.autoStart || false;
    autoconnectToggle.checked = settings.autoConnect || false;
  } catch (error) {
    // silently handle
  }
}

function handleStatusUpdate(status) {
  isConnected = status.connected;
  isDownloading = status.downloading;
  
  // When backend confirms connected, clear local connecting state
  if (isConnected) {
    isConnecting = false;
  }
  
  // Update status indicator
  statusIndicator.classList.remove('connected', 'connecting', 'searching', 'downloading');
  connectBtn.classList.remove('connected', 'connecting', 'downloading');
  
  if (isDownloading) {
    statusIndicator.classList.add('downloading');
    statusText.textContent = 'Скачивание...';
    connectBtn.classList.add('downloading');
    connectBtn.querySelector('.btn-text').textContent = 'Скачивание...';
    downloadSection.style.display = 'block';
    updateBinaryStatus(false, true);
  } else if (status.searching) {
    statusIndicator.classList.add('searching');
    statusText.textContent = 'Поиск стратегии...';
    connectBtn.classList.add('connecting');
    connectBtn.querySelector('.btn-text').textContent = 'Поиск...';
    downloadSection.style.display = 'none';
  } else if (isConnected) {
    statusIndicator.classList.add('connected');
    statusText.textContent = 'Защита активна';
    connectBtn.classList.add('connected');
    connectBtn.querySelector('.btn-text').textContent = 'Отключить';
    downloadSection.style.display = 'none';
  } else if (isConnecting) {
    statusIndicator.classList.add('connecting');
    statusText.textContent = 'Подключение...';
    connectBtn.classList.add('connecting');
    connectBtn.querySelector('.btn-text').textContent = 'Подключение...';
    downloadSection.style.display = 'none';
  } else {
    statusText.textContent = 'Отключено';
    connectBtn.querySelector('.btn-text').textContent = 'Подключить';
    downloadSection.style.display = 'none';
  }
  
  // Update strategy text
  if (status.strategy) {
    strategyText.textContent = `Стратегия: ${status.strategy}`;
  } else {
    strategyText.textContent = '';
  }
  
  // Update binary status
  if (!isDownloading) {
    updateBinaryStatus(status.binaryExists);
  }
}

function handleDownloadProgress(progress) {
  downloadSection.style.display = 'block';
  progressFill.style.width = `${progress.percent}%`;
  downloadPercent.textContent = `${progress.percent}%`;
  
  if (progress.total) {
    const downloadedMB = (progress.downloaded / 1024 / 1024).toFixed(1);
    const totalMB = (progress.total / 1024 / 1024).toFixed(1);
    downloadText.textContent = `Скачивание: ${downloadedMB} / ${totalMB} MB`;
  }
}

async function handleConnectClick() {
  if (isConnecting || isDownloading) return;
  
  if (isConnected) {
    // Disconnect
    try {
      await window.api.stopProxy();
    } catch (error) {
      // silently handle
    }
  } else {
    // Connect
    isConnecting = true;
    statusIndicator.classList.add('connecting');
    statusText.textContent = 'Подключение...';
    connectBtn.classList.add('connecting');
    connectBtn.querySelector('.btn-text').textContent = 'Подключение...';
    
    try {
      await window.api.startProxy();
    } catch (error) {
      // silently handle
    } finally {
      isConnecting = false;
      // Sync UI with actual backend state after connect attempt
      await loadStatus();
    }
  }
}

// Start
init();
