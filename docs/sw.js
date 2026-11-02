/* Steam Sale Alert - 서비스 워커
 *
 * 갱신 전략: 네트워크 우선, 실패하면 캐시로 대체.
 *
 * 캐시 우선(cache-first)으로 두면 한 번이라도 방문한 브라우저가
 * 갱신된 앱을 영원히 못 볼 수 있다. 실제로 그랬다. 썸이 둘이
 * 필요해서 배포했는데도 옛 파일을 서빙해 썸이 하나만 보였다.
 * Ctrl+F5 (SW 우회) 로만 고쳐지는 상태였다.
 *
 * 셸 파일은 30KB 미만이라 네트워크 우선의 비용이 크지 않다.
 * 오프라인에서는 마지막 캐시를 쓴다.
 */
var CACHE = "ssa-v2";

var SHELL_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 하나가 실패해도 설치가 죽지 않도록 개별 처리
      return Promise.all(SHELL_FILES.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // 이전 세대 캐시(ssa-shell-v1, ssa-data-v1 등)를 모두 지운다
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  // Steam CDN 등 외부 요청은 그대로 통과시킨다
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      // 오프라인: 마지막 캐시를 쓴다
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (url.pathname.indexOf("/games.json") !== -1) {
          return new Response('{"games":[],"stats":{"total":0}}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("offline", { status: 503 });
      });
    })
  );
});
