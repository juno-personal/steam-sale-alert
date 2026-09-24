/**
 * Steam 공식 스토어 검색 API 기반 할인 스크래퍼
 *
 * GitHub Actions에서 SteamDB 403을 피하고 Steam의 검색 결과를 사용합니다.
 * API는 이름, 이미지, 가격, 할인율, 평점, 리뷰 수를 제공합니다.
 *
 * 주의:
 * - Steam 검색 API에는 할인 시작/종료 시각이 없습니다.
 * - saleEndText는 "확인 필요"로 설정됩니다.
 * - 시작일 24시간 필터는 이 API만으로 정확히 수행할 수 없습니다.
 */

import { writeFileSync } from "node:fs";
import minimist from "minimist";
import { chromium } from "playwright";

const SEARCH_URL =
  "https://store.steampowered.com/search/results" +
  "?force_infinite=1&hwtype=0&supportedlang=koreana&cc=ae&untags=9130" +
  "&category1=998&specials=1&ndl=1&infinite=1";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MIN_RATING = 70;
const MIN_REVIEWS = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function buildSearchUrl(start) {
  return SEARCH_URL + `&start=${start}&count=${PAGE_SIZE}`;
}

function extractReviewInfo(dataTooltip) {
  const tooltip = String(dataTooltip || "").replace(/<br\s*\/?>(\s*)/gi, " ");
  const ratingMatch = tooltip.match(/(\d{1,3})%\s+of\s+the\s+([\d,]+)\s+user reviews/i);
  if (!ratingMatch) return { rating: null, reviewCount: null };
  return {
    rating: Number(ratingMatch[1]),
    reviewCount: Number(ratingMatch[2].replace(/,/g, "")),
  };
}

async function extractGamesFromHtml(html, page) {
  return page.locator("a[data-ds-appid]").evaluateAll((rows) => {
    return rows.map((row) => {
      const text = (selector) => row.querySelector(selector)?.textContent?.trim() || null;
      const attr = (selector, name) => row.querySelector(selector)?.getAttribute(name) || null;
      const appId = row.getAttribute("data-ds-appid");
      const href = row.getAttribute("href") || `https://store.steampowered.com/app/${appId}/`;
      const tooltip = attr(".search_reviewscore .search_review_summary", "data-tooltip-html") || "";
      const match = tooltip.match(/(\d{1,3})%\s+of\s+the\s+([\d,]+)\s+user reviews/i);
      return {
        packageId: appId,
        name: text(".search_name .title"),
        discountPercent: Number((text(".discount_pct") || "0").match(/\d+/)?.[0] || 0),
        rating: match ? Number(match[1]) : null,
        reviewCount: match ? Number(match[2].replace(/,/g, "")) : null,
        originalPrice: text(".discount_original_price"),
        salePrice: text(".discount_final_price"),
        imageUrl: attr(".search_capsule img", "src"),
        productUrl: href.split("?")[0],
        startedDate: null,
        saleEndDate: null,
        saleEndText: "확인 필요",
        source: "steam-store-search",
      };
    });
  });
}

function calculateSteamDbRating(positiveVotes, negativeVotes) {
  const totalVotes = positiveVotes + negativeVotes;
  if (!totalVotes) return null;
  const reviewScore = positiveVotes / totalVotes;
  const adjusted = reviewScore - (reviewScore - 0.5) * Math.pow(2, -Math.log10(totalVotes + 1));
  return Number((adjusted * 100).toFixed(2));
}

async function fetchReviewSummary(appId) {
  const url = "https://store.steampowered.com/appreviews/" + encodeURIComponent(appId) +
    "?json=1&language=all&purchase_type=all&filter=recent&num_per_page=0";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.status !== 429) {
      if (!response.ok) return null;
      const data = await response.json();
      return data.query_summary || null;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return null;
}

async function enrichSteamDbRatings(games) {
  const seen = new Set();
  const candidates = games.filter((game) => {
    if (!game.packageId || seen.has(game.packageId)) return false;
    seen.add(game.packageId);
    return true;
  });
  let enriched = 0;
  for (const game of candidates) {
    const summary = await fetchReviewSummary(game.packageId);
    if (!summary) continue;
    const positive = Number(summary.total_positive) || 0;
    const negative = Number(summary.total_negative) || 0;
    const total = Number(summary.total_reviews) || positive + negative;
    const steamDbRating = calculateSteamDbRating(positive, negative);
    if (steamDbRating !== null) {
      game.rating = steamDbRating;
      game.reviewCount = total;
      game.positiveVotes = positive;
      game.negativeVotes = negative;
      game.steamReviewDescription = summary.review_score_desc || null;
      enriched += 1;
    }
    if (enriched % 50 === 0) console.log(`[reviews] ${enriched}/${candidates.length}개 SteamDB Rating 계산 완료`);
  }
  return games;
}

async function fetchPage(browser, start) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(buildSearchUrl(start), {
      headers: {
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://store.steampowered.com/search/",
      },
    });
    if (response.status !== 429) break;
    const waitMs = 5000 * Math.pow(2, attempt);
    console.warn(`[scrape] HTTP 429 대기 ${waitMs / 1000}초 후 재시도 (start=${start})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (!response.ok) {
    throw new Error(`Steam 검색 API 오류: HTTP ${response.status} (start=${start})`);
  }

  const data = await response.json();
  if (!data || data.success !== 1 || typeof data.results_html !== "string") {
    throw new Error(`Steam 검색 API 응답 형식 오류 (start=${start})`);
  }

  const page = await browser.newPage();
  await page.setContent(`<html><body>${data.results_html}</body></html>`, { waitUntil: "domcontentloaded" });
  const games = await extractGamesFromHtml(data.results_html, page);
  if (games.length === 0) {
    console.warn(`[scrape] start=${start} 응답 HTML ${data.results_html.length}자, a=${await page.locator("a").count()}, app=${await page.locator("a[data-ds-appid]").count()}, prefix=${data.results_html.slice(0, 120)}`);
  }
  await page.close();
  return { games, totalCount: Number(data.total_count || 0) };
}

export async function scrape() {
  const browser = await chromium.launch({ headless: true });
  try {
    const allGames = [];
    let totalCount = 0;

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const start = pageIndex * PAGE_SIZE;
      const result = await fetchPage(browser, start);
      totalCount = result.totalCount;
      allGames.push(...result.games);
      console.log(
        `[scrape] ${result.games.length}개 수집 (누적 ${allGames.length}/${totalCount || "?"})`
      );
      if (result.games.length < PAGE_SIZE || allGames.length >= totalCount) break;
    }

    console.log(`[scrape] 파싱된 게임 ${allGames.length}개`);
    const seen = new Set();
    const enrichedGames = await enrichSteamDbRatings(allGames);
    const games = enrichedGames
      .filter((game) => {
        if (!game.packageId || !game.name || seen.has(game.packageId)) return false;
        seen.add(game.packageId);
        return (
          game.discountPercent > 0 &&
          game.rating !== null && game.rating >= MIN_RATING &&
          game.reviewCount !== null && game.reviewCount >= MIN_REVIEWS
        );
      })
      .sort((a, b) => {
        const ratingDifference = (b.rating || 0) - (a.rating || 0);
        if (ratingDifference) return ratingDifference;
        return (b.discountPercent || 0) - (a.discountPercent || 0);
      });

    return {
      scrapedAt: new Date().toISOString(),
      sourceUrl: buildSearchUrl(0),
      source: "steam-store-search",
      totalCollected: allGames.length,
      totalCount,
      games,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = minimist(process.argv.slice(2));
  const result = await scrape();
  console.log(`[scrape] 필터 적용 후 ${result.games.length}개`);
  console.log("[scrape] 할인 종료 시각은 Steam 검색 API에 없어 '확인 필요'로 표시됩니다.");
  writeFileSync(args.out || "games.json", JSON.stringify(result, null, 2), "utf8");
  console.log(`[scrape] 저장: ${args.out || "games.json"}`);
}

main().catch((error) => {
  console.error(`[scrape] 실패: ${error.stack || error.message}`);
  process.exit(1);
});
