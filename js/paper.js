'use strict';
/* 用紙（テンプレート）と大きさ。用紙は線で描く（拡大してもくっきり）。座標はページの pt（回転前）。 */

const PAGE_SIZES = {
  A4: [595, 842], B5: [516, 729], A5: [420, 595], A3: [842, 1191], 'レター': [612, 792],
  'iPad（4:3）': [600, 800], 'ワイド（16:9）': [450, 800],
};

const PAPER_COLORS = [
  { id: 'white', label: '白', bg: '#ffffff', line: '#c9d2e3', strong: '#e2a3a3' },
  { id: 'cream', label: 'クリーム', bg: '#fbf6e6', line: '#d9cfae', strong: '#d99a8c' },
  { id: 'gray', label: 'グレー', bg: '#f1f2f4', line: '#c8ccd3', strong: '#d6a0a0' },
  { id: 'dark', label: '黒板', bg: '#25282d', line: '#3d434c', strong: '#6a5048' },
  { id: 'green', label: '緑', bg: '#eef5ec', line: '#bcd3b8', strong: '#d6a0a0' },
];

/* 用紙の種類。mm は線の間隔（ミリ）。cat: basic（基本）・study（勉強・仕事）・planner（プランナーが作る。一覧には出さない） */
const PAPER_TYPES = [
  { id: 'blank', label: '無地', cat: 'basic' },
  { id: 'ruled', label: '横罫', mm: 7, cat: 'basic' },
  { id: 'ruled-narrow', label: '横罫（狭い）', mm: 6, cat: 'basic' },
  { id: 'grid', label: '方眼', mm: 5, cat: 'basic' },
  { id: 'dot', label: 'ドット', mm: 5, cat: 'basic' },
  { id: 'music', label: '五線譜', cat: 'basic' },
  { id: 'cornell', label: 'コーネル', mm: 7, cat: 'study' },
  { id: 'study', label: '勉強ノート', cat: 'study' },
  { id: 'meeting', label: '議事録', cat: 'study' },
  { id: 'todo', label: 'ToDo', mm: 9, cat: 'study' },
  { id: 'habit', label: '習慣トラッカー', cat: 'study' },
  { id: 'twocol', label: '2 段', cat: 'study' },
  { id: 'storyboard', label: '絵コンテ', cat: 'study' },
  { id: 'genko', label: '原稿用紙', cat: 'study' },
  { id: 'p-year', label: '年間', cat: 'planner' },
  { id: 'p-month', label: '月間', cat: 'planner' },
  { id: 'p-week', label: '週間', cat: 'planner' },
  { id: 'p-day', label: '1 日', cat: 'planner' },
  { id: 'image', label: '自作（画像）', cat: 'custom' },
];

const MM = 72 / 25.4;

function paperColor(paper) { return PAPER_COLORS.find((c) => c.id === (paper && paper.color)) || PAPER_COLORS[0]; }
function paperType(paper) { return PAPER_TYPES.find((t) => t.id === (paper && paper.type)) || PAPER_TYPES[0]; }

/* ページの用紙を描く（ctx はページの座標になっている）。s = 画面の拡大率（線の太さを画面で一定に） */
function drawPaper(g, pg, s) {
  const pc = paperColor(pg.paper), pt = paperType(pg.paper);
  const W = pg.w, H = pg.h;
  g.fillStyle = pc.bg;
  g.fillRect(0, 0, W, H);
  const hair = Math.max(0.35, 0.8 / s);
  g.lineWidth = hair;
  g.strokeStyle = pc.line;
  const step = (pt.mm || 7) * MM;
  const top = 22 * MM, margin = 14 * MM;
  const hline = (y, x0 = 0, x1 = W) => { g.moveTo(x0, y); g.lineTo(x1, y); };
  const vline = (x, y0 = 0, y1 = H) => { g.moveTo(x, y0); g.lineTo(x, y1); };
  g.beginPath();
  switch (pt.id) {
    case 'ruled': case 'ruled-narrow':
      for (let y = top; y < H - 8 * MM; y += step) hline(y);
      g.stroke();
      g.beginPath(); g.strokeStyle = pc.strong; vline(margin * 1.6); g.stroke();
      break;
    case 'grid':
      for (let y = step; y < H; y += step) hline(y);
      for (let x = step; x < W; x += step) vline(x);
      g.stroke();
      break;
    case 'dot': {
      g.fillStyle = pc.line;
      const r = Math.max(0.55, 1.1 / s);
      for (let y = step; y < H; y += step) for (let x = step; x < W; x += step) { g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); }
      g.fill();
      break;
    }
    case 'cornell': {
      const cue = W * 0.3, sumY = H - H * 0.2;
      for (let y = top; y < sumY; y += step) hline(y, cue, W);
      g.stroke();
      g.beginPath(); g.strokeStyle = pc.strong; g.lineWidth = hair * 1.6;
      vline(cue, top - step, sumY); hline(sumY); hline(top - step);
      g.stroke();
      paperLabel(g, pc, 'キーワード・質問', margin * 0.5, top - step - 4);
      paperLabel(g, pc, 'ノート', cue + 6, top - step - 4);
      paperLabel(g, pc, 'まとめ', margin * 0.5, sumY + 14);
      break;
    }
    case 'todo': {
      for (let y = top + step; y < H - 10 * MM; y += step) {
        hline(y, margin + 10 * MM, W - margin);
        const b = 4.2 * MM;
        g.rect(margin + 2 * MM, y - b - 1.5 * MM, b, b);
      }
      g.stroke();
      paperLabel(g, pc, 'ToDo', margin + 2 * MM, top - 2, 14);
      break;
    }
    case 'music': {
      const gap = 2.2 * MM, staff = gap * 4, block = staff + 13 * MM;
      for (let y = top; y + staff < H - 10 * MM; y += block) for (let k = 0; k < 5; k++) hline(y + k * gap, margin, W - margin);
      g.stroke();
      break;
    }
    case 'genko': {     // 20×20 の原稿用紙（縦書き）。中央に柱
      const cols = 20, rows = 20, cell = Math.min((W - 2 * margin) / (cols + 1), (H - 2 * top) / rows);
      const gw = cell * cols + cell, gh = cell * rows, x0 = (W - gw) / 2, y0 = (H - gh) / 2;
      g.strokeStyle = pc.strong;
      for (let c = 0; c <= cols + 1; c++) {
        const x = x0 + c * cell + (c > cols / 2 ? 0 : 0);
        vline(x, y0, y0 + gh);
      }
      for (let r = 0; r <= rows; r++) {
        hline(y0 + r * cell, x0, x0 + cell * 10);
        hline(y0 + r * cell, x0 + cell * 11, x0 + gw);
      }
      g.stroke();
      break;
    }
    case 'image': {            // 自作テンプレート（画像）
      if (!pg.paper.src) break;
      if (g.drawPaperImage) { g.drawPaperImage(pg.paper.src, W, H); break; }       // PDF に書き出す時
      const img = ImageCache.get(pg.paper.src);
      if (img) g.drawImage(img, 0, 0, W, H);
      break;
    }
    default: {                 // 勉強・仕事の用紙、プランナー（templates.js）
      const L = templateLayout(pg, pc);
      if (L) drawLayout(g, L);
      break;
    }
  }
}

function paperLabel(g, pc, text, x, y, size = 9) {
  g.save();
  g.fillStyle = pc.strong;
  g.font = `${size}px -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif`;
  g.fillText(text, x, y);
  g.restore();
}

/* 無限キャンバスの背景（文書の座標で、見えている範囲 r = {x0,y0,x1,y1} だけ） */
function drawBoardPaper(g, pg, r, s) {
  const pc = paperColor(pg.paper), pt = paperType(pg.paper);
  g.fillStyle = pc.bg;
  g.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  if (pt.id === 'blank') return;
  let step = (pt.mm || 5) * MM * 2;
  while (step * s < 14) step *= 4;         // 縮めすぎて線が詰まったら間引く
  const x0 = Math.floor(r.x0 / step) * step, y0 = Math.floor(r.y0 / step) * step;
  g.beginPath();
  if (pt.id === 'dot') {
    g.fillStyle = pc.line;
    const rad = Math.max(0.6, 1.3 / s);
    for (let y = y0; y < r.y1; y += step) for (let x = x0; x < r.x1; x += step) { g.moveTo(x + rad, y); g.arc(x, y, rad, 0, Math.PI * 2); }
    g.fill();
  } else {
    g.lineWidth = Math.max(0.3, 0.8 / s);
    g.strokeStyle = pc.line;
    for (let y = y0; y < r.y1; y += step) { g.moveTo(r.x0, y); g.lineTo(r.x1, y); }
    if (pt.id !== 'ruled' && pt.id !== 'ruled-narrow') for (let x = x0; x < r.x1; x += step) { g.moveTo(x, r.y0); g.lineTo(x, r.y1); }
    g.stroke();
  }
}

/* 用紙の見本（新規作成の画面用）: canvas に小さく描く */
function paperPreview(canvas, paper, size, landscape) {
  let [w, h] = PAGE_SIZES[size] || PAGE_SIZES.A4;
  if (landscape) [w, h] = [h, w];
  const k = Math.min(canvas.width / w, canvas.height / h);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.save();
  g.translate((canvas.width - w * k) / 2, (canvas.height - h * k) / 2);
  g.scale(k, k);
  drawPaper(g, { w, h, paper }, k * 1.6);
  g.restore();
}
