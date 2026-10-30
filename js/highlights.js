'use strict';
/* マーカー（蛍光ペン）を引いた所の文字を取り出して、箇条書き・表（CSV）にする。
   PDF のページの文字（PdfText.items: 項目ごとの四角形）を字ごとに等分し、字の真ん中が蛍光ペンの線から
   「線の太さの半分（ただし行の高さの 0.7 倍まで）＋行の高さの 0.15 倍」以内なら、その字は引いてある。
   線ごとに引いた字を読む順に並べ、間が空白だけ（引き損ねた 1 字までは許す）ならひと続きに。
   同じ色（色合いで見た名前）で重なる・空白や改行だけを挟んで続く所はつなぐ。
   黄と赤は「上下に分かれた 1 つの文」もつなぐ: 次の行に続いていて、間の引き損ね（行末・行頭）が 12 字まで、
   前が文の終わり（。！？）でなければ、間の字も入れて 1 つに。ページをまたぐ時も（間の字＝柱・ページ番号は入れない）。
   赤は重要（★）。文全体（前の。の後から次の。まで、見つかった側だけ広げる）も持っておき、書き出す時に選べる。
   線と文字はどちらもページの座標（pdf.js の表示座標）なので、ページの回転とは関係ない。
   文字の無い所（OCR していないスキャン・手書きの上）に引いたマーカーは数えるだけ（blind）。 */

const HL_JOIN = new Set(['黄', '赤']);         // 上下に分かれた文をつなぐ色
const HL_IMPORTANT = '赤';
const SENT_END = /[。．！？!?]/;
/* 色合いで名前を付ける（自分で選んだ赤も「赤」に。最初からある桃色は「ピンク」） */
function hlColorName(c) {
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return c || '';
  const [r, g, b] = hexToRgb(c).map((v) => v / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (d < 0.12) return mx > 0.8 ? '白' : mx < 0.25 ? '黒' : '灰';
  const h = ((mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return h < 18 || h >= 345 ? '赤' : h < 42 ? 'オレンジ' : h < 70 ? '黄' : h < 165 ? '緑' : h < 255 ? '青' : h < 295 ? '紫' : 'ピンク';
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
        chars.push({ i: joined.length + k, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, th: th || 10, v: !!it.vertical });
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
        spans.push({ a, b: prev + 1, color: s.color, fam: hlColorName(s.color) });
        a = prev = cur;
      }
    }
    spans.sort((x, y) => x.a - y.a || x.b - y.b);
    const at = new Map(chars.map((c) => [c.i, c]));
    const first = (sp) => { let i = sp.a; while (i < sp.b && !at.has(i)) i++; return at.get(i); };
    const last = (sp) => { let i = sp.b - 1; while (i >= sp.a && !at.has(i)) i--; return at.get(i); };
    const nextLine = (p, q) => { const c1 = last(p), c2 = first(q); if (!c1 || !c2) return false; const th = Math.max(c1.th, c2.th); return c1.v ? Math.abs(c1.x - c2.x) > th * 0.6 : Math.abs(c1.y - c2.y) > th * 0.6; };
    const merged = [];
    for (const sp of spans) {
      const pv = merged[merged.length - 1];
      const gap = pv ? joined.slice(pv.b, sp.a) : '';
      const touch = pv && pv.fam === sp.fam && (sp.a <= pv.b || !gap.trim());
      // 黄・赤: 次の行に続く文（行末・行頭の引き損ね 12 字まで、前が文の終わりでない）
      const cont = pv && !touch && pv.fam === sp.fam && HL_JOIN.has(sp.fam) && sp.a > pv.b && gap.replace(/\s/g, '').length <= 12 &&
        !SENT_END.test(joined.slice(pv.a, pv.b).trim().slice(-1)) && !SENT_END.test(gap) && nextLine(pv, sp);
      if (touch || cont) pv.b = Math.max(pv.b, sp.b);
      else merged.push({ ...sp });
    }
    const pageItems = [];
    for (const sp of merged) {
      const text = tidyText(joined.slice(sp.a, sp.b));
      if (!text) continue;
      const h = { page: pi, pageEnd: pi, color: sp.color, fam: sp.fam, important: sp.fam === HL_IMPORTANT, text,
        head: joined.slice(0, sp.a).replace(/\s/g, '').length, tail: joined.slice(sp.b).replace(/\s/g, '').length };
      if (h.important) { const [s0, s1] = sentenceRange(joined, sp.a, sp.b); h.sentence = tidyText(joined.slice(s0, s1)); h.sOpen = !SENT_END.test(h.sentence.slice(-1)); }
      pageItems.push(h);
    }
    // ページをまたぐ文（黄・赤）: 前のページの最後と、このページの最初（間は柱・ページ番号くらい＝12 字まで、字は入れない）
    const pv = items[items.length - 1], cur = pageItems[0];
    if (pv && cur && pv.pageEnd === pi - 1 && pv.fam === cur.fam && HL_JOIN.has(cur.fam) && pv.tail <= 12 && cur.head <= 12 && !SENT_END.test(pv.text.slice(-1))) {
      pv.text = tidyText(pv.text + ' ' + cur.text);
      if (pv.important) pv.sentence = tidyText((pv.sentence || pv.text) + ' ' + (cur.sentence || cur.text));
      pv.pageEnd = pi; pv.tail = cur.tail;
      pageItems.shift();
    }
    items.push(...pageItems);
  }
  return { items, blind };
}

/* [a, b) を含む文の範囲。前の文の終わり・次の文の終わりが 120 字以内に見つかった側だけ広げる（見つからない側＝ページの端の文はそのまま） */
function sentenceRange(t, a, b) {
  let s = a, e = b;
  for (let k = a - 1; k >= 0 && a - k <= 120; k--) if (SENT_END.test(t[k])) { s = k + 1; break; }
  if (!SENT_END.test(t.slice(a, b).trim().slice(-1))) for (let k = b; k < t.length && k - b <= 120; k++) if (SENT_END.test(t[k])) { e = k + 1; break; }
  return [s, e];
}

/* 書き出す形: 'txt'（・の箇条書き）| 'md'（Markdown）| 'csv'（表: 番号・ページ・色・重要・文。Excel 用に BOM 付き）
   opt: pages（ページ番号）, byColor（色ごと。赤＝重要を先に）, redSentence（赤は文全体）, onlyImportant（赤だけ） */
function highlightRows(list, opt = {}) {
  let rows = list.map((h) => ({ ...h, text: h.important && opt.redSentence && h.sentence ? h.sentence : h.text }));
  rows = rows.filter((h, i) => !(i && rows[i - 1].text === h.text && rows[i - 1].page === h.page));     // 文全体にすると同じ文が重なる
  return opt.onlyImportant ? rows.filter((h) => h.important) : rows;
}
function highlightsText(name, list, fmt, opt = {}) {
  const rows = highlightRows(list, opt);
  const date = fmtDate(Date.now()).slice(0, 10);
  const pg = (h) => (h.pageEnd > h.page ? `${h.page + 1}–${h.pageEnd + 1}` : `${h.page + 1}`);
  if (fmt === 'csv') {
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const head = ['番号', ...(opt.pages ? ['ページ'] : []), '色', '重要', '文'];
    const lines = [head.map(q).join(',')].concat(rows.map((h, i) => [i + 1, ...(opt.pages ? [pg(h)] : []), h.fam, h.important ? '★' : '', h.text].map(q).join(',')));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
  const groups = new Map();
  if (opt.byColor && rows.some((h) => h.important)) groups.set(HL_IMPORTANT, []);
  for (const h of rows) {
    const k = opt.byColor ? h.fam : '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  const md = fmt === 'md';
  const lines = md ? [`# ${name} — マーカーした所`, '', `${date}・${rows.length} 件`, ''] : [`${name} — マーカーした所（${date}・${rows.length} 件）`, ''];
  for (const [fam, l] of groups) {
    const label = fam === HL_IMPORTANT ? `${fam}（重要）` : fam;
    if (fam) lines.push(md ? `## ${label}` : `【${label}】`);
    for (const h of l) {
      const t = h.important ? (md ? `**★ ${h.text}**` : `★ ${h.text}`) : h.text;
      lines.push(`${md ? '- ' : '・'}${t}${opt.pages ? `（p.${pg(h)}）` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
