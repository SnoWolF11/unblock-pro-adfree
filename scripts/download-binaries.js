const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ZAPRET_VERSION = 'v72.9';
const ZAPRET_RELEASE_URL = `https://github.com/bol-van/zapret/releases/download/${ZAPRET_VERSION}`;

const BINARIES = {
  darwin: {
    name: 'tpws',
    url: `${ZAPRET_RELEASE_URL}/zapret-${ZAPRET_VERSION}.tar.gz`,
    extractPath: `zapret-${ZAPRET_VERSION}/binaries/aarch64/tpws`,
    extractPathX64: `zapret-${ZAPRET_VERSION}/binaries/x86_64/tpws`
  },
  win32: {
    name: 'winws.exe',
    url: `${ZAPRET_RELEASE_URL}/zapret-${ZAPRET_VERSION}.zip`,
    extractPath: `zapret-${ZAPRET_VERSION}/binaries/win64/winws.exe`
  }
};

const binDir = path.join(__dirname, '..', 'bin');
const tempDir = path.join(__dirname, '..', 'temp');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);
    
    const file = fs.createWriteStream(dest);
    
    const request = https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
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
        const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
        process.stdout.write(`\rProgress: ${percent}%`);
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log('\nDownload complete');
        resolve();
      });
    });
    
    request.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function extractArchive(archivePath, extractTo, platform) {
  console.log(`Extracting: ${archivePath}`);
  
  if (platform === 'darwin' || archivePath.endsWith('.tar.gz')) {
    execSync(`tar -xzf "${archivePath}" -C "${extractTo}"`, { stdio: 'inherit' });
  } else if (archivePath.endsWith('.zip')) {
    // Windows or zip file
    try {
      execSync(`unzip -o "${archivePath}" -d "${extractTo}"`, { stdio: 'inherit' });
    } catch (e) {
      // Try powershell on Windows
      execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractTo}' -Force"`, { stdio: 'inherit' });
    }
  }
}

async function downloadBinaries() {
  console.log('='.repeat(50));
  console.log('UnblockPro Binary Downloader');
  console.log('='.repeat(50));
  
  ensureDir(binDir);
  ensureDir(tempDir);
  
  const platforms = process.argv[2] ? [process.argv[2]] : ['darwin', 'win32'];
  
  for (const platform of platforms) {
    const config = BINARIES[platform];
    if (!config) {
      console.log(`Skipping unknown platform: ${platform}`);
      continue;
    }
    
    const platformDir = path.join(binDir, platform);
    ensureDir(platformDir);
    
    const destBinary = path.join(platformDir, config.name);
    
    if (fs.existsSync(destBinary)) {
      console.log(`Binary already exists: ${destBinary}`);
      continue;
    }
    
    console.log(`\nDownloading binaries for: ${platform}`);
    
    const archiveExt = config.url.endsWith('.tar.gz') ? '.tar.gz' : '.zip';
    const archivePath = path.join(tempDir, `zapret-${platform}${archiveExt}`);
    
    try {
      await downloadFile(config.url, archivePath);
      
      extractArchive(archivePath, tempDir, platform);
      
      // Copy binary
      let sourcePath = path.join(tempDir, config.extractPath);
      
      // For macOS, check architecture
      if (platform === 'darwin' && !fs.existsSync(sourcePath)) {
        sourcePath = path.join(tempDir, config.extractPathX64);
      }
      
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destBinary);
        
        // Make executable on Unix
        if (platform !== 'win32') {
          fs.chmodSync(destBinary, '755');
        }
        
        console.log(`Binary installed: ${destBinary}`);
      } else {
        console.error(`Binary not found in archive: ${sourcePath}`);
      }
      
    } catch (error) {
      console.error(`Error downloading ${platform}: ${error.message}`);
    }
  }
  
  // Cleanup
  console.log('\nCleaning up...');
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {
    console.log('Cleanup skipped');
  }
  
  console.log('\nDone!');
  console.log('='.repeat(50));
}

// Run
downloadBinaries().catch(console.error);
