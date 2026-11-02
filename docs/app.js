// Steam Sale Alert - 앱 로직 (ES 모듈 진입점)

import { state } from "./state.js";
import { el } from "./elements.js";
import { RANGES } from "./config.js";
import { buildThumbsAll, fullRange } from "./range.js";
import { loadFilters, saveFilters } from "./storage.js";
import { updateLabels, updateSummary } from "./ui_labels.js";
import { header, calibratePrice } from "./ui.js";
import { bind, setupInstall, setupSW } from "./ui_events.js";
import { render, renderReset } from "./rendering.js";
import { apply } from "./filtering.js";

/** 앱 초기화 */
export function boot(data) {
  state.data = data;
  state.dataDate = (data.scrapedAt || "").slice(0, 10);
  state.list = data.games || [];

  // 가격 상한을 먼저 정한 뒤에 저장된 필터를 복원해야 한다.
  // 순서가 바뀌면 priceMin/max 의 max 가 아직 0 이어서 복원값이 깨진다.
  calibratePrice();

  // 범위 상태 초기화
  Object.keys(RANGES).forEach((key) => {
    state.ranges[key] = fullRange(key);
  });

  buildThumbsAll();
  loadFilters();
  updateLabels();
  header();
  bind();
  renderReset();
  setupInstall();
  setupSW();
}

function fail(msg) {
  el.count.innerHTML = "";
  el.empty.hidden = false;
  el.empty.textContent = msg;
  el.stats.textContent = "";
}

// games.json 로딩 + 앱 시작
fetch("games.json", { cache: "no-cache" })
  .then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  })
  .then(boot)
  .catch((e) => {
    fail("games.json을 불러오지 못했습니다 (" + e.message + "). 수집 작업이 아직 실행되지 않았을 수 있습니다.");
  });
