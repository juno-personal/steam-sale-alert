/* 실제 Steam 응답에서 행 3개를 잘라 픽스처로 저장한다.
 *   node tools/make-fixture.mjs
 *
 * selftest.mjs가 이 파일을 대조한다. 마크업이 바뀌면 여기서 갱신해야 한다.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const U =
  "https://store.steampowered.com/search/results" +
  "?force_infinite=1&hwtype=0&l=korean&cc=ae&untags=9130" +
  "&category1=998&specials=1&ndl=1&infinite=1&start=0&count=100";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "scraper", "fixtures");

const res = await fetch(U, {
  headers: {
    "User-Agent": UA,
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://store.steampowered.com/search/",
  },
});
if (!res.ok) throw new Error("HTTP " + res.status);
const data = await res.json();

// 행 시작을 기준으로 앞에서 3행만 잘라낸다.
const ROW_SPLIT = /(?=<a\b[^>]*data-ds-appid="\d+")/;
const parts = data.results_html.split(ROW_SPLIT);
const keep = parts.slice(0, 4).join("");
// 잘라내며 잘린 태그를 정리한다
const closed = keep
  .replace(/<\/a>(?![\s\S]*<\/a>)/g, "")
  .concat("\n</body></html>\n");

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, "search-results.html");
writeFileSync(file, closed, "utf8");

const rows = (closed.match(/data-ds-appid="/g) || []).length;
console.log(`${file}`);
console.log(`  ${rows}행, ${closed.length} bytes`);
console.log(`  (원본 ${parts.length - 1}행 중 앞 3행 사용)`);
