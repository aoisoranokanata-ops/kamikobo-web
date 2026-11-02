'use strict';
/* テンプレート集: 勉強・仕事の用紙（議事録・習慣トラッカー・勉強ノート・2段・絵コンテ）、書類（入力欄にタイピング）、週間・月間（日付なし・月曜はじまり）、
   ミュージック（大譜表・ギタースコア・TAB 譜・コード表・歌詞とコード）、表紙のページ（paper.accent の色・paper.title の題名）、
   プランナー（年・月・週・日。祝日つき・ページ間リンク）、自作テンプレート（PDF・画像から）、本棚のカードの表紙。
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
  constructor(pc) { this.els = []; this.links = []; this.fields = []; this.ink = P_INK[pc.id] || P_INK.white; this.sub = P_SUB[pc.id] || P_SUB.white; this.line = pc.line; this.strong = pc.strong; this.bg = pc.bg; }
  text(text, x, y, size, color, opt = {}) { this.els.push({ t: 'text', text, x, y, size, color: color || this.ink, bold: !!opt.bold, align: opt.align || 'left' }); }
  lines(segs, color, w = 0.5) { this.els.push({ t: 'lines', segs, c: color || this.line, w }); }
  rect(x, y, w, h, opt = {}) { this.els.push({ t: 'rect', x, y, w, h, r: opt.r || 0, c: opt.c === undefined ? this.sub : opt.c, lw: opt.lw || 0.8, fill: opt.fill || null }); }
  link(x, y, w, h, to) { this.links.push({ rect: [x, y, w, h], to }); }
  circle(x, y, r, fill) { this.els.push({ t: 'circle', x, y, r, fill }); }
  /* 入力欄（書類の用紙）: ページを作る時に文字の物（kind:'text', field）になる。描く物には入らない */
  field(x, y, w, h, opt = {}) { this.fields.push({ x, y, w, h, ph: opt.ph || '', size: opt.size || 11, bold: !!opt.bold }); }
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
    } else if (e.t === 'circle') {
      g.beginPath(); g.arc(e.x, e.y, e.r, 0, Math.PI * 2); g.fillStyle = e.fill; g.fill();
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

// ---- 書類（入力）: タイピングで書く用紙。L.field の所に入力欄（文字の物）を置く。タップでキーボード
/* 見出し（左）＋入力欄（右）の 1 行 */
function docRow(L, label, x, y, w, h, opt = {}) {
  const lw = opt.lw || 64;
  L.text(label, x + 6, y + h / 2 + 4, 10, L.sub, { bold: true });
  L.lines([x + lw, y + h, x + w, y + h], L.sub, 0.6);
  L.field(x + lw, y + 2, w - lw, h - 4, { ph: opt.ph || label, size: opt.size || 11 });
}
/* 見出しつきの枠（中は入力欄） */
function docBox(L, label, x, y, w, h, ph) {
  L.rect(x, y, w, h, { r: 4 });
  L.text(label, x + 8, y + 16, 10, L.ink, { bold: true });
  L.field(x + 6, y + 24, w - 12, h - 30, { ph: ph || `${label}を入力`, size: 11 });
}
const DOC_SHEETS = {
  /* 文書: 題名と本文だけ */
  'd-plain'(L, w, h) {
    L.field(TM, TM + 6, w - TM * 2, 32, { ph: 'タイトル', size: 18, bold: true });
    L.lines([TM, TM + 44, w - TM, TM + 44], L.strong, 0.9);
    L.field(TM, TM + 54, w - TM * 2, h - TM * 2 - 54, { ph: '本文（タップして入力）', size: 11 });
  },
  /* レポート: 題名・科目・提出日・学籍番号・氏名・本文 */
  'd-report'(L, w, h) {
    L.field(TM, TM + 8, w - TM * 2, 32, { ph: 'レポートの題名', size: 18, bold: true });
    const y0 = TM + 52, cw = (w - TM * 2) / 2, rh = 24;
    L.rect(TM, y0, w - TM * 2, rh * 2, { r: 3 });
    L.lines([TM + cw, y0, TM + cw, y0 + rh * 2, TM, y0 + rh, w - TM, y0 + rh], L.sub, 0.6);
    [['科目', 0, 0], ['提出日', 1, 0], ['学籍番号', 0, 1], ['氏名', 1, 1]].forEach(([lb, c, r]) => {
      const x = TM + c * cw, y = y0 + r * rh;
      L.text(lb, x + 6, y + 16, 9, L.sub, { bold: true });
      L.field(x + 54, y + 3, cw - 60, rh - 6, { ph: lb, size: 11 });
    });
    const by = y0 + rh * 2 + 14;
    L.text('本文', TM, by + 10, 10, L.ink, { bold: true });
    L.lines([TM, by + 16, w - TM, by + 16], L.strong, 0.8);
    L.field(TM, by + 22, w - TM * 2, h - TM - by - 22, { ph: '本文を入力', size: 11 });
  },
  /* 議事録（入力）: 日時・場所・出席者・議題・内容・決定事項・次回・ToDo */
  'd-minutes'(L, w, h) {
    L.text('議事録', TM, TM + 22, 20, L.ink, { bold: true });
    let y = TM + 36;
    for (const [lb, rh] of [['日時', 24], ['場所', 24], ['出席者', 36], ['議題', 24]]) { docRow(L, lb, TM, y, w - TM * 2, rh); y += rh; }
    const rest = h - TM - y - 16;
    docBox(L, '内容', TM, y + 10, w - TM * 2, rest * 0.5);
    docBox(L, '決定事項', TM, y + 16 + rest * 0.5, w - TM * 2, rest * 0.24);
    docBox(L, '次回・ToDo（担当・期限）', TM, y + 22 + rest * 0.74, w - TM * 2, rest * 0.26 - 6);
  },
  /* 日報: 日付・氏名・業務・成果と課題・明日の予定・所感 */
  'd-daily'(L, w, h) {
    L.text('日報', TM, TM + 22, 20, L.ink, { bold: true });
    const half = (w - TM * 2) / 2;
    docRow(L, '日付', TM, TM + 32, half - 8, 24, { lw: 40 });
    docRow(L, '氏名', TM + half + 8, TM + 32, half - 8, 24, { lw: 40 });
    const y = TM + 66, rest = h - TM - y, gap = 8;
    const parts = [['今日の業務', 0.34], ['成果・課題', 0.24], ['明日の予定', 0.22], ['所感・連絡', 0.2]];
    let yy = y;
    for (const [lb, k] of parts) { const bh = rest * k - gap; docBox(L, lb, TM, yy, w - TM * 2, bh); yy += bh + gap; }
  },
  /* 手紙（便箋）: 宛名・本文（罫線に字が乗る）・日付・差出人 */
  'd-letter'(L, w, h) {
    const size = 13, lh = size * 1.45, pad = size * 0.15, x0 = TM + 14, x1 = w - TM - 14;
    L.field(x0, TM + 20, (x1 - x0) * 0.7, 26, { ph: '宛名（○○様）', size: 15, bold: true });
    const top = TM + 62, bottom = h - TM - 92;
    L.field(x0, top, x1 - x0, bottom - top, { ph: '本文（拝啓　…）', size });
    const segs = [];
    for (let yy = top + pad + size * 1.05 + 3; yy < bottom; yy += lh) segs.push(x0, yy, x1, yy);
    L.lines(segs, L.line, 0.5);
    L.field(x1 - 220, h - TM - 82, 220, 22, { ph: '日付', size: 11 });
    L.field(x1 - 220, h - TM - 54, 220, 26, { ph: '差出人', size: 13 });
    L.rect(TM, TM, w - TM * 2, h - TM * 2, { r: 6, c: L.line, lw: 0.8 });
  },
  /* 送付状（FAX・郵送）: 宛先・差出人・日付・枚数・件名・連絡事項 */
  'd-fax'(L, w, h) {
    L.text('送付状', w / 2, TM + 26, 22, L.ink, { bold: true, align: 'center' });
    L.lines([w / 2 - 60, TM + 34, w / 2 + 60, TM + 34], L.strong, 1.2);
    let y = TM + 50;
    const W = w - TM * 2;
    for (const [lb, rh] of [['宛先', 28], ['ご担当', 28], ['差出人', 28], ['電話・FAX', 24], ['日付', 24], ['枚数（本状含む）', 24], ['件名', 28]]) {
      docRow(L, lb, TM, y, W, rh, { lw: lb.length > 5 ? 100 : 72 });
      y += rh;
    }
    docBox(L, '連絡事項', TM, y + 14, W, h - TM - y - 14);
  },
};

// ---- 週間・月間（日付なし。月曜はじまり）
const WD_MON = ['月', '火', '水', '木', '金', '土', '日'];
const wdColor = (k, ink) => (k === 5 ? SAT : k === 6 ? SUN : ink);
function planHead(L, w, title, blank) {
  L.text(title, TM, TM + 22, 20, L.ink, { bold: true });
  L.text(blank, w - TM, TM + 22, 10, L.sub, { align: 'right' });
  L.lines([TM, TM + 32, w - TM, TM + 32], L.strong, 0.9);
}
const PLAN_SHEETS = {
  /* 週間: 月〜日を縦に 7 段、右に ToDo・メモ */
  'w-plan'(L, w, h) {
    planHead(L, w, '週間プラン', '　　年　　月　　日（月）〜　　月　　日（日）');
    const gy = TM + 42;
    L.rect(TM, gy, w - TM * 2, 40, { r: 4 });
    L.text('今週の目標', TM + 8, gy + 15, 10, L.ink, { bold: true });
    const y0 = gy + 52, H0 = h - TM - y0, lw = (w - TM * 2) * 0.64, rx = TM + lw + 10, rw = w - TM - rx, rh = H0 / 7, dw = 38;
    L.rect(TM, y0, lw, H0, { r: 4 });
    const segs = [TM + dw, y0, TM + dw, y0 + H0];
    for (let k = 0; k < 7; k++) {
      const y = y0 + k * rh;
      if (k) segs.push(TM, y, TM + lw, y);
      L.text(WD_MON[k], TM + dw / 2, y + 19, 13, wdColor(k, L.ink), { bold: true, align: 'center' });
      L.text('／', TM + dw / 2, y + 36, 9, L.sub, { align: 'center' });
      L.ruled(TM + dw + 6, TM + lw - 6, y + 22, y + rh - 4, 20);
    }
    L.lines(segs, L.sub, 0.7);
    const th = H0 * 0.56;
    L.rect(rx, y0, rw, th, { r: 4 });
    L.text('ToDo', rx + 8, y0 + 15, 10, L.ink, { bold: true });
    for (let yy = y0 + 38; yy < y0 + th - 6; yy += 22) { L.checkbox(rx + 8, yy - 11, 9); L.lines([rx + 22, yy, rx + rw - 8, yy], L.line, 0.5); }
    L.rect(rx, y0 + th + 8, rw, H0 - th - 8, { r: 4 });
    L.text('メモ', rx + 8, y0 + th + 23, 10, L.ink, { bold: true });
    L.ruled(rx + 8, rx + rw - 8, y0 + th + 44, y0 + H0 - 4, 20);
  },
  /* 週間: 月〜日を横に 7 列、下に目標・メモ */
  'w-plan-col'(L, w, h) {
    planHead(L, w, '週間プラン', '　　年　　月　　日（月）〜　　月　　日（日）');
    const y0 = TM + 42, memo = (h - TM - y0) * 0.2, gh = h - TM - y0 - memo - 10, cw = (w - TM * 2) / 7, hd = 30;
    L.rect(TM, y0, w - TM * 2, gh, { r: 4 });
    const segs = [TM, y0 + hd, w - TM, y0 + hd];
    for (let k = 0; k < 7; k++) {
      const x = TM + k * cw;
      if (k) segs.push(x, y0, x, y0 + gh);
      L.text(WD_MON[k], x + 8, y0 + 19, 12, wdColor(k, L.ink), { bold: true });
      L.text('／', x + cw - 8, y0 + 19, 9, L.sub, { align: 'right' });
      L.ruled(x + 4, x + cw - 4, y0 + hd + 22, y0 + gh - 4, 22);
    }
    L.lines(segs, L.sub, 0.7);
    const my = y0 + gh + 10, half = (w - TM * 2 - 10) / 2;
    L.rect(TM, my, half, memo, { r: 4 }); L.text('今週の目標', TM + 8, my + 15, 10, L.ink, { bold: true }); L.ruled(TM + 8, TM + half - 8, my + 36, my + memo - 4, 20);
    L.rect(TM + half + 10, my, half, memo, { r: 4 }); L.text('メモ', TM + half + 18, my + 15, 10, L.ink, { bold: true }); L.ruled(TM + half + 18, w - TM - 8, my + 36, my + memo - 4, 20);
  },
  /* 月間: 月曜はじまりのカレンダー（6 週）＋目標・メモ */
  'm-plan'(L, w, h) {
    planHead(L, w, '月間プラン', '　　　年　　　月');
    const gy = TM + 42;
    L.rect(TM, gy, w - TM * 2, 40, { r: 4 });
    L.text('今月の目標', TM + 8, gy + 15, 10, L.ink, { bold: true });
    const y0 = gy + 52, port = h > w, memo = port ? (h - TM - y0) * 0.24 : 0, gh = h - TM - y0 - (memo ? memo + 10 : 0), hd = 20, cw = (w - TM * 2) / 7, rh = (gh - hd) / 6;
    const segs = [];
    for (let r = 0; r <= 6; r++) segs.push(TM, y0 + hd + r * rh, w - TM, y0 + hd + r * rh);
    for (let k = 0; k <= 7; k++) segs.push(TM + k * cw, y0 + hd, TM + k * cw, y0 + gh);
    L.lines(segs, L.sub, 0.7);
    for (let k = 0; k < 7; k++) L.text(WD_MON[k], TM + k * cw + cw / 2, y0 + 14, 10, wdColor(k, L.sub), { bold: true, align: 'center' });
    for (let r = 0; r < 6; r++) for (let k = 0; k < 7; k++) L.rect(TM + k * cw + 4, y0 + hd + r * rh + 4, 16, 14, { r: 2, c: L.line, lw: 0.6 });     // 日付を書く枠
    if (memo) {
      const my = y0 + gh + 10;
      L.rect(TM, my, w - TM * 2, memo, { r: 4 });
      L.text('メモ', TM + 8, my + 15, 10, L.ink, { bold: true });
      L.ruled(TM + 8, w - TM - 8, my + 36, my + memo - 4, 20);
    }
  },
  /* 月間: 1〜31 日の一覧（曜日・予定・チェック） */
  'm-list'(L, w, h) {
    planHead(L, w, '月間リスト', '　　　年　　　月');
    const y0 = TM + 44, rh = (h - TM - y0) / 32, c1 = TM + 30, c2 = c1 + 30, c3 = w - TM - 26;
    L.text('日', TM + 15, y0 + rh * 0.7, 9, L.sub, { align: 'center', bold: true });
    L.text('曜', c1 + 15, y0 + rh * 0.7, 9, L.sub, { align: 'center', bold: true });
    L.text('予定・やること', c2 + 8, y0 + rh * 0.7, 9, L.sub, { bold: true });
    L.text('✓', c3 + 13, y0 + rh * 0.7, 9, L.sub, { align: 'center', bold: true });
    const segs = [c1, y0, c1, h - TM, c2, y0, c2, h - TM, c3, y0, c3, h - TM];
    for (let r = 1; r <= 32; r++) segs.push(TM, y0 + r * rh, w - TM, y0 + r * rh);
    L.lines(segs, L.line, 0.6);
    L.rect(TM, y0, w - TM * 2, h - TM - y0, { r: 3 });
    for (let d = 1; d <= 31; d++) L.text(String(d), TM + 15, y0 + d * rh + rh * 0.68, Math.min(10, rh * 0.6), L.ink, { align: 'center' });
  },
};

// ---- ミュージック（五線譜は paper.js の 'music'）
function staffLines(L, x0, x1, y, gap, n, color, lw = 0.6) {
  const s = [];
  for (let k = 0; k < n; k++) s.push(x0, y + k * gap, x1, y + k * gap);
  L.lines(s, color, lw);
  return y + (n - 1) * gap;
}
/* TAB の字（線の上に紙の色を敷いてから縦に T・A・B） */
function tabLetters(L, x, y, gap) {
  const sz = Math.min(gap * 1.3, 11);
  L.rect(x - sz * 0.55, y + gap * 0.25, sz * 1.1, gap * 4.5, { fill: L.bg, c: null });
  ['T', 'A', 'B'].forEach((c, i) => L.text(c, x, y + gap * (1 + i * 1.5) + sz * 0.36, sz, L.ink, { bold: true, align: 'center' }));
}
function songHead(L, w, extra) {
  const M = 14 * MM;
  L.text('曲名', M, TM + 18, 9, L.sub);
  L.lines([M + 26, TM + 20, w * 0.62, TM + 20], L.sub, 0.6);
  let x = w * 0.62 + 14;
  for (const f of extra) { L.text(f, x, TM + 18, 9, L.sub); x += f.length * 9 + 4; L.lines([x, TM + 20, x + 44, TM + 20], L.sub, 0.6); x += 54; }
  return TM + 40;
}
const MUSIC_SHEETS = {
  /* 大譜表（ピアノ）: ト音・ヘ音の 2 段をかっこでつなぐ */
  'music-grand'(L, w, h) {
    const M = 14 * MM, gap = 2.1 * MM, staff = gap * 4, mid = 9 * MM, sys = staff * 2 + mid, space = 12 * MM;
    for (let y = songHead(L, w, ['作曲']) + 8; y + sys < h - 10 * MM; y += sys + space) {
      staffLines(L, M, w - M, y, gap, 5, L.ink);
      staffLines(L, M, w - M, y + staff + mid, gap, 5, L.ink);
      L.lines([M, y, M, y + sys, w - M, y, w - M, y + sys], L.ink, 0.8);
      L.lines([M - 5, y - 1, M - 5, y + sys + 1], L.ink, 2.2);          // かっこ
    }
  },
  /* ギタースコア: 五線＋TAB（6 線）を 1 組に */
  'music-guitar'(L, w, h) {
    const M = 14 * MM, g1 = 2.0 * MM, g2 = 2.3 * MM, s1 = g1 * 4, s2 = g2 * 5, mid = 5.5 * MM, sys = s1 + mid + s2, space = 11 * MM;
    for (let y = songHead(L, w, ['キー', 'テンポ']) + 8; y + sys < h - 10 * MM; y += sys + space) {
      staffLines(L, M, w - M, y, g1, 5, L.ink);
      const ty = y + s1 + mid;
      staffLines(L, M, w - M, ty, g2, 6, L.ink, 0.5);
      tabLetters(L, M + 8, ty, g2);
      L.lines([M, y, M, y + sys, w - M, y, w - M, y + s1, w - M, ty, w - M, ty + s2], L.ink, 0.8);
    }
  },
  /* TAB 譜（6 線） */
  'music-tab'(L, w, h) {
    const M = 14 * MM, gap = 2.6 * MM, st = gap * 5, space = 12 * MM;
    for (let y = songHead(L, w, ['チューニング']) + 8; y + st < h - 10 * MM; y += st + space) {
      staffLines(L, M, w - M, y, gap, 6, L.ink, 0.5);
      tabLetters(L, M + 8, y, gap);
      L.lines([M, y, M, y + st, w - M, y, w - M, y + st], L.ink, 0.8);
    }
  },
  /* コード表: ギターのコードダイアグラム（6 弦 × 5 フレット）を並べる */
  'music-chord'(L, w, h) {
    const M = 14 * MM, y0 = songHead(L, w, []) + 4, cols = w > h ? 7 : 5, cw = (w - M * 2) / cols;
    const sp = Math.min(cw * 0.62 / 5, 9.5), fr = sp * 1.3, dh = fr * 5, rh = dh + 44, rows = Math.max(1, Math.floor((h - 10 * MM - y0) / rh));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = M + c * cw + (cw - sp * 5) / 2, y = y0 + r * rh + 26;
      L.lines([x + sp * 0.4, y - 10, x + sp * 4.6, y - 10], L.sub, 0.6);       // コード名を書く線
      const s = [];
      for (let k = 0; k < 6; k++) s.push(x + k * sp, y, x + k * sp, y + dh);
      for (let f = 1; f <= 5; f++) s.push(x, y + f * fr, x + sp * 5, y + f * fr);
      L.lines(s, L.ink, 0.6);
      L.lines([x, y, x + sp * 5, y], L.ink, 2);                           // ナット
    }
  },
  /* 歌詞とコード: コードを書く細い行＋歌詞の行 */
  'music-lyric'(L, w, h) {
    const M = 14 * MM, y0 = songHead(L, w, ['キー', 'カポ']) + 10;
    for (let y = y0; y + 34 < h - 10 * MM; y += 40) {
      L.lines([M, y + 12, w - M, y + 12], L.line, 0.4);
      L.lines([M, y + 34, w - M, y + 34], L.sub, 0.7);
    }
  },
};

// ---- 表紙のページ（paper.accent の色、paper.title の題名。題名が無ければ手書き用の線）
const COVER_ACCENTS = [
  { c: '#2f4b7c', label: '紺' }, { c: '#b8453f', label: '赤' }, { c: '#3f7d5a', label: '緑' }, { c: '#8a6440', label: '茶' },
  { c: '#4a90c2', label: '水色' }, { c: '#d07a95', label: 'ピンク' }, { c: '#6b5b95', label: '紫' }, { c: '#3a3d42', label: '黒' },
];
function mixColor(hex, t) {         // 白と混ぜる（t = 0 のまま〜1 で白）
  const [r, g, b] = hexToRgb(hex);
  const f = (v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
function coverTitle(L, P, cx, cy, maxW, color, opt = {}) {
  const t = (P.title || '').trim();
  if (!t) { L.lines([cx - maxW / 2, cy + 8, cx + maxW / 2, cy + 8], color, 0.8); return; }
  const units = [...t].reduce((n, ch) => n + (/[\x20-\x7e]/.test(ch) ? 0.58 : 1), 0);
  const size = Math.max(12, Math.min(opt.max || 34, maxW / Math.max(1, units)));
  L.text(t, opt.left ? cx - maxW / 2 : cx, cy + size * 0.36, size, color, { bold: true, align: opt.left ? 'left' : 'center' });
}
function coverFields(L, x0, x1, y, color, sub) {
  L.text('No.', x0, y, 9, sub); L.lines([x0 + 22, y + 3, x0 + 80, y + 3], color, 0.7);
  L.text('名前', x0 + 96, y, 9, sub); L.lines([x0 + 120, y + 3, x1, y + 3], color, 0.7);
  L.text('期間', x0, y + 30, 9, sub);
  L.text('　　年　　月　　日 〜 　　年　　月　　日', x0 + 28, y + 30, 10, sub);
}
const COVER_SHEETS = {
  /* 帯: 上に色の帯、題名は白で */
  'cv-band'(L, w, h, P) {
    const a = P.accent || COVER_ACCENTS[0].c, bh = h * 0.42;
    L.rect(0, 0, w, bh, { fill: a, c: null });
    L.lines([w * 0.18, bh * 0.72, w * 0.82, bh * 0.72], '#ffffff', 0.8);
    coverTitle(L, P, w / 2, bh * 0.56, w * 0.7, '#ffffff');
    L.lines([0, bh + 6, w, bh + 6], a, 2);
    coverFields(L, w * 0.18, w * 0.82, h * 0.72, a, L.sub);
  },
  /* ラベル: 全体が色、真ん中に白いラベル */
  'cv-label'(L, w, h, P) {
    const a = P.accent || COVER_ACCENTS[0].c, lw = w * 0.66, lh = h * 0.3, lx = (w - lw) / 2, ly = h * 0.26;
    L.rect(0, 0, w, h, { fill: a, c: null });
    L.rect(lx, ly, lw, lh, { r: 10, fill: '#ffffff', c: null });
    L.rect(lx + 6, ly + 6, lw - 12, lh - 12, { r: 7, c: a, lw: 0.8 });
    coverTitle(L, P, w / 2, ly + lh * 0.38, lw * 0.8, '#2b2d31');
    coverFields(L, lx + 22, lx + lw - 22, ly + lh * 0.7, a, '#7a7f88');
  },
  /* 枠: 二重の枠と真ん中の題名 */
  'cv-frame'(L, w, h, P) {
    const a = P.accent || COVER_ACCENTS[0].c;
    L.rect(20, 20, w - 40, h - 40, { c: a, lw: 2.4 });
    L.rect(28, 28, w - 56, h - 56, { c: a, lw: 0.8 });
    coverTitle(L, P, w / 2, h * 0.36, w * 0.66, a);
    L.lines([w * 0.3, h * 0.36 + 34, w * 0.7, h * 0.36 + 34], a, 0.8);
    L.circle(w / 2, h * 0.36 + 34, 3, a);
    coverFields(L, w * 0.2, w * 0.8, h * 0.76, a, L.sub);
  },
  /* ストライプ: 左に色の帯、題名は左寄せ */
  'cv-stripe'(L, w, h, P) {
    const a = P.accent || COVER_ACCENTS[0].c, sw = w * 0.2;
    L.rect(0, 0, sw, h, { fill: a, c: null });
    L.rect(sw + 6, 0, 3, h, { fill: mixColor(a, 0.45), c: null });
    const x0 = sw + 34, tw = w - x0 - 40;
    coverTitle(L, P, x0 + tw / 2, h * 0.38, tw, a, { left: true });
    L.lines([x0, h * 0.38 + 30, w - 40, h * 0.38 + 30], a, 1.2);
    coverFields(L, x0, w - 40, h * 0.8, a, L.sub);
  },
  /* ドット: 水玉の上に白いラベル */
  'cv-dots'(L, w, h, P) {
    const a = P.accent || COVER_ACCENTS[0].c, dc = mixColor(a, 0.55), st = 24;
    for (let r = 0, y = 12; y < h; r++, y += st) for (let x = (r % 2) * st / 2 + 12; x < w; x += st) L.circle(x, y, 3.2, dc);
    const lw = w * 0.64, lh = h * 0.28, lx = (w - lw) / 2, ly = h * 0.3;
    L.rect(lx, ly, lw, lh, { r: 12, fill: '#ffffff', c: a, lw: 1.4 });
    coverTitle(L, P, w / 2, ly + lh * 0.38, lw * 0.8, a);
    coverFields(L, lx + 22, lx + lw - 22, ly + lh * 0.7, a, '#7a7f88');
  },
  /* シンプル: 大きな題名と線だけ */
  'cv-simple'(L, w, h, P) {
    const a = P.accent || COVER_ACCENTS[0].c, x0 = 44;
    coverTitle(L, P, w / 2, h * 0.3, w - x0 * 2, a, { left: true, max: 40 });
    L.lines([x0, h * 0.3 + 30, w - x0, h * 0.3 + 30], a, 2);
    coverFields(L, x0, w - x0, h - 90, a, L.sub);
  },
};
function isCoverPaper(paper) { return !!(paper && COVER_SHEETS[paper.type]); }

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
  const P = pg.paper || {}, fn = SHEETS[P.type] || DOC_SHEETS[P.type] || PLAN_SHEETS[P.type] || MUSIC_SHEETS[P.type] || COVER_SHEETS[P.type] || PLANNER[P.type];
  if (!fn) return null;
  const key = `${P.type}|${pc.id}|${pg.w}|${pg.h}|${P.y}|${P.m}|${P.d}|${P.accent}|${P.title}`;
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

/* 書類の用紙の入力欄 → 文字の物（ページを作った・用紙を書類にした時に置く） */
function docFieldsFor(pg) {
  const P = pg.paper || {};
  if (!DOC_SHEETS[P.type]) return [];
  const pc = paperColor(P), L = templateLayout(pg, pc);
  const color = pc.id === 'dark' ? '#ecedf0' : '#1d1d1f';
  return L.fields.map((f) => ({ id: uid('m'), kind: 'text', field: true, ph: f.ph, minH: f.h, x: f.x, y: f.y, w: f.w, h: f.h, rot: 0,
    text: '', size: f.size, color, font: 'gothic', bold: f.bold, bg: null }));
}
