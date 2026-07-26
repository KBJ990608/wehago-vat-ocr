const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  askChatbot: (payload) => ipcRenderer.invoke('chatbot:ask', payload),
});
