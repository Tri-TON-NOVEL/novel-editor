// オフラインでも起動できるよう、アプリ本体をキャッシュする。
// ファイルを更新したら VERSION を上げる。
const VERSION = 'v3';
const CACHE = 'novel-editor-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/db.js',
  'js/format.js',
  'js/localfile.js',
  'js/notation.js',
  'js/providers/index.js',
  'js/providers/gdrive.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('novel-editor-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同じサイトのファイルだけ扱う。ネットにつながれば最新版、つながらなければキャッシュ。
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
