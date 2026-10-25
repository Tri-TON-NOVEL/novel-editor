// オフラインでも起動できるよう、アプリ本体をキャッシュする。
// ファイルを更新したら VERSION を上げる。
const VERSION = 'v76';
const CACHE = 'novel-editor-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-32.png',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/app.js',
  'js/db.js',
  'js/format.js',
  'js/localfile.js',
  'js/notation.js',
  'js/tables.js',
  'js/backup.js',
  'js/sync.js',
  'js/importer.js',
  'js/importui.js',
  'js/dialogs.js',
  'js/providers/index.js',
  'js/providers/gdrive.js',
  'js/providers/onedrive.js',
];

self.addEventListener('install', (e) => {
  // ブラウザ自身のキャッシュを通さず、必ずサーバーから最新を取る
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('novel-editor-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同じサイトのファイルだけ扱う。ネットにつながれば最新版、つながらなければキャッシュ。
// ブラウザのキャッシュ（GitHub Pages は10分ほど保持される）に古い JS が残り、
// 画面だけ新しく処理が古い、という食い違いが起きないよう、毎回サーバーに確認する（cache: 'no-cache'）。
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
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
