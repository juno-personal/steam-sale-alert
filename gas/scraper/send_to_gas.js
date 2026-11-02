/**
 * 수집 결과의 알림 블록을 Google Apps Script Web App으로 전송합니다.
 *
 * GitHub Actions에서 실행:
 *   node scraper/send_to_gas.js --games games.json
 *
 * 전체 게임 목록(~1.3MB)이 아니라 스크래퍼가 이미 골라낸
 * 상위 40건과 요약 통계만 전달합니다.
 *
 * 필수 환경 변수:
 *   GAS_WEBAPP_URL - /exec로 끝나는 GAS Web App URL
 *   GAS_TOKEN      - GAS의 SHARED_TOKEN과 같은 값
 */

import { readFile } from "node:fs/promises";
import process from "node:process";
import minimist from "minimist";

const args = minimist(process.argv.slice(2));
const gamesFile = String(args.games || "games.json");
const force = !!args.force;
const webAppUrl = String(process.env.GAS_WEBAPP_URL || "").trim();
const token = String(process.env.GAS_TOKEN || "").trim();

if (!webAppUrl || !token) {
  console.error("[send] GAS_WEBAPP_URL 또는 GAS_TOKEN 환경 변수가 없습니다.");
  process.exit(1);
}

if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\/?$/.test(webAppUrl)) {
  console.error("[send] 올바른 GAS /exec URL이 아닙니다: " + webAppUrl);
  process.exit(1);
}

let payload;
try {
  const source = JSON.parse(await readFile(gamesFile, "utf8"));
  const notify = source.notify || {};
  const top = Array.isArray(notify.top) ? notify.top : [];

  payload = {
    token: token,
    scrapedAt: source.scrapedAt || new Date().toISOString(),
    sourceUrl: source.sourceUrl || null,
    stats: {
      total: Number(source.stats?.total) || 0,
      newToday: Number(source.stats?.newToday) || 0,
      reviews10kPlus: Number(source.stats?.reviews10kPlus) || 0,
    },
    notify: {
      newCount: Number(notify.newCount) || 0,
      forced: !!notify.forced,
      top: top,
    },
  };
} catch (error) {
  console.error("[send] games.json 읽기 실패: " + error.message);
  process.exit(1);
}

if (payload.notify.top.length === 0) {
  console.log("[send] 보낼 게임이 없습니다. GAS 전송을 생략합니다.");
  process.exit(0);
}

console.log(`[send] 신규 ${payload.notify.newCount}건 중 상위 ${payload.notify.top.length}건을 GAS로 전송합니다.`);
console.log(`[send] 대상: ${new URL(webAppUrl).origin}`);

try {
  const response = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  console.log(`[send] GAS HTTP ${response.status}: ${responseText}`);

  if (!response.ok) process.exit(2);

  // GAS가 200을 주어도 ok:false일 수 있으므로 본문을 확인한다.
  try {
    const parsed = JSON.parse(responseText);
    if (parsed && parsed.ok === false) {
      console.error("[send] GAS가 실패를 보고했습니다.");
      process.exit(3);
    }
  } catch {
    // JSON이 아니면 그대로 통과시킨다
  }
} catch (error) {
  console.error("[send] GAS 전송 실패: " + error.message);
  process.exit(1);
}
