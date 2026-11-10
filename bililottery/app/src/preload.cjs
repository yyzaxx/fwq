const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lotteryDesktop', {
    bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
    saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
    previewSummaries: () => ipcRenderer.invoke('summaries:preview'),
    previewCleanup: () => ipcRenderer.invoke('cleanup:preview'),
    chooseEngine: () => ipcRenderer.invoke('engine:choose'),
    run: action => ipcRenderer.invoke('engine:run', action),
    stop: () => ipcRenderer.invoke('engine:stop'),
    openPath: target => ipcRenderer.invoke('path:open', target),
    openExternal: url => ipcRenderer.invoke('url:open', url),
    onQrCode: callback => {
        const listener = (_event, image) => callback(image);
        ipcRenderer.on('engine:qrcode', listener);
        return () => ipcRenderer.removeListener('engine:qrcode', listener);
    },
    onOutput: callback => {
        const listener = (_event, text) => callback(text);
        ipcRenderer.on('engine:output', listener);
        return () => ipcRenderer.removeListener('engine:output', listener);
    },
    onState: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('engine:state', listener);
        return () => ipcRenderer.removeListener('engine:state', listener);
    }
});
