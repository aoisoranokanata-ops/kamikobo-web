'use strict';
/* 書き出し: PDF（手書きはベクター、PDF の下地は元のまま＝文字も選べる）・バックアップ（.kmkw）と復元・共有。 */

const fmtN = (v) => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? '0' : String(r); };

function parseColor(c) {
  if (!c) return [0, 0, 0, 1];
  if (c[0] === '#') { const [r, g, b] = hexToRgb(c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c); return [r / 255, g / 255, b / 255, 1]; }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const v = m[1].split(',').map((x) => parseFloat(x)); return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] == null ? 1 : v[3]]; }
  return [0, 0, 0, 1];
}
const rgbOp = (c, stroke) => { const [r, g, b] = parseColor(c); return `${fmtN(r)} ${fmtN(g)} ${fmtN(b)} ${stroke ? 'RG' : 'rg'}`; };
function matInv(m) {
  const [a, b, c, d, e, f] = m, det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/* PDF の操作を文字で集める「なんちゃって canvas」（用紙の線を描くのに使う） */
class PdfCtx {
  constructor(ops) {
    this.ops = ops; this.path = []; this.cur = [0, 0]; this.stack = []; this.texts = [];
    this.fillStyle = '#000'; this.strokeStyle = '#000'; this.lineWidth = 1; this.font = '10px sans-serif'; this.globalAlpha = 1;
  }
  save() { this.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font }); this.ops.push('q'); }
  restore() { const s = this.stack.pop(); if (s) Object.assign(this, s); this.ops.push('Q'); }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push(`${fmtN(x)} ${fmtN(y)} m`); this.cur = [x, y]; this.start = [x, y]; }
  lineTo(x, y) { this.path.push(`${fmtN(x)} ${fmtN(y)} l`); this.cur = [x, y]; }
  rect(x, y, w, h) { this.path.push(`${fmtN(x)} ${fmtN(y)} ${fmtN(w)} ${fmtN(h)} re`); }
  closePath() { this.path.push('h'); }
  quadraticCurveTo(cx, cy, x, y) {
    const [x0, y0] = this.cur;
    this.path.push(`${fmtN(x0 + (2 / 3) * (cx - x0))} ${fmtN(y0 + (2 / 3) * (cy - y0))} ${fmtN(x + (2 / 3) * (cx - x))} ${fmtN(y + (2 / 3) * (cy - y))} ${fmtN(x)} ${fmtN(y)} c`);
    this.cur = [x, y];
  }
  arc(cx, cy, r) {           // 用紙では円しか使わない
    const k = 0.5523 * r;
    this.path.push(`${fmtN(cx + r)} ${fmtN(cy)} m`,
      `${fmtN(cx + r)} ${fmtN(cy + k)} ${fmtN(cx + k)} ${fmtN(cy + r)} ${fmtN(cx)} ${fmtN(cy + r)} c`,
      `${fmtN(cx - k)} ${fmtN(cy + r)} ${fmtN(cx - r)} ${fmtN(cy + k)} ${fmtN(cx - r)} ${fmtN(cy)} c`,
      `${fmtN(cx - r)} ${fmtN(cy - k)} ${fmtN(cx - k)} ${fmtN(cy - r)} ${fmtN(cx)} ${fmtN(cy - r)} c`,
      `${fmtN(cx + k)} ${fmtN(cy - r)} ${fmtN(cx + r)} ${fmtN(cy - k)} ${fmtN(cx + r)} ${fmtN(cy)} c`, 'h');
  }
  stroke() { if (!this.path.length) return; this.ops.push(rgbOp(this.strokeStyle, true), `${fmtN(this.lineWidth)} w`, ...this.path, 'S'); }
  fill() { if (!this.path.length) return; this.ops.push(rgbOp(this.fillStyle, false), ...this.path, 'f'); }
  fillRect(x, y, w, h) { this.ops.push(rgbOp(this.fillStyle, false), `${fmtN(x)} ${fmtN(y)} ${fmtN(w)} ${fmtN(h)} re`, 'f'); }
  /* 文字（用紙の見出し）は小さな画像にして置く（日本語の字形を PDF に入れずに済む） */
  fillText(text, x, y) {
    const size = parseFloat(this.font) || 10, K = 6;
    const c = document.createElement('canvas'), g = c.getContext('2d');
    const font = this.font.replace(/[\d.]+px/, size * K + 'px');
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 4, h = Math.ceil(size * K * 1.4);
    c.width = w; c.height = h;
    g.font = font; g.fillStyle = this.fillStyle; g.textBaseline = 'alphabetic';
    g.fillText(text, 2, size * K * 1.05);
    const mark = this.ops.length;
    this.ops.push(null);           // 後で画像の命令に差し替える
    this.texts.push({ canvas: c, x: x - 2 / K, y: y - size * 1.05, w: w / K, h: h / K, mark });
  }
}

/* 万年筆・筆ペンの線の外形（1 つの多角形）。PDF を軽くするため点を間引く */
function strokeOutline(s) {
  const d = densify(s), m = d.length / 3;
  const P = [];
  for (let i = 0; i < m; i++) {
    const x = d[i * 3], y = d[i * 3 + 1], r = Math.max(0.15, d[i * 3 + 2]);
    if (P.length && i < m - 1) { const q = P[P.length - 1]; if (Math.hypot(x - q[0], y - q[1]) < Math.max(0.5, r * 0.6)) continue; }
    P.push([x, y, r]);
  }
  const circle = (x, y, r) => { const out = []; for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; out.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); } return out; };
  if (P.length === 1) return [circle(...P[0])];
  const L = [], R = [];
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const [x, y, r] = P[i];
    L.push([x - ty * r, y + tx * r]); R.push([x + ty * r, y - tx * r]);
  }
  const cap = (c, from, to, steps = 6) => {      // c を中心に from → to へ半円
    const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
    let a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
    while (a1 > a0) a1 -= Math.PI * 2;
    const out = [];
    for (let k = 1; k < steps; k++) { const a = a0 + ((a1 - a0) * k) / steps; out.push([c[0] + Math.cos(a) * c[2], c[1] + Math.sin(a) * c[2]]); }
    return out;
  };
  const poly = [...L, ...cap(P[n - 1], L[n - 1], R[n - 1]), ...R.slice().reverse(), ...cap(P[0], R[0], L[0])];
  const out = [poly];
  // 急に曲がる所は丸を足して欠けを防ぐ
  for (let i = 1; i < n - 1; i++) {
    const a = P[i - 1], b = P[i], c = P[i + 1];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1);
    if (cos < 0.5) out.push(circle(b[0], b[1], b[2]));
  }
  return out;
}

/* 線 → PDF の命令 */
function strokeOps(s, gsName) {
  const ops = [];
  const p = s.pts, n = p.length / 4;
  if (!n) return ops;
  if (gsName) ops.push('q', `/${gsName} gs`);
  if (s.tool === 'hl' || s.pen === 'ball') {
    const ctx = new PdfCtx(ops);
    ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
    else if (n === 2) ctx.lineTo(p[4], p[5]);
    else {
      for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(p[i * 4], p[i * 4 + 1], (p[i * 4] + p[(i + 1) * 4]) / 2, (p[i * 4 + 1] + p[(i + 1) * 4 + 1]) / 2);
      ctx.lineTo(p[(n - 1) * 4], p[(n - 1) * 4 + 1]);
    }
    ops.push(rgbOp(s.color, true), `${fmtN(s.w)} w`, s.tool === 'hl' ? '0 J' : '1 J', '1 j', ...ctx.path, 'S');
  } else {
    ops.push(rgbOp(s.color, false));
    for (const poly of strokeOutline(s)) {
      ops.push(`${fmtN(poly[0][0])} ${fmtN(poly[0][1])} m`);
      for (let i = 1; i < poly.length; i++) ops.push(`${fmtN(poly[i][0])} ${fmtN(poly[i][1])} l`);
      ops.push('h');
    }
    ops.push('f');
  }
  if (gsName) ops.push('Q');
  return ops;
}

/* ページの並び → PDF（Uint8Array）。opt: {title, paper(用紙の線も), onProgress(i, n)} */
async function exportPdf(pages, opt = {}) {
  const L = await Lib.pdflib();
  const out = await L.PDFDocument.create();
  out.setTitle(opt.title || '紙工房 Web');
  out.setCreator('紙工房 Web'); out.setProducer('紙工房 Web (pdf-lib)');
  const ctx = out.context;

  // PDF の下地は元の文書からまとめて写す（同じ文書のページはフォントなどを共有させる）
  const want = new Map();
  for (const p of pages) if (p.bg) { if (!want.has(p.bg.src)) want.set(p.bg.src, []); want.get(p.bg.src).push(p.bg.page); }
  const copied = new Map();     // `${src}|${page}` → [PDFPage...]
  const raster = new Set();     // pdf-lib で扱えない（暗号化など）→ 画像で
  for (const [src, idx] of want) {
    try {
      const v = await Src.get(src);
      const sd = await L.PDFDocument.load(v.data, { ignoreEncryption: true, updateMetadata: false });
      if (sd.isEncrypted) throw new Error('encrypted');
      const list = await out.copyPages(sd, idx);
      idx.forEach((i, k) => { const key = src + '|' + i; if (!copied.has(key)) copied.set(key, []); copied.get(key).push(list[k]); });
    } catch { raster.add(src); }
  }

  const gsCache = new Map(), imgCache = new Map();
  const links = [], outPage = new Map();     // リンク（最後にまとめて）・ページ id → 書き出したページ
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    let page, vt, baseRot = 0;
    const bgKey = p.bg ? p.bg.src + '|' + p.bg.page : null;
    if (p.bg && !raster.has(p.bg.src) && copied.get(bgKey) && copied.get(bgKey).length) {
      page = copied.get(bgKey).shift();
      out.addPage(page);
      baseRot = page.getRotation().angle || 0;
      vt = p.bg.vt;
    } else {
      page = out.addPage([p.w, p.h]);
      vt = [1, 0, 0, -1, 0, p.h];
    }
    page.node.normalize();                      // 元の中身を q … Q で包む（後から足す命令が狂わないように）
    outPage.set(p.id, page);
    page.setRotation(L.degrees((((baseRot + (p.rot || 0)) % 360) + 360) % 360));
    const ops = ['q', `${matInv(vt).map(fmtN).join(' ')} cm`];
    const gsName = (op, multiply) => {
      const key = op.toFixed(2) + (multiply ? 'm' : '');
      let ref = gsCache.get(key);
      if (!ref) { ref = ctx.register(ctx.obj({ Type: 'ExtGState', CA: op, ca: op, ...(multiply ? { BM: 'Multiply' } : {}) })); gsCache.set(key, ref); }
      return page.node.newExtGState('GS', ref).asString().slice(1);
    };
    const putImage = async (canvasOrSrc, box, rot = 0) => {
      let ref = typeof canvasOrSrc === 'string' ? imgCache.get(canvasOrSrc) : null;
      if (!ref) {
        let bytes, type;
        if (typeof canvasOrSrc === 'string') { const v = await Src.get(canvasOrSrc); bytes = v.data; type = v.type; }
        else { const b = await new Promise((r) => canvasOrSrc.toBlob(r, 'image/png')); bytes = await b.arrayBuffer(); type = 'image/png'; }
        const emb = type === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        ref = emb.ref;
        if (typeof canvasOrSrc === 'string') imgCache.set(canvasOrSrc, ref);
      }
      const name = page.node.newXObject('Im', ref).asString().slice(1);
      const { x, y, w, h } = box, c = Math.cos(rot), s = Math.sin(rot), cx = x + w / 2, cy = y + h / 2;
      return ['q', [w * c, w * s, h * s, -h * c, cx - 0.5 * w * c - 0.5 * h * s, cy - 0.5 * w * s + 0.5 * h * c].map(fmtN).join(' ') + ' cm', `/${name} Do`, 'Q'];
    };

    if (p.bg && raster.has(p.bg.src)) {
      const r = await BgRender.ensure(p, 2);
      if (r) ops.push(...await putImage(r.canvas, { x: 0, y: 0, w: p.w, h: p.h }));
    } else if (!p.bg && opt.paper !== false) {
      const pc = new PdfCtx(ops);
      if (p._boardPaper) {          // 無限キャンバス: 方眼などを書いた範囲に
        ops.push('q', `1 0 0 1 ${fmtN(-p._x0)} ${fmtN(-p._y0)} cm`);
        drawBoardPaper(pc, { paper: p._boardPaper }, { x0: p._x0, y0: p._y0, x1: p._x0 + p.w, y1: p._y0 + p.h }, 2);
        ops.push('Q');
      } else drawPaper(pc, p, 2);
      for (const t of pc.texts) ops[t.mark] = (await putImage(t.canvas, t)).join('\n');
    }
    for (const im of p.images || []) {
      const k = im.kind || 'image';
      if (k === 'image') ops.push(...await putImage(im.src, im, im.rot || 0));
      else if (k === 'text' || k === 'stamp') {       // 日本語の字形を埋め込まずに済むよう、細かい画像で
        const { canvas, pad } = objectCanvas(im, 4);
        ops.push(...await putImage(canvas, { x: im.x - pad, y: im.y - pad, w: im.w + pad * 2, h: im.h + pad * 2 }, im.rot || 0));
      } else if (k === 'link') links.push({ page, vt, o: im });
    }
    for (const pass of ['hl', 'pen']) {
      for (const s of p.strokes) {
        if (s.tool !== pass) continue;
        const op = s.op == null ? 1 : s.op;
        const name = s.tool === 'hl' ? gsName(op, true) : op < 0.999 ? gsName(op, false) : null;
        ops.push(...strokeOps(s, name));
      }
    }
    ops.push('Q');
    const ref = ctx.register(ctx.flateStream(ops.filter((x) => x != null).join('\n')));
    page.node.addContentStream(ref);
    if (opt.onProgress) opt.onProgress(i + 1, pages.length);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));     // 画面を固めない
  }
  // リンク（ページへ・URL へ）
  for (const { page, vt, o } of links) {
    const iv = matInv(vt), cs = imageCorners(o).map(([x, y]) => [iv[0] * x + iv[2] * y + iv[4], iv[1] * x + iv[3] * y + iv[5]]);
    const rect = [Math.min(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1])), Math.max(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1]))];
    const to = o.to || {};
    const dict = { Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0] };
    if (to.page) { const tp = outPage.get(to.page); if (!tp) continue; dict.Dest = [tp.ref, 'Fit']; }
    else if (to.url) dict.A = ctx.obj({ Type: 'Action', S: 'URI', URI: L.PDFString.of(to.url) });
    else continue;
    page.node.addAnnot(ctx.register(ctx.obj(dict)));
  }
  // しおり → PDF のしおり（目次）
  const marks = pages.filter((p) => p.mark && outPage.get(p.id));
  if (marks.length) {
    const root = ctx.nextRef();
    const refs = marks.map(() => ctx.nextRef());
    marks.forEach((p, i) => {
      const d = { Title: L.PDFHexString.fromText(p.mark.title || 'しおり'), Parent: root, Dest: [outPage.get(p.id).ref, 'Fit'] };
      if (i > 0) d.Prev = refs[i - 1];
      if (i < marks.length - 1) d.Next = refs[i + 1];
      ctx.assign(refs[i], ctx.obj(d));
    });
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: marks.length }));
    out.catalog.set(L.PDFName.of('Outlines'), root);
    out.catalog.set(L.PDFName.of('PageMode'), L.PDFName.of('UseOutlines'));
  }
  return out.save({ useObjectStreams: true });
}

/* 無限キャンバスを 1 枚の PDF に（書いた範囲＋余白） */
function boardAsPage(p) {
  const b = p.strokes.length || (p.images || []).length
    ? unionBBox(p.strokes.concat((p.images || []).map((im) => ({ _bb: imageBBox(im) })))) : [-300, -200, 300, 200];
  const pad = 36, x0 = b[0] - pad, y0 = b[1] - pad, w = b[2] - b[0] + pad * 2, h = b[3] - b[1] + pad * 2;
  const m = { a: 1, b: 0, c: 0, d: 1, e: -x0, f: -y0 };
  return { id: p.id, w, h, rot: 0, paper: { ...p.paper, type: 'blank' }, strokes: p.strokes.map((s) => strokeTransformed(s, m)),
    images: (p.images || []).map((im) => imageTransformed(im, m)), _boardPaper: p.paper, _x0: x0, _y0: y0 };
}

// ================= バックアップ（.kmkw）
/* 形: "KMKWEB1\n" ＋ ヘッダの長さ(4 バイト) ＋ ヘッダ(JSON) ＋ 中身（線の点・PDF・画像）を順に */
const BACKUP_MAGIC = 'KMKWEB1\n';

/* ids の中身（フォルダは中身ごと）。ids が null なら本棚全部（ゴミ箱は除く） */
async function buildBackup(ids, kind = 'library') {
  const all = await Store.allItems();
  const byId = new Map(all.map((it) => [it.id, it]));
  const take = new Set();
  const walk = (id) => { const it = byId.get(id); if (!it || it.trashed) return; take.add(id); for (const c of all) if (c.parent === id) walk(c.id); };
  if (ids) ids.forEach(walk); else for (const it of all) if (it.parent === 'root') walk(it.id);
  const items = [...take].map((id) => ({ ...byId.get(id) }));
  const parts = [];
  let off = 0;
  const addBin = (buf) => { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf); parts.push(u); const o = off; off += u.byteLength; return { o, n: u.byteLength }; };
  const pages = [], texts = [], srcs = new Set();
  for (const it of items) {
    if (it.type !== 'note') continue;
    const recs = (await Store.getPages(it.pageIds)).filter(Boolean);
    for (const r of recs) {
      if (r.bg) srcs.add(r.bg.src);
      for (const im of r.images || []) srcs.add(im.src);
      pages.push({ ...r, strokes: r.strokes.map((s) => ({ ...s, pts: addBin(new Float32Array(s.pts)) })) });
    }
    texts.push(...await Store.getTexts(it.id));
  }
  const blobs = [];
  for (const key of srcs) {
    const v = await Store.getBlob(key);
    if (v) blobs.push({ key, type: v.type, name: v.name || '', ...addBin(v.data) });
  }
  const header = new TextEncoder().encode(JSON.stringify({ app: 'kamikobo-web', format: 1, kind, created: Date.now(), roots: ids || null, items, pages, texts, blobs }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.byteLength, true);
  return new Blob([BACKUP_MAGIC, len, header, ...parts], { type: 'application/octet-stream' });
}

/* 復元: いつも「追加」（id を付け直す。今の本棚は消さない）。library なら「復元 日付」フォルダに入れる */
async function restoreBackup(file, parentFolder) {
  const buf = await file.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(8, buf.byteLength)));
  if (magic !== BACKUP_MAGIC) throw new Error('紙工房 Web のファイルではありません');
  const hlen = new DataView(buf, 8, 4).getUint32(0, true);
  const H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen)));
  const base = 12 + hlen;
  const bin = (r) => buf.slice(base + r.o, base + r.o + r.n);
  const idMap = new Map();
  const nid = (old, pre) => { if (!idMap.has(old)) idMap.set(old, uid(pre)); return idMap.get(old); };
  const inSet = new Set(H.items.map((it) => it.id));
  let parent = parentFolder || 'root';
  const now = Date.now();
  if (H.kind === 'library') {
    const f = { id: uid('f'), type: 'folder', parent, name: '復元 ' + fmtDate(now).slice(0, 10), created: now, updated: now, trashed: false, color: '#8a8f99' };
    await Store.putItem(f);
    parent = f.id;
  }
  for (const b of H.blobs) if (!await Store.hasBlob(b.key)) await Store.putBlob(b.key, { type: b.type, name: b.name, data: bin(b) });
  const pagesById = new Map(H.pages.map((p) => [p.id, p]));
  const textsByPage = new Map(H.texts.filter((t) => t.text).map((t) => [t.pageId, t.text]));
  let notes = 0;
  for (const it of H.items) {
    const copy = { ...it, id: nid(it.id, it.type === 'folder' ? 'f' : 'n'), parent: inSet.has(it.parent) ? nid(it.parent, 'f') : parent, trashed: false };
    if (it.type === 'folder') { await Store.putItem(copy); continue; }
    const pages = [];
    for (const pid of it.pageIds || []) {
      const r = pagesById.get(pid);
      if (!r) continue;
      const q = { ...r, id: uid('p'), noteId: copy.id, strokes: r.strokes.map((s) => ({ ...s, pts: new Float32Array(bin(s.pts)) })) };
      if (textsByPage.has(pid)) q.text = textsByPage.get(pid);
      pages.push(q);
    }
    copy.pageIds = pages.map((p) => p.id);
    await Store.saveNote(copy, pages.map(pageRecord), [], textRecs(pages, copy.id));
    notes++;
  }
  return { notes, kind: H.kind, folder: H.kind === 'library' ? parent : null };
}

// ================= 共有・保存
function safeName(s) { return (s || '紙工房').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80); }

/* できあがったファイルを渡す。iPad の共有シート（AirDrop・ファイルに保存）は押した時にしか開けないので、ボタンを押してもらう */
async function offerFile(blob, filename, title = '書き出しました') {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const size = blob.size > 1048576 ? (blob.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(blob.size / 1024)) + ' KB';
  const v = await modal(title, el('p', {}, `${filename}（${size}）`), [
    { label: '閉じる', value: null },
    { label: '保存', value: 'save' },
    canShare ? { label: '共有…（AirDrop・ファイル）', primary: true, value: 'share' } : null,
  ].filter(Boolean));
  if (v === 'share') {
    try { await navigator.share({ files: [file], title: filename }); } catch (e) { if (e && e.name !== 'AbortError') downloadBlob(blob, filename); }
  } else if (v === 'save') downloadBlob(blob, filename);
}
function downloadBlob(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}

/* ファイルを選んでもらう（iPad では accept の無い方が確実に選べることがある） */
function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const inp = el('input', { type: 'file', accept: accept || null, multiple: multiple || null, style: { position: 'fixed', left: '-1000px' } });
    let done = false;
    inp.addEventListener('change', () => { done = true; res([...inp.files]); inp.remove(); });
    window.addEventListener('focus', () => setTimeout(() => { if (!done && !inp.files.length) { res([]); inp.remove(); } }, 1200), { once: true });
    document.body.append(inp);
    inp.click();
  });
}

/* 進み具合の小さな表示 */
function progressBox(title) {
  const bar = el('div', { class: 'prog' }, el('i'));
  const txt = el('div', { class: 'muted' }, '');
  const back = el('div', { class: 'modal-back' }, el('div', { class: 'modal' }, el('h2', {}, title), bar, txt));
  document.body.append(back);
  return {
    set(i, n, msg) { bar.firstChild.style.width = (n ? (100 * i) / n : 0) + '%'; txt.textContent = msg || (n ? `${i} / ${n}` : ''); },
    close() { back.remove(); },
  };
}
