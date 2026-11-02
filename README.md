# Steam Sale Alert — 웹 앱

GitHub Pages로 배포되는 정적 앱입니다. 빌드 단계 없이 `index.html` + `games.json`으로 동작합니다.

- URL: https://lostempus06-eng.github.io/steam-sale-alert-site/
- 원본: https://github.com/lostempus06-eng/steam-sale-alert-site

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 앱 셸 |
| `style.css` | Steam 계열 다크 블루 테마 |
| `app.js` | 필터 · 정렬 · 점진 렌더링 · PWA 등록 |
| `manifest.json` | PWA 매니페스트 |
| `sw.js` | 서비스 워커 (앱 셸 캐시, `games.json`은 네트워크 우선) |
| `games.json` | 수집 데이터. **비공개 저장소가 자동 갱신한다.** |
| `icons/` | PWA 아이콘 |
| `tools/make-icons.mjs` | 아이콘 재생성 (`node tools/make-icons.mjs`) |

## games.json 스키마

```jsonc
{
  "scrapedAt": "2026-10-04T02:19:18.471Z",
  "currency": "AED",
  "imgPrefix": "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/",
  "stats": { "total": 2342, "newToday": 249, "reviews10kPlus": 353 },
  "games": [
    {
      "i": "1304930",   // appId
      "n": "게임 이름",
      "d": 90,          // 할인율 %
      "r": 83,          // 표본 보정 평점 (0~100, 소수 1자리)
      "c": 784,         // 리뷰 수
      "o": 105,         // 기존가 (AED)
      "s": 10.5,        // 할인가 (AED)
      "g": "115ccc74…/capsule_231x87_alt_assets_3.jpg",  // 이미지 상대경로
      "f": "2026-10-03" // 최초 발견일
    }
  ]
}
```

이미지 URL은 `imgPrefix + i + "/" + g`로 복원합니다.
상대경로 `g`에는 해시 디렉터리가 **있을 수도 없을 수도 있습니다.**

```
해시 있음   115ccc74cf2a3951184659a5f953c8db1a48e499/capsule_231x87.jpg
해시 없음   capsule_231x87.jpg
```

파일명은 `capsule_231x87_koreana.jpg`, `capsule_231x87_alt_assets_3.jpg` 등 다양하므로
없애지 말고 그대로 저장합니다. 한 게임당 약 150바이트입니다.

`r`은 Steam 이 그대로 보여주는 긍정 비율이 아니라 **표본 보정값**입니다.

```
Rating = ReviewScore - (ReviewScore - 0.5) × 2^(-log10(TotalReviews + 1))
```

작은 표본을 50점으로 끌어당겨 신뢰도를 반영합니다. 리뷰 509개에 97%면
보정 후 89.9% 로 표시됩니다. 앱 표시·필터·정렬과 메일 상위 40개 선정이
전부 이 값을 쓰므로, 앱 정렬 결과와 메일 순위가 어긋나지 않습니다.

`f < scrapedAt`인 게임은 이전 수집본이므로 "이미 본 게임 숨기기"로 걸러집니다.

## 필터

숫자 필터는 최소/최대 쌍이다. 한쪽만 지정하면 `80%+`, 양쪽을 지정하면 `70%~90%`
형태로 표시되고 여러 조건은 교차한다. 좁은 화면(≤860px)에서는 필터가 접혀서
현재 조건이 한 줄로 보인다.

| 필터 | 스케일 | 붙는 단위 |
|---|---|---|
| 가격대 | 선형, 상한은 데이터의 실제 최댓값 | 1 AED |
| 할인율 | 선형 0~95% | 5% |
| 평점 | 선형 0~100% | 5% |
| 리뷰 수 | 로그 500~1,000,000 | 로그 정지점 |

리뷰 수는 선형으로 하면 저역(500~10K)이 한 자리에 몰리므로 로그 스케일로
매핑한다. 눈금(500 / 1K / 5K / 10K / 30K / 100K / 1M+)은 실제 값의 좌표에
배치한다. 균등 배치를 쓰면 로그 스케일에서 전부 어긋난다.

썸을 직접 구현하면서 `input.step` 이 무시되므로 스냅은 `app.js` 에서 직접
 맞춘다. 스냅된 실제 값은 `state.ranges` 에 있고, input 은 위치를 보여주는
거울일 뿐이다. 로그 스케일에서 정수 위치로 되돌리면 30000 이 30306 이 되어
정지점을 잃기 때문이다.

가격 슬라이더 상한을 98퍼센타일 같은 값으로 자르면 값이 비싼 게임이
핸들이 닿지 않아 조용히 사라진다. 실제 최댓값을 써야 "전체"가 truthful하다.

## 데이터 갱신

비공개 저장소 `steamdb-sale-alert`의 워크플로가 수집 후 이 저장소로
`games.json`만 푸시합니다. 이 푸시를 감지해 `pages.yml`이 자동 배포합니다.

앱 파일을 직접 고치는 것도 이 공개 저장소에서 하면 됩니다.

## 주의

- 평점/리뷰수 기준선(리뷰 500 이상)은 스크래퍼에 있습니다. 여기서 기준을 낮추면
  앱의 평점·리뷰수 필터 범위가 함께 좁아집니다.
- 할인 종료일을 제공하지 않습니다. `games.json`은 수집 시점의 스냅샷입니다.
