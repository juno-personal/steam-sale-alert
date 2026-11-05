// 출력 라벨 + 필터 요약.

import { state } from "./state.js";
import { el } from "./elements.js";
import { RANGES } from "./config.js";
import { readFilters } from "./storage.js";
import { toPct, snapValue } from "./range.js";
import { fullRange } from "./range.js";
import { compact } from "./utils.js";
import { money } from "./format.js";

/** 단일 필터의 조건 텍스트 (예: "5,000~10,000 원") */
function rangeText(key, f) {
  const r = RANGES[key];
  const lo = f[key + "Min"];
  const hi = f[key + "Max"];

  const fmt = (key === "price") ? money
    : (key === "reviews") ? compact
    : (v) => v + "%";

  const atLo = key === "price" ? lo <= r.lo : lo <= r.lo;
  const atHi = key === "price" ? hi >= r.hi : hi >= r.hi;

  if (atLo && atHi) return "전체";
  if (atLo) return "≤ " + fmt(Math.round(hi * 100) / 100);
  if (atHi) return fmt(Math.round(lo * 100) / 100) + "+";
  return fmt(Math.round(lo * 100) / 100) + "~" + fmt(Math.round(hi * 100) / 100);
}

/** 필터 조건 라벨 갱신 (범위 필터 제거됨) */
export function updateLabels() {
  updateSummary();
}

/** 필터 요약 (접힌 상태 한 줄) */
export function updateSummary(f) {
  f = f || readFilters();
  const parts = [];
  if (f.q) parts.push("'" + f.q + "'");
  if (f.hideSeen) parts.push("본 것 숨김");
  if (f.hideNoReview) parts.push("한글 리뷰 없음 숨김");
  if (el.filterSummary) el.filterSummary.textContent = parts.length ? parts.join(" · ") : "전체";
}
