const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepAutoCodeDesktop', {
  isElectron: true,
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  setThemeOverlay: (mode) => ipcRenderer.invoke('window:setTheme', mode),
});

