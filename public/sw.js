/*
 * SGBusNavi — Service Worker
 *
 * キャッシュ戦略:
 * - 静的アセット（HTML/CSS/JS/アイコン等）: cache-first
 *   一度取得したら高速表示を優先し、更新はCACHE_VERSIONを上げてデプロイすることで反映する。
 * - /api/* （LTA DataMallプロキシ）: 必ずnetwork-only
 *   バス到着時刻はリアルタイム性が命であり、キャッシュして古いデータを返すと
 *   実用上有害なため、Service Workerでは一切キャッシュしない（plan.md 第10節参照）。
 *
 * キャッシュのバージョニング:
 * - CACHE_VERSION を含めたキャッシュ名を使うことで、activate時に
 *   古いバージョンのキャッシュを破棄できるようにしている。
 *   静的アセットを更新した際はこの値をインクリメントすること。
 */

const CACHE_VERSION = 'v152';
const CACHE_NAME = `sgbusnavi-static-${CACHE_VERSION}`;

// プリキャッシュする静的アセット（アプリシェル）
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/qrcode-generator.js',
  '/manifest.json',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-144.png',
  '/icons/icon-152.png',
  '/icons/icon-192.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-384.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name.startsWith('sgbusnavi-static-') && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 同一オリジン以外（外部CDN等）はService Workerを介さずそのままブラウザに任せる。
  // フェーズ3-B（目的地登録）で導入したLeaflet本体（unpkg.com）・OSMタイル
  // （*.tile.openstreetmap.org）もここで除外され、Service Workerには一切
  // キャッシュされない（ブラウザの標準HTTPキャッシュのみに依存する）。
  // オフライン時はタイル画像が読み込めず地図が真っ白になるが、Leaflet側で
  // 個別タイルのエラーとして処理されるため、アプリ全体が落ちることはない
  // （plan.md 12節ステップ8の許容範囲内）。
  if (url.origin !== self.location.origin) {
    return;
  }

  // /api/* は必ずnetwork-only。バス到着時刻のリアルタイム性を守るため
  // Service Workerでは一切キャッシュしない。
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // GET以外（POST等）はキャッシュ対象外
  if (request.method !== 'GET') {
    return;
  }

  // 静的アセット: cache-first、キャッシュになければネットワーク取得しキャッシュに追加
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => {
          // オフライン時、ナビゲーションリクエストはアプリシェル(index.html)にフォールバック
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return undefined;
        });
    })
  );
});
