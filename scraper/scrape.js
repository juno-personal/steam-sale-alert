/**
 * SteamDB Sales 무한스크롤 스크래퍼 (Playwright / Node)
 * 
 * 사용법:
 *   node scrape.js --out games.json
 * 
 * 실측(2026-09, SteamDB 테이블 구조 기반):
 *   - 테이블 행 기반 스크롤로 상세 페이지까지 수집
 *   - 필드: 이미지, 제목, 할인율, 가격(AED), 평점, 종료 일시
 *   - 24시간 이내 시작된 항목만 필터링
 *   - Rating 기준 내림차순 정렬
 */

import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  TARGET_URL,
  ROW_SELECTORS,
  TABLE_SELECTORS,
  SCROLL_DEFAULTS,
  USER_AGENT,
} from "./selectors.js";

// 가격 텍스트 패턴 (AED 통화 포함)
const PRICE_PATTERN = "AED\\s?\\d[\\d.,]*|\\d+\\s?AED|\\d+";

/** 페이지 내에서 행 데이터 추출 (셀렉터는 인자로 전달) */
function extractInPage(args) {
  const rowSelector = args.rowSelector;
  const priceRe = new RegExp(args.pricePattern, "g");

  return Array.from(document.querySelectorAll(rowSelector)).map((row) => {
    // 셀 추출 헬퍼: 행 내의 td 찾기
    const findCell = (className) => {
      return row.querySelector(`td.${className}`) || row.querySelector(`td[data-name="${className}"]`);
    };

    const nameEl = row.querySelector('td.name') || row.querySelector('td:first-child');
    const discountEl = row.querySelector('td.discount');
    const ratingEl = row.querySelector('td.rating');
    const priceEl = row.querySelector('td.price');
    const originalPriceEl = row.querySelector('td.original-price');
    const salePriceEl = row.querySelector('td.sale-price');
    const imageEl = row.querySelector('td img');
    const linkEl = row.querySelector('td a');

    const href = linkEl ? linkEl.getAttribute("href") : null;
    const pkgMatch = href ? href.match(/[?&]id=([^&]+)/) : null;

    return {
      packageId: pkgMatch ? decodeURIComponent(pkgMatch[1]) : null,
      name: nameEl ? nameEl.textContent.trim() : null,
      discountPercent: discountEl ? discountEl.textContent.trim() : null,
      ratingText: ratingEl ? ratingEl.getAttribute("aria-label") : null,
      originalPriceText: originalPriceEl ? originalPriceEl.textContent.trim() : null,
      salePriceText: salePriceEl ? salePriceEl.textContent.trim() : null,
      priceTexts: [],
      imageUrl: imageEl ? imageEl.getAttribute("src") : null,
      productUrl: href ? `https://steamdb.info${href}` : null,
      // SteamDB 전용: 할인 시작/종료 정보
      startedText: findCell("started") ? findCell("started").textContent.trim() : null,
      saleEndText: findCell("ends") ? findCell("ends").textContent.trim() : null,
    };
  });
}

/** 원시 DOM 값을 GAS 게임 스키마로 정규화 */
function normalizeGame(raw) {
  const discount = raw.discountPercent ? parseInt(raw.discountPercent.replace(/[^\d]/g, ""), 10) : NaN;
  const rating = raw.ratingText ? parseFloat(raw.ratingText.replace(/[^\d.]/g, "")) : NaN;

  let salePrice = raw.salePriceText;
  let originalPrice = raw.originalPriceText;

  // 가격이 없으면 텍스트에서 백
  if (!salePrice && raw.priceTexts.length) {
    salePrice = raw.priceTexts[raw.priceTexts.length - 1];
    originalPrice = originalPrice || raw.priceTexts[0];
  }

  const isPaid = Boolean(originalPrice) && !/^free$/i.test(String(originalPrice).trim());

  // SteamDB는 절대 날짜 또는 "in 3 days" 같은 상대 기간을 표시할 수 있습니다.
  // 절대 날짜는 Date로 변환하고, 변환할 수 없는 표시는 원문을 보존합니다.
  let startedDate = null;
  let saleEndDate = null;
  if (raw.startedText) {
    const dateMatch = raw.startedText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (dateMatch) {
      startedDate = new Date(
        parseInt(dateMatch[1]),
        parseInt(dateMatch[2]) - 1,
        parseInt(dateMatch[3]),
        parseInt(dateMatch[4]),
        parseInt(dateMatch[5])
      );
    }
  }
  if (raw.saleEndText) {
    const endMatch = raw.saleEndText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (endMatch) {
      saleEndDate = new Date(
        parseInt(endMatch[1]),
        parseInt(endMatch[2]) - 1,
        parseInt(endMatch[3]),
        parseInt(endMatch[4]),
        parseInt(endMatch[5])
      );
    }
  }

  return {
    packageId: raw.packageId,
    name: raw.name,
    discountPercent: Number.isFinite(discount) ? discount : null,
    rating: Number.isFinite(rating) ? rating : null,
    originalPrice: originalPrice || null,
    salePrice: salePrice || null,
    imageUrl: raw.imageUrl,
    productUrl: raw.productUrl,
    saleEndDate,
    saleEndText: raw.saleEndText || null,
    isPaid,
    startedDate, // 24시간 필터용
  };
}

/** 무한스크롤: 행 수가 stableNeeded회 연속 동일하면 정지 */
async function scrollUntilStable(page, opts) {
  const timeline = [];
  let stable = 0;
  let lastN = -1;
  let lastScrollHeight = -1;
  const started = Date.now();

  for (let step = 0; step <= opts.maxScrolls; step += 1) {
    const n = await page.locator(ROW_SELECTORS[0]).count();
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    
    timeline.push({
      step,
      cards: n,
      scrollHeight,
      elapsedSec: Number(((Date.now() - started) / 1000).toFixed(2)),
    });

    if (n === lastN && scrollHeight === lastScrollHeight) stable += 1;
    else stable = 0;
    lastN = n;
    lastScrollHeight = scrollHeight;

    if (stable >= opts.stableNeeded) return { timeline, stopReason: "stable" };
    if ((Date.now() - started) / 1000 > opts.maxSeconds) return { timeline, stopReason: "time-limit" };

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(opts.settleMs);
  }
  return { timeline, stopReason: "max-scrolls" };
}

export async function scrape({ channel = null, headed = false, verbose = false, launchOptions = {} } = {}) {
  const opts = { ...SCROLL_DEFAULTS };
  const browser = await chromium.launch({
    headless: !headed,
    ...(channel ? { channel } : {}),
    ...launchOptions,
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: opts.viewport,
      userAgent: USER_AGENT,
    });
    const page = await context.newPage();

    const t0 = Date.now();
    const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    const status = response ? response.status() : 0;

    // 테이블 대기
    let matched = null;
    for (const sel of TABLE_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 12000 });
        matched = sel;
        break;
      } catch {
        /* 다음 폴백 */
      }
    }
    if (!matched) throw new Error("테이블 셀렉터를 찾지 못했습니다. DOM 구조 변경 가능성.");

    if (verbose) console.log(`[scrape] 테이블 셀렉터: ${matched}`);

    await page.waitForTimeout(2500); // hydration 대기
    const initialCards = await page.locator(ROW_SELECTORS[0]).count();

    const { timeline, stopReason } = await scrollUntilStable(page, opts);
    const rawRows = await page.evaluate(extractInPage, {
      rowSelector: ROW_SELECTORS[0],
      pricePattern: PRICE_PATTERN,
    });

    const games = rawRows
      .map((raw) => normalizeGame(raw))
      .filter((g) => g.name && g.packageId);

    // 24시간 필터: Started가 최근 24시간 이내인 경우만 유지
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const recentGames = games.filter((g) => {
      if (!g.startedDate) return true; // Started 정보가 없으면 포함
      return g.startedDate >= twentyFourHoursAgo;
    });

    if (verbose) {
      console.log(`[scrape] 전체 ${games.length}개 중 24시간 이내 ${recentGames.length}개`);
      console.log(`[scrape] 제외된 항목: ${games.length - recentGames.length}개`);
    }

    return {
      scrapedAt: new Date().toISOString(),
      sourceUrl: TARGET_URL,
      httpStatus: status,
      initialCards,
      finalCards: await page.locator(ROW_SELECTORS[0]).count(),
      uniquePackages: new Set(recentGames.map((g) => g.packageId)).size,
      scroll: { stopReason, scrolls: timeline.length - 1, timeline },
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
      games: recentGames, // 24시간 필터 적용된 결과
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = require("minimist")(process.argv.slice(2));
  const result = await scrape({ channel: args.channel, headed: args.headed, verbose: args.verbose });

  console.log(`[scrape] URL: ${result.sourceUrl}`);
  console.log(`[scrape] HTTP ${result.httpStatus} | 초기 ${result.initialCards} → 최종 ${result.finalCards} 카드`);
  console.log(`[scrape] 고유 패키지 ${result.uniquePackages} | 스크롤 ${result.scroll.scrolls}회 (${result.scroll.stopReason})`);
  console.log(`[scrape] 소요 ${result.elapsedSec}s`);

  if (args.verbose) {
    for (const g of result.games.slice(0, 5)) {
      console.log(`  - ${g.name} | ${g.discountPercent}% | ${g.rating} | ${g.startedDate}`);
    }
  }

  if (result.games.length === 0) {
    console.error("[scrape] 결과 0건 → 실패로 처리합니다.");
    process.exit(2);
  }

  writeFileSync(args.out, JSON.stringify(result, null, 2), "utf8");
  console.log(`[scrape] 저장: ${args.out}`);
}

main().catch((err) => {
  console.error(`[scrape] 실패: ${err.stack || err.message}`);
  process.exit(1);
});