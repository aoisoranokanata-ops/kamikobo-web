'use strict';
/* マーカー（蛍光ペン）を引いた所の文字を取り出して、箇条書き・表（CSV）にする。
   PDF のページの文字（PdfText.items: 項目ごとの四角形）を字ごとに等分し、字の真ん中が蛍光ペンの線から
   「線の太さの半分（ただし行の高さの 0.7 倍まで）＋行の高さの 0.15 倍」以内なら、その字は引いてある。
   線ごとに引いた字を読む順に並べ、間が空白だけ（引き損ねた 1 字までは許す）ならひと続きに。
   同じ色で重なる・空白や改行だけを挟んで続く所はつなぐ（2 行にまたがって引いた所は 1 つの文に）。
   線と文字はどちらもページの座標（pdf.js の表示座標）なので、ページの回転とは関係ない。
   文字の無い所（OCR していないスキャン・手書きの上）に引いたマーカーは数えるだけ（blind）。 */

const HL_COLOR_NAMES = [['#ffe14d', '黄'], ['#9be36b', '緑'], ['#7fd3ff', '青'], ['#ff9ec7', 'ピンク'], ['#ffb347', 'オレンジ']];
function hlColorName(c) {
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return c || '';
  const [r, g, b] = hexToRgb(c);
  let best = c, bd = 6000;            // 近い色が無ければ #rrggbb のまま
  for (const [h, name] of HL_COLOR_NAMES) {
    const [r2, g2, b2] = hexToRgb(h), d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}
/* 空白・改行を 1 つの空白に、日本語の字どうしの間の空白（OCR）は詰める */
function tidyText(s) {
  const cjk = '[\\u3001-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff01-\\uff0f\\uff1a-\\uff20]';
  return s.replace(/\s+/g, ' ').replace(new RegExp(`(${cjk}) (?=${cjk})`, 'g'), '$1').trim();
}

/* pages の蛍光ペンの所の文字。{items:[{page(0 始まり), color, text}]（ページ順・読む順）, blind: 文字の無かった線の数} */
async function collectHighlights(pages, onProgress) {
  const items = [];
  let blind = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    if (onProgress) onProgress(pi + 1, pages.length);
    const hls = (p.strokes || []).filter((s) => s.tool === 'hl' && s.pts && s.pts.length >= 4);
    if (!hls.length) continue;
    const tItems = p.bg && !p.bg.tpl ? await PdfText.items(p).catch(() => []) : [];
    // 字ごとの真ん中と、行の高さ（縦書きは列の幅）
    let joined = '';
    const chars = [];
    for (const it of tItems) {
      const n = it.str.length, P = it.poly;
      for (let k = 0; P && k < n; k++) {
        if (/\s/.test(it.str[k])) continue;
        const t = (k + 0.5) / n;
        const lerp = (i, j) => [P[i] + (P[j] - P[i]) * t, P[i + 1] + (P[j + 1] - P[i + 1]) * t];
        const [a, b] = it.vertical ? [lerp(0, 6), lerp(2, 4)] : [lerp(0, 2), lerp(6, 4)];
        const th = it.vertical ? Math.hypot(P[2] - P[0], P[3] - P[1]) : Math.hypot(P[6] - P[0], P[7] - P[1]);
        chars.push({ i: joined.length + k, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, th: th || 10 });
      }
      joined += it.str;
    }
    const spans = [];
    for (const s of hls) {
      const pts = s.pts, half = (s.w || 12) / 2, bb = strokeBBox(s);
      const hit = [];
      for (const c of chars) {
        if (c.x < bb[0] - c.th || c.x > bb[2] + c.th || c.y < bb[1] - c.th || c.y > bb[3] + c.th) continue;
        const lim = Math.min(half, c.th * 0.7) + c.th * 0.15;
        let d = Math.hypot(c.x - pts[0], c.y - pts[1]);
        for (let j = 4; j < pts.length && d > lim; j += 4) d = Math.min(d, distToSeg(c.x, c.y, pts[j - 4], pts[j - 3], pts[j], pts[j + 1]));
        if (d <= lim) hit.push(c.i);
      }
      if (!hit.length) { blind++; continue; }
      hit.sort((a, b) => a - b);
      // 引いた字のひと続き（間が空白だけ、または引き損ねた字が 1 つまで）
      let a = hit[0], prev = hit[0];
      for (let k = 1; k <= hit.length; k++) {
        const cur = hit[k];
        if (cur !== undefined && joined.slice(prev + 1, cur).replace(/\s/g, '').length <= 1) { prev = cur; continue; }
        spans.push({ a, b: prev + 1, color: s.color });
        a = prev = cur;
      }
    }
    spans.sort((x, y) => x.a - y.a || x.b - y.b);
    const merged = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && last.color === sp.color && (sp.a <= last.b || !joined.slice(last.b, sp.a).trim())) last.b = Math.max(last.b, sp.b);
      else merged.push({ ...sp });
    }
    for (const sp of merged) {
      const text = tidyText(joined.slice(sp.a, sp.b));
      if (text) items.push({ page: pi, color: sp.color, text });
    }
  }
  return { items, blind };
}

/* 書き出す形: 'txt'（・の箇条書き）| 'md'（Markdown）| 'csv'（表: 番号・ページ・色・文。Excel 用に BOM 付き） */
function highlightsText(name, list, fmt, opt = {}) {
  const date = fmtDate(Date.now()).slice(0, 10);
  if (fmt === 'csv') {
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const rows = [['番号', 'ページ', '色', '文'].map(q).join(',')].concat(list.map((h, i) => [i + 1, h.page + 1, hlColorName(h.color), h.text].map(q).join(',')));
    return '\ufeff' + rows.join('\r\n') + '\r\n';
  }
  const groups = new Map();
  for (const h of list) {
    const k = opt.byColor ? hlColorName(h.color) : '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  const md = fmt === 'md';
  const lines = md ? [`# ${name} — マーカーした所`, '', `${date}・${list.length} 件`, ''] : [`${name} — マーカーした所（${date}・${list.length} 件）`, ''];
  for (const [color, l] of groups) {
    if (color) lines.push(md ? `## ${color}` : `【${color}】`);
    for (const h of l) lines.push(`${md ? '- ' : '・'}${h.text}${opt.pages ? `（p.${h.page + 1}）` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}
