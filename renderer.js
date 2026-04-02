let rows = [
  {
    checked: true,
    keyword: "",
    linkUrl: "",
    keywordName: "",
    targetCount: 0,
    trafficOk: 0,
    trafficFail: 0,
    rank: "",
    reviewCount: "",
    priceSale: "",
  },
];
let selectedRow = 0;

function extractProductId(url) {
  const raw = String(url || "");
  let m = raw.match(/\/vp\/products\/(\d+)/);
  if (m) return m[1];
  m = raw.match(/\/products\/(\d+)/);
  if (m) return m[1];
  m = raw.match(/[?&]productId=(\d+)/i);
  if (m) return m[1];
  m = raw.match(/[?&]itemId=(\d+)/i);
  if (m) return m[1];
  return "";
}

function logLine(msg) {
  const el = document.getElementById("logArea");
  const t = new Date().toLocaleTimeString("ko-KR");
  el.value += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function esc(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeRow(r) {
  return {
    checked: !!r?.checked,
    keyword: String(r?.keyword || ""),
    linkUrl: String(r?.linkUrl || ""),
    keywordName: String(r?.keywordName ?? r?.secondKeyword ?? ""),
    targetCount: Math.max(0, Number(r?.targetCount) || 0),
    trafficOk: Math.max(0, Number(r?.trafficOk) || 0),
    trafficFail: Math.max(0, Number(r?.trafficFail) || 0),
    rank: String(r?.rank ?? r?.currentRank ?? ""),
    reviewCount: String(r?.reviewCount ?? ""),
    priceSale: String(r?.priceSale ?? ""),
  };
}

function syncFromDom() {
  const trs = document.querySelectorAll("#taskBody tr");
  trs.forEach((tr, i) => {
    if (!rows[i]) return;
    rows[i].checked = !!tr.querySelector('input[data-f="checked"]')?.checked;
    rows[i].keyword = tr.querySelector('input[data-f="keyword"]')?.value || "";
    rows[i].linkUrl = tr.querySelector('input[data-f="linkUrl"]')?.value || "";
    rows[i].keywordName = tr.querySelector('input[data-f="keywordName"]')?.value || "";
    rows[i].targetCount = Math.max(0, Number(tr.querySelector('input[data-f="targetCount"]')?.value) || 0);
  });
}

/** 워커가 갱신하는 필드만 병합 — 입력 중인 키워드/URL 등은 DOM에서 읽은 값 유지 */
function applyRunnerRowUpdates(nextRows) {
  const incoming = Array.isArray(nextRows) ? nextRows.map(normalizeRow) : [];
  syncFromDom();
  const n = Math.max(rows.length, incoming.length);
  const merged = [];
  for (let i = 0; i < n; i += 1) {
    const loc = rows[i];
    const inc = incoming[i];
    if (!inc) {
      if (loc) merged.push(loc);
      continue;
    }
    if (!loc) {
      merged.push(inc);
      continue;
    }
    merged.push({
      ...loc,
      trafficOk: inc.trafficOk,
      trafficFail: inc.trafficFail,
      rank: inc.rank,
      reviewCount: inc.reviewCount,
      priceSale: inc.priceSale,
    });
  }
  rows = merged;
}

function updateSecondKeywordHeader() {
  const flow = document.getElementById("searchFlowVersion").value;
  const th = document.getElementById("thSecondKeyword");
  if (!th) return;
  const labels = {
    A: "2차 키워드 (조합)",
    B: "2차 키워드 (미사용)",
    C: "2차 키워드 (제목풀·필수)",
    D: "2차 키워드 (미사용)",
  };
  th.textContent = labels[flow] || "2차 키워드";
}

function renderTable() {
  const tb = document.getElementById("taskBody");
  tb.innerHTML = "";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (i === selectedRow) tr.style.background = "#294133";
    tr.innerHTML = `
      <td style="text-align:center"><input type="checkbox" data-f="checked" ${r.checked ? "checked" : ""}></td>
      <td style="text-align:center">${i + 1}</td>
      <td><input type="text" data-f="keyword" value="${esc(r.keyword)}" placeholder="1차 검색어"></td>
      <td><input type="text" data-f="linkUrl" value="${esc(r.linkUrl)}" placeholder="상품 URL"></td>
      <td><input type="text" data-f="keywordName" value="${esc(r.keywordName)}" placeholder="2차"></td>
      <td style="text-align:center">${esc(extractProductId(r.linkUrl) || "-")}</td>
      <td><input type="number" data-f="targetCount" min="0" value="${r.targetCount || 0}" style="text-align:center"></td>
      <td style="text-align:center">${r.trafficOk || 0}</td>
      <td style="text-align:center">${r.trafficFail || 0}</td>
      <td style="text-align:center">${esc(r.rank || "-")}</td>
      <td style="text-align:center">${esc(r.reviewCount || "-")}</td>
      <td style="text-align:center">${esc(r.priceSale || "-")}</td>
    `;
    tr.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return;
      // 입력 중 다른 셀/영역 클릭 시 값 유실 방지
      syncFromDom();
      selectedRow = i;
      renderTable();
    });
    tb.appendChild(tr);
  });
}

function buildConfigPayload() {
  return {
    mode: document.getElementById("mode").value,
    maxScroll: Math.max(1, Number(document.getElementById("maxScroll").value) || 5),
    searchFlowVersion: document.getElementById("searchFlowVersion").value,
    ipRotationEnabled: document.getElementById("ipRotationEnabled").checked === true,
    delayBrowserLoad: Math.max(0, Number(document.getElementById("delayBrowserLoad").value) || 2500),
    delayExplore: Math.max(0, Number(document.getElementById("delayExplore").value) || 500),
  };
}

async function saveTasks() {
  syncFromDom();
  const res = await window.coupangApi.saveTasks(rows);
  if (res?.ok) logLine(`작업 저장 완료: ${res.path}`);
}

function validateCheckedRows() {
  syncFromDom();
  const flow = document.getElementById("searchFlowVersion").value;
  const checked = rows.filter((r) => r.checked);
  if (!checked.length) return "체크된 행이 없습니다.";
  for (const r of checked) {
    if (!String(r.linkUrl || "").trim()) return "상품 URL을 입력하세요.";
    if (!extractProductId(r.linkUrl)) return "URL에서 상품 ID를 찾을 수 없습니다.";
    if (flow === "C") {
      if (!String(r.keywordName || "").trim()) return "C 모드는 2차 키워드(제목풀)가 필요합니다.";
    } else {
      if (!String(r.keyword || "").trim()) return "검색 키워드를 입력하세요.";
    }
    if (flow !== "D") {
      if (!r.targetCount || r.targetCount <= 0) return "목표 횟수를 입력하세요 (D 모드만 0=무제한).";
    }
  }
  return null;
}

async function init() {
  const cfg = await window.coupangApi.loadConfig();
  document.getElementById("mode").value = cfg.mode || "desktop";
  document.getElementById("maxScroll").value = cfg.maxScroll || 5;
  document.getElementById("searchFlowVersion").value =
    cfg.searchFlowVersion === "B" || cfg.searchFlowVersion === "C" || cfg.searchFlowVersion === "D"
      ? cfg.searchFlowVersion
      : "A";
  document.getElementById("ipRotationEnabled").checked = cfg.ipRotationEnabled === true;
  document.getElementById("delayBrowserLoad").value = cfg.delayBrowserLoad ?? 2500;
  document.getElementById("delayExplore").value = cfg.delayExplore ?? 500;

  const loaded = await window.coupangApi.loadTasks();
  if (Array.isArray(loaded) && loaded.length) {
    rows = loaded.map(normalizeRow);
  }
  updateSecondKeywordHeader();
  renderTable();
  bindTaskBodySyncEvents();

  const p = await window.coupangApi.getPaths();
  logLine(`프로젝트: ${p.projectRoot}`);
  logLine("쿠팡 GUI 준비 완료");

  document.getElementById("searchFlowVersion").addEventListener("change", () => {
    updateSecondKeywordHeader();
  });

  document.getElementById("btnAddRow").onclick = () => {
    syncFromDom();
    rows.push(normalizeRow({ checked: true }));
    selectedRow = rows.length - 1;
    renderTable();
  };

  document.getElementById("btnDelRow").onclick = () => {
    if (rows.length <= 1) return;
    syncFromDom();
    rows.splice(selectedRow, 1);
    selectedRow = Math.max(0, selectedRow - 1);
    renderTable();
  };

  document.getElementById("btnResetStats").onclick = () => {
    syncFromDom();
    rows = rows.map((r) => ({ ...r, trafficOk: 0, trafficFail: 0 }));
    renderTable();
    logLine("성공/실패 카운터 초기화");
  };

  document.getElementById("btnSaveConfig").onclick = async () => {
    const res = await window.coupangApi.saveConfig(buildConfigPayload());
    if (res?.ok) logLine("설정 저장 완료");
  };

  document.getElementById("btnSaveDelayPanel").onclick = async () => {
    const res = await window.coupangApi.saveConfig(buildConfigPayload());
    if (res?.ok) logLine("작업 딜레이·작업 선택 저장 완료");
  };

  document.getElementById("btnSaveIpRotation").onclick = async () => {
    const res = await window.coupangApi.saveConfig(buildConfigPayload());
    if (res?.ok) logLine("IP 로테이션 설정 저장 완료");
  };

  document.getElementById("btnSaveTasks").onclick = saveTasks;

  document.getElementById("btnSaveResults").onclick = async () => {
    syncFromDom();
    const res = await window.coupangApi.saveResults(rows);
    if (res?.ok) logLine(`결과 저장 완료: ${res.path}`);
  };

  document.getElementById("btnStart").onclick = async () => {
    const err = validateCheckedRows();
    if (err) {
      logLine("시작 불가: " + err);
      return;
    }
    await window.coupangApi.saveConfig(buildConfigPayload());
    await saveTasks();
    const flow = document.getElementById("searchFlowVersion").value;
    const runnable = rows.filter((r) => {
      if (!r.checked) return false;
      if (!String(r.linkUrl || "").trim()) return false;
      if (!extractProductId(r.linkUrl)) return false;
      if (flow === "C") {
        if (!String(r.keywordName || "").trim()) return false;
      } else if (!String(r.keyword || "").trim()) {
        return false;
      }
      if (flow !== "D") {
        if (!r.targetCount || r.targetCount <= 0) return false;
        return (r.trafficOk || 0) < r.targetCount;
      }
      if (!r.targetCount || r.targetCount <= 0) return true;
      return (r.trafficOk || 0) < r.targetCount;
    });
    if (!runnable.length) {
      logLine("시작 불가: 실행 가능한 행이 없습니다(목표 달성 또는 조건 확인).");
      return;
    }
    const res = await window.coupangApi.startRunner();
    if (!res?.ok) {
      logLine(`시작 실패: ${res?.error || "알 수 없는 오류"}`);
      return;
    }
    document.getElementById("runnerStatus").textContent = "실행 중";
  };

  document.getElementById("btnStop").onclick = async () => {
    await window.coupangApi.stopRunner();
    document.getElementById("runnerStatus").textContent = "대기 중";
  };

  document.getElementById("checkAll").addEventListener("change", (e) => {
    const checked = !!e.target.checked;
    syncFromDom();
    rows.forEach((r) => {
      r.checked = checked;
    });
    renderTable();
  });

  window.coupangApi.onRunnerLog(({ line }) => logLine(line));
  window.coupangApi.onRunnerTick(({ rows: nextRows }) => {
    applyRunnerRowUpdates(nextRows);
    renderTable();
  });
  window.coupangApi.onRunnerExit(() => {
    document.getElementById("runnerStatus").textContent = "대기 중";
  });
  window.coupangApi.onRunnerAllDone(() => {
    document.getElementById("runnerStatus").textContent = "목표 달성 완료";
    logLine("모든 체크 행이 목표를 달성하여 자동 종료되었습니다.");
    window.coupangApi.stopRunner().catch(() => {});
  });

  const st = await window.coupangApi.runnerStatus();
  document.getElementById("runnerStatus").textContent = st?.running ? "실행 중" : "대기 중";
}

function bindTaskBodySyncEvents() {
  const taskBody = document.getElementById("taskBody");
  if (!taskBody || taskBody.dataset.syncBound === "1") return;
  taskBody.dataset.syncBound = "1";
  // 입력값을 rows에 즉시 반영해, 재렌더/포커스 이동 시 초기화되지 않게 유지
  taskBody.addEventListener("input", (e) => {
    const t = e.target;
    if (t && t.matches("input[data-f]")) syncFromDom();
  });
  taskBody.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.matches("input[data-f]")) syncFromDom();
  });
}

init().catch((e) => {
  console.error(e);
  logLine(`초기화 오류: ${e.message || String(e)}`);
});
