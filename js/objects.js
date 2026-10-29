'use strict';
/* ページに置く物（page.images に一緒に入れる。kind で区別、無い物は画像）:
     文字   {kind:'text', x, y, w, h, rot, text, size(pt), color, font:'gothic'|'mincho'|'maru', bold, bg(付箋の色 or null)}
     スタンプ {kind:'stamp', x, y, w, h, rot, label, color, style:'hanko'|'badge'|'icon'}
     リンク {kind:'link', x, y, w, h, rot, to:{page: ページ id} | {url}}（画面だけに薄く出す。PDF ではリンクの注釈）
   なげなわで画像と同じように選び・動かし・拡大縮小（文字の大きさも）・回転できる。 */

const FONT_FAMILIES = {
  gothic: { label: 'ゴシック', css: '-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", sans-serif' },
  mincho: { label: '明朝', css: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", serif' },
  maru: { label: '丸ゴシック', css: '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Yu Gothic UI", sans-serif' },
};
const STICKY_COLORS = ['#fff3a3', '#ffd2e1', '#cfe8ff', '#d5f5c8', '#ffe0b8'];
const STAMPS = [
  { label: '済', color: '#d12b2b', style: 'hanko' },
  { label: '重要', color: '#d12b2b', style: 'badge' },
  { label: '要復習', color: '#1f4fd1', style: 'badge' },
  { label: '暗記', color: '#8a3cc2', style: 'badge' },
  { label: 'OK', color: '#1f8a3c', style: 'badge' },
  { label: '★', color: '#f0a81c', style: 'icon' },
  { label: '✓', color: '#1f8a3c', style: 'icon' },
  { label: '✗', color: '#d12b2b', style: 'icon' },
  { label: '？', color: '#1f4fd1', style: 'icon' },
  { label: '！', color: '#e0861c', style: 'icon' },
  { label: '◎', color: '#d12b2b', style: 'icon' },
  { label: '♡', color: '#e0478f', style: 'icon' },
  { label: 'today', color: '#5c5f66', style: 'badge' },     // 今日の日付
];

const _mctx = document.createElement('canvas').getContext('2d');
function objFont(o) { return `${o.bold ? '700 ' : ''}${o.size}px ${(FONT_FAMILIES[o.font] || FONT_FAMILIES.gothic).css}`; }
function textPad(o) { return o.bg ? o.size * 0.7 : o.size * 0.15; }

/* 折り返し（日本語は字ごと、英単語は語ごと、句読点は行頭に来ないように） */
function layoutText(o) {
  const key = `${o.text}|${o.w}|${o.size}|${o.font}|${o.bold}|${!!o.bg}`;
  if (o._lay && o._lay.key === key) return o._lay;
  _mctx.font = objFont(o);
  const pad = textPad(o), maxW = Math.max(o.size, o.w - pad * 2);
  const lines = [];
  for (const para of String(o.text || '').split('\n')) {
    let cur = '';
    for (const ch of para) {
      if (cur && _mctx.measureText(cur + ch).width > maxW) {
        if ('、。，．・」』）)!?！？ー…'.includes(ch)) { cur += ch; continue; }       // 禁則（ぶら下げ）
        const m = /[A-Za-z0-9]$/.test(cur) && /[A-Za-z0-9]/.test(ch) ? cur.match(/^(.*\s)(\S+)$/) : null;
        if (m && m[1].trim()) { lines.push(m[1].trimEnd()); cur = m[2] + ch; } else { lines.push(cur); cur = ch; }
      } else cur += ch;
    }
    lines.push(cur);
  }
  const lh = o.size * 1.45;
  o._lay = { key, lines, lh, pad, h: lines.length * lh + pad * 2 };
  return o._lay;
}
/* 文字の高さを中身に合わせる（付箋は少し大きめが最低） */
function fitTextHeight(o) {
  const L = layoutText(o);
  o.h = Math.max(L.h, o.bg ? o.w * 0.55 : o.size * 1.45 + L.pad * 2);
  return o;
}

function stampText(o) { return o.label === 'today' ? fmtDate(o.date || Date.now()).slice(0, 10) : o.label; }
function newStamp(st, x, y) {
  const label = st.label, text = label === 'today' ? fmtDate(Date.now()).slice(0, 10) : label;
  let w, h;
  if (st.style === 'hanko') { w = h = 46; }
  else if (st.style === 'icon') { w = h = 40; }
  else { _mctx.font = `700 16px ${FONT_FAMILIES.gothic.css}`; w = Math.ceil(_mctx.measureText(text).width) + 22; h = 28; }
  return { id: uid('m'), kind: 'stamp', label, color: st.color, style: st.style, date: label === 'today' ? Date.now() : undefined, x: x - w / 2, y: y - h / 2, w, h, rot: 0 };
}

/* 物を描く（g はページの座標）。opt.screen = 画面（リンクの枠を出す） */
function drawObject(g, o, opt = {}) {
  const k = o.kind || 'image';
  if (k === 'image') { drawImageItem(g, o); return; }
  if (k === 'link' && (!opt.screen || o.hidden)) return;      // プランナーのリンクは見えないまま
  g.save();
  g.translate(o.x + o.w / 2, o.y + o.h / 2);
  if (o.rot) g.rotate(o.rot);
  g.translate(-o.w / 2, -o.h / 2);
  if (k === 'text') {
    const L = layoutText(o);
    if (o.bg) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,.22)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
      g.fillStyle = o.bg;
      g.fillRect(0, 0, o.w, o.h);
      g.restore();
      g.fillStyle = 'rgba(0,0,0,.06)'; g.fillRect(0, 0, o.w, Math.min(o.h, o.size * 0.5));     // 付箋の糊の所
    }
    g.font = objFont(o);
    g.fillStyle = o.color || '#1d1d1f';
    g.textBaseline = 'alphabetic';
    L.lines.forEach((ln, i) => g.fillText(ln, L.pad, L.pad + i * L.lh + o.size * 1.05));
  } else if (k === 'stamp') {
    const t = stampText(o), c = o.color || '#d12b2b';
    g.strokeStyle = c; g.fillStyle = c; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (o.style === 'hanko') {
      const r = Math.min(o.w, o.h) / 2;
      g.lineWidth = r * 0.09;
      g.beginPath(); g.arc(o.w / 2, o.h / 2, r * 0.92, 0, Math.PI * 2); g.stroke();
      g.lineWidth = r * 0.04;
      g.beginPath(); g.arc(o.w / 2, o.h / 2, r * 0.74, 0, Math.PI * 2); g.stroke();
      g.font = `700 ${r * (t.length > 1 ? 0.62 : 0.95)}px ${FONT_FAMILIES.mincho.css}`;
      g.fillText(t, o.w / 2, o.h / 2 + r * 0.04);
    } else if (o.style === 'icon') {
      g.font = `700 ${o.h * 0.92}px ${FONT_FAMILIES.gothic.css}`;
      g.fillText(t, o.w / 2, o.h / 2 + o.h * 0.04);
    } else {
      const r = o.h * 0.22;
      g.lineWidth = Math.max(1, o.h * 0.07);
      g.beginPath(); roundRectPath(g, g.lineWidth / 2, g.lineWidth / 2, o.w - g.lineWidth, o.h - g.lineWidth, r);
      g.globalAlpha = 0.1; g.fill(); g.globalAlpha = 1; g.stroke();
      g.font = `700 ${o.h * 0.56}px ${FONT_FAMILIES.gothic.css}`;
      g.fillText(t, o.w / 2, o.h / 2 + o.h * 0.03);
    }
  } else if (k === 'link') {
    g.fillStyle = 'rgba(70,130,230,.10)';
    g.fillRect(0, 0, o.w, o.h);
    g.strokeStyle = 'rgba(70,130,230,.75)'; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.strokeRect(0, 0, o.w, o.h);
    g.setLineDash([]);
    g.font = `${Math.min(14, o.h * 0.6)}px ${FONT_FAMILIES.gothic.css}`; g.fillStyle = 'rgba(40,90,200,.9)'; g.textBaseline = 'top';
    g.fillText('🔗', o.w - Math.min(14, o.h * 0.6) - 2, 2);
  }
  g.restore();
}
function roundRectPath(g, x, y, w, h, r) {
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
/* 物を 1 枚の canvas に（PDF 書き出し用。K 倍の細かさ） */
function objectCanvas(o, K = 4) {
  const c = document.createElement('canvas');
  const pad = o.bg ? 8 : 0;           // 付箋の影の分
  c.width = Math.max(1, Math.ceil((o.w + pad * 2) * K)); c.height = Math.max(1, Math.ceil((o.h + pad * 2) * K));
  const g = c.getContext('2d');
  g.scale(K, K);
  drawObject(g, { ...o, x: pad, y: pad, rot: 0, _lay: null });
  return { canvas: c, pad };
}
/* 検索用: 物の文字 */
function objectsText(p) {
  return (p.images || []).filter((o) => o.kind === 'text' || o.kind === 'stamp').map((o) => (o.kind === 'text' ? o.text : stampText(o))).join('\n');
}

// ================= 文字の道具
/* タップ = 新しい文字（既にある文字の上なら書き直し）、横にドラッグ = 幅を決めて新しい文字。入力は本物の textarea（iPad の手書き入力スクリブルも使える） */
class TextTool {
  constructor(app) { this.app = app; this.showsHover = false; this.start = null; this.edit = null; }
  get opt() { return this.app.toolState.text; }
  down(p, v) {
    if (this.edit) { this.commit(v); return; }
    const n = v.note, hit = n.pageAt(p.X, p.Y, 0);
    if (!hit.inside) return;
    const q = n.docToPage(hit.page, p.X, p.Y);
    this.start = { page: hit.page, q, cur: q };
  }
  move(p, v) { if (this.start) { this.start.cur = v.note.docToPage(this.start.page, p.X, p.Y); v.requestOver(); } }
  up(p, v) {
    const S = this.start;
    this.start = null;
    if (!S) return;
    const page = S.page, q = S.q;
    const drag = Math.abs(S.cur.x - q.x) * v.s > 20;
    const exist = !drag && (page.images || []).slice().reverse().find((o) => o.kind === 'text' && imageHit(o, q.x, q.y));
    if (exist) { this.open(v, page, exist, false); return; }
    const o = this.opt, size = o.size;
    const w = drag ? Math.abs(S.cur.x - q.x) : Math.min(page.infinite ? 320 : page.w - q.x - 10, Math.max(160, size * 14));
    const obj = { id: uid('m'), kind: 'text', x: drag ? Math.min(q.x, S.cur.x) : q.x, y: q.y - size * 0.8, w: Math.max(size * 3, w), h: size * 1.6, rot: 0,
      text: '', size, color: o.color, font: o.font, bold: !!o.bold, bg: null };
    this.open(v, page, obj, true);
  }
  cancel(v) { this.start = null; v.requestOver(); }
  drawOverlay(g, v) {
    const S = this.start;
    if (!S || Math.abs(S.cur.x - S.q.x) * v.s < 20) return;
    v.withPage(g, S.page, (gg) => {
      gg.strokeStyle = '#3d7be0'; gg.lineWidth = 1.2 / v.s; gg.setLineDash([5 / v.s, 4 / v.s]);
      gg.strokeRect(Math.min(S.q.x, S.cur.x), S.q.y - this.opt.size * 0.8, Math.abs(S.cur.x - S.q.x), this.opt.size * 1.6);
    });
  }

  /* 書いている文字の上に textarea を重ねる */
  open(v, page, obj, isNew) {
    const ta = $('#text-editor');
    this.edit = { page, obj: { ...obj }, orig: obj, isNew };
    v.hidden = new Set([obj.id]);
    v.invalidate();
    ta.value = obj.text || '';
    ta.hidden = false;
    this.place(v);
    ta.oninput = () => { this.edit.obj.text = ta.value; this.place(v); };
    ta.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.commit(v); } };
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 20);
    this.app.renderQuick();
  }
  place(v) {
    const E = this.edit, ta = $('#text-editor');
    if (!E) return;
    const o = E.obj;
    fitTextHeight(o);
    const n = v.note, pm = n.pageMatrix(E.page);
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const c = v.toScreen(pm.a * cx + pm.c * cy + pm.e, pm.b * cx + pm.d * cy + pm.f);
    const ang = Math.atan2(pm.b, pm.a) + v.rot + (o.rot || 0);
    const pad = textPad(o);
    Object.assign(ta.style, {
      left: c.x - (o.w * v.s) / 2 + 'px', top: c.y - (o.h * v.s) / 2 + 'px', width: o.w * v.s + 'px', height: o.h * v.s + 'px',
      transform: `rotate(${ang}rad)`, font: objFont({ ...o, size: o.size * v.s }), lineHeight: o.size * 1.45 * v.s + 'px',
      padding: pad * v.s + 'px', color: o.color, background: o.bg || 'rgba(255,255,255,.55)',
    });
  }
  /* 確定（空なら消す）。変わっていれば履歴に */
  commit(v) {
    const E = this.edit;
    if (!E) return;
    this.edit = null;
    const ta = $('#text-editor');
    ta.hidden = true; ta.oninput = null; ta.blur();
    v.hidden = null;
    const o = E.obj, page = E.page;
    o.text = o.text.replace(/\s+$/, '');
    fitTextHeight(o);
    const ib = (page.images || []).slice();
    let after = null;
    if (E.isNew) { if (o.text) after = ib.concat([o]); }
    else if (!o.text) after = ib.filter((x) => x.id !== o.id);
    else if (o.text !== E.orig.text || o.size !== E.orig.size || o.color !== E.orig.color || o.font !== E.orig.font || o.bold !== E.orig.bold || o.bg !== E.orig.bg)
      after = ib.map((x) => (x.id === o.id ? o : x));
    if (after) v.note.swapBoth(page, page.strokes.slice(), page.strokes.slice(), ib, after, E.isNew ? '文字' : '文字を直す');
    v.invalidate();
    this.app.renderQuick();
    this.app.updateStatus();
  }
  /* 編集中の文字の見た目を変える（クイックバーから） */
  restyle(v, patch) {
    if (!this.edit) return false;
    Object.assign(this.edit.obj, patch);
    this.edit.obj._lay = null;
    this.place(v);
    return true;
  }
}

// ================= レーザーポインター（残らない。少しで消える）
class LaserTool {
  constructor(app) { this.app = app; this.showsHover = true; this.trails = []; this.cur = null; this._raf = 0; }
  down(p, v) { this.cur = { pts: [[p.X, p.Y, performance.now()]] }; this.trails.push(this.cur); this.loop(v); }
  move(p, v) { if (this.cur) this.cur.pts.push([p.X, p.Y, performance.now()]); }
  up(p, v) { if (this.cur) this.cur.end = performance.now(); this.cur = null; }
  cancel(v) { this.cur = null; this.trails = []; v.requestOver(); }
  loop(v) {
    if (this._raf) return;
    const step = () => {
      this._raf = 0;
      const now = performance.now();
      this.trails = this.trails.filter((t) => !t.end || now - t.end < 900);
      for (const t of this.trails) if (!t.end) while (t.pts.length > 2 && now - t.pts[0][2] > 1400) t.pts.shift();
      v.requestOver();
      if (this.trails.length) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  drawOverlay(g, v) {
    const now = performance.now(), d = v.dpr;
    g.save();
    g.setTransform(d, 0, 0, d, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const t of this.trails) {
      const fade = t.end ? 1 - (now - t.end) / 900 : 1;
      if (fade <= 0 || !t.pts.length) continue;
      const sp = t.pts.map((q) => v.toScreen(q[0], q[1]));
      for (const [w, col] of [[14, 'rgba(255,40,40,.18)'], [7, 'rgba(255,60,60,.5)'], [3, 'rgba(255,235,235,.95)']]) {
        g.globalAlpha = fade;
        g.strokeStyle = col; g.lineWidth = w;
        g.beginPath(); g.moveTo(sp[0].x, sp[0].y); for (const q of sp) g.lineTo(q.x, q.y);
        if (sp.length === 1) g.lineTo(sp[0].x + 0.1, sp[0].y);
        g.stroke();
      }
    }
    g.restore();
  }
  drawHover(g, v, P) {
    const sp = v.toScreen(P.x, P.y), d = v.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.beginPath(); g.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,50,50,.85)'; g.shadowColor = 'rgba(255,0,0,.8)'; g.shadowBlur = 12; g.fill(); g.shadowBlur = 0;
  }
}
