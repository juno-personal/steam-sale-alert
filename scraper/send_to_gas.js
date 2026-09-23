/**
 * SteamDB 수집 결과를 Google Apps Script Web App으로 전송합니다.
 *
 * GitHub Actions에서 실행:
 *   node scraper/send_to_gas.js --games games.json
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
  payload = {
    token: token,
    sourceUrl: source.sourceUrl || null,
    scrapedAt: source.scrapedAt || new Date().toISOString(),
    games: Array.isArray(source.games) ? source.games : [],
  };
} catch (error) {
  console.error("[send] games.json 읽기 실패: " + error.message);
  process.exit(1);
}

console.log(`[send] 게임 ${payload.games.length}개를 GAS로 전송합니다.`);
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
} catch (error) {
  console.error("[send] GAS 전송 실패: " + error.message);
  process.exit(1);
}
