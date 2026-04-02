const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  process.stderr.write(`[RUNNER] playwright 로드 실패: ${e.message || String(e)}\n`);
  process.stderr.write("[RUNNER] 해결: 프로젝트 폴더에서 npm install 후 exe 재빌드 필요\n");
  process.exit(1);
}

const CONFIG_PATH = process.env.COUPANG_CONFIG_PATH || path.join(__dirname, "data", "config.json");
const TASKS_PATH = process.env.COUPANG_TASKS_PATH || path.join(__dirname, "data", "tasks.json");

let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
  process.exit(0);
});

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, v) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf-8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function emitRows(rows) {
  process.stdout.write(`__ROW_UPDATE__${JSON.stringify(rows)}\n`);
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  return {
    mode: c.mode || "desktop",
    maxScroll: Math.max(1, Number(c.maxScroll) || 5),
    searchFlowVersion: ["A", "B", "C", "D"].includes(c.searchFlowVersion) ? c.searchFlowVersion : "A",
    ipRotationEnabled: c.ipRotationEnabled === true,
    delayBrowserLoad: Math.max(0, Number(c.delayBrowserLoad) || 2500),
    delayExplore: Math.max(0, Number(c.delayExplore) || 500),
  };
}

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

function buildSearchKeyword(flow, row) {
  const k1 = String(row?.keyword || "").trim();
  const k2 = String(row?.keywordName ?? row?.secondKeyword ?? "").trim();
  if (flow === "A") return [k1, k2].filter(Boolean).join(" ").trim();
  if (flow === "B" || flow === "D") return k1;
  if (flow === "C") return k2;
  return k1;
}

function rowPassesFilters(flow, row) {
  if (!row || row.checked !== true) return false;
  const linkUrl = String(row.linkUrl || "").trim();
  if (!linkUrl || !extractProductId(linkUrl)) return false;
  if (flow === "C") {
    if (!String(row.keywordName ?? row.secondKeyword ?? "").trim()) return false;
  } else {
    if (!String(row.keyword || "").trim()) return false;
  }
  const targetCount = Math.max(0, Number(row.targetCount) || 0);
  const okCount = Math.max(0, Number(row.trafficOk) || 0);
  if (flow === "D") {
    if (targetCount <= 0) return true;
    return okCount < targetCount;
  }
  if (targetCount <= 0) return false;
  return okCount < targetCount;
}

async function checkAdbDeviceStatus() {
  try {
    const { stdout } = await execAsync("adb devices", {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    const lines = String(stdout || "").trim().split("\n").slice(1);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/\s+/);
      if (parts[1] === "device") return "device";
      if (parts[1] === "unauthorized") return "unauthorized";
    }
    return null;
  } catch {
    return null;
  }
}

async function setMobileData(enable) {
  const cmd = enable ? "adb shell svc data enable" : "adb shell svc data disable";
  await execAsync(cmd, {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
}

async function toggleAdbMobileDataOffOn(reason, cycles = 1) {
  const status = await checkAdbDeviceStatus();
  if (status !== "device") {
    if (status === "unauthorized") {
      log(`[IPRotation] ${reason}: ADB 미인증(휴대폰 USB 디버깅 허용 필요), 스킵`);
    } else {
      log(`[IPRotation] ${reason}: ADB 기기 없음, 스킵`);
    }
    return false;
  }

  const n = Math.max(1, Math.floor(cycles));
  for (let i = 0; i < n; i += 1) {
    log(`[IPRotation] ${reason}: 모바일 데이터 OFF -> ON (${i + 1}/${n})`);
    await setMobileData(false);
    await sleep(5000);
    await setMobileData(true);
    await sleep(5000);
  }
  log(`[IPRotation] ${reason}: 완료`);
  return true;
}

function classifyErrorMessage(err) {
  const msg = String(err?.message || err || "");
  if (/timeout|timed out|Timeout/i.test(msg)) return "TIMEOUT";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|net::/i.test(msg)) return "NETWORK";
  if (/403|access denied|captcha|차단/i.test(msg)) return "BLOCKED";
  if (/Target page, context or browser has been closed/i.test(msg)) return "BROWSER_CLOSED";
  return "UNKNOWN";
}

async function checkAccessDenied(page) {
  try {
    const pageTitle = await page.title();
    const pageContent = await page.content();
    const pageUrl = page.url();
    return (
      pageTitle.includes("Access Denied") ||
      pageContent.includes("Access Denied") ||
      pageContent.includes("Reference #") ||
      pageContent.includes("errors.edgesuite.net") ||
      pageUrl.includes("errors.edgesuite.net") ||
      pageUrl.includes("access-denied")
    );
  } catch {
    return false;
  }
}

async function doTrafficOnUrl(page, linkUrl, cfg) {
  const load = Math.min(12000, Math.max(800, cfg.delayBrowserLoad));
  const explore = Math.max(200, cfg.delayExplore);
  await page.goto(linkUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(load);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(explore);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(explore + 600 + Math.floor(Math.random() * 1200));
}

async function findRank(page, keyword, productId, maxPages, cfg) {
  const MAX_RETRIES = 10;
  const MAX_PAGES_FIXED = 30;
  const searchUrl = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}`;
  const randomBetween = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    try {
      let pageNumber = 1;
      const seen = new Set();

      // 1) 메인 방문
      await page.goto("https://www.coupang.com/", { waitUntil: "domcontentloaded", timeout: 8000 });
      await page.waitForTimeout(300);
      if (await checkAccessDenied(page)) {
        throw new Error("ACCESS_DENIED_MAIN");
      }

      // 2) 검색 진입
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(500 + randomBetween(0, 500));
      if (await checkAccessDenied(page)) {
        throw new Error("ACCESS_DENIED_SEARCH");
      }

      // 3) 페이지 순회
      const pageLimit = Math.max(1, Math.min(MAX_PAGES_FIXED, Number(maxPages) || MAX_PAGES_FIXED));
      while (pageNumber <= pageLimit) {
        const currentUrl = pageNumber === 1 ? searchUrl : `${searchUrl}&page=${pageNumber}`;

        if (pageNumber > 1) {
          try {
            await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
            await page.waitForTimeout(300);
            if (await checkAccessDenied(page)) throw new Error("ACCESS_DENIED_SEARCH");
          } catch (pageErr) {
            // 원본처럼 2페이지 이상 접속 실패 시 즉시 중단
            const detail = pageErr?.message || String(pageErr);
            throw new Error(`PAGE_ACCESS_FAILED:${pageNumber}:${detail}`);
          }
        }

        try {
          await page.getByText("동의하고 계속하기").first().click({ timeout: 900 });
        } catch {
          // noop
        }

        await page.waitForTimeout(1500);
        const pageProducts = await page.evaluate(() => {
          const found = new Set();
          const selectors = [
            "a[href*='/vp/products/']",
            "a[href*='/products/']",
            "a[data-product-id]",
            ".search-product",
            "li[data-product-id]",
            "[data-product-id]",
            "a[href*='productId=']",
            "a[href*='itemId=']",
          ];
          for (const selector of selectors) {
            try {
              const els = document.querySelectorAll(selector);
              for (const el of Array.from(els)) {
                const href = el.getAttribute("href") || "";
                const dataPid = el.getAttribute("data-product-id") || "";
                const m = href.match(/\/(?:vp\/)?products\/(\d+)/);
                if (m && m[1]) found.add(m[1]);
                const pm = href.match(/(?:productId|itemId)=(\d+)/);
                if (pm && pm[1]) found.add(pm[1]);
                if (dataPid) found.add(dataPid);
              }
            } catch {
              // noop
            }
          }
          return Array.from(found);
        });

        if (!Array.isArray(pageProducts) || pageProducts.length === 0) break;

        for (const pid of pageProducts) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          if (pid === productId) return seen.size;
        }
        pageNumber += 1;
      }

      return null;
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (msg.startsWith("PAGE_ACCESS_FAILED:")) {
        throw e;
      }
      const isAccessDenied = msg.includes("ACCESS_DENIED") || msg.includes("Access Denied");
      if (!isAccessDenied || retry >= MAX_RETRIES) throw e;
      const waitMs = 3000 + Math.floor(Math.random() * 2000);
      log(`[RUNNER] Access Denied 감지 - ${Math.round(waitMs / 1000)}초 후 재시도 (${retry + 1}/${MAX_RETRIES})`);
      if (cfg.ipRotationEnabled === true) {
        try {
          await toggleAdbMobileDataOffOn("Access Denied 재시도 전 IP 전환", 1);
        } catch (ipErr) {
          log(`[RUNNER] Access Denied 대응 IP 전환 실패: ${ipErr.message || String(ipErr)}`);
        }
      }
      await sleep(waitMs);
    }
  }

  return null;
}

async function ensureOnProductPage(page, linkUrl, cfg) {
  const pid = extractProductId(linkUrl);
  const u = page.url() || "";
  if (pid && (u.includes(`/products/${pid}`) || u.includes(`/vp/products/${pid}`))) {
    return;
  }
  await page.goto(linkUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(Math.min(8000, Math.max(800, cfg.delayBrowserLoad)));
}

/** copang_rank_10 스타일: 리뷰 수·할인 판매가 */
async function extractReviewAndSalePrice(page) {
  await page.waitForTimeout(1500);
  try {
    await page.waitForSelector("#prod-review-nav-link .rating-count-txt, .rating-count-txt", {
      timeout: 4000,
    });
  } catch {
    // noop
  }
  const result = await page.evaluate(() => {
    let reviewCount = "";
    const sels = [
      "#prod-review-nav-link .rating-count-txt",
      'a[href="#sdpReview"] .rating-count-txt',
      ".review-atf .rating-count-txt",
      ".rating-count-txt",
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const innerText = (el.innerText || el.textContent || "").trim();
      const bracket = innerText.match(/\((\d{1,3}(?:,\d{3})*)\)/);
      if (bracket && bracket[1]) {
        reviewCount = bracket[1].replace(/,/g, "");
        break;
      }
      const m2 = innerText.match(/(\d{1,3}(?:,\d{3})*)\s*개\s*상품평/);
      if (m2 && m2[1]) {
        reviewCount = m2[1].replace(/,/g, "");
        break;
      }
    }
    let priceSale = "";
    const finalPriceEl = document.querySelector(".final-price .price-amount.final-price-amount");
    if (finalPriceEl) {
      const text = finalPriceEl.textContent?.trim() || "";
      priceSale = text.replace(/[^0-9]/g, "");
    }
    return { reviewCount, priceSale };
  });
  return result;
}

function applyRowSnapshot(row, rankVal, meta) {
  row.rank =
    typeof rankVal === "number" && Number.isFinite(rankVal)
      ? String(rankVal)
      : rankVal != null && String(rankVal).trim() !== ""
        ? String(rankVal)
        : "-";
  row.reviewCount = meta?.reviewCount ? String(meta.reviewCount) : "-";
  row.priceSale = meta?.priceSale ? String(meta.priceSale) : "-";
}

async function runOneCycle(browser) {
  const cfg = normalizeConfig(readJsonSafe(CONFIG_PATH, {}));
  const rows = readJsonSafe(TASKS_PATH, []);
  if (!Array.isArray(rows) || rows.length === 0) {
    log("[RUNNER] 작업이 없습니다.");
    await sleep(1500);
    return;
  }

  const flow = cfg.searchFlowVersion;
  const checkedIndexes = [];
  rows.forEach((r, i) => {
    if (rowPassesFilters(flow, r)) checkedIndexes.push(i);
  });

  if (!checkedIndexes.length) {
    log("[RUNNER] 실행 대상 없음 (목표 도달 또는 체크 없음)");
    process.stdout.write("__ALL_DONE__targets_reached\n");
    await sleep(1000);
    return;
  }

  for (const i of checkedIndexes) {
    if (stopped) return;
    const taskRows = readJsonSafe(TASKS_PATH, rows);
    const row = taskRows[i];
    if (!row) continue;

    const linkUrl = String(row.linkUrl || "").trim();
    const searchKeyword = buildSearchKeyword(flow, row);
    if (!linkUrl || !searchKeyword) {
      row.trafficFail = (Number(row.trafficFail) || 0) + 1;
      writeJson(TASKS_PATH, taskRows);
      emitRows(taskRows);
      log(`[RUNNER] 행 데이터 부족: row=${i + 1}`);
      continue;
    }

    const productId = extractProductId(linkUrl);
    if (!productId) {
      row.trafficFail = (Number(row.trafficFail) || 0) + 1;
      writeJson(TASKS_PATH, taskRows);
      emitRows(taskRows);
      log(`[RUNNER] 상품 ID 파싱 실패: row=${i + 1}`);
      continue;
    }

    let context;
    try {
      if (cfg.ipRotationEnabled === true) {
        try {
          await toggleAdbMobileDataOffOn(`${searchKeyword} 작업 전`, 1);
        } catch (e) {
          log(`[IPRotation] 실패: ${e.message || String(e)}`);
        }
      }

      context = await browser.newContext({
        viewport: cfg.mode === "mobile" ? { width: 412, height: 915 } : { width: 1366, height: 850 },
      });
      const page = await context.newPage();
      log(`[RUNNER] 작업 시작: row=${i + 1} flow=${flow} 검색어="${searchKeyword}"`);

      const maxPages = cfg.maxScroll;
      const rank = await findRank(page, searchKeyword, productId, maxPages, cfg);

      if (flow !== "D") {
        await doTrafficOnUrl(page, linkUrl, cfg);
      } else {
        await ensureOnProductPage(page, linkUrl, cfg);
      }

      let meta = { reviewCount: "", priceSale: "" };
      try {
        await ensureOnProductPage(page, linkUrl, cfg);
        meta = await extractReviewAndSalePrice(page);
      } catch (e) {
        log(`[RUNNER] PDP 메타 추출 경고: ${e.message || String(e)}`);
      }

      applyRowSnapshot(row, rank, meta);

      row.trafficOk = (Number(row.trafficOk) || 0) + 1;
      writeJson(TASKS_PATH, taskRows);
      emitRows(taskRows);
      log(
        `[RUNNER] 성공: 검색="${searchKeyword}" | 순위=${row.rank} | 리뷰=${row.reviewCount} | 할인가=${row.priceSale} | 성공=${row.trafficOk} 실패=${row.trafficFail || 0}`
      );
    } catch (e) {
      row.trafficFail = (Number(row.trafficFail) || 0) + 1;
      writeJson(TASKS_PATH, taskRows);
      emitRows(taskRows);
      log(`[RUNNER] 실패: ${searchKeyword} | ${classifyErrorMessage(e)} | ${e.message || String(e)}`);
    } finally {
      if (context) await context.close();
      await sleep(1200);
    }
  }
}

async function main() {
  log("[RUNNER] 쿠팡 워커 시작");
  let browser;
  const launchErrors = [];
  try {
    browser = await chromium.launch({ channel: "chrome", headless: false });
    log("[RUNNER] 시스템 Chrome 채널로 실행");
  } catch (e) {
    launchErrors.push(`chrome-channel: ${e.message || String(e)}`);
  }
  if (!browser) {
    try {
      browser = await chromium.launch({ channel: "msedge", headless: false });
      log("[RUNNER] 시스템 Edge 채널로 실행");
    } catch (e) {
      launchErrors.push(`edge-channel: ${e.message || String(e)}`);
    }
  }
  if (!browser) {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const exePath of candidates) {
      if (!fs.existsSync(exePath)) continue;
      try {
        browser = await chromium.launch({ executablePath: exePath, headless: false });
        log(`[RUNNER] 실행파일 경로로 브라우저 실행: ${exePath}`);
        break;
      } catch (e) {
        launchErrors.push(`exe-path(${exePath}): ${e.message || String(e)}`);
      }
    }
  }
  if (!browser) {
    try {
      browser = await chromium.launch({ headless: false });
      log("[RUNNER] Playwright Chromium으로 실행");
    } catch (e) {
      launchErrors.push(`playwright-chromium: ${e.message || String(e)}`);
    }
  }
  if (!browser) {
    process.stderr.write("[RUNNER] 브라우저 실행 실패. Chrome/Edge 설치 또는 런타임 확인 필요\n");
    for (const err of launchErrors) {
      process.stderr.write(`[RUNNER] launch-error: ${err}\n`);
    }
    process.exit(1);
  }
  try {
    while (!stopped) {
      await runOneCycle(browser);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`[RUNNER] 치명적 오류: ${e.message || String(e)}\n`);
  process.exit(1);
});
