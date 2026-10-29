'use strict';
/* PDF と画像: ライブラリの遅延読み込み・PDF の読み込み（ページの下地にする）・下地の描画（キャッシュ）・PDF の文字（検索）・画像。
   ページの座標 = pdf.js の表示座標（scale 1、PDF 自身の /Rotate を含む）。bg.vt はその行列（書き出しで PDF の座標に戻すのに使う）。 */

// ---- ライブラリ（必要になった時だけ読む。オフラインでも sw.js のキャッシュから）
const Lib = {
  _p: {},
  load(src, test) {
    if (test()) return Promise.resolve();
    if (!this._p[src]) {
      this._p[src] = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => res();
        s.onerror = () => { delete this._p[src]; rej(new Error('部品を読み込めません: ' + src)); };
        document.head.append(s);
      });
    }
    return this._p[src];
  },
  async pdfjs() {
    await this.load('vendor/pdfjs/pdf.min.js', () => !!window.pdfjsLib);
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
    return window.pdfjsLib;
  },
  async pdflib() { await this.load('vendor/pdf-lib.min.js', () => !!window.PDFLib); return window.PDFLib; },
};

// ---- 中身（blobs）。読み込んだ ArrayBuffer は少しだけ覚えておく
const Src = {
  _mem: new Map(),
  async put(data, type, name) {
    const key = 'src|' + uid('');
    await Store.putBlob(key, { type, name: name || '', data });
    this._remember(key, { type, name, data });
    return key;
  },
  async get(key) {
    if (this._mem.has(key)) { const v = this._mem.get(key); this._mem.delete(key); this._mem.set(key, v); return v; }
    const v = await Store.getBlob(key);
    if (!v) throw new Error('PDF・画像のデータが見つかりません');
    this._remember(key, v);
    return v;
  },
  _remember(key, v) {
    this._mem.set(key, v);
    let total = 0;
    for (const x of this._mem.values()) total += x.data.byteLength;
    while (total > 160e6 && this._mem.size > 1) {        // 大きな PDF をいくつも開いてもメモリを食い過ぎない
      const [k, x] = this._mem.entries().next().value;
      this._mem.delete(k); total -= x.data.byteLength;
    }
  },
};

// ---- pdf.js の文書（src ごと）
const PdfDocs = {
  _docs: new Map(),
  async open(data) {
    const lib = await Lib.pdfjs();
    return lib.getDocument({
      data: new Uint8Array(data.slice(0)),          // worker に渡すと元が使えなくなるので写しを渡す
      cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
      isEvalSupported: false,
    }).promise;
  },
  get(src) {
    if (!this._docs.has(src)) {
      const p = Src.get(src).then((v) => this.open(v.data));
      p.catch(() => this._docs.delete(src));
      this._docs.set(src, p);
      if (this._docs.size > 6) {
        const [k, old] = this._docs.entries().next().value;
        this._docs.delete(k);
        old.then((d) => d.destroy()).catch(() => {});
      }
    }
    return this._docs.get(src);
  },
  async page(src, i) { return (await this.get(src)).getPage(i + 1); },
};

/* PDF のページの下地を描く。base = ページ全体（長い辺 2400px まで）、detail = 拡大した時に見えている所だけ細かく */
const BgRender = {
  base: new Map(),          // `${src}|${page}` → {k, canvas}
  detail: new Map(),        // page.id → {k, rect:[x0,y0,x1,y1], canvas}
  queue: [],                // {kind, key, p, k, rect, prio}
  busy: false,
  onReady: null,
  _pend: new Map(),
  _pt: 0,
  CAP: 2400,
  baseKey(p) { return p.bg.src + '|' + p.bg.page; },
  capK(p) { return this.CAP / Math.max(p.w, p.h); },
  best(p) {
    const k = this.baseKey(p), v = this.base.get(k);
    if (!v) return null;
    this.base.delete(k); this.base.set(k, v);          // 使った物を新しい側へ（古い物から捨てる）
    return v;
  },
  /* view から: このページを s*dpr の細かさで見ている。足りなければ描く予定に入れる */
  want(p, need, visRect, prio) {
    const key = this.baseKey(p);
    const cur = this.base.get(key);
    const kb = Math.min(this.capK(p), Math.max(0.25, need));
    if (!cur || cur.k < kb * 0.8) this.enqueue({ kind: 'base', key, p, k: Math.min(this.capK(p), kb * 1.25), prio });
    if (need > this.capK(p) * 1.05 && visRect) {
      const d = this.detail.get(p.id);
      const pad = 0.15 * Math.max(visRect[2] - visRect[0], visRect[3] - visRect[1]);
      const r = [Math.max(0, visRect[0] - pad), Math.max(0, visRect[1] - pad), Math.min(p.w, visRect[2] + pad), Math.min(p.h, visRect[3] + pad)];
      const covers = d && Math.abs(d.k - need) / need < 0.12 && d.rect[0] <= visRect[0] + 0.5 && d.rect[1] <= visRect[1] + 0.5 &&
        d.rect[2] >= Math.min(p.w, visRect[2]) - 0.5 && d.rect[3] >= Math.min(p.h, visRect[3]) - 0.5;
      if (!covers && r[2] > r[0] && r[3] > r[1]) {
        // つまんで拡大している間は描かない（止まってから）
        this._pend.set(p.id, { kind: 'detail', key: p.id, p, k: need, rect: r, prio: prio + 0.5 });
        clearTimeout(this._pt);
        this._pt = setTimeout(() => { const list = [...this._pend.values()]; this._pend.clear(); list.forEach((j) => this.enqueue(j)); }, 220);
      }
    } else if (this.detail.has(p.id) && need <= this.capK(p)) {
      this.detail.delete(p.id);
    }
  },
  enqueue(job) {
    const i = this.queue.findIndex((j) => j.kind === job.kind && j.key === job.key);
    if (i >= 0) this.queue.splice(i, 1);
    this.queue.push(job);
    this.queue.sort((a, b) => a.prio - b.prio);
    if (this.queue.length > 24) this.queue.length = 24;
    this.pump();
  },
  /* 一覧の小さな絵用: base が無ければ低い解像度で描いて待つ */
  async ensure(p, k) {
    const cur = this.best(p);
    if (cur && cur.k >= k * 0.7) return cur;
    await this.renderTo({ kind: 'base', key: this.baseKey(p), p, k: Math.min(this.capK(p), k) });
    return this.best(p);
  },
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        if (job.kind === 'base') { const cur = this.base.get(job.key); if (cur && cur.k >= job.k * 0.8) continue; }
        try { await this.renderTo(job); } catch (e) { console.warn('PDF の描画に失敗', e); }
        if (this.onReady) this.onReady(job);
      }
    } finally { this.busy = false; }
  },
  async renderTo(job) {
    const { p, k } = job;
    const page = await PdfDocs.page(p.bg.src, p.bg.page);
    const vp = page.getViewport({ scale: k });
    const r = job.rect || [0, 0, p.w, p.h];
    const W = Math.max(1, Math.ceil((r[2] - r[0]) * k)), H = Math.max(1, Math.ceil((r[3] - r[1]) * k));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { alpha: false });
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const lib = await Lib.pdfjs();
    await page.render({ canvasContext: g, viewport: vp, transform: [1, 0, 0, 1, -r[0] * k, -r[1] * k],
      annotationMode: lib.AnnotationMode.ENABLE }).promise;
    if (job.kind === 'base') { this.base.delete(job.key); this.base.set(job.key, { k, canvas: c }); this.trim(); }
    else this.detail.set(job.key, { k, rect: r, canvas: c });
  },
  trim() {
    let px = 0;
    for (const v of this.base.values()) px += v.canvas.width * v.canvas.height;
    while (px > 36e6 && this.base.size > 2) {       // iPad の canvas のメモリに収める
      const [k, v] = this.base.entries().next().value;
      px -= v.canvas.width * v.canvas.height;
      this.base.delete(k);           // 縮めはしない（まだ使っている途中かもしれない）。参照が消えればメモリは戻る
    }
    while (this.detail.size > 4) this.detail.delete(this.detail.keys().next().value);
  },
  /* ページの座標の g に下地を描く */
  draw(g, p) {
    const b = this.best(p);
    if (b) g.drawImage(b.canvas, 0, 0, p.w, p.h);
    const d = this.detail.get(p.id);
    if (d && (!b || d.k > b.k)) g.drawImage(d.canvas, d.rect[0], d.rect[1], d.rect[2] - d.rect[0], d.rect[3] - d.rect[1]);
    return !!b;
  },
};

// ---- PDF の文字
const PdfText = {
  _items: new Map(),       // `${src}|${page}` → [{str, poly:[x,y,...]}]
  /* textContent → ページの座標の文字の並び（項目ごとに四角形） */
  async items(p) {
    if (!p.bg) return [];
    const key = p.bg.src + '|' + p.bg.page;
    if (this._items.has(key)) return this._items.get(key);
    const lib = await Lib.pdfjs();
    const page = await PdfDocs.page(p.bg.src, p.bg.page);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const out = [];
    for (const it of tc.items) {
      if (!it.str) { if (it.hasEOL) out.push({ str: '\n', poly: null }); continue; }
      const tx = lib.Util.transform(vp.transform, it.transform);
      const vertical = tc.styles[it.fontName] && tc.styles[it.fontName].vertical;
      const fh = Math.hypot(tx[2], tx[3]) || 10;
      const ang = Math.atan2(tx[1], tx[0]);
      const ux = Math.cos(ang), uy = Math.sin(ang), nx = Math.sin(ang), ny = -Math.cos(ang);    // 文字の進む向き・上の向き
      const x = tx[4], y = tx[5];
      let poly;
      if (vertical) {
        const len = it.height || fh * it.str.length, half = (it.width || fh) / 2;
        // 縦書き: 原点から下へ進む（ページの回転を含めて「上」の逆向き）
        poly = [x - ux * half, y - uy * half, x + ux * half, y + uy * half, x + ux * half - nx * len, y + uy * half - ny * len, x - ux * half - nx * len, y - uy * half - ny * len];
      } else {
        const len = it.width || fh * it.str.length * 0.6;
        const dx = -nx * fh * 0.22, dy = -ny * fh * 0.22, ax = nx * fh * 0.9, ay = ny * fh * 0.9;     // 下がり・上がり
        poly = [x + dx, y + dy, x + ux * len + dx, y + uy * len + dy, x + ux * len + ax, y + uy * len + ay, x + ax, y + ay];
      }
      out.push({ str: it.str, poly, vertical: !!vertical });
      if (it.hasEOL) out.push({ str: '\n', poly: null });
    }
    this._items.set(key, out);
    if (this._items.size > 60) this._items.delete(this._items.keys().next().value);
    return out;
  },
  /* ページの文字全体（検索用に保存する） */
  async pageText(page) {
    const tc = await page.getTextContent();
    let s = '';
    for (const it of tc.items) { s += it.str || ''; if (it.hasEOL) s += '\n'; }
    return s.replace(/[ \t]+\n/g, '\n').trim();
  },
  /* 検索語に当たった所の四角形（ページの座標）。文字は項目の中で等分と見なす */
  async findPolys(p, q) {
    const items = await this.items(p);
    if (!q) return [];
    const norm = (s) => normText(s);
    let joined = '';
    const map = [];        // joined の各文字 → [項目番号, 項目内の位置]
    items.forEach((it, i) => { for (let k = 0; k < it.str.length; k++) { joined += norm(it.str[k]); map.push([i, k]); } });
    const nq = norm(q).replace(/\s+/g, '');
    if (!nq) return [];
    // 空白・改行を無視して探す
    let squeezed = '', back = [];
    for (let i = 0; i < joined.length; i++) if (!/\s/.test(joined[i])) { squeezed += joined[i]; back.push(i); }
    const out = [];
    for (let at = squeezed.indexOf(nq); at >= 0; at = squeezed.indexOf(nq, at + nq.length)) {
      const a = back[at], b = back[at + nq.length - 1];
      const spans = new Map();
      for (let j = a; j <= b; j++) {
        const [ii, kk] = map[j];
        const sp = spans.get(ii) || [kk, kk];
        sp[0] = Math.min(sp[0], kk); sp[1] = Math.max(sp[1], kk);
        spans.set(ii, sp);
      }
      for (const [ii, [k0, k1]] of spans) {
        const it = items[ii];
        if (!it.poly) continue;
        const n = it.str.length, t0 = k0 / n, t1 = (k1 + 1) / n, P = it.poly;
        // poly = [始まり下, 終わり下, 終わり上, 始まり上]（縦書きは 始まり左, 始まり右, 終わり右, 終わり左）
        const lerp = (i, j, t) => [P[i] + (P[j] - P[i]) * t, P[i + 1] + (P[j + 1] - P[i + 1]) * t];
        if (it.vertical) out.push([...lerp(0, 6, t0), ...lerp(2, 4, t0), ...lerp(2, 4, t1), ...lerp(0, 6, t1)]);
        else out.push([...lerp(0, 2, t0), ...lerp(0, 2, t1), ...lerp(6, 4, t1), ...lerp(6, 4, t0)]);
      }
    }
    return out;
  },
};

/* 検索のための正規化: 全角英数→半角・大文字→小文字・カタカナ→ひらがなはしない（意味が変わるため） */
function normText(s) {
  return s.normalize('NFKC').toLowerCase();
}

/* 文字列の中の当たりの前後（一覧に出す） */
function snippetOf(text, q, span = 28) {
  const orig = text.replace(/\s+/g, ' ');
  const nt = normText(orig);
  const t = nt.length === orig.length ? orig : nt;      // 長さが変わらなければ元の字のまま見せる
  const nq = normText(q).trim();
  const i = nt.indexOf(nq);
  if (i < 0) return null;
  const a = Math.max(0, i - span), b = Math.min(t.length, i + nq.length + span);
  return { before: (a > 0 ? '…' : '') + t.slice(a, i), hit: t.slice(i, i + nq.length), after: t.slice(i + nq.length, b) + (b < t.length ? '…' : '') };
}

// ---- 読み込み
/* PDF のファイル → ページの並び（下地付き・文字付き）。onProgress(i, n) */
async function pagesFromPdf(file, onProgress) {
  const data = await file.arrayBuffer();
  let doc;
  try { doc = await PdfDocs.open(data); } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('パスワード付きの PDF は読み込めません（紙工房 exe でパスワードを外してください）');
    throw new Error('PDF を読めません: ' + (e.message || e));
  }
  const src = await Src.put(data, 'application/pdf', file.name);
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const pg = await doc.getPage(i + 1);
    const vp = pg.getViewport({ scale: 1 });
    let text = '';
    try { text = await PdfText.pageText(pg); } catch { /* 文字の無い PDF */ }
    pages.push({ id: uid('p'), w: vp.width, h: vp.height, rot: 0, infinite: false, paper: { type: 'blank', color: 'white' },
      strokes: [], images: [], bg: { src, page: i, vt: Array.from(vp.transform) }, text });
    if (onProgress) onProgress(i + 1, doc.numPages);
  }
  // 開いた文書はそのまま使い回す
  PdfDocs._docs.set(src, Promise.resolve(doc));
  return pages;
}

/* 画像のファイル → 保存する形（JPEG/PNG、長い辺 3000px まで）。{src, w, h(px)} */
async function storeImage(file) {
  const type = (file.type || '').toLowerCase();
  const bmp = await loadImageEl(file);
  const W0 = bmp.naturalWidth || bmp.width, H0 = bmp.naturalHeight || bmp.height;
  if (!W0 || !H0) throw new Error('画像を読めません');
  const MAX = 3000;
  let data, outType;
  if ((type === 'image/jpeg' || type === 'image/png') && Math.max(W0, H0) <= MAX && file.size < 12e6) {
    data = await file.arrayBuffer(); outType = type;
  } else {
    const k = Math.min(1, MAX / Math.max(W0, H0));
    const c = document.createElement('canvas');
    c.width = Math.round(W0 * k); c.height = Math.round(H0 * k);
    const g = c.getContext('2d');
    outType = type === 'image/png' || type === 'image/gif' || type === 'image/webp' ? 'image/png' : 'image/jpeg';
    if (outType === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, outType, 0.9));
    data = await blob.arrayBuffer();
  }
  const src = await Src.put(data, outType, file.name);
  return { src, w: W0, h: H0 };
}

function loadImageEl(blobOrFile) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blobOrFile);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を読めません')); };
    im.src = url;
  });
}

/* 貼った画像の表示用（src → 読み込んだ Image） */
const ImageCache = {
  _m: new Map(),
  onReady: null,
  get(src) {
    const v = this._m.get(src);
    if (v && v.img) return v.img;
    if (!v) {
      const e = { img: null };
      this._m.set(src, e);
      Src.get(src).then((r) => loadImageEl(new Blob([r.data], { type: r.type }))).then((img) => { e.img = img; if (this.onReady) this.onReady(); })
        .catch(() => { this._m.delete(src); });
    }
    return null;
  },
};

/* ページの座標の g に画像を描く（hide = 描かない id） */
function drawImages(g, p, hide, opt) {
  for (const im of p.images || []) {
    if (hide && hide.has(im.id)) continue;
    drawObject(g, im, opt);
  }
}
function drawImageItem(g, im) {
  const img = ImageCache.get(im.src);
  g.save();
  g.translate(im.x + im.w / 2, im.y + im.h / 2);
  if (im.rot) g.rotate(im.rot);
  if (img) g.drawImage(img, -im.w / 2, -im.h / 2, im.w, im.h);
  else { g.fillStyle = 'rgba(128,128,128,.15)'; g.fillRect(-im.w / 2, -im.h / 2, im.w, im.h); }
  g.restore();
}
/* 画像の 4 隅（ページの座標） */
function imageCorners(im) {
  const cx = im.x + im.w / 2, cy = im.y + im.h / 2, c = Math.cos(im.rot || 0), s = Math.sin(im.rot || 0);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const x = (u * im.w) / 2, y = (v * im.h) / 2;
    return [cx + x * c - y * s, cy + x * s + y * c];
  });
}
function imageBBox(im) {
  const cs = imageCorners(im);
  return [Math.min(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1])), Math.max(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1]))];
}
function imageHit(im, x, y) {
  const cx = im.x + im.w / 2, cy = im.y + im.h / 2, c = Math.cos(-(im.rot || 0)), s = Math.sin(-(im.rot || 0));
  const dx = x - cx, dy = y - cy, lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= im.w / 2 && Math.abs(ly) <= im.h / 2;
}
/* 画像に行列 m をかける（移動・拡大縮小・回転。傾きは無い前提） */
function imageTransformed(im, m, keepId = true) {
  const cx = im.x + im.w / 2, cy = im.y + im.h / 2;
  const nx = m.a * cx + m.c * cy + m.e, ny = m.b * cx + m.d * cy + m.f;
  const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  const w = im.w * k, h = im.h * k;
  const out = { ...imageRecord(im), id: keepId ? im.id : uid('m'), x: nx - w / 2, y: ny - h / 2, w, h, rot: (im.rot || 0) + Math.atan2(m.b, m.a) };
  if (im.size) out.size = im.size * k;          // 文字は大きさも
  return out;
}
