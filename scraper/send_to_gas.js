/**
 * SteamDB Sale Scraper → GAS Web App POST
 * 
 * 사용법:
 *   node send_to_gas.js --token SHARED_TOKEN --games games.json
 * 
 * 필수 Script Properties (GAS):
 *   SHARED_TOKEN    - GitHub Actions와 공유하는 인증 토큰
 *   GAS_WEBAPP_URL  - 웹앱 /exec URL
 */

import { } from "node:fs";
import UrlFetchApp from "UrlFetchApp";

const args = require("minimist")(process.argv.slice(2));

if (!args.token || !args.games) {
  console.error("Usage: node send_to_gas.js --token <TOKEN> --games <GAMES_JSON>");
  process.exit(1);
}

const token = args.token;
const gamesData = JSON.parse(require("fs").readFileSync(args.games, "utf8"));
const games = gamesData.games || [];

const webappUrl = PropertiesService.getScriptProperties().getProperty("GAS_WEBAPP_URL");

const payload = JSON.stringify({
  token: token,
  games: games,
  sourceUrl: gamesData.sourceUrl,
});

console.log(`POSTing ${games.length} games to GAS...`);

const options = {
  method: "post",
  contentType: "application/json",
  payload: payload,
  muteHttpExceptions: true,
};

try {
  const response = UrlFetchApp.fetch(webappUrl, options);
  const code = response.getResponseCode();
  console.log("GAS 응답 코드: " + code);
  
  if (code === 200 || code === 204) {
    console.log("성공: GAS로 데이터 전송 완료");
  } else {
    const respText = response.getContentText();
    console.warn("경고: HTTP " + code + " - " + (respText || "no response"));
  }
} catch (error) {
  console.error("GAS 전송 오류: " + error.message);
  process.exit(1);
}