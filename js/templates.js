'use strict';
/* テンプレート集: 勉強・仕事の用紙（議事録・習慣トラッカー・勉強ノート・2段・絵コンテ）、プランナー（年・月・週・日。祝日つき・ページ間リンク）、
   自作テンプレート（PDF・画像から）、表紙。
   用紙は「描く物の並び（display list）」で作る → 画面（canvas）と PDF（PdfCtx）が同じ物を描ける。リンクの場所も同じ計算から出す。 */

const P_INK = { white: '#4b5260', cream: '#5e5440', gray: '#4f545c', dark: '#c4c9d2', green: '#466048' };
const P_SUB = { white: '#8a909c', cream: '#9a8f72', gray: '#8a8f97', dark: '#7d848f', green: '#7f957f' };
const SUN = '#d0473f', SAT = '#3a68c8';
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const TM = 30;            // 余白

// ---- 日付
function ymd(dt) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(dt, n) { const d = new Date(dt); d.setDate(d.getDate() + n); return d; }
function mondayOf(dt) { return addDays(dt, -((dt.getDay() + 6) % 7)); }
function isoWeek(dt) {
  const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y0) / 86400000 + 1) / 7);
}
/* 日本の祝日（振替休日・国民の休日を含む。春分・秋分は計算式で 2099 年まで） */
const _hol = new Map();
function jpHolidays(y) {
  if (_hol.has(y)) return _hol.get(y);
  const H = new Map();
  const add = (m, d, name) => H.set(ymd(new Date(y, m - 1, d)), name);
  const nthMon = (m, n) => { const w = new Date(y, m - 1, 1).getDay(); return 1 + ((8 - w) % 7) + (n - 1) * 7; };
  const eq = (base) => Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  add(1, 1, '元日'); add(1, nthMon(1, 2), '成人の日'); add(2, 11, '建国記念の日'); add(2, 23, '天皇誕生日');
  add(3, eq(20.8431), '春分の日'); add(4, 29, '昭和の日'); add(5, 3, '憲法記念日'); add(5, 4, 'みどりの日'); add(5, 5, 'こどもの日');
  add(7, nthMon(7, 3), '海の日'); add(8, 11, '山の日'); add(9, nthMon(9, 3), '敬老の日'); add(9, eq(23.2488), '秋分の日');
  add(10, nthMon(10, 2), 'スポーツの日'); add(11, 3, '文化の日'); add(11, 23, '勤労感謝の日');
  for (const k of [...H.keys()]) {            // 国民の休日（祝日にはさまれた平日）
    const d = parseYmd(k), mid = addDays(d, 1);
    if (H.has(ymd(addDays(d, 2))) && !H.has(ymd(mid)) && mid.getDay() !== 0) H.set(ymd(mid), '国民の休日');
  }
  for (const k of [...H.keys()].sort()) {     // 振替休日
    const d = parseYmd(k);
    if (d.getDay() !== 0) continue;
    let n = addDays(d, 1);
    while (H.has(ymd(n))) n = addDays(n, 1);
    H.set(ymd(n), '振替休日');
  }
  _hol.set(y, H);
  return H;
}
function holidayName(dt) { return jpHolidays(dt.getFullYear()).get(ymd(dt)) || ''; }
function dayColor(dt, ink) { return holidayName(dt) || dt.getDay() === 0 ? SUN : dt.getDay() === 6 ? SAT : ink; }

// ---- 描く物の並び
class Lay {
  constructor(pc) { this.els = []; this.links = []; this.ink = P_INK[pc.id] || P_INK.white; this.sub = P_SUB[pc.id] || P_SUB.white; this.line = pc.line; this.strong = pc.strong; }
  text(text, x, y, size, color, opt = {}) { this.els.push({ t: 'text', text, x, y, size, color: color || this.ink, bold: !!opt.bold, align: opt.align || 'left' }); }
  lines(segs, color, w = 0.5) { this.els.push({ t: 'lines', segs, c: color || this.line, w }); }
  rect(x, y, w, h, opt = {}) { this.els.push({ t: 'rect', x, y, w, h, r: opt.r || 0, c: opt.c === undefined ? this.sub : opt.c, lw: opt.lw || 0.8, fill: opt.fill || null }); }
  link(x, y, w, h, to) { this.links.push({ rect: [x, y, w, h], to }); }
  /* 罫線を y0〜y1 に step ごと */
  ruled(x0, x1, y0, y1, step, color) { const s = []; for (let y = y0; y <= y1 + 0.01; y += step) s.push(x0, y, x1, y); this.lines(s, color); }
  checkbox(x, y, s) { this.rect(x, y, s, s, { r: 1.5, c: this.sub, lw: 0.8 }); }
  /* 見出し＋右上の移動ボタン（年間・月・週） */
  header(w, title, sub, nav) {
    this.text(title, TM, TM + 22, 20, this.ink, { bold: true });
    if (sub) this.text(sub, TM, TM + 40, 10, this.sub);
    let x = w - TM;
    for (const n of nav.slice().reverse()) {
      const cw = n.label.length * 11 + 18;
      x -= cw;
      this.rect(x, TM + 6, cw, 20, { r: 10, c: this.sub, lw: 0.8 });
      this.text(n.label, x + cw / 2, TM + 20, 10, this.sub, { align: 'center' });
      this.link(x, TM + 6, cw, 20, n.to);
      x -= 6;
    }
    this.lines([TM, TM + 50, w - TM, TM + 50], this.strong, 0.9);
  }
}
function drawLayout(g, L) {
  for (const e of L.els) {
    if (e.t === 'lines') {
      g.beginPath();
      for (let i = 0; i < e.segs.length; i += 4) { g.moveTo(e.segs[i], e.segs[i + 1]); g.lineTo(e.segs[i + 2], e.segs[i + 3]); }
      g.strokeStyle = e.c; g.lineWidth = e.w; g.stroke();
    } else if (e.t === 'rect') {
      g.beginPath();
      if (e.r) roundRectPath(g, e.x, e.y, e.w, e.h, e.r); else g.rect(e.x, e.y, e.w, e.h);
      if (e.fill) { g.fillStyle = e.fill; g.fill(); }
      if (e.c) { g.strokeStyle = e.c; g.lineWidth = e.lw; g.stroke(); }
    } else if (e.t === 'text') {
      g.save();
      g.font = `${e.bold ? '700 ' : ''}${e.size}px ${FONT_FAMILIES.gothic.css}`;
      g.fillStyle = e.color;
      let x = e.x;
      if (e.align !== 'left') { const tw = g.measureText(e.text).width; x -= e.align === 'center' ? tw / 2 : tw; }
      g.fillText(e.text, x, e.y);
      g.restore();
    }
  }
}

// ---- 勉強・仕事の用紙
const SHEETS = {
  meeting(L, w, h) {
    L.text('議事録', TM, TM + 22, 20, L.ink, { bold: true });
    const fields = ['日付', '時間', '場所', '参加者', '議題'];
    let y = TM + 40;
    for (const f of fields) { L.text(f, TM, y + 16, 10, L.sub); L.lines([TM + 52, y + 22, w - TM, y + 22], L.line, 0.6); y += 24; }
    const rest = h - TM - y - 20;
    const sec = (label, y0, hh, checks) => {
      L.rect(TM, y0, w - TM * 2, hh, { r: 4, c: L.sub, lw: 0.8 });
      L.text(label, TM + 8, y0 + 16, 11, L.ink, { bold: true });
      for (let yy = y0 + 40, i = 0; yy < y0 + hh - 6; yy += 22, i++) {
        if (checks) L.checkbox(TM + 10, yy - 12, 9);
        L.lines([TM + (checks ? 26 : 8), yy, w - TM - 8, yy], L.line, 0.5);
      }
    };
    sec('内容', y + 10, rest * 0.52, false);
    sec('決定事項', y + 18 + rest * 0.52, rest * 0.22, false);
    sec('ToDo（担当・期限）', y + 26 + rest * 0.74, rest * 0.26, true);
  },
  habit(L, w, h, paper) {
    L.text('習慣トラッカー', TM, TM + 22, 20, L.ink, { bold: true });
    L.text('年　　月', w - TM - 80, TM + 22, 12, L.sub);
    const nameW = Math.min(130, w * 0.22), x0 = TM + nameW, cw = (w - TM - x0) / 31, y0 = TM + 46, rh = 26;
    const rows = Math.floor((h - TM - y0 - 20 - 120) / rh);
    for (let d = 0; d < 31; d++) L.text(String(d + 1), x0 + cw * d + cw / 2, y0 + 14, Math.min(9, cw * 0.62), L.sub, { align: 'center' });
    L.text('習慣', TM + 4, y0 + 14, 10, L.sub);
    const segs = [];
    for (let r = 0; r <= rows; r++) segs.push(TM, y0 + 20 + r * rh, w - TM, y0 + 20 + r * rh);
    for (let d = 0; d <= 31; d++) segs.push(x0 + cw * d, y0 + 20, x0 + cw * d, y0 + 20 + rows * rh);
    segs.push(TM, y0 + 20, TM, y0 + 20 + rows * rh);
    L.lines(segs, L.line, 0.6);
    const my = y0 + 20 + rows * rh + 24;
    L.text('ふりかえり', TM, my, 11, L.ink, { bold: true });
    L.ruled(TM, w - TM, my + 18, h - TM, 22);
  },
  study(L, w, h) {
    const fields = [['日付', 0.25], ['科目', 0.3], ['範囲・目標', 0.45]];
    let x = TM;
    for (const [f, k] of fields) {
      const fw = (w - TM * 2) * k;
      L.text(f, x, TM + 20, 9, L.sub);
      L.lines([x, TM + 32, x + fw - 10, TM + 32], L.sub, 0.7);
      x += fw;
    }
    const sumH = h * 0.16, y1 = h - TM - sumH - 14;
    L.ruled(TM, w - TM, TM + 62, y1, 22);
    L.lines([TM + 52, TM + 46, TM + 52, y1], L.strong, 0.7);
    L.rect(TM, h - TM - sumH, w - TM * 2, sumH, { r: 4 });
    L.text('今日のまとめ・できなかったこと', TM + 8, h - TM - sumH + 16, 10, L.ink, { bold: true });
  },
  twocol(L, w, h) {
    const mid = w / 2;
    L.ruled(TM, mid - 10, TM + 40, h - TM, 22);
    L.ruled(mid + 10, w - TM, TM + 40, h - TM, 22);
    L.lines([mid, TM + 20, mid, h - TM], L.strong, 0.7);
  },
  storyboard(L, w, h) {
    L.text('絵コンテ', TM, TM + 20, 16, L.ink, { bold: true });
    L.text('タイトル', w * 0.4, TM + 20, 9, L.sub); L.lines([w * 0.4 + 40, TM + 22, w - TM, TM + 22], L.sub, 0.6);
    const n = h > w ? 4 : 3, y0 = TM + 36, rh = (h - TM - y0) / n, fw = Math.min((w - TM * 2) * 0.55, (rh - 20) * (16 / 9));
    for (let i = 0; i < n; i++) {
      const y = y0 + i * rh;
      L.text(`No. ${i + 1}`, TM, y + 12, 9, L.sub);
      L.rect(TM, y + 18, fw, fw * (9 / 16), { c: L.ink, lw: 0.9 });
      const tx = TM + fw + 12;
      L.text('内容・セリフ', tx, y + 12, 9, L.sub);
      L.ruled(tx, w - TM, y + 36, y + 18 + fw * (9 / 16), 18);
      L.text('秒', w - TM - 30, y + 12, 9, L.sub);
    }
  },
};

// ---- プランナー
function plannerHeaderNav(kind, dt) {
  const nav = [{ label: '年間', to: 'year' }];
  if (kind === 'week' || kind === 'day') nav.push({ label: '月', to: `m:${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}` });
  if (kind === 'day') nav.push({ label: '週', to: 'w:' + ymd(mondayOf(dt)) });
  return nav;
}
const PLANNER = {
  'p-year'(L, w, h, P) {
    const y = P.y, m0 = P.m || 0;
    L.header(w, m0 ? `${y}年${m0 + 1}月〜` : `${y}年`, '年間カレンダー', []);
    const cols = w > h ? 4 : 3, rows = 12 / cols, x0 = TM, y0 = TM + 60, cw = (w - TM * 2) / cols, ch = (h - TM - y0) / rows;
    for (let i = 0; i < 12; i++) {
      const first = new Date(y, m0 + i, 1), cx = x0 + (i % cols) * cw, cy = y0 + Math.floor(i / cols) * ch;
      const label = (i > 0 && first.getMonth() === 0) || (i === 0 && m0) ? `${first.getFullYear()}年${first.getMonth() + 1}月` : `${first.getMonth() + 1}月`;
      L.text(label, cx + 6, cy + 16, 11, L.ink, { bold: true });
      L.link(cx, cy, cw, ch, `m:${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`);
      const gx = cx + 6, gy = cy + 24, gw = cw - 12, gh = ch - 30, dcw = gw / 7, rh = gh / 7;
      for (let k = 0; k < 7; k++) L.text('月火水木金土日'[k], gx + dcw * k + dcw / 2, gy + rh * 0.7, Math.min(7, rh * 0.6), k === 5 ? SAT : k === 6 ? SUN : L.sub, { align: 'center' });
      const start = mondayOf(first);
      for (let r = 0; r < 6; r++) for (let k = 0; k < 7; k++) {
        const d = addDays(start, r * 7 + k);
        if (d.getMonth() !== first.getMonth()) continue;
        L.text(String(d.getDate()), gx + dcw * k + dcw / 2, gy + rh * (r + 1) + rh * 0.72, Math.min(7.5, rh * 0.62), dayColor(d, L.ink), { align: 'center' });
      }
    }
  },
  'p-month'(L, w, h, P) {
    const first = new Date(P.y, P.m, 1);
    L.header(w, `${P.y}年 ${P.m + 1}月`, '', plannerHeaderNav('month', first));
    const start = mondayOf(first), last = new Date(P.y, P.m + 1, 0);
    const rows = Math.ceil(((last - start) / 86400000 + 1) / 7);
    const wkW = 24, gx = TM + wkW, gy = TM + 60, gw = w - TM - gx, hdr = 18, cw = gw / 7, rh = (h - TM - gy - hdr) / rows;
    for (let k = 0; k < 7; k++) L.text('月火水木金土日'[k], gx + cw * k + cw / 2, gy + 13, 10, k === 5 ? SAT : k === 6 ? SUN : L.sub, { align: 'center', bold: true });
    const segs = [];
    for (let r = 0; r <= rows; r++) segs.push(TM, gy + hdr + r * rh, w - TM, gy + hdr + r * rh);
    for (let k = 0; k <= 7; k++) segs.push(gx + cw * k, gy + hdr, gx + cw * k, gy + hdr + rows * rh);
    segs.push(TM, gy + hdr, TM, gy + hdr + rows * rh);
    L.lines(segs, L.sub, 0.6);
    for (let r = 0; r < rows; r++) {
      const mon = addDays(start, r * 7), cy = gy + hdr + r * rh;
      L.text('W' + isoWeek(mon), TM + wkW / 2, cy + rh / 2 + 3, 8, L.sub, { align: 'center' });
      L.link(TM, cy, wkW, rh, 'w:' + ymd(mon));
      for (let k = 0; k < 7; k++) {
        const d = addDays(mon, k), cx = gx + cw * k;
        const inMonth = d.getMonth() === P.m;
        L.text(String(d.getDate()), cx + 5, cy + 14, inMonth ? 11 : 8, inMonth ? dayColor(d, L.ink) : L.line, { bold: inMonth });
        if (!inMonth) continue;
        const hn = holidayName(d);
        if (hn) L.text(hn, cx + 5, cy + 25, Math.min(7.5, cw / (hn.length + 1)), SUN);
        L.link(cx, cy, cw, rh, 'd:' + ymd(d));
      }
    }
  },
  'p-week'(L, w, h, P) {
    const mon = new Date(P.y, P.m, P.d), sun = addDays(mon, 6);
    L.header(w, `${mon.getMonth() + 1}月${mon.getDate()}日 〜 ${sun.getMonth() + 1}月${sun.getDate()}日`, `${mon.getFullYear()}年 第${isoWeek(mon)}週`, plannerHeaderNav('week', mon));
    const y0 = TM + 60, gap = 8, bw = (w - TM * 2 - gap) / 2, bh = (h - TM - y0 - gap * 3) / 4;
    for (let i = 0; i < 8; i++) {
      const col = i < 4 ? 0 : 1, row = i % 4, bx = TM + col * (bw + gap), by = y0 + row * (bh + gap);
      L.rect(bx, by, bw, bh, { r: 4 });
      if (i === 7) { L.text('メモ', bx + 8, by + 15, 11, L.ink, { bold: true }); L.ruled(bx + 8, bx + bw - 8, by + 40, by + bh - 6, 20); continue; }
      const d = addDays(mon, i);
      L.text(`${d.getDate()}（${WD[d.getDay()]}）`, bx + 8, by + 15, 11, dayColor(d, L.ink), { bold: true });
      const hn = holidayName(d);
      if (hn) L.text(hn, bx + 60, by + 15, 8, SUN);
      L.link(bx, by, bw, 22, 'd:' + ymd(d));
      L.ruled(bx + 8, bx + bw - 8, by + 40, by + bh - 6, 20);
    }
  },
  'p-day'(L, w, h, P) {
    const d = new Date(P.y, P.m, P.d), hn = holidayName(d);
    L.header(w, `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`, `${d.getFullYear()}年${hn ? '　' + hn : ''}`, plannerHeaderNav('day', d));
    const y0 = TM + 62, lw = (w - TM * 2) * 0.48, rx = TM + lw + 16, rw = w - TM - rx;
    L.text('スケジュール', TM, y0 + 4, 11, L.ink, { bold: true });
    const hours = 18, rh = (h - TM - y0 - 16) / hours;
    const segs = [];
    for (let i = 0; i <= hours; i++) {
      const yy = y0 + 16 + i * rh;
      segs.push(TM + 34, yy, TM + lw, yy);
      if (i < hours) L.text(`${6 + i}:00`, TM + 28, yy + 10, 8, L.sub, { align: 'right' });
    }
    segs.push(TM + 34, y0 + 16, TM + 34, y0 + 16 + hours * rh);
    L.lines(segs, L.line, 0.6);
    L.text('ToDo', rx, y0 + 4, 11, L.ink, { bold: true });
    const th = (h - TM - y0) * 0.42;
    for (let yy = y0 + 34, i = 0; yy < y0 + th; yy += 24, i++) { L.checkbox(rx, yy - 12, 10); L.lines([rx + 16, yy, rx + rw, yy], L.line, 0.5); }
    L.text('メモ', rx, y0 + th + 20, 11, L.ink, { bold: true });
    L.ruled(rx, rx + rw, y0 + th + 40, h - TM, 22);
  },
};

/* 用紙の並び（キャッシュ）。テンプレートの種類でなければ null */
const _layCache = new Map();
function templateLayout(pg, pc) {
  const P = pg.paper || {}, fn = SHEETS[P.type] || PLANNER[P.type];
  if (!fn) return null;
  const key = `${P.type}|${pc.id}|${pg.w}|${pg.h}|${P.y}|${P.m}|${P.d}`;
  let L = _layCache.get(key);
  if (!L) {
    L = new Lay(pc);
    fn(L, pg.w, pg.h, P);
    _layCache.set(key, L);
    if (_layCache.size > 300) _layCache.delete(_layCache.keys().next().value);
  }
  return L;
}

/* プランナーのページを作る。opt: {year, month(0〜11), parts:{year,month,week,day}, w, h, color} */
function buildPlanner(opt) {
  const { year, month, parts, w, h, color } = opt;
  const pages = [], ids = new Map();
  const mk = (key, paper) => { const p = { id: uid('p'), w, h, rot: 0, infinite: false, paper: { ...paper, color }, strokes: [], images: [] }; ids.set(key, p.id); pages.push(p); return p; };
  if (parts.year) mk('year', { type: 'p-year', y: year, m: month });
  const first = new Date(year, month, 1), end = new Date(year, month + 12, 0);
  if (parts.month) for (let i = 0; i < 12; i++) { const d = new Date(year, month + i, 1); mk(`m:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, { type: 'p-month', y: d.getFullYear(), m: d.getMonth() }); }
  if (parts.week) for (let d = mondayOf(first); d <= end; d = addDays(d, 7)) mk('w:' + ymd(d), { type: 'p-week', y: d.getFullYear(), m: d.getMonth(), d: d.getDate() });
  if (parts.day) for (let d = new Date(first); d <= end; d = addDays(d, 1)) mk('d:' + ymd(d), { type: 'p-day', y: d.getFullYear(), m: d.getMonth(), d: d.getDate() });
  // リンク（行き先が無ければ、日 → その週）
  const resolve = (to) => {
    if (ids.has(to)) return ids.get(to);
    if (to.startsWith('d:')) return ids.get('w:' + ymd(mondayOf(parseYmd(to.slice(2))))) || ids.get('m:' + to.slice(2, 9)) || null;
    return null;
  };
  const pc = PAPER_COLORS.find((c) => c.id === color) || PAPER_COLORS[0];
  for (const p of pages) {
    const L = templateLayout(p, pc);
    for (const lk of L.links) {
      const id = resolve(lk.to);
      if (!id || id === p.id) continue;
      const [x, y, lw, lh] = lk.rect;
      p.images.push({ id: uid('m'), kind: 'link', hidden: true, x, y, w: lw, h: lh, rot: 0, to: { page: id } });
    }
  }
  return pages;
}

// ================= 自作テンプレート（PDF・画像から）。中身は blobs、一覧は localStorage
const MyTemplates = {
  list() { try { return JSON.parse(localStorage.getItem(LS + 'templates') || '[]'); } catch { return []; } },
  save(list) { try { localStorage.setItem(LS + 'templates', JSON.stringify(list)); } catch { toast('テンプレートを保存できません（容量）', { error: true }); } },
  /* ファイル → テンプレート（PDF は 1 ページずつ、20 ページまで） */
  async add(file) {
    const out = [];
    if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
      const pages = await pagesFromPdf(file);
      for (const p of pages.slice(0, 20)) {
        const t = { id: uid('t'), name: file.name.replace(/\.pdf$/i, '') + (pages.length > 1 ? ` p.${p.bg.page + 1}` : ''), kind: 'pdf', src: p.bg.src, page: p.bg.page, vt: p.bg.vt, w: p.w, h: p.h };
        const r = await BgRender.ensure(p, 160 / p.w);
        if (r) { const c = el('canvas', { width: 120, height: Math.round(120 * p.h / p.w) }); c.getContext('2d').drawImage(r.canvas, 0, 0, c.width, c.height); t.thumb = c.toDataURL('image/jpeg', 0.8); }
        out.push(t);
      }
    } else {
      const r = await storeImage(file);
      const w = 595, h = Math.round((595 * r.h) / r.w);
      const t = { id: uid('t'), name: file.name.replace(/\.[^.]+$/, ''), kind: 'image', src: r.src, w, h };
      const img = await loadImageEl(file);
      const c = el('canvas', { width: 120, height: Math.round(120 * h / w) }); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      t.thumb = c.toDataURL('image/jpeg', 0.8);
      out.push(t);
    }
    this.save(this.list().concat(out));
    return out;
  },
  remove(id) { this.save(this.list().filter((t) => t.id !== id)); },
  /* このテンプレートの白紙のページ */
  page(t, color = 'white') {
    const p = { id: uid('p'), w: t.w, h: t.h, rot: 0, infinite: false, strokes: [], images: [], paper: { type: 'blank', color } };
    if (t.kind === 'pdf') p.bg = { src: t.src, page: t.page, vt: t.vt, tpl: true };
    else p.paper = { type: 'image', src: t.src, color };
    return p;
  },
};

// ================= 表紙
const COVER_COLORS = ['#2f4a7a', '#3f7d6a', '#8a3b3b', '#c27b2c', '#6a4a8a', '#2d2f36', '#9aa3ad', '#d9c7a3', '#e7a2a8', '#7fb3d5'];
const COVER_STYLES = [['plain', '無地'], ['stripe', 'ストライプ'], ['dots', 'ドット'], ['band', '帯'], ['grad', 'グラデーション']];
/* 表紙の見た目（CSS）。本棚のカードと選ぶ画面で使う */
function coverStyle(cv) {
  if (!cv) return {};
  if (cv.style === 'image' && cv.img) return { backgroundImage: `url(${cv.img})`, backgroundSize: 'cover', backgroundPosition: 'center' };
  const c = cv.color || COVER_COLORS[0];
  switch (cv.style) {
    case 'stripe': return { background: `repeating-linear-gradient(135deg, ${c} 0 14px, color-mix(in srgb, ${c} 82%, #fff) 14px 28px)` };
    case 'dots': return { background: `radial-gradient(color-mix(in srgb, ${c} 60%, #fff) 2px, transparent 2.5px) 0 0 / 14px 14px, ${c}` };
    case 'band': return { background: `linear-gradient(${c} 0 62%, #f4f1ea 62% 78%, ${c} 78%)` };
    case 'grad': return { background: `linear-gradient(160deg, color-mix(in srgb, ${c} 55%, #fff), ${c} 70%)` };
    default: return { background: c };
  }
}
function coverEl(cv, name) {
  const dark = !(cv.style === 'band' || /^#(d9|e7|9a|7f)/i.test(cv.color || ''));
  return el('div', { class: 'cover cv', style: coverStyle(cv) },
    cv.style === 'image' ? null : el('span', { class: 'cv-title' + (dark ? '' : ' ink') + (cv.style === 'band' ? ' band' : '') }, name));
}
/* 表紙を選ぶ。戻り値: 表紙 / null（1 ページ目の絵に戻す）/ undefined（やめた） */
async function coverDialog(cur, name) {
  let pick = cur ? { ...cur } : null;
  const preview = el('div', { class: 'cv-preview' });
  const draw = () => { preview.innerHTML = ''; preview.append(pick ? coverEl(pick, name) : el('div', { class: 'cover cv none' }, '1 ページ目')); };
  const styles = el('div', { class: 'cv-row' }), colors = el('div', { class: 'cv-row' });
  for (const [s, label] of COVER_STYLES) styles.append(el('button', { class: 'chip', onclick: () => { pick = { style: s, color: (pick && pick.color) || COVER_COLORS[0] }; draw(); } }, label));
  for (const c of COVER_COLORS) colors.append(el('button', { class: 'swatch', style: { '--c': c }, onclick: () => { pick = { style: pick && pick.style !== 'image' ? pick.style : 'plain', color: c }; draw(); } }));
  const imgBtn = el('button', { class: 'chip', onclick: async () => {
    const f = (await pickFiles('image/*', false))[0];
    if (!f) return;
    const im = await loadImageEl(f), W = 360, H = 480, c = el('canvas', { width: W, height: H }), g = c.getContext('2d');
    const k = Math.max(W / im.width, H / im.height);
    g.drawImage(im, (W - im.width * k) / 2, (H - im.height * k) / 2, im.width * k, im.height * k);
    pick = { style: 'image', img: c.toDataURL('image/jpeg', 0.82) };
    draw();
  } }, '画像…');
  const none = el('button', { class: 'chip', onclick: () => { pick = null; draw(); } }, '1 ページ目の絵');
  draw();
  const v = await modal('表紙', el('div', { class: 'cv-dialog' }, preview, el('div', {}, styles, colors, el('div', { class: 'cv-row' }, imgBtn, none))),
    [{ label: 'キャンセル', value: 'cancel' }, { label: '決める', primary: true, value: 'ok' }], { wide: true });
  return v === 'ok' ? pick : undefined;
}
