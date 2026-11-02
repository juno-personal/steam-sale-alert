// 필터링 + 정렬.

import { state } from "./state.js";
import { el } from "./elements.js";
import { RANGES } from "./config.js";
import { readFilters } from "./storage.js";

/**
 * 필터 적용 + 정렬.
 * @returns {Array} 조건에 맞는 게임 배열 (정렬됨)
 */
export function apply() {
  const f = readFilters();
  const out = [];

  for (let i = 0; i < state.list.length; i++) {
    const g = state.list[i];
    if (g.s < f.priceMin || g.s > f.priceMax) continue;
    if (g.d < f.discountMin || g.d > f.discountMax) continue;
    if (g.r < f.ratingMin || g.r > f.ratingMax) continue;
    if (g.c < f.reviewsMin || g.c > f.reviewsMax) continue;
    if (f.hideSeen && g.f < state.dataDate) continue;
    if (f.q && g.n.toLowerCase().indexOf(f.q) === -1) continue;
    out.push(g);
  }

  const dir = f.sort === "price-desc" ? -1 : 1;
  switch (f.sort) {
    case "price-asc":
      out.sort((a, b) => (a.s - b.s) * dir || a.c - b.c || (a.i < b.i ? -1 : 1));
      break;
    case "discount-desc":
      out.sort((a, b) => b.d - a.d || b.r - a.r || (a.i < b.i ? -1 : 1));
      break;
    case "rating-desc":
      out.sort((a, b) => b.r - a.r || b.c - a.c || (a.i < b.i ? -1 : 1));
      break;
    case "reviews-desc":
      out.sort((a, b) => b.c - a.c || b.r - a.r || (a.i < b.i ? -1 : 1));
      break;
    case "name-asc":
      out.sort((a, b) => a.n.localeCompare(b.n, "ko") || (a.i < b.i ? -1 : 1));
      break;
    default:
      break;
  }
  return out;
}
