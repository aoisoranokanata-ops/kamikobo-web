/* ------------------------------------------------------------
   紙工房 Web — Service Worker（オフラインで開けるようにするだけ）

   GitHub Pages では他の PWA と同じオリジンを共有するため：
   - キャッシュ名は "kamikobo-web-" で始め、消すのは自分の古い版だけ
   - 参照するのも自分のキャッシュだけ（caches.match は使わない）
   - install では cache:'reload' で取得（HTTP キャッシュの旧版を掴まない）
   ネットワーク優先。iPad のホーム画面アプリでは待機中の SW が切り替わらないことがあるので、待機させない。
   ファイルを直したら、下の VERSION と js/util.js の APP_VERSION を必ず上げること。
   ------------------------------------------------------------ */
const VERSION = '1.2.0';
const PREFIX = 'kamikobo-web-';
const CACHE = PREFIX + 'v' + VERSION;
// pdf.js が日本語などの PDF に使う文字の対応表・標準フォント（オフラインでも開けるように最初に取っておく）
const VENDOR_DATA = [
  "78-EUC-H.bcmap", "78-EUC-V.bcmap", "78-H.bcmap", "78-RKSJ-H.bcmap", "78-RKSJ-V.bcmap", "78-V.bcmap", "78ms-RKSJ-H.bcmap", "78ms-RKSJ-V.bcmap", "83pv-RKSJ-H.bcmap", "90ms-RKSJ-H.bcmap", "90ms-RKSJ-V.bcmap", "90msp-RKSJ-H.bcmap", "90msp-RKSJ-V.bcmap", "90pv-RKSJ-H.bcmap", "90pv-RKSJ-V.bcmap", "Add-H.bcmap", "Add-RKSJ-H.bcmap", "Add-RKSJ-V.bcmap", "Add-V.bcmap", "Adobe-CNS1-0.bcmap", "Adobe-CNS1-1.bcmap", "Adobe-CNS1-2.bcmap", "Adobe-CNS1-3.bcmap", "Adobe-CNS1-4.bcmap", "Adobe-CNS1-5.bcmap", "Adobe-CNS1-6.bcmap", "Adobe-CNS1-UCS2.bcmap", "Adobe-GB1-0.bcmap", "Adobe-GB1-1.bcmap", "Adobe-GB1-2.bcmap", "Adobe-GB1-3.bcmap", "Adobe-GB1-4.bcmap", "Adobe-GB1-5.bcmap", "Adobe-GB1-UCS2.bcmap", "Adobe-Japan1-0.bcmap", "Adobe-Japan1-1.bcmap", "Adobe-Japan1-2.bcmap", "Adobe-Japan1-3.bcmap", "Adobe-Japan1-4.bcmap", "Adobe-Japan1-5.bcmap", "Adobe-Japan1-6.bcmap", "Adobe-Japan1-UCS2.bcmap", "Adobe-Korea1-0.bcmap", "Adobe-Korea1-1.bcmap", "Adobe-Korea1-2.bcmap", "Adobe-Korea1-UCS2.bcmap", "B5-H.bcmap", "B5-V.bcmap", "B5pc-H.bcmap", "B5pc-V.bcmap", "CNS-EUC-H.bcmap", "CNS-EUC-V.bcmap", "CNS1-H.bcmap", "CNS1-V.bcmap", "CNS2-H.bcmap", "CNS2-V.bcmap", "ETHK-B5-H.bcmap", "ETHK-B5-V.bcmap", "ETen-B5-H.bcmap", "ETen-B5-V.bcmap", "ETenms-B5-H.bcmap", "ETenms-B5-V.bcmap", "EUC-H.bcmap", "EUC-V.bcmap", "Ext-H.bcmap", "Ext-RKSJ-H.bcmap", "Ext-RKSJ-V.bcmap", "Ext-V.bcmap", "GB-EUC-H.bcmap", "GB-EUC-V.bcmap", "GB-H.bcmap", "GB-V.bcmap", "GBK-EUC-H.bcmap", "GBK-EUC-V.bcmap", "GBK2K-H.bcmap", "GBK2K-V.bcmap", "GBKp-EUC-H.bcmap", "GBKp-EUC-V.bcmap", "GBT-EUC-H.bcmap", "GBT-EUC-V.bcmap", "GBT-H.bcmap", "GBT-V.bcmap", "GBTpc-EUC-H.bcmap", "GBTpc-EUC-V.bcmap", "GBpc-EUC-H.bcmap", "GBpc-EUC-V.bcmap", "H.bcmap", "HKdla-B5-H.bcmap", "HKdla-B5-V.bcmap", "HKdlb-B5-H.bcmap", "HKdlb-B5-V.bcmap", "HKgccs-B5-H.bcmap", "HKgccs-B5-V.bcmap", "HKm314-B5-H.bcmap", "HKm314-B5-V.bcmap", "HKm471-B5-H.bcmap", "HKm471-B5-V.bcmap", "HKscs-B5-H.bcmap", "HKscs-B5-V.bcmap", "Hankaku.bcmap", "Hiragana.bcmap", "KSC-EUC-H.bcmap", "KSC-EUC-V.bcmap", "KSC-H.bcmap", "KSC-Johab-H.bcmap", "KSC-Johab-V.bcmap", "KSC-V.bcmap", "KSCms-UHC-H.bcmap", "KSCms-UHC-HW-H.bcmap", "KSCms-UHC-HW-V.bcmap", "KSCms-UHC-V.bcmap", "KSCpc-EUC-H.bcmap", "KSCpc-EUC-V.bcmap", "Katakana.bcmap", "NWP-H.bcmap", "NWP-V.bcmap", "RKSJ-H.bcmap", "RKSJ-V.bcmap", "Roman.bcmap", "UniCNS-UCS2-H.bcmap", "UniCNS-UCS2-V.bcmap", "UniCNS-UTF16-H.bcmap", "UniCNS-UTF16-V.bcmap", "UniCNS-UTF32-H.bcmap", "UniCNS-UTF32-V.bcmap", "UniCNS-UTF8-H.bcmap", "UniCNS-UTF8-V.bcmap", "UniGB-UCS2-H.bcmap", "UniGB-UCS2-V.bcmap", "UniGB-UTF16-H.bcmap", "UniGB-UTF16-V.bcmap", "UniGB-UTF32-H.bcmap", "UniGB-UTF32-V.bcmap", "UniGB-UTF8-H.bcmap", "UniGB-UTF8-V.bcmap", "UniJIS-UCS2-H.bcmap", "UniJIS-UCS2-HW-H.bcmap", "UniJIS-UCS2-HW-V.bcmap", "UniJIS-UCS2-V.bcmap", "UniJIS-UTF16-H.bcmap", "UniJIS-UTF16-V.bcmap", "UniJIS-UTF32-H.bcmap", "UniJIS-UTF32-V.bcmap", "UniJIS-UTF8-H.bcmap", "UniJIS-UTF8-V.bcmap", "UniJIS2004-UTF16-H.bcmap", "UniJIS2004-UTF16-V.bcmap", "UniJIS2004-UTF32-H.bcmap", "UniJIS2004-UTF32-V.bcmap", "UniJIS2004-UTF8-H.bcmap", "UniJIS2004-UTF8-V.bcmap", "UniJISPro-UCS2-HW-V.bcmap", "UniJISPro-UCS2-V.bcmap", "UniJISPro-UTF8-V.bcmap", "UniJISX0213-UTF32-H.bcmap", "UniJISX0213-UTF32-V.bcmap", "UniJISX02132004-UTF32-H.bcmap", "UniJISX02132004-UTF32-V.bcmap", "UniKS-UCS2-H.bcmap", "UniKS-UCS2-V.bcmap", "UniKS-UTF16-H.bcmap", "UniKS-UTF16-V.bcmap", "UniKS-UTF32-H.bcmap", "UniKS-UTF32-V.bcmap", "UniKS-UTF8-H.bcmap", "UniKS-UTF8-V.bcmap", "V.bcmap", "WP-Symbol.bcmap",
].map((f) => './vendor/pdfjs/cmaps/' + f).concat([
  "FoxitDingbats.pfb", "FoxitFixed.pfb", "FoxitFixedBold.pfb", "FoxitFixedBoldItalic.pfb", "FoxitFixedItalic.pfb", "FoxitSerif.pfb", "FoxitSerifBold.pfb", "FoxitSerifBoldItalic.pfb", "FoxitSerifItalic.pfb", "FoxitSymbol.pfb", "LICENSE_FOXIT", "LICENSE_LIBERATION", "LiberationSans-Bold.ttf", "LiberationSans-BoldItalic.ttf", "LiberationSans-Italic.ttf", "LiberationSans-Regular.ttf",
].map((f) => './vendor/pdfjs/standard_fonts/' + f));
const ASSETS = [
  './', './index.html', './oauth.html', './manifest.webmanifest', './css/app.css',
  './js/util.js', './js/store.js', './js/paper.js', './js/ink.js', './js/notebook.js', './js/view.js', './js/tools.js',
  './js/shapes.js', './js/objects.js', './js/ruler.js', './js/zoomwin.js', './js/templates.js', './js/recorder.js', './js/pdfdoc.js', './js/exporter.js', './js/gdrive.js', './js/library.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './vendor/pdf-lib.min.js', './vendor/pdfjs/pdf.min.js', './vendor/pdfjs/pdf.worker.min.js',
].concat(VENDOR_DATA);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  // アプリの画面（./ と index.html）だけを index.html として覚える。oauth.html（Google のサインインから戻る所）は別
  const isApp = req.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname.endsWith('/index.html'));

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetchWithTimeout(req, 6000);
      if (res && res.ok && res.type === 'basic') cache.put(isApp ? './index.html' : req, res.clone()).catch(() => {});
      return res;
    } catch {
      const hit = isApp ? await cache.match('./index.html') : await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req, { cache: 'no-cache' }).then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
  });
}
