const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const RUNNER_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "runner")
  : __dirname;
const DATA_DIR = app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || app.getPath("userData"), "coupang-traffic-data")
  : path.join(__dirname, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const TASKS_PATH = path.join(DATA_DIR, "tasks.json");
const RESULTS_PATH = path.join(DATA_DIR, "results-save.txt");

let win = null;
let running = false;
let runnerChild = null;
let shouldKeepRunnerAlive = false;
let restartTimer = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#3d3d3d",
    title: "쿠팡 트래픽 자동화",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

function logLine(line, stream = "stdout") {
  if (win && !win.isDestroyed()) {
    win.webContents.send("runner-log", { line: String(line || ""), stream });
  }
}

function emitTick(rows) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("runner-tick", { rows });
  }
}

function startRunner() {
  if (running) return { ok: false, error: "이미 실행 중입니다." };
  ensureDataDir();
  const workerPath = path.join(RUNNER_ROOT, "worker-runner.cjs");
  if (!fs.existsSync(workerPath)) {
    return { ok: false, error: `worker-runner.cjs 파일이 없습니다: ${workerPath}` };
  }
  shouldKeepRunnerAlive = true;
  running = true;
  logLine("쿠팡 실러너 시작");
  const child = spawn(process.execPath, [workerPath], {
    cwd: DATA_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: [path.join(RUNNER_ROOT, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      COUPANG_CONFIG_PATH: CONFIG_PATH,
      COUPANG_TASKS_PATH: TASKS_PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  runnerChild = child;

  const onData = (buf, stream) => {
    const lines = buf
      .toString("utf-8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("__ROW_UPDATE__")) {
        try {
          const rows = JSON.parse(line.slice("__ROW_UPDATE__".length));
          emitTick(rows);
        } catch {
          logLine("행 업데이트 파싱 실패", "stderr");
        }
      } else if (line.startsWith("__ALL_DONE__")) {
        if (win && !win.isDestroyed()) {
          win.webContents.send("runner-all-done", { reason: "targets_reached" });
        }
      } else {
        logLine(line, stream);
      }
    }
  };

  child.stdout?.on("data", (buf) => onData(buf, "stdout"));
  child.stderr?.on("data", (buf) => onData(buf, "stderr"));
  child.on("close", (code) => {
    if (runnerChild === child) runnerChild = null;
    const exitCode = code ?? 0;

    // run-rank-processor.bat 로직 이식:
    // 0/130 이외 비정상 종료는 3초 후 자동 재시작
    if (shouldKeepRunnerAlive && exitCode !== 0 && exitCode !== 130) {
      logLine(`[RUNNER] 비정상 종료(code=${exitCode}) - 3초 후 자동 재시작`);
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!shouldKeepRunnerAlive) return;
        const res = startRunner();
        if (!res.ok) {
          running = false;
          shouldKeepRunnerAlive = false;
          logLine(`[RUNNER] 자동 재시작 실패: ${res.error || "unknown"}`, "stderr");
          if (win && !win.isDestroyed()) {
            win.webContents.send("runner-exit", { code: exitCode, error: "auto-restart-failed" });
          }
        }
      }, 3000);
      return;
    }

    running = false;
    shouldKeepRunnerAlive = false;
    if (win && !win.isDestroyed()) {
      win.webContents.send("runner-exit", { code: exitCode });
    }
  });
  child.on("error", (err) => {
    logLine(`러너 프로세스 오류: ${err.message}`, "stderr");
    running = false;
    shouldKeepRunnerAlive = false;
    runnerChild = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send("runner-exit", { code: -1, error: err.message });
    }
  });
  return { ok: true };
}

function stopRunner() {
  shouldKeepRunnerAlive = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (runnerChild) {
    try {
      runnerChild.kill("SIGTERM");
    } catch {
      // noop
    }
  }
  runnerChild = null;
  running = false;
  if (win && !win.isDestroyed()) {
    win.webContents.send("runner-exit", { code: 0 });
  }
  logLine("쿠팡 실러너 중지");
  return { ok: true };
}

app.whenReady().then(() => {
  ensureDataDir();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("get-paths", () => ({
  projectRoot: RUNNER_ROOT,
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  tasksPath: TASKS_PATH,
  resultsPath: RESULTS_PATH,
}));

ipcMain.handle("load-config", () => {
  const base = readJsonSafe(CONFIG_PATH, {});
  return {
    mode: base.mode ?? "desktop",
    maxScroll: base.maxScroll ?? 5,
    searchFlowVersion: ["A", "B", "C", "D"].includes(base.searchFlowVersion) ? base.searchFlowVersion : "A",
    ipRotationEnabled: base.ipRotationEnabled === true,
    delayBrowserLoad: base.delayBrowserLoad ?? 2500,
    delayExplore: base.delayExplore ?? 500,
  };
});

ipcMain.handle("save-config", (_e, cfg) => {
  writeJson(CONFIG_PATH, cfg || {});
  return { ok: true };
});

ipcMain.handle("load-tasks", () => readJsonSafe(TASKS_PATH, []));

ipcMain.handle("save-tasks", (_e, rows) => {
  writeJson(TASKS_PATH, Array.isArray(rows) ? rows : []);
  return { ok: true, path: TASKS_PATH };
});

ipcMain.handle("save-results", (_e, rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const header = "순번\t검색키워드\t2차키워드\t상품URL\t목표\t성공\t실패\t순위\t리뷰\t할인판매가";
  const lines = list.map((r, i) => {
    const rank = String(r.rank ?? r.currentRank ?? "");
    return [
      i + 1,
      String(r.keyword || ""),
      String(r.keywordName || r.secondKeyword || ""),
      String(r.linkUrl || ""),
      Number(r.targetCount) || 0,
      Number(r.trafficOk) || 0,
      Number(r.trafficFail) || 0,
      rank,
      String(r.reviewCount || ""),
      String(r.priceSale || ""),
    ].join("\t");
  });
  ensureDataDir();
  fs.writeFileSync(RESULTS_PATH, `\uFEFF${[header, ...lines].join("\n")}`, "utf-8");
  return { ok: true, path: RESULTS_PATH };
});

ipcMain.handle("runner-start", () => startRunner());
ipcMain.handle("runner-stop", () => stopRunner());
ipcMain.handle("runner-status", () => ({ running }));
