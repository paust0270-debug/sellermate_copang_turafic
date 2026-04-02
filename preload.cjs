const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coupangApi", {
  loadConfig: () => ipcRenderer.invoke("load-config"),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  loadTasks: () => ipcRenderer.invoke("load-tasks"),
  saveTasks: (rows) => ipcRenderer.invoke("save-tasks", rows),
  saveResults: (rows) => ipcRenderer.invoke("save-results", rows),
  startRunner: () => ipcRenderer.invoke("runner-start"),
  stopRunner: () => ipcRenderer.invoke("runner-stop"),
  runnerStatus: () => ipcRenderer.invoke("runner-status"),
  getPaths: () => ipcRenderer.invoke("get-paths"),
  onRunnerLog: (fn) => ipcRenderer.on("runner-log", (_e, payload) => fn(payload)),
  onRunnerTick: (fn) => ipcRenderer.on("runner-tick", (_e, payload) => fn(payload)),
  onRunnerAllDone: (fn) => ipcRenderer.on("runner-all-done", (_e, payload) => fn(payload)),
  onRunnerExit: (fn) => ipcRenderer.on("runner-exit", (_e, payload) => fn(payload)),
});
