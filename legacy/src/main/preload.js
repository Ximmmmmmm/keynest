'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 钥巢 KeyNest — 渲染进程与主进程之间唯一的通道。
 * 仅暴露白名单方法，不泄露 require / ipcRenderer 本身。
 */
contextBridge.exposeInMainWorld('vaultApi', {
  status: () => ipcRenderer.invoke('vault:status'),
  create: (password) => ipcRenderer.invoke('vault:create', { password }),
  unlock: (password) => ipcRenderer.invoke('vault:unlock', { password }),
  lock: () => ipcRenderer.invoke('vault:lock'),
  snapshot: () => ipcRenderer.invoke('vault:snapshot'),
  saveEntry: (entry) => ipcRenderer.invoke('vault:save-entry', { entry }),
  deleteEntry: (id) => ipcRenderer.invoke('vault:delete-entry', { id }),
  addCategory: (name) => ipcRenderer.invoke('vault:add-category', { name }),
  updateSettings: (patch) => ipcRenderer.invoke('vault:update-settings', { patch }),
  changeMaster: (oldPassword, newPassword) =>
    ipcRenderer.invoke('vault:change-master', { oldPassword, newPassword }),
  generatePassword: (options) => ipcRenderer.invoke('vault:generate-password', options),
  estimateStrength: (password) => ipcRenderer.invoke('vault:estimate-strength', { password }),
  copy: (text, sensitive = true) => ipcRenderer.invoke('vault:copy', { text, sensitive }),
  exportBackup: () => ipcRenderer.invoke('vault:export-backup'),
  wipe: () => ipcRenderer.invoke('vault:wipe'),
  openDataFolder: () => ipcRenderer.invoke('vault:open-data-folder'),
  openExternal: (url) => ipcRenderer.invoke('vault:open-external', { url }),

  scanBrowsers: () => ipcRenderer.invoke('browser:scan'),
  importBrowser: (id, dir, mode) => ipcRenderer.invoke('browser:import', { id, dir, mode }),
  pickCsv: () => ipcRenderer.invoke('browser:pick-csv'),
  importCsv: (token, mode) => ipcRenderer.invoke('browser:import-csv', { token, mode }),

  discoverCsv: () => ipcRenderer.invoke('browser:discover-csv'),
  importCsvFile: (filePath, mode) => ipcRenderer.invoke('browser:import-file', { filePath, mode }),
  importCsvFiles: (filePaths, mode) => ipcRenderer.invoke('browser:import-files', { filePaths, mode }),
  discardCsv: (filePaths) => ipcRenderer.invoke('browser:discard-csv', { filePaths }),

  exportPlain: (format) => ipcRenderer.invoke('vault:export-plain', { format }),

  touch: () => ipcRenderer.invoke('vault:touch'),

  onLocked: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('vault:locked', listener);
    return () => ipcRenderer.removeListener('vault:locked', listener);
  },
  onCommand: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('vault:command', listener);
    return () => ipcRenderer.removeListener('vault:command', listener);
  },
});
