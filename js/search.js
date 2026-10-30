'use strict';
/* 検索: 文字の並びを「検索の鍵」に直して探す（ノートの中・本棚・PDF の上の色付けで共通）。
   - いつも（exact）: NFKC（全角英数→半角・康熙部首→漢字など）・小文字・空白と改行と見えない字は無視
     （OCR した PDF は字の間に空白が入る・行の途中で切れる）・ダッシュのたぐいを 1 つに・CJK 部首補助の字を漢字に・半角/後付けの濁点をくっつける。
   - 見つからない時だけ ゆるく（loose）: カタカナ＝ひらがな・濁点/半濁点を無視・小さい字＝大きい字・OCR で取り違えやすい字（力/カ・口/ロ・一/ー など）。
   - それでも無い時（鍵が 4 字以上）は あいまい（fuzzy）: 1 字（8 字以上は 2 字）までの違い（OCR の読み違い・抜け）。
   鍵の 1 字ごとに元の文字の位置を持つので、当たった所を元の文字で見せられる・PDF の上に色を付けられる。 */

const SEARCH_LEVELS = ['exact', 'loose', 'fuzzy'];
const SEARCH_LEVEL_NOTE = {
  loose: 'カタカナ/ひらがな・濁点・小さい字・OCR で間違えやすい字（力とカ など）の違いを無視して見つけました',
  fuzzy: '1〜2 字違う所も含めて見つけました（OCR の読み違い）',
};
const SEARCH_RADICALS = { '⺅': '亻', '⺡': '氵', '⺠': '民', '⺾': '艹', '⻁': '虎', '⻄': '西', '⻆': '角', '⻌': '辶', '⻏': '阝', '⻑': '長',
  '⻖': '阝', '⻘': '青', '⻝': '食', '⻤': '鬼', '⻩': '黄', '⻫': '斉', '⻭': '歯', '⻯': '竜', '⻲': '亀' };
const SEARCH_RADICAL_RE = new RegExp('[' + Object.keys(SEARCH_RADICALS).join('') + ']', 'g');
const SEARCH_LOOSE = { '力': 'か', '口': 'ろ', '工': 'え', '二': 'に', '八': 'は', '卜': 'と', '夕': 'た', '一': 'ー', '-': 'ー', '〇': 'o', '○': 'o', '0': 'o',
  '1': 'l', '|': 'l', 'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'っ': 'つ', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ', 'ゕ': 'か', 'ゖ': 'け' };
const SEARCH_LOOSE_RE = new RegExp('[' + Object.keys(SEARCH_LOOSE).join('').replace(/[-|\\\]^]/g, '\\$&') + ']', 'g');

/* 前の字にくっつく字（濁点・アクセント・異体字セレクタ） */
function isJoiner(k) {
  return (k >= 0x300 && k <= 0x36f) || (k >= 0x3099 && k <= 0x309c) || k === 0xff9e || k === 0xff9f || (k >= 0xfe00 && k <= 0xfe0f) ||
    (k >= 0x1ab0 && k <= 0x1aff) || (k >= 0x1dc0 && k <= 0x1dff) || (k >= 0x20d0 && k <= 0x20ff) || (k >= 0xfe20 && k <= 0xfe2f);
}
/* text の i から始まるひとかたまり（1 字＋くっつく字）の終わり */
function clusterEnd(text, i) {
  const k = text.charCodeAt(i);
  let j = i + (k >= 0xd800 && k <= 0xdbff && i + 1 < text.length ? 2 : 1);
  for (;;) {
    const c = text.charCodeAt(j);
    if (j < text.length && isJoiner(c)) { j++; continue; }
    if (c === 0xdb40 && j + 1 < text.length) { j += 2; continue; }       // 異体字セレクタ（IVS）
    return j;
  }
}
/* ひとかたまりを鍵の字に（空なら無視する字） */
function foldStrict(c) {
  const k = c.charCodeAt(0);
  if (c.length === 1) {               // よく出る字は速く
    if (k < 0x80) return k <= 0x20 || k === 0x7f ? '' : k >= 65 && k <= 90 ? String.fromCharCode(k + 32) : c;
    if ((k >= 0x3041 && k <= 0x3096) || (k >= 0x30a1 && k <= 0x30fa) || k === 0x30fc || (k >= 0x4e00 && k <= 0x9fff)) return c;
  }
  let s = c.replace(/[\u309b\uff9e]/g, '\u3099').replace(/[\u309c\uff9f]/g, '\u309a')
    .normalize('NFKC').toLowerCase();
  s = s.replace(/[\s\u200b-\u200f\u2028-\u202f\u2060\ufeff\u00ad\ufe00-\ufe0f]|\udb40[\udd00-\uddef]/g, '');
  return s.replace(/[\u2010-\u2015\u2212\u2500\u2501\ufe58\ufe63]/g, '-').replace(/\u301c/g, '~').replace(SEARCH_RADICAL_RE, (m) => SEARCH_RADICALS[m]);
}
function foldLoose(s) {
  s = s.normalize('NFD').replace(/\p{M}/gu, '');
  s = s.replace(/[\u30a1-\u30f6]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0x60));
  return s.replace(SEARCH_LOOSE_RE, (m) => SEARCH_LOOSE[m]);
}
/* 字ごとの直し方は覚えておく（文書に出てくる字の種類は数千なので速くなる） */
const _foldMemo = { exact: new Map(), loose: new Map() };
function foldCluster(c, loose) {
  const memo = _foldMemo[loose ? 'loose' : 'exact'];
  let f = memo.get(c);
  if (f === undefined) {
    f = foldStrict(c);
    if (f && loose) f = foldLoose(f);
    if (memo.size > 50000) memo.clear();
    memo.set(c, f);
  }
  return f;
}
/* 鍵と、鍵の 1 字（UTF-16 の 1 単位）ごとの元の位置 */
function buildSearchIndex(text, level) {
  const loose = level !== 'exact';
  const parts = [], pos = [];
  for (let i = 0; i < text.length;) {
    const j = clusterEnd(text, i);
    const f = foldCluster(text.slice(i, j), loose);
    if (f) { parts.push(f); for (let n = 0; n < f.length; n++) pos.push(i); }
    i = j;
  }
  return { key: parts.join(''), pos };
}
function searchKey(q, level) { return buildSearchIndex(String(q || ''), level === 'fuzzy' ? 'loose' : level).key; }

/* 同じ文字の鍵は作り直さない（owner はページ・検索の記録など。中身が変われば作り直す） */
const _searchIdx = new WeakMap();
function searchIndexFor(owner, text, level) {
  if (!owner || typeof owner !== 'object') return buildSearchIndex(text, level);
  let c = _searchIdx.get(owner);
  if (!c || c.text !== text) { c = { text }; _searchIdx.set(owner, c); }
  return c[level] || (c[level] = buildSearchIndex(text, level));
}

/* text の中の q の場所 [{a, b}]（元の文字の位置、b は含まない） */
function matchRanges(text, q, level = 'exact', owner = null) {
  if (!text) return [];
  const qk = searchKey(q, level);
  if (!qk || (level === 'fuzzy' && qk.length < 4)) return [];
  const idx = searchIndexFor(owner, text, level === 'fuzzy' ? 'loose' : level);
  const range = (s, e) => ({ a: idx.pos[s], b: clusterEnd(text, idx.pos[e - 1]) });
  const out = [];
  if (level === 'fuzzy') { for (const [s, e] of fuzzyFind(idx.key, qk, qk.length >= 8 ? 2 : 1)) out.push(range(s, e)); }
  else for (let at = idx.key.indexOf(qk); at >= 0; at = idx.key.indexOf(qk, at + qk.length)) out.push(range(at, at + qk.length));
  return out;
}

/* 字の違い（置き換え・抜け・余分）が k 以下で q に合う所 [[始め, 終わり)]（鍵の位置）。重なる所は違いの少ない方 */
function fuzzyFind(t, q, k) {
  const m = q.length;
  let D = new Int32Array(m + 1), S = new Int32Array(m + 1), nD = new Int32Array(m + 1), nS = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) D[j] = j;
  const out = [];
  let last = null;
  for (let i = 0; i < t.length; i++) {
    nD[0] = 0; nS[0] = i + 1;
    const ch = t[i];
    for (let j = 1; j <= m; j++) {
      let best = D[j - 1] + (ch === q[j - 1] ? 0 : 1), s = S[j - 1];
      if (D[j] + 1 < best) { best = D[j] + 1; s = S[j]; }
      if (nD[j - 1] + 1 < best) { best = nD[j - 1] + 1; s = nS[j - 1]; }
      nD[j] = best; nS[j] = s;
    }
    if (nD[m] <= k) {
      const cur = { s: nS[m], e: i + 1, d: nD[m] };
      if (last && cur.s < last.e) { if (cur.d < last.d) { out[out.length - 1] = cur; last = cur; } }
      else { out.push(cur); last = cur; }
    }
    [D, nD] = [nD, D]; [S, nS] = [nS, S];
  }
  return out.map((r) => [r.s, r.e]);
}

/* 一覧に出す当たりの前後（元の文字のまま。空白・改行は 1 つの空白に） */
function snippetAt(text, r, span = 28) {
  let s0 = Math.max(0, r.a - span);
  const s1 = Math.min(text.length, r.b + span);
  if (s0 > 0 && text.charCodeAt(s0) >= 0xdc00 && text.charCodeAt(s0) <= 0xdfff) s0--;
  // OCR の字の間の空白は、日本語の字どうしの間なら詰める（つなぎ目もまとめて見る）
  const cjk = '[\\u3001-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff]';
  const tight = new RegExp(`(${cjk})\\s+(?=${cjk})`, 'g');
  const parts = [text.slice(s0, r.a), text.slice(r.a, r.b), text.slice(r.b, s1)].map((x) => x.replace(/\s+/g, ' '));
  const glued = parts.join('\u0000').replace(new RegExp(`(${cjk}) (\\u0000)(?=${cjk})|(${cjk})(\\u0000) (?=${cjk})`, 'g'), '$1$2$3$4');
  const [before, hit, after] = glued.split('\u0000').map((x) => x.replace(tight, '$1'));
  return { before: (s0 > 0 ? '…' : '') + before, hit, after: after + (s1 < text.length ? '…' : '') };
}
function snippetOf(text, q, span = 28, level = 'exact', owner = null) {
  const r = matchRanges(text, q, level, owner)[0];
  return r ? snippetAt(text, r, span) : null;
}
/* 当たるか（文字の道具・スタンプなど短い物） */
function textHas(text, q, level = 'exact') { return matchRanges(text || '', q, level).length > 0; }
