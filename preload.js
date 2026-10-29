const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchGame: (executablePath, args) => ipcRenderer.invoke('launch-game', executablePath, args),
  launchPlatform: (platform, gameId) => ipcRenderer.invoke('launch-platform', platform, gameId),
  chooseExecutable: () => ipcRenderer.invoke('choose-executable'),
  importMedia: (kind) => ipcRenderer.invoke('import-media', kind),
  downloadMedia: (url, kind) => ipcRenderer.invoke('download-media', url, kind),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  setWindowMaximized: (maximized) => ipcRenderer.invoke('set-window-maximized', maximized),
  setWindowFullscreen: (fullscreen) => ipcRenderer.invoke('set-window-fullscreen', fullscreen),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  saveBackup: (payload) => ipcRenderer.invoke('save-backup', payload),
  loadBackup: () => ipcRenderer.invoke('load-backup'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  onGameEnded: (callback) => {
    ipcRenderer.on('game-ended', (_event, result) => callback(result));
  }
});
