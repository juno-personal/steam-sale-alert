// 화면 상태 표시 + 초기값 세팅.

import { state } from "./state.js";
import { el } from "./elements.js";
import { RANGES } from "./config.js";
import { toPct, sliderMax } from "./range.js";
import { saveFilters } from "./storage.js";
import { renderReset } from "./rendering.js";
import { money } from "./format.js";

/** 헤더 정보 표시 */
export function header() {
  const s = state.data.stats || {};
  const cur = state.data.currency || "";
  el.stats.innerHTML =
    "진행 중 <b>" + (s.total || 0).toLocaleString("ko-KR") + "</b>개" +
    " · 오늘 신규 <b>" + (s.newToday || 0).toLocaleString("ko-KR") + "</b>개" +
    " · 리뷰 1만+ <b>" + (s.reviews10kPlus || 0).toLocaleString("ko-KR") + "</b>개";
  el.stamp.textContent =
    "수집 " + state.data.scrapedAt.replace("T", " ").replace(/\..*$/, " UTC") +
    " · 가격 통화 " + cur;
  el.footSub.textContent =
    "데이터 수집 " + state.data.scrapedAt.slice(0, 10) + " 기준. 할인 종료일은 제공되지 않습니다.";
}

/**
 * 가격 상한 보정: 실제 최댓값 기준으로 price 범위 상한을 갱신한다.
 * 상한을 실제 최댓값으로 쓰지 않고 98퍼센타일로 자르면
 * 비싼 게임들이 조용히 화면에서 사라진다.
 */
export function calibratePrice() {
  // 범위형 필터가 제거되어 가격 상한 보정이 필요 없다.
  if (!el.priceMin) return;
  const prices = state.list.map((g) => g.s).sort((a, b) => a - b);
  if (!prices.length) return;
  const max = Math.max(10, Math.ceil(prices[prices.length - 1]));
  RANGES.price.hi = max;
  state.priceMax = max;

  const full = sliderMax("price");
  el.priceMin.max = String(full);
  el.priceMax.max = String(full);
  el.priceMin.value = "0";
  el.priceMax.value = String(full);

  const priceTicks = document.querySelector('[data-ticks="price"]');
  if (priceTicks) {
    priceTicks.innerHTML = "";
    addTick(priceTicks, 0, "0");
    addTick(priceTicks, Math.round(max * 0.25), money(Math.round(max * 0.25)));
    addTick(priceTicks, Math.round(max * 0.5), money(Math.round(max * 0.5)));
    addTick(priceTicks, Math.round(max * 0.75), money(Math.round(max * 0.75)));
    addTick(priceTicks, max, money(max));
  }

  layoutTicks();
}

/** 눈금 span 생성 */
export function addTick(container, value, label) {
  const s = document.createElement("span");
  s.setAttribute("data-v", String(value));
  s.textContent = label;
  container.appendChild(s);
}

/** 눈금 위치 보정 (백분율 기반) */
export function layoutTicks() {
  document.querySelectorAll("[data-ticks]").forEach((box) => {
    const key = box.getAttribute("data-ticks");
    if (!RANGES[key]) return;
    box.querySelectorAll("span[data-v]").forEach((s) => {
      s.style.left = toPct(key, Number(s.getAttribute("data-v"))) + "%";
    });
  });
}
