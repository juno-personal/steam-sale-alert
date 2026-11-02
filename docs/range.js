// 범위형 필터 유틸리티.
//   * 내부 교환은 모두 백분율(0~100)로 한다.
//   * 슬라이더 값(0~sliderMax)과 실제 값 사이의 변환은 여기서만 한다.
//   * 할인율은 0~95, 가격은 0~p98 처럼 스케일이 다르기 때문에
//     슬라이더 값을 곧바로 백분율로 쓰면 안 된다.

import { RANGES, LOG_LO, LOG_HI } from "./config.js";
import { state } from "./state.js";
import { el } from "./elements.js";
// 순환 참조이지만 모두 이벤트 핸들러 내부에서만 호출하므로 안전하다.
import { updateLabels } from "./ui_labels.js";
import { saveFilters } from "./storage.js";
import { renderReset } from "./rendering.js";

/** 특정 키의 선형 스케일 상한 ( reviews 는 로그 스케일이라 항상 100 ). */
export function sliderMax(key) {
  return RANGES[key].linear ? Math.max(1, RANGES[key].hi) : 100;
}

/** 백분율 0~100 → 슬라이더 값 (반올림, 문자열 반환) */
export function sliderOf(key, pct) {
  const span = sliderMax(key);
  return String(Math.max(0, Math.min(span, Math.round((pct / 100) * span))));
}

/** 백분율 → 실제 값 */
export function toReal(key, pct) {
  const r = RANGES[key];
  if (r.linear) {
    return r.lo + ((r.hi - r.lo) * pct) / 100;
  }
  return Math.exp(LOG_LO + ((LOG_HI - LOG_LO) * pct) / 100);
}

/** 실제 값 → 백분율 */
export function toPct(key, value) {
  const r = RANGES[key];
  if (r.linear) {
    const span = r.hi - r.lo;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(100, ((value - r.lo) / span) * 100));
  }
  if (value <= r.lo) return 0;
  if (value >= r.hi) return 100;
  return Math.max(0, Math.min(100, ((Math.log(value) - LOG_LO) / (LOG_HI - LOG_LO)) * 100));
}

/** 실제 값을 가장 가까운 스냅 값으로 보정 */
export function snapValue(key, raw) {
  const r = RANGES[key];
  if (r.stops) {
    let best = r.stops[0];
    let bestD = Math.abs(best - raw);
    for (let i = 1; i < r.stops.length; i++) {
      const d = Math.abs(r.stops[i] - raw);
      if (d < bestD) {
        bestD = d;
        best = r.stops[i];
      }
    }
    return best;
  }
  const step = r.snap || 1;
  return Math.max(0, Math.round(raw / step) * step);
}

/** 전체 범위 객체 */
export function fullRange(key) {
  return { lo: RANGES[key].lo, hi: RANGES[key].hi };
}

/** 스냅된 실제 값으로 상태를 설정하고 화면을 갱신한다. */
export function setRangeState(key, lo, hi) {
  let r = RANGES[key];
  let nlo = Math.max(r.lo, Math.min(r.hi, lo));
  let nhi = Math.max(r.lo, Math.min(r.hi, hi));
  if (nlo > nhi) {
    let t = nlo;
    nlo = nhi;
    nhi = t;
  }
  state.ranges[key] = { lo: nlo, hi: nhi };
  paintRange(key);
}

/** 상태 -> 슬라이더 위치 / 채움 / 썸 좌표 */
export function paintRange(key) {
  const p = state.ranges[key];
  const loPct = toPct(key, p.lo);
  const hiPct = toPct(key, p.hi);

  el[key + "Min"].value = sliderOf(key, loPct);
  el[key + "Max"].value = sliderOf(key, hiPct);

  const fill = el[key + "Fill"];
  fill.style.left = loPct + "%";
  fill.style.width = Math.max(0, hiPct - loPct) + "%";

  const track = el[key + "Min"].parentElement;
  const loThumb = track.querySelector(".rng-thumb-lo");
  const hiThumb = track.querySelector(".rng-thumb-hi");
  if (loThumb) loThumb.style.left = loPct + "%";
  if (hiThumb) hiThumb.style.left = hiPct + "%";
}

/** 정렬된 stops 배열에서 value 에 가장 가까운 인덱스를 찾는다. */
export function nearestStop(stops, value) {
  let best = 0;
  let bestD = Math.abs(stops[0] - value);
  for (let i = 1; i < stops.length; i++) {
    const d = Math.abs(stops[i] - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Thumb 요소에 pointer 이벤트를 바인딩하여
 * 마우스/터치가 같은 경로로 동작하게 한다.
 * @param {string} key  필터 키
 * @param {HTMLElement} track  rng-track 요소
 */
export function bindRangePointer(key, track) {
  let active = null; // 현재 끌고 있는 썸 ("Min" | "Max")
  let activeEl = null;
  let applyTimer = null;

  function pctFromEvent(e) {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
  }

  /** 두 썸 중 어느 쪽을 잡을지 정한다. 가까운 쪽, 동률이면 항상 최소 쪽. */
  function pick(pct) {
    const p = state.ranges[key];
    const loPct = toPct(key, p.lo);
    const hiPct = toPct(key, p.hi);
    return Math.abs(pct - loPct) <= Math.abs(pct - hiPct) ? "Min" : "Max";
  }

  /**
   * 썸 위치를 실제 스냅 값으로 바꾼다.
   */
  function apply(pct) {
    const p = state.ranges[key];
    const snapped = snapValue(key, toReal(key, pct));
    if (active === "Min") {
      setRangeState(key, snapped, Math.max(snapped, p.hi));
    } else {
      setRangeState(key, Math.min(snapped, p.lo), snapped);
    }
    updateLabels();
    scheduleApply();
  }

  function scheduleApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      saveFilters();
      renderReset();
    }, 160);
  }

  track.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
    const pct = pctFromEvent(e);
    active = pick(pct);
    activeEl = track.querySelector(active === "Min" ? ".rng-thumb-lo" : ".rng-thumb-hi");
    if (activeEl) activeEl.classList.add("dragging");
    try { track.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    e.preventDefault();
    apply(pct);
  });

  track.addEventListener("pointermove", (e) => {
    if (!active) return;
    e.preventDefault();
    apply(pctFromEvent(e));
  });

  function end(e) {
    if (!active) return;
    if (activeEl) activeEl.classList.remove("dragging");
    active = null;
    activeEl = null;
    try { track.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    saveFilters();
    renderReset();
  }

  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);

  // 키보드 접근성. 한 칸 이동도 스냅 단위를 따른다.
  ["lo", "hi"].forEach((side) => {
    const thumb = track.querySelector(".rng-thumb-" + side);
    if (!thumb) return;
    thumb.addEventListener("keydown", (e) => {
      const which = side === "lo" ? "Min" : "Max";
      const r = RANGES[key];
      const p = state.ranges[key];
      let dir = 0;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") dir = -1;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") dir = 1;
      else if (e.key === "Home" || e.key === "End") dir = 0;
      else return;
      e.preventDefault();

      let cur = which === "Min" ? p.lo : p.hi;
      let next;
      if (r.stops) {
        const i = nearestStop(r.stops, cur);
        const targetIdx = e.key === "Home"
          ? 0
          : e.key === "End"
            ? r.stops.length - 1
            : i + dir;
        const clamped = Math.max(0, Math.min(r.stops.length - 1, targetIdx));
        next = r.stops[clamped];
      } else {
        const unit = r.snap || 1;
        const step = e.shiftKey
          ? Math.max(unit, snapValue(key, (r.hi - r.lo) / 20))
          : unit;
        const to = e.key === "Home" ? r.lo : e.key === "End" ? r.hi : cur + dir * step;
        next = snapValue(key, to);
      }

      if (which === "Min") {
        setRangeState(key, next, Math.max(next, p.hi));
      } else {
        setRangeState(key, Math.min(next, p.lo), next);
      }
      updateLabels();
      saveFilters();
      renderReset();
    });
  });
}

/**
 * 각 rng-track 에 커스텀 썸 2개(.rng-thumb-lo/.rng-thumb-hi)를 만들고
 * pointer 이벤트를 바인딩한다. 네이티브 input 은 CSS 로 숨기고
 * 커스텀 썸이 시각적/조작 인터페이스를 대신한다.
 */
export function buildThumbsAll() {
  Object.keys(RANGES).forEach((key) => {
    const track = el[key + "Min"].parentElement;
    if (!track) return;
    ["lo", "hi"].forEach((side) => {
      if (track.querySelector(".rng-thumb-" + side)) return;
      const thumb = document.createElement("div");
      thumb.className = "rng-thumb rng-thumb-" + side;
      thumb.tabIndex = 0;
      thumb.setAttribute("role", "slider");
      track.appendChild(thumb);
    });
    paintRange(key);
    bindRangePointer(key, track);
  });
}
