/**
 * Steam 공식 스토어 검색 API 기반 할인 스크래퍼
 *
 * - 평점 하한 0 / 리뷰 500 이상인 게임을 apps.json 스키마로 수집
 * - history.json 으로 최초 발견일(firstSeenAt)을 관리하고 만료시키지 않는다.
 *   이번 실행에 없던 게임은 기록에서 제거되므로 파일 크기가 스스로 제한된다.
 * - 부분 실패 허용: 개별 페이지 실패는 건너뛰고 진행한다.
 *
 * 사용법:
 *   node scraper/scrape.js --out games.json
 *   node scraper/scrape.js --out games.json --max-pages 3   (테스트)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import minimist from "minimist";

const SEARCH_URL =
  "https://store.steampowered.com/search/results" +
  "?force_infinite=1&hwtype=0&l=korean&cc=ae&untags=9130" +
  "&category1=998&specials=1&ndl=1&infinite=1";

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const REQUEST_DELAY_MS = 1500;
const MAX_RETRIES = 5;

// 스크랩 단계 기준선. 여기서 잘린 게임만 앱에 올라가므로
// 앱의 평점/리뷰수 필터는 이 범위 안에서만 움직일 수 있다.
const MIN_RATING = 0;
const MIN_REVIEWS = 500;

const REVIEW_BENCHMARK = 10000;

// 이메일 1통에 담을 게임 수. GAS가 아니라 여기서 고른다.
// payload에 전체 1.3MB를 실을 필요 없이 이 40건만 전달하면 된다.
const EMAIL_TOP_N = 40;

// 마크업 변경 감지용. 한 페이지에서 이보다 적게 인식되면 파싱이 깨진 것으로 본다.
const MIN_ROWS_PER_PAGE = 40;

// 발행 안전장치.
//
// Steam 은 마크업을 수시로 바꾼다. 2026-10 에 discount_pct 에 aria-hidden 이
// 추가되어 할인율이 0 이 되었고, 그 결과 games.json 이 0개로 발행됐다.
// 파싱은 "성공"했으므로 워크플로도 초록불이었고, 사용자는 그제야
// 앱이 비어 있는 걸 알았다. history.json 까지 0개로 덮어써졌다.
//
// 그래서 결과가 이상하면 발행하지 않고 실패한다.
// 기준값은 전 실행 결과와 비교해 정하고, 더 엄격한 쪽을 쓴다.
const SAFE_MIN_GAMES = 500;   // 절대 하한. 이보다 적으면 파싱이 깨진 것으로 본다
const SAFE_MIN_RATE = 0.5;    // 직전 실행 대비 비율. 이보다 많이 줄면 파싱이 깨진 것으로 본다
const SAFE_MIN_HEALTH = 0.8;  // 필드 유효 평균 하한
// 원시 파싱 결과의 필드명이다. toCompact 이후의 짧은 키(r 등)와 다르므로
// 반드시 이쪽 이름을 쓴다. 틀리면 정상 데이터도 "비어 있다"고 오판한다.
const SAFE_FIELDS = ["d", "c", "rawRating", "n"];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// 이미지 URL은 games.json 최상위로 prefix만 두고, 게임마다 상대경로만 저장한다.
// prefix + appId + "/" + 상대경로 로 원본 URL을 그대로 복원할 수 있다.
//
// 해시 디렉터리는 선택 사항이다 (전체 중 약 6할에만 존재) :
//   해시 있음  .../apps/1304930/115ccc74.../capsule_231x87.jpg
//   해시 없음  .../apps/1174180/capsule_231x87.jpg
// 파일명도 capsule_231x87_koreana.jpg, capsule_231x87_alt_assets_3.jpg 등이
// 있으므로 임의로 지우지 말고 있는 그대로 저장한다.
const IMG_PREFIX = "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/";
const IMG_REL_RE = /store_item_assets\/steam\/apps\/\d+\/(.+?)(?:\?|$)/;

// Steam 검색 결과의 마크업.
// 행 경계는 </a> 대신 "다음 행 시작"으로 나눈다. </a>가 빠진 행이 있어도
// 안정적으로 분리된다.
const ROW_SPLIT = /(?=<a\b[^>]*data-ds-appid="\d+")/;
const RE_APID = /data-ds-appid="(\d+)"/;
const RE_TITLE = /<span class="title">([\s\S]*?)<\/span>/;
const RE_IMAGE = /<div class="search_capsule"><img src="([^"]+)"/;
// 할인율 추출.
//
// Steam 이 마크업을 바꿔 <div class="discount_pct" aria-hidden="true">-90%</div>
// 처럼 중간에 속성이 들어갔다. 예전 정규식은 class="discount_pct"> 를 요구해서
// 전부 탈락했고, 그 결과 d 가 0 이 되어 toCompact 가 모든 게임을 버렸다.
//
// 이제 두 경로를 모두 시도한다.
//   1) data-discount="90"  — 할인 블록의 속성. 속성 추가/순서 변경에 강하다
//   2) discount_pct 안의 텍스트 — 속성 개수와 무관하게 태그 내용을 읽는다
// 둘 다 실패하면 0 이고, toCompact 가 그 행을 버린다.
const RE_DISCOUNT_ATTR = /data-discount="(\d+)"/;
const RE_DISCOUNT_TEXT = /class="[^"]*discount_pct[^"]*"[^>]*>\s*-?(\d+)\s*%/;
const RE_ORIGINAL = /class="discount_original_price">([^<]*)</;
const RE_FINAL = /class="discount_final_price">([^<]*)</;
const RE_TOOLTIP = /class="search_review_summary[^"]*"[^>]*data-tooltip-html="([^"]*)"/;

const HISTORY_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "history.json");

export function decodeEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, "&"); // &amp;는 마지막에 디코드해야 이중 디코딩이 안 된다
}

/** 툴팁에서 긍정 평가 비율과 리뷰 수를 뽑는다. (영문/한글 응답 모두 지원)
 *
 * 한국어 리뷰가 충분해 Steam 이 한국어 기준으로 점수를 내는 경우에만
 * "환경 설정에 따라 사용자의 언어로 작성된 평가에 기반" 문장이 붙는다.
 * 그 문장이 없으면 Steam 이 전체(total) 리뷰 수로 폴백한 것이므로
 * korean=false 로 표시하고, 최종 앱에서는 리뷰 수를 0으로 보여준다.
 */
export function parseReviewTooltip(tooltip) {
  const match =
    tooltip.match(/(\d{1,3})%\s+of\s+the\s+([\d,]+)\s+user reviews/i) ||
    tooltip.match(/([\d,]+)\s*개[^%]*?(\d{1,3})%/);
  if (!match) return { ratingPct: null, reviewCount: null, korean: false };

  const korean = /환경 설정에 따라 사용자의 언어/.test(tooltip);

  if (/user reviews/i.test(tooltip)) {
    return { ratingPct: Number(match[1]), reviewCount: Number(match[2].replace(/,/g, "")), korean };
  }
  return { reviewCount: Number(match[1].replace(/,/g, "")), ratingPct: Number(match[2]), korean };
}

export function parsePrice(text) {
  if (!text) return null;
  const match = String(text).match(/\d[\d.]*/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * SteamDB 스타일 평점. 리뷰 표본이 작으면 50점에 강하게 끌리고,
 * 표본이 커질수록 원래 긍정률에 수렴한다.
 *
 * 이 값은 "중요한 게임"을 고를 때의 내부 순위용이다.
 * 리뷰 500개에서도 보정 폭이 15%라 Steam이 보여주는 수치와 다르므로
 * 사용자 화면이나 필터에는 쓰지 않는다. 그쪽은 원본 긍정률(rawScore)을 쓴다.
 */
export function calculateRating(positiveVotes, negativeVotes) {
  const total = positiveVotes + negativeVotes;
  if (!total) return null;
  const reviewScore = positiveVotes / total;
  const adjusted = reviewScore - (reviewScore - 0.5) * Math.pow(2, -Math.log10(total + 1));
  return Number((adjusted * 100).toFixed(2));
}

/**
 * 발행 전에 결과를 검사한다. 이상하면 예외를 던져 실행을 실패시킨다.
 *
 * 이렇게 하는 이유는 파싱 실패가 조용히 지나가면 안 되기 때문이다.
 * 0개로 발행되면 앱이 비고, history.json 이 0개로 덮여서
 * 다음 실행에서 이미 보낸 게임을 전부 신규로 다시 보낸다.
 * 여기서 던지면 games.json 과 history.json 은 그대로 남는다.
 *
 * 필드 이름은 원시 파싱 결과(rawRating)에 맞춰야 한다.
 * toCompact 이후의 짧은 키(r)로 재면 전부 0 으로 재서 정상 실행을 막아버린다.
 *
 * 반드시 main() 안에서 writeFileSync 전에만 호출한다.
 */
export function assertPublishable(result, previousCount) {
  const problems = [];
  const games = result.games;

  // --max-pages 로 일부만 훑는 로컬 테스트는 개수 기준이 맞지 않는다.
  // 3페이지면 249개가 정상이라 하한에 걸린다. 그 실행만 개수 검사를 건너뛴다.
  const isFullRun = result.fullRun !== false;

  if (games.length === 0) {
    problems.push("게임이 0개입니다. 파싱이 깨졌거나 Steam 응답이 바뀐 것 같습니다.");
  } else if (isFullRun && games.length < SAFE_MIN_GAMES) {
    problems.push(
      `게임이 ${games.length}개뿐입니다(안전 하한 ${SAFE_MIN_GAMES}개). ` +
      `평소 수치와 비교해 파싱이 깨졌는지 확인하세요.`
    );
  }

  // 직전 실행 대비 급감. 세일 종료로 줄어드는 건 수천 개 단위라
  // 절반 이하로 떨어지면 파싱 문제로 본다.
  // 부분 실행은 비교 자체가 무의미하므로 건너뛴다.
  if (isFullRun && previousCount > 0 && games.length > 0) {
    const rate = games.length / previousCount;
    // 수집 개수가 절대 하한(SAFE_MIN_GAMES) 미만이면서 동시에 직전 대비 비율이 급감했을 때만 오류로 판단
    if (rate < SAFE_MIN_RATE && games.length < SAFE_MIN_GAMES) {
      problems.push(
        `직전 실행(${previousCount}개) 대비 ${(rate * 100).toFixed(0)}% 만 남았고 ` +
        `절대 하한(${SAFE_MIN_GAMES}개) 미만입니다. 마크업 변화 가능성을 확인하세요.`
      );
    }
  }

  // 필드 유효도. 행 수는 정상인데 값만 사라지는 사고를 잡는다.
  if (result.health !== undefined && result.health < SAFE_MIN_HEALTH) {
    problems.push(
      `필드 유효 평균이 ${(result.health * 100).toFixed(1)}% 입니다 ` +
      `(하한 ${(SAFE_MIN_HEALTH * 100).toFixed(0)}%). ` +
      `정규식 중 하나가 Steam 마크업 변화에 뒤처진 것 같습니다.`
    );
  }

  // 수집 자체가 대부분 실패한 경우
  if (result.pagesFetched > 0 && result.pagesFailed >= result.pagesFetched) {
    problems.push(`모든 페이지 수집에 실패했습니다(${result.pagesFailed}/${result.pagesFetched}).`);
  }

  if (problems.length) {
    const detail = problems.map((p) => `  - ${p}`).join("\n");
    throw new Error(
      `발행을 중단합니다. games.json 과 history.json 은 수정하지 않았습니다.\n${detail}\n` +
      `scrape.js 의 정규식(RE_DISCOUNT_*, RE_TITLE, RE_TOOLTIP, RE_IMAGE)을 Steam 응답과 대조하세요.`
    );
  }
}

/**
 * 파싱 결과에서 필드별 유효 비율을 잰다.
 *
 * 행 수는 정상이면서 특정 필드만 0 이 되는 경우가 실제 사고였다.
 * (할인율 0 → 99행 중 99행이 탈락)
 * 필드 단위로 보면 어느 쪽이 깨졌는지 바로 알 수 있다.
 */
export function measureHealth(games) {
  const total = games.length || 1;
  const health = { total: games.length };
  for (const field of SAFE_FIELDS) {
    const filled = games.filter((g) => {
      const v = g[field];
      return v !== null && v !== undefined && v !== 0 && v !== "";
    }).length;
    health[field] = filled / total;
  }
  return health;
}

/** 필드 유효 비율들을 합쳐 평균을 낸다. 낮으면 마크업이 바뀌었을 가능성이 높다. */
export function averageHealth(healthList) {
  if (!healthList.length) return 1;
  let sum = 0;
  for (const health of healthList) {
    for (const field of SAFE_FIELDS) sum += health[field] || 0;
  }
  return sum / (healthList.length * SAFE_FIELDS.length);
}

/**
 * 한 행에서 할인율을 뽑는다. 없으면 0.
 *
 * 속성(data-discount)과 텍스트(discount_pct) 두 경로를 모두 시도한다.
 * 어느 쪽이 살아남든 파싱이 0 으로 붕괴하지 않게 하는 것이 목적이다.
 */
export function extractDiscount(row) {
  const byAttr = row.match(RE_DISCOUNT_ATTR);
  if (byAttr) return Number(byAttr[1]) || 0;
  const byText = row.match(RE_DISCOUNT_TEXT);
  if (byText) return Number(byText[1]) || 0;
  return 0;
}

/** results_html 한 페이지를 파싱한다. */
export function parseResultsHtml(html) {
  const games = [];
  // parts[0]은 첫 행 이전의 프롤로그이므로 제외한다.
  const parts = html.split(ROW_SPLIT);
  let rowsWithoutTitle = 0;

  for (let i = 1; i < parts.length; i += 1) {
    const row = parts[i];
    const idMatch = row.match(RE_APID);
    if (!idMatch) continue;

    const titleMatch = row.match(RE_TITLE);
    if (!titleMatch) {
      rowsWithoutTitle += 1;
      continue;
    }

    const discount = extractDiscount(row);
    const tooltipMatch = row.match(RE_TOOLTIP);
    const review = tooltipMatch ? parseReviewTooltip(decodeEntities(tooltipMatch[1])) : { ratingPct: null, reviewCount: null, korean: false };

    games.push({
      i: idMatch[1],
      n: decodeEntities(titleMatch[1]).trim(),
      d: discount,
      rawRating: review.ratingPct,
      c: review.reviewCount,
      korean: review.korean,
      originalPrice: row.match(RE_ORIGINAL)?.[1]?.trim() || null,
      salePrice: row.match(RE_FINAL)?.[1]?.trim() || null,
      imageUrl: row.match(RE_IMAGE)?.[1] || null,
    });
  }
  return { games, rowsDetected: parts.length - 1, rowsWithoutTitle };
}

/**
 * 마크업 변경으로 파싱이 조용히 깨지는 것을 막는다.
 *
 * Steam은 count=100을 요청해도 97~100행을 주며, data-ds-appid 속성을
 * 행이 아닌 곳에도 가끔 붙인다. 그래서 속성 개수는 판정 기준으로 쓰지 않고,
 * "행으로 인식된 개수"와 "실제 파싱 성공 개수"의 일치만 확인한다.
 */
function verifyIntegrity(start, rowsDetected, rowsWithoutTitle, games, totalCount) {
  if (rowsWithoutTitle > 0) {
    console.error(
      `[scrape] 경고: start=${start} 행 ${rowsDetected}개 중 ${rowsWithoutTitle}개에서 ` +
      `<span class="title"> 을 찾지 못했습니다. 마크업 변경 가능성.`
    );
  }
  // 마지막 페이지는 전체 개수를 채우지 못하므로 행이 적게 나와도 정상이다.
  const isLastPage = totalCount > 0 && start + PAGE_SIZE >= totalCount;
  if (rowsDetected < MIN_ROWS_PER_PAGE && !isLastPage) {
    console.error(
      `[scrape] 경고: start=${start} 행을 ${rowsDetected}개만 인식했습니다 ` +
      `(정상 ${PAGE_SIZE}개 근처). Steam 마크업이 바뀌었는지 확인하세요.`
    );
  }

  // 파싱은 되는데 값이 0 으로 비면 최종 결과가 0 개가 된다.
  // 2026-10 에 Steam 이 discount_pct 뒤에 aria-hidden 을 추가해서
  // 이런 상태가 실제로 발생했다. 행 수 경고로는 잡히지 않으므로 따로 본다.
  if (rowsDetected > 0 && games.length > 0) {
    const withDiscount = games.filter((g) => g.d > 0).length;
    if (withDiscount === 0) {
      console.error(
        `[scrape] 오류: start=${start} 행 ${games.length}개인데 할인율이 하나도 인식되지 않았습니다. ` +
        `정규식이 Steam 마크업 변화에 뒤처진 것입니다. RE_DISCOUNT_ATTR / RE_DISCOUNT_TEXT 를 확인하세요.`
      );
    }
  }
}

/**
 * 원시 게임 배열을 apps.json 스키마(짧은 키)로 변환한다.
 *
 * r = 표본 보정 평점. 앱 표시·필터·정렬과 이메일 상위 40개 선정이
 *     전부 이 값을 쓴다. Steam 이 표시하는 원본 긍정률과는 다르다.
 *     (리뷰 509개에 97% → 보정 89.8% 처럼 작은 표본을 낮춰 신뢰도를 반영)
 * g = 이미지 상대경로
 */
export function toCompact(raw) {
  const out = [];
  for (const game of raw) {
    if (!game.i || !game.n) continue;
    if (game.d <= 0) continue;
    // 수집 기준선은 Steam 이 보여주는 리뷰 수(폴백 포함)로 판단한다.
    // 한국어 리뷰 수로 필터링하면 폴백 게임이 전부 탈락해 목록이 비어버린다.
    if (game.c === null || game.c < MIN_REVIEWS) continue;

    let rating = game.rawRating;
    if (game.rawRating !== null && game.c > 0) {
      const positive = Math.round(game.c * (game.rawRating / 100));
      rating = calculateRating(positive, game.c - positive) ?? game.rawRating;
    }
    if (rating === null || rating < MIN_RATING) continue;

    out.push({
      i: game.i,
      n: game.n,
      d: game.d,
      r: Math.round(rating * 10) / 10,
      // 한국어 리뷰가 없는 게임은 Steam 이 전체(total) 수로 폴백한다.
      // 그런 경우 최종 앱에서 0으로 표기해 '리뷰 많은 순' 정렬 시 하단으로 가게 한다.
      c: game.korean === false ? 0 : game.c,
      o: parsePrice(game.originalPrice),
      s: parsePrice(game.salePrice),
      g: (game.imageUrl || "").match(IMG_REL_RE)?.[1] || null,
    });
  }
  return out;
}

function buildSearchUrl(start) {
  return SEARCH_URL + `&start=${start}&count=${PAGE_SIZE}`;
}

/**
 * 이메일 상위 N개 선정 기준.
 *
 * 리뷰 수 내림차순 → 보정 평점 내림차순.
 * 사용자가 "리뷰 많은 순"으로 받기를 원하므로 리뷰 수를 1순위로 둔다.
 * 리뷰 수가 같으면 보정 평점이 높은 쪽이 먼저 온다.
 */
export function rankForEmail(games) {
  return games
    .slice()
    .sort((a, b) => b.c - a.c || b.r - a.r || (a.i < b.i ? -1 : 1));
}

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn("[scrape] history.json 파싱 실패, 빈 기록으로 시작합니다.");
    return {};
  }
}

async function fetchPage(start) {
  let response = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    response = await fetch(buildSearchUrl(start), {
      headers: {
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://store.steampowered.com/search/",
      },
    });
    if (![429, 502, 503, 504].includes(response.status)) break;
    if (attempt === MAX_RETRIES) break;

    // 579페이지를 순회하므로 백오프를 길게 잡으면 한 페이지에서
    // 실행 전체 시간표를 소모한다. 짧게 물러난다.
    const waitMs = response.status === 429 ? 5000 * 2 ** attempt : 3000 * 2 ** attempt;
    console.warn(`[scrape] HTTP ${response.status} → ${waitMs / 1000}초 대기 후 재시도 (start=${start})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // 실패한 페이지는 건너뛴다. start는 명시적 오프셋이라 다른 페이지에 영향이 없다.
  if (!response || !response.ok) return null;

  const data = await response.json();
  if (!data || data.success !== 1 || typeof data.results_html !== "string") return null;

  const totalCount = Number(data.total_count || 0);
  const parsed = parseResultsHtml(data.results_html);
  verifyIntegrity(start, parsed.rowsDetected, parsed.rowsWithoutTitle, parsed.games, totalCount);

  return { games: parsed.games, totalCount, health: measureHealth(parsed.games) };
}

export async function scrape(maxPages) {
  const raw = [];
  const seen = new Set();
  const healthList = [];
  let totalCount = 0;
  let fetched = 0;
  let failed = 0;

  const limit = Math.min(maxPages || MAX_PAGES, MAX_PAGES);

  for (let pageIndex = 0; pageIndex < limit; pageIndex += 1) {
    if (pageIndex > 0) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    const start = pageIndex * PAGE_SIZE;
    const result = await fetchPage(start);

    if (!result) {
      failed += 1;
      console.warn(`[scrape] start=${start} 실패, 건너뜁니다.`);
      continue;
    }

    fetched += 1;
    totalCount = result.totalCount;
    healthList.push(result.health);

    for (const game of result.games) {
      if (seen.has(game.i)) continue;
      seen.add(game.i);
      raw.push(game);
    }

    console.log(`[scrape] start=${start} → ${result.games.length}개 (누적 ${raw.length}/${totalCount || "?"})`);

    // Steam은 count=100을 요청해도 99행을 주거나 마지막 페이지에서 더 적게 준다.
    // "행 수 < PAGE_SIZE"로 종료 판단하면 매 페이지마다 잘리므로 쓰지 않는다.
    if (result.games.length === 0) break;
    if (totalCount && start + PAGE_SIZE >= totalCount) break;
  }

  const games = toCompact(raw);
  const health = averageHealth(healthList);
  console.log(`[scrape] ${fetched}페이지 수집(실패 ${failed}), 조건 통과 ${games.length}개`);
  console.log(`[scrape] 필드 유효 평균 ${(health * 100).toFixed(1)}%`);

  return {
    scrapedAt: new Date().toISOString(),
    sourceUrl: buildSearchUrl(0),
    source: "steam-store-search",
    filters: { minRating: MIN_RATING, minReviews: MIN_REVIEWS },
    totalCollected: raw.length,
    totalCount,
    pagesFetched: fetched,
    pagesFailed: failed,
    // 부분 실행(--max-pages)에서는 개수 기준 비교가 무의미하므로 표시해 둔다.
    fullRun: limit >= MAX_PAGES,
    health,
    games,
  };
}

async function main() {
  const args = minimist(process.argv.slice(2));
  const result = await scrape(args["max-pages"]);

  const today = result.scrapedAt.slice(0, 10);
  const previous = loadHistory();

  // 반드시 파일을 쓰기 전에 검사한다. 여기서 던지면 아무것도 갱신되지 않는다.
  assertPublishable(result, Object.keys(previous).length);

  // 최초 발견일 확정. 이전 기록에 없던 게임은 오늘이 최초 발견일이다.
  // 기존 history.json 은 ISO 타임스탬프를 담고 있으므로 날짜 부분만 취한다.
  // (한 번 실행되면 YYYY-MM-DD 형식으로 정규화되어 저장된다.)
  const firstSeen = {};
  for (const game of result.games) {
    firstSeen[game.i] = String(previous[game.i] || "").slice(0, 10) || today;
  }

  // 만료 없는 history: 이번 실행에 없던 게임은 세일이 끝난 것으로 보고 제거한다.
  const nextHistory = {};
  for (const game of result.games) nextHistory[game.i] = firstSeen[game.i];

  const newToday = result.games.filter((g) => !previous[g.i]).length;
  const reviews10kPlus = result.games.filter((g) => g.c >= REVIEW_BENCHMARK).length;

  const games = result.games.map((g) => ({ ...g, f: firstSeen[g.i] }));

  // --force-notify 는 send_to_gas 실패로 알림을 놓쳤을 때 수동 복구용이다.
  // 평소에는 오늘 처음 발견된 게임만으로 상위 40개를 뽑는다.
  const notifyPool = args["force-notify"] ? games : games.filter((g) => !previous[g.i]);
  const top = rankForEmail(notifyPool).slice(0, EMAIL_TOP_N);

  const payload = {
    scrapedAt: result.scrapedAt,
    currency: "AED",
    source: result.source,
    sourceUrl: result.sourceUrl,
    filters: result.filters,
    imgPrefix: IMG_PREFIX,
    stats: { total: games.length, newToday, reviews10kPlus },
    pagesFetched: result.pagesFetched,
    pagesFailed: result.pagesFailed,
    games,
    notify: {
      newCount: notifyPool.length,
      forced: !!args["force-notify"],
      top,
    },
  };

  writeFileSync(args.out || "games.json", JSON.stringify(payload), "utf8");
  writeFileSync(HISTORY_FILE, JSON.stringify(nextHistory), "utf8");

  console.log(`[scrape] 최종 ${games.length}개 저장 (오늘 신규 ${newToday}개, 리뷰 1만+ ${reviews10kPlus}개)`);
  console.log(`[scrape] 알림 후보 ${notifyPool.length}개 → 상위 ${top.length}개 (${args["force-notify"] ? "강제" : "일반"})`);
  console.log(`[scrape] history.json ${Object.keys(nextHistory).length}개 항목으로 갱신`);
}

// 직접 실행할 때만 수집을 시작한다 (테스트에서 import해도 실행되지 않도록).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[scrape] 실패: ${error.stack || error.message}`);
    process.exit(1);
  });
}
