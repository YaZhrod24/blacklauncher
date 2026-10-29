const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { nativeImage } = require('electron');

let mainWindow;
let runningGame = null;
let updateState = { status: 'idle' };

function mediaDirectory() {
  const directory = path.join(app.getPath('userData'), 'media');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function executableTitle(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/[._-]+/g, ' ')
    .replace(/\b(x64|x86|win64|win32|shipping|launcher|game)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findExecutables(directory, depth = 0, results = []) {
  if (depth > 4 || results.length >= 80) return results;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_error) {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= 80) break;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'redist', 'redistributables', '__pycache__'].includes(entry.name.toLowerCase())) {
        findExecutables(fullPath, depth + 1, results);
      }
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe') {
      const lowerName = entry.name.toLowerCase();
      if (!['uninstall.exe', 'unins000.exe', 'crashreporter.exe'].includes(lowerName)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function safeMediaName(name) {
  return `${Date.now()}-${String(name || 'media').replace(/[^a-z0-9._-]/gi, '_')}`;
}

function toFileUrl(filePath) {
  return pathToFileURL(filePath).toString();
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'BlackLaunch/0.2.11',
        Accept: 'application/json',
        ...headers
      }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Le service a répondu HTTP ${response.statusCode}.`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (_error) {
          reject(new Error('Réponse JSON invalide.'));
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Trop de redirections.'));
      return;
    }

    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Referer': `${new URL(url).origin}/`
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(new URL(response.headers.location, url).toString(), destination, redirects + 1)
          .then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Téléchargement impossible (HTTP ${response.statusCode}).`));
        return;
      }

      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.once('finish', () => output.close(resolve));
      output.once('error', reject);
    });

    request.once('error', reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'BlackLaunch',
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.once('did-finish-load', () => {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdates().catch((error) => {
      sendUpdateStatus({ status: 'error', message: error.message });
    });
  });
}

function sendUpdateStatus(status) {
  updateState = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', status);
  }
}

function stopRunningGame() {
  if (!runningGame) return;

  const { child } = runningGame;
  runningGame = null;

  if (!child.killed) {
    child.kill();
  }
}

ipcMain.handle('launch-game', async (_event, executablePath, argumentString = '') => {
  if (typeof executablePath !== 'string' || !executablePath.trim()) {
    return { ok: false, error: 'Chemin du jeu manquant.' };
  }

  if (runningGame) {
    return { ok: false, error: 'Un jeu est déjà en cours.' };
  }

  const executable = executablePath.trim();
  if (!fs.existsSync(executable)) {
    return { ok: false, error: `Fichier introuvable : ${executable}` };
  }

  if (path.extname(executable).toLowerCase() !== '.exe') {
    return { ok: false, error: 'Le fichier sélectionné doit être un exécutable .exe.' };
  }

  const workingDirectory = path.dirname(executable);
  const args = typeof argumentString === 'string'
    ? argumentString.match(/"[^"]*"|\S+/g)?.map((value) => value.replace(/^"|"$/g, '')) || []
    : [];
  const child = spawn(executable, args, {
    cwd: workingDirectory,
    detached: false,
    windowsHide: false
  });

  ipcMain.handle('launch-platform', async (_event, platform, gameId) => {
    const schemes = { steam: `steam://rungameid/${gameId}`, epic: `com.epicgames.launcher://apps/${gameId}?action=launch`, ubisoft: `uplay://launch/${gameId}/0` };
    if (!schemes[platform]) return { ok: false, error: 'Plateforme non prise en charge.' };
    await shell.openExternal(schemes[platform]);
    return { ok: true, startedAt: Date.now() };
  });

  runningGame = { child, startedAt: Date.now() };

  child.once('error', (error) => {
    if (runningGame && runningGame.child === child) {
      runningGame = null;
      mainWindow?.webContents.send('game-ended', {
        ok: false,
        error: `Impossible de lancer le jeu : ${error.message}`
      });
    }
  });

  child.once('close', (code) => {
    if (runningGame && runningGame.child === child) {
      const startedAt = runningGame.startedAt;
      runningGame = null;
      mainWindow?.webContents.send('game-ended', {
        ok: true,
        startedAt,
        endedAt: Date.now(),
        exitCode: code
      });
    }
  });

  return { ok: true, startedAt: runningGame.startedAt };
});

ipcMain.handle('choose-executable', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le fichier du jeu',
    properties: ['openFile'],
    filters: [{ name: 'Programmes Windows', extensions: ['exe'] }]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('scan-game-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier du jeu à analyser',
    properties: ['openDirectory']
  });
  if (result.canceled) return [];

  const executables = findExecutables(result.filePaths[0]);
  return executables.map((filePath) => {
    let icon = null;
    try {
      const image = nativeImage.createFromPath(filePath);
      if (!image.isEmpty()) {
        const destination = path.join(mediaDirectory(), safeMediaName(`${path.basename(filePath, '.exe')}.png`));
        fs.writeFileSync(destination, image.resize({ width: 256, height: 256 }).toPNG());
        icon = toFileUrl(destination);
      }
    } catch (_error) {
      icon = null;
    }
    return { path: filePath, title: executableTitle(filePath), icon };
  });
});

ipcMain.handle('import-media', async (_event, kind) => {
  const filters = kind === 'icon'
    ? [{ name: 'Images et icônes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'bmp'] }]
    : [{ name: 'Images et vidéos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'bmp', 'mp4', 'webm', 'mov'] }];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'icon' ? 'Choisir une icône' : 'Choisir une image de fond',
    properties: ['openFile'],
    filters
  });

  if (result.canceled) return null;
  const source = result.filePaths[0];
  const destination = path.join(mediaDirectory(), safeMediaName(path.basename(source)));
  fs.copyFileSync(source, destination);
  return toFileUrl(destination);
});

ipcMain.handle('download-media', async (_event, url, kind) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('URL http(s) invalide.');
  }

  const parsed = new URL(url);
  const extension = path.extname(parsed.pathname).toLowerCase() || (kind === 'video' ? '.mp4' : '.jpg');
  const destination = path.join(mediaDirectory(), safeMediaName(`download${extension}`));
  await downloadFile(url, destination);
  return toFileUrl(destination);
});

ipcMain.handle('search-steam-game', async (_event, query) => {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Saisissez un titre ou un ID Steam.');
  }

  const searchTerm = query.trim();
  let app;
  const appIdMatch = searchTerm.match(/(?:\/app\/|^)(\d+)(?:\/|$)/i);
  const appId = appIdMatch ? appIdMatch[1] : null;

  if (appId) {
    const details = await requestJson(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&l=french&cc=fr`);
    const result = details[appId];
    if (!result?.success || !result.data) {
      throw new Error('Aucun jeu Steam trouvé pour cet ID.');
    }
    app = result.data;
  } else {
    const search = await requestJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(searchTerm)}&l=french&cc=fr`);
    const firstResult = Array.isArray(search.items) ? search.items[0] : null;
    if (!firstResult?.id) {
      throw new Error('Aucun jeu Steam trouvé pour ce titre.');
    }
    const details = await requestJson(`https://store.steampowered.com/api/appdetails?appids=${firstResult.id}&l=french&cc=fr`);
    const result = details[String(firstResult.id)];
    if (!result?.success || !result.data) {
      throw new Error('Les informations détaillées de ce jeu sont indisponibles.');
    }
    app = result.data;
  }

  const id = String(app.steam_appid);
  return {
    id,
    title: app.name,
    icon: app.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,
    bg: app.background_raw || app.background || `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_hero.jpg`
  };
});

ipcMain.handle('open-data-folder', async () => {
  await shell.openPath(app.getPath('userData'));
});

ipcMain.handle('set-window-maximized', (_event, maximized) => {
  if (maximized) mainWindow.maximize();
  else mainWindow.unmaximize();
});

ipcMain.handle('set-window-fullscreen', (_event, fullscreen) => {
  mainWindow.setFullScreen(Boolean(fullscreen));
});

ipcMain.handle('save-backup', async (_event, payload) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exporter la sauvegarde BlackLaunch',
    defaultPath: 'blacklaunch-backup.json',
    filters: [{ name: 'Sauvegarde BlackLaunch', extensions: ['json'] }]
  });
  if (!result.canceled) fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
  return !result.canceled;
});

ipcMain.handle('load-backup', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Importer une sauvegarde BlackLaunch',
    properties: ['openFile'],
    filters: [{ name: 'Sauvegarde BlackLaunch', extensions: ['json'] }]
  });
  if (result.canceled) return null;
  return JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
});

ipcMain.handle('check-update', async () => {
  const result = await autoUpdater.checkForUpdates();
  return { version: result?.updateInfo?.version || null };
});

ipcMain.handle('get-update-state', () => updateState);

ipcMain.handle('download-update', async () => {
  await autoUpdater.downloadUpdate();
  return true;
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

autoUpdater.on('update-available', (info) => {
  sendUpdateStatus({ status: 'available', version: info.version });
});
autoUpdater.on('download-progress', (progress) => {
  sendUpdateStatus({ status: 'downloading', percent: Math.round(progress.percent) });
});
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus({ status: 'downloaded', version: info.version });
});
autoUpdater.on('update-not-available', () => {
  sendUpdateStatus({ status: 'current' });
});
autoUpdater.on('error', (error) => {
  sendUpdateStatus({ status: 'error', message: error.message });
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopRunningGame();
  if (process.platform !== 'darwin') app.quit();
});
