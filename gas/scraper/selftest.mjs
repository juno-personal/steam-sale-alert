/**
 * Steam 검색 결과 마크업 파서 회귀 테스트
 *
 *   node scraper/selftest.mjs
 *
 * 스크래퍼는 정규식으로 Steam HTML을 긁는다. 마크업이 바뀌면 조용히
 * 0개가 되거나 필드가 null로 채워지므로, 실제 응답에서 잘라낸 픽스처를
 * 대조해 회귀를 막는다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeEntities,
  parseReviewTooltip,
  parsePrice,
  calculateRating,
  parseResultsHtml,
  toCompact,
  rankForEmail,
  measureHealth,
  averageHealth,
  assertPublishable,
} from "./scrape.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "search-results.html");

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ok   " + name);
  } else {
    failed += 1;
    console.error("  FAIL " + name + (detail ? " — " + detail : ""));
  }
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected),
    "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

/* ---------- decodeEntities ---------- */
console.log("\ndecodeEntities");
eq("&amp; 는 마지막에 처리 (이중 디코딩 방지)", decodeEntities("A&amp;lt;"), "A&lt;");
eq("기본 엔티티", decodeEntities("&lt;a&gt;&quot;b&quot;&#39;c&apos;"), '<a>"b"\'c\'');
eq("십진 숫자 참조", decodeEntities("&#65;&#66;"), "AB");
eq("십육진 숫자 참조", decodeEntities("&#x41;&#x42;"), "AB");

/* ---------- parseReviewTooltip ---------- */
console.log("\nparseReviewTooltip");
const ko = parseReviewTooltip("매우 긍정적<br>이 게임에 대한 사용자 평가 783개 중 88%가 긍정적입니다.");
eq("한국어 리뷰 수", ko.reviewCount, 783);
eq("한국어 긍정률", ko.ratingPct, 88);

const en = parseReviewTooltip("Very Positive<br>88% of the 1,234 user reviews for this game are positive.");
eq("영문 리뷰 수 (콤마 제거)", en.reviewCount, 1234);
eq("영문 긍정률", en.ratingPct, 88);

eq("파싱 불가하면 null", parseReviewTooltip("평가 없음").reviewCount, null);

/* ---------- parsePrice ---------- */
console.log("\nparsePrice");
eq("AED 문자열", parsePrice("105.00 AED"), 105);
eq("소수점 유지", parsePrice("11.99 AED"), 11.99);
eq("통화 없는 숫자", parsePrice("14.99"), 14.99);
eq("빈 값", parsePrice(""), null);
eq("숫자 없음", parsePrice("가격 확인"), null);

/* ---------- calculateRating (이메일 순위 전용) ---------- */
console.log("\ncalculateRating");
// 표본이 작으면 50점에 강하게 끌리고, 표본이 커질수록 원래 긍정률에 수렴한다.
// 리뷰 500개에서도 보정 폭이 15%라 Steam 표시값과 어긋난다.
// 그래서 이 값은 상위 40개 선정에만 쓰고, 화면·필터에는 원본 긍정률(p)을 쓴다.
eq("0표는 null", calculateRating(0, 0), null);
eq("소표본 10개 90% → 50점으로 끌림", calculateRating(9, 1), 70.57);
eq("표본 500개 80% → 75.38 (보정 15%)", calculateRating(400, 100), 75.38);
eq("표본 5000개 70% → 68.46", calculateRating(3500, 1500), 68.46);
eq("표본 10000개 90% → 87.5", calculateRating(9000, 1000), 87.5);
check("표본이 커질수록 원본에 수렴",
  calculateRating(9000, 1000) - 90 > calculateRating(400, 100) - 80);
check("긍정률 높을수록 보정값도 높다",
  calculateRating(9500, 500) > calculateRating(5000, 500));

/* ---------- 픽스처 기반 행 파싱 ---------- */
console.log("\nparseResultsHtml (실제 응답 픽스처)");
const html = readFileSync(FIXTURE, "utf8");
const parsed = parseResultsHtml(html);

check("행을 인식했다", parsed.rowsDetected > 0, "rowsDetected=" + parsed.rowsDetected);
eq("제목이 없는 행 없음", parsed.rowsWithoutTitle, 0);
check("행 수 = 파싱 수", parsed.games.length === parsed.rowsDetected,
  "detected=" + parsed.rowsDetected + " parsed=" + parsed.games.length);

const first = parsed.games[0];
check("appId 존재", Boolean(first && first.i), JSON.stringify(first));
check("이름 존재", Boolean(first && first.n), JSON.stringify(first));
check("할인율 숫자", Boolean(first && first.d > 0), String(first && first.d));
check("이미지 URL이 store_item_assets 형태",
  Boolean(first && /store_item_assets\/steam\/apps\/\d+\//.test(first.imageUrl || "")),
  String(first && first.imageUrl));
check("리뷰 수가 숫자", Boolean(first && Number.isFinite(first.c)), String(first && first.c));
check("원본 긍정률 존재", Boolean(first && Number.isFinite(first.rawRating)),
  String(first && first.rawRating));

/* ---------- toCompact ---------- */
console.log("\ntoCompact (평점 하한 0 / 폴백 리뷰 500 이상)");
const compact = toCompact(parsed.games);
check("필터 통과 게임이 있다", compact.length > 0, "n=" + compact.length);
check("모두 할인율 양수", compact.every((g) => g.d > 0), "무료 게임 있음");
check("모두 보정 평점을 갖는다", compact.every((g) => Number.isFinite(g.r)), "r 누락 있음");
// i,n,d,r,c,o,s,g = 8개. 최초 발견일(f)은 main()에서 나중에 붙는다.
check("필드 8개만 저장", compact.every((g) => Object.keys(g).length === 8),
  JSON.stringify(Object.keys(compact[0] || {})));
check("원본 긍정률은 저장하지 않는다", compact.every((g) => g.p === undefined));

// 보정값은 원본과 다르며, 표본이 클수록 원본에 수렴한다
{
  const mk = (p, c) => toCompact([{ i: "1", n: "x", d: 10, rawRating: p, c,
    originalPrice: "10", salePrice: "5", imageUrl: "" }])[0];
  const small = mk(97, 509);
  const big = mk(90, 100000);
  check("리뷰 509개 97% → 보정 89.9%", small && small.r === 89.9, String(small && small.r));
  check("리뷰 10만개 90% → 보정 88.8%", big && big.r === 88.8, String(big && big.r));
  check("같은 80% 면 표본이 클수록 보정값이 높다",
    mk(80, 100000).r > mk(80, 500).r, mk(80, 500).r + " vs " + mk(80, 100000).r);
}

// MIN_REVIEWS 는 폴백(전체 언어) 게임에만 적용되어야 한다.
// 한국어 기준 리뷰가 500 미만이어도 Steam이 한국어 평가를 집계한 것이므로 유지한다.
{
  const base = { d: 10, rawRating: 90, originalPrice: "10", salePrice: "5", imageUrl: "" };
  const keepKo = toCompact([{ ...base, i: "ko-small", n: "ko", c: 206, korean: true }]);
  eq("한국어 리뷰 206개는 유지", keepKo.length, 1);
  eq("한국어 리뷰 수를 그대로 저장", keepKo[0] && keepKo[0].c, 206);

  const tinyKo = toCompact([{ ...base, i: "ko-tiny", n: "ko", c: 15, korean: true }]);
  eq("한국어 리뷰 15개도 유지", tinyKo.length, 1);

  const dropFb = toCompact([{ ...base, i: "fb-small", n: "fb", c: 499, korean: false }]);
  eq("폴백 게임 499개는 제외", dropFb.length, 0);

  const keepFb = toCompact([{ ...base, i: "fb-big", n: "fb", c: 500, korean: false }]);
  eq("폴백 게임 500개는 유지", keepFb.length, 1);
  eq("폴백 게임은 c=0 으로 저장", keepFb[0] && keepFb[0].c, 0);
}

// 이미지 상대경로. 해시 디렉터리는 있을 수도 없을 수도 있다.
//   해시 있음  40hex/capsule_231x87.jpg
//   해시 없음  capsule_231x87.jpg
// 파일명은 _koreana, _alt_assets_N 등 다양하므로 보존해야 한다.
const relOk = compact.filter((g) => g.g !== null);
check("대부분에 이미지 경로가 있다", relOk.length / compact.length > 0.9,
  (relOk.length / compact.length * 100).toFixed(1) + "%");
check("상대경로는 쿼리 없이 끝난다", relOk.every((g) => !/[?]/.test(g.g)));
check("상대경로에 조각(#)이 없다", relOk.every((g) => !/#/.test(g.g)));
check("상대경로는 .jpg로 끝난다", relOk.every((g) => /\.jpg$/.test(g.g)),
  relOk.find((g) => !/\.jpg$/.test(g.g))?.g);
const hashed = relOk.filter((g) => /^[0-9a-f]{40}\//.test(g.g));
const plain = relOk.filter((g) => /^[0-9a-f]{40}\//.test(g.g) === false);
console.log("     해시 있음 " + hashed.length + " / 해시 없음 " + plain.length);
console.log("     예시(해시) " + (hashed[0] ? hashed[0].g : "-"));
console.log("     예시(일반) " + (plain[0] ? plain[0].g : "-"));

/* ---------- 필드 유효도 (health) ---------- */
// 2026-11 사고: 세일 목록 뒤쪽 페이지는 리뷰가 하나도 없는 게임뿐이라
// <div class="search_reviewscore"> 가 비어 있다. 예전에는 전체 행을 분모로
// 써서 정상 실행도 79.5% 로 떨어졌고, 발행이 중단됐다.
// 리뷰 필드는 '툴팁이 있는 행'에서만 재야 한다.
console.log("\nmeasureHealth (리뷰 없는 행은 분모에서 제외)");
{
  const stripped = parseResultsHtml(
    html.replace(/<span class="search_review_summary[\s\S]*?<\/span>/g, "")
  );
  eq("리뷰 툴팁을 지워도 행은 그대로", stripped.games.length, parsed.games.length);
  eq("툴팁이 있는 행 0개", stripped.games.filter((g) => g.hasReviewTooltip).length, 0);

  const h = measureHealth(stripped.games);
  eq("구조 필드(할인율)는 100%", h.d, 1);
  eq("구조 필드(제목)는 100%", h.n, 1);
  eq("리뷰 없는 페이지만 있어도 health 100%", averageHealth([h]), 1);

  // 실제 실행은 정상 페이지 + 리뷰 없는 페이지의 평균이므로 100% 근처여야 한다.
  const mixed = averageHealth([measureHealth(parsed.games), h]);
  check("정상 페이지와 섞여도 99% 이상", mixed > 0.99, (mixed * 100).toFixed(1) + "%");

  // 툴팁 문구 형식이 바뀌면(마크업 변경) 리뷰 필드가 0 이 되어 잡힌다.
  const drift = parseResultsHtml(
    html.replace(/data-tooltip-html="[^"]*"/g, 'data-tooltip-html="평가 정보 없음"')
  );
  const bad = measureHealth(drift.games);
  eq("툴팁 존재는 그대로 인식", bad.reviewed, parsed.games.length);
  eq("문구가 바뀌면 리뷰 수 파싱 0", bad.c, 0);
  eq("문구가 바뀌면 긍정률 파싱 0", bad.rawRating, 0);
  check("그때 health 는 하한 아래로 떨어진다",
    averageHealth([bad]) < 0.8, (averageHealth([bad]) * 100).toFixed(1) + "%");
}

/* ---------- 발행 안전장치 ---------- */
console.log("\nassertPublishable");
{
  const many = (n) => Array.from({ length: n }, (_, k) => ({
    i: String(k), n: "g" + k, d: 10, c: 1000, rawRating: 90,
  }));
  const ok = { games: many(600), health: 1, pagesFetched: 10, pagesFailed: 0,
    fullRun: true, headReviewRatio: 0.98 };
  const err = (result) => {
    try { assertPublishable(result, 500); return null; } catch (e) { return e.message; }
  };

  eq("정상 결과는 통과", err(ok), null);
  check("리뷰 툴팁 인식률이 무너지면 중단",
    /리뷰 툴팁/.test(err({ ...ok, headReviewRatio: 0.1 }) || ""), String(err({ ...ok, headReviewRatio: 0.1 })));
  check("게임 수가 급감하면 중단", Boolean(err({ ...ok, games: many(400), headReviewRatio: 1 })));
  check("health 가 낮으면 중단", Boolean(err({ ...ok, health: 0.5 })));
}

/* ---------- rankForEmail ---------- */
console.log("\nrankForEmail (리뷰 수 내림차순 → 보정 평점 내림차순)");
// 리뷰 수가 가장 많은 게임이 먼저 온다.
const ranked = rankForEmail([
  { i: "small-perfect", r: 87.5, c: 100 },
  { i: "big-good", r: 93.7, c: 20000 },
  { i: "mid", r: 94.6, c: 3000 },
]);
const order = ranked.map((g) => g.i);
eq("리뷰 2만개가 1위", order[0], "big-good");
eq("리뷰 3천개가 2위", order[1], "mid");
eq("리뷰 100개가 꼴찌", order[order.length - 1], "small-perfect");

// 리뷰 수가 같으면 보정 평점이 높은 쪽이 먼저
const tie = rankForEmail([
  { i: "a", r: 90, c: 20000 },
  { i: "b", r: 95, c: 20000 },
]);
eq("동점이면 보정 평점 우선", tie[0].i, "b");

eq("100건이 그대로 유지된다", rankForEmail(
  Array.from({ length: 100 }, (_, k) => ({ i: String(k), r: 100, c: 100000 - k }))
).length, 100);

/* ---------- 결과 ---------- */
console.log("\n통과 " + passed + ", 실패 " + failed);
if (failed > 0) {
  console.error("\n실패한 항목을 확인하세요. Steam 마크업이 바뀌었을 수 있습니다.");
  process.exit(1);
}
console.log("모든 테스트 통과");
