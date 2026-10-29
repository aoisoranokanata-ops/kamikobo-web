'use strict';
/* AI（Claude）: 利用者自身の API キーで、ブラウザから直接 Claude API を呼ぶ（公式 SDK を vendor に同梱、dangerouslyAllowBrowser）。
   要約・質問（チャット）・手書き→文字（検索できる・位置つき）・暗記カード・ノートの整理。
   キーはこの端末の localStorage だけに置く。送るのはノートのページの絵と文字（Anthropic の API へ）。 */

const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（いちばん賢い・おすすめ）', in: 4, out: 20, cache: 0.2, fallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（速い・安め）', in: 2, out: 10, cache: 0.2, fallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（とても安い・簡単な作業向き）', in: 0.1, out: 0.5, cache: 0.01, fallback: false },
];
const AI_SYSTEM = `あなたは日本語の手書きノート・PDF 学習アプリ「紙工房 Web」の中のアシスタントです。
利用者は iPad でノートを取り、資格試験などの勉強や仕事に使っています。ノートの内容（ページの画像・PDF の文字・置いた文字・録音の文字起こし）を読み、日本語で答えます。
ページの画像に写っている手書きの文字・図・矢印・囲み・蛍光ペンも内容として読み取ってください。読めない所は推測せず「（判読不能）」とします。
答えは画面の狭いパネルに出るので、見出し（##）と箇条書きで簡潔にまとめます。ページを示すときは「p.3」のように書きます。`;

const AIConf = {
  get() { return loadJSON('ai', { key: '', model: AI_MODELS[0].id, autoHw: false, agreed: false, spent: 0, month: '' }); },
  set(patch) { saveJSON('ai', { ...this.get(), ...patch }); },
  model() { const id = this.get().model; return AI_MODELS.find((m) => m.id === id) || AI_MODELS[0]; },
  /* 使った金額（目安、ドル）を月ごとに数える */
  addUsage(u, model) {
    if (!u) return 0;
    const m = model || this.model();
    const cost = ((u.input_tokens || 0) * m.in + (u.cache_creation_input_tokens || 0) * m.in * 1.25 + (u.cache_read_input_tokens || 0) * m.cache + (u.output_tokens || 0) * m.out) / 1e6;
    const c = this.get(), month = new Date().toISOString().slice(0, 7);
    this.set({ spent: (c.month === month ? c.spent || 0 : 0) + cost, month });
    return cost;
  },
};

const AI = {
  async client() {
    const c = AIConf.get();
    if (!c.key) throw new AIError('nokey', 'Claude の API キーが設定されていません（✨ →「AI の設定」）');
    await Lib.load('vendor/anthropic-sdk.min.js', () => !!window.Anthropic);
    if (!this._c || this._key !== c.key) {
      this._c = new window.Anthropic({ apiKey: c.key, dangerouslyAllowBrowser: true, maxRetries: 2 });
      this._key = c.key;
    }
    return this._c;
  },
  /* 1 回の呼び出し（ストリーミング）。onText で少しずつ。json = スキーマを渡すと JSON で返す */
  async run({ messages, effort = 'medium', maxTokens = 32000, json = null, onText = null, signal = null, model = null }) {
    const client = await this.client();
    const m = model || AIConf.model();
    const body = {
      model: m.id, max_tokens: maxTokens, system: AI_SYSTEM, messages,
      output_config: { effort, ...(json ? { format: { type: 'json_schema', schema: json } } : {}) },
      cache_control: { type: 'ephemeral' },          // 同じノートで続けて質問すると、ノートの部分は安く読める
    };
    if (m.fallback) { body.betas = ['server-side-fallback-2026-07-01']; body.fallbacks = 'default'; }   // 安全のための断りが出たら別のモデルで続ける
    let msg;
    try {
      const stream = client.beta.messages.stream(body, signal ? { signal } : undefined);
      if (onText) stream.on('text', (t) => onText(t));
      msg = await stream.finalMessage();
    } catch (e) { throw aiError(e); }
    const cost = AIConf.addUsage(msg.usage, m);
    if (msg.stop_reason === 'refusal') throw new AIError('refusal', 'Claude がこの内容への回答を控えました。内容や頼み方を変えてもう一度試してください。');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (msg.stop_reason === 'max_tokens' && json) throw new AIError('length', '答えが長すぎて途中で切れました。範囲を狭めてもう一度試してください。');
    let data = null;
    if (json) { try { data = JSON.parse(text); } catch { throw new AIError('json', 'AI の答えを読み取れませんでした。もう一度試してください。'); } }
    return { text, data, usage: msg.usage, cost, model: msg.model };
  },
};

class AIError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
/* SDK の例外を、利用者に分かる言葉に（細かい種類から順に） */
function aiError(e) {
  const A = window.Anthropic;
  if (e instanceof AIError) return e;
  if (A && e instanceof A.APIUserAbortError) return new AIError('abort', '止めました');
  if (A && e instanceof A.AuthenticationError) return new AIError('auth', 'API キーが正しくありません（✨ →「AI の設定」で確かめてください）');
  if (A && e instanceof A.PermissionDeniedError) return new AIError('perm', 'この API キーでは使えません（組織の設定・残高を確かめてください）');
  if (A && e instanceof A.RateLimitError) return new AIError('rate', '混み合っているか、利用の上限に達しました。少し待ってからもう一度試してください。');
  if (A && e instanceof A.BadRequestError) return new AIError('bad', '送った内容が大きすぎるか、正しくありません: ' + (e.message || ''));
  if (A && e instanceof A.APIConnectionError) return new AIError('net', 'インターネットにつながりません（AI はオンラインの時だけ使えます）');
  if (A && e instanceof A.APIError) return new AIError('api', `Claude API のエラー（${e.status || '?'}）: ${e.message || ''}`);
  return new AIError('other', String((e && e.message) || e));
}

// ================= ノートの中身を AI に渡す形に
/* ページの絵（JPEG base64、長い辺 1568px） */
async function pageImageB64(note, p, side = 1568) {
  const W = Math.round(side * Math.min(1, p.disp.w / Math.max(p.disp.w, p.disp.h)));
  if (p.bg) { try { await BgRender.ensure(p, (W * 1.1) / p.w); } catch { /* 白のまま */ } }
  for (const im of p.images || []) if (!im.kind || im.kind === 'image') ImageCache.get(im.src);
  await new Promise((r) => setTimeout(r, 30));
  return makeThumb(note, p, W).split(',')[1];
}
function pageHasInk(p) { return p.strokes.length > 0 || (p.images || []).some((o) => !o.kind || o.kind === 'image'); }
/* ノートの内容 → user の content（文字と絵）。pages = 対象ページ。絵は最大 maxImages 枚 */
async function noteContent(note, pages, { maxImages = 20, recordings = true, onProgress } = {}) {
  const blocks = [];
  let images = 0, skipped = 0;
  blocks.push({ type: 'text', text: `ノート「${note.item.name}」（全 ${note.pages.length} ページ。ここでは ${pages.length} ページ）` });
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], no = note.pageIndex(p) + 1;
    const parts = [];
    if (p.text) parts.push('［PDF の文字］\n' + p.text.slice(0, 6000));
    const obj = objectsText(p);
    if (obj) parts.push('［置いた文字・付箋］\n' + obj);
    if (p.hw && p.hw.text) parts.push('［手書き（読み取り済み）］\n' + p.hw.text);
    const needImg = pageHasInk(p) || (p.bg && !p.text);
    blocks.push({ type: 'text', text: `\n## p.${no}\n` + (parts.join('\n') || (needImg ? '（下の画像）' : '（空のページ）')) });
    if (needImg) {
      if (images < maxImages) { blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await pageImageB64(note, p) } }); images++; }
      else skipped++;
    }
    if (onProgress) onProgress(i + 1, pages.length);
  }
  if (recordings) for (const r of note.item.recordings || []) {
    const t = (r.transcript || []).map((x) => `[${fmtClock(x.t)}] ${x.text}`).join('\n');
    if (t) blocks.push({ type: 'text', text: `\n## 録音「${r.name}」の文字起こし\n${t.slice(0, 20000)}` });
  }
  if (skipped) blocks.push({ type: 'text', text: `（ほかに ${skipped} ページは画像を省略しました）` });
  return blocks;
}

// ================= 手書き → 文字（位置つき・検索できる）
const HW_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, box: { type: 'array', items: { type: 'number' } } },
        required: ['text', 'box'], additionalProperties: false,
      },
    },
  },
  required: ['lines'], additionalProperties: false,
};
/* 線の様子が変わったか見るための印 */
function inkSig(p) { const s = p.strokes; return s.length ? `${s.length}|${s[0].id}|${s[s.length - 1].id}` : '0'; }
/* 手書きの線だけを白地に描いた絵（書いた範囲を切り出し）。戻り値 {b64, rect(ページの座標)} */
function inkImage(p, side = 1568) {
  const pens = p.strokes.filter((s) => s.tool !== 'hl');
  if (!pens.length) return null;
  const b = unionBBox(pens), pad = 12;
  const x0 = b[0] - pad, y0 = b[1] - pad, w = b[2] - b[0] + pad * 2, h = b[3] - b[1] + pad * 2;
  const k = Math.min(4, side / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(w * k)); c.height = Math.max(8, Math.round(h * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  drawStrokes(g, pens, null, { minW: 1.2 / k });
  return { b64: c.toDataURL('image/png').split(',')[1], rect: [x0, y0, w, h], mime: 'image/png' };
}
async function recognizeHandwriting(p) {
  const img = inkImage(p);
  if (!img) return { text: '', lines: [], sig: inkSig(p), at: Date.now() };
  const r = await AI.run({
    effort: 'low', maxTokens: 16000, json: HW_SCHEMA,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } },
      { type: 'text', text: '画像は手書きのノートです。書かれている文字を、行ごとに上から順に書き起こしてください（日本語・英数字・記号）。\n' +
        '各行の box は、その行が画像のどこにあるかを [左, 上, 右, 下] で、画像の幅と高さをそれぞれ 0〜1000 とした数で表してください。\n' +
        '図や矢印だけの所は省き、読めない字は「□」にします。文字が無ければ lines は空にします。' },
    ] }],
  });
  const [x0, y0, w, h] = img.rect;
  const lines = (r.data.lines || []).filter((l) => l.text && l.text.trim()).map((l) => {
    const bx = (l.box || [0, 0, 1000, 1000]).map((v) => clamp(+v || 0, 0, 1000) / 1000);
    return { text: l.text.trim(), box: [x0 + bx[0] * w, y0 + bx[1] * h, x0 + bx[2] * w, y0 + bx[3] * h] };
  });
  return { text: lines.map((l) => l.text).join('\n'), lines, sig: inkSig(p), at: Date.now(), cost: r.cost };
}

// ================= 暗記カード
const CARDS_SCHEMA = {
  type: 'object',
  properties: { cards: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' }, page: { type: 'integer' } }, required: ['q', 'a', 'page'], additionalProperties: false } } },
  required: ['cards'], additionalProperties: false,
};
/* 覚えた度合い（ライトナー式: 箱 0〜5、箱が上がるほど次に出るまで空く） */
const BOX_DAYS = [0, 1, 3, 7, 16, 35];
function cardDue(c) { return (c.due || 0) <= Date.now(); }
function cardAnswer(c, ok) {
  c.box = ok ? Math.min(5, (c.box || 0) + 1) : 0;
  c.due = Date.now() + BOX_DAYS[c.box] * 86400000 + (ok ? 0 : 60 * 1000);
  c.seen = (c.seen || 0) + 1;
}

// ================= ノートの整理
const ORG_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    pages: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, heading: { type: 'string' } }, required: ['page', 'heading'], additionalProperties: false } },
  },
  required: ['title', 'summary', 'pages'], additionalProperties: false,
};

/* 少しの Markdown（見出し・箇条書き・太字）を要素に。文字はすべて textContent で入れる（HTML として解釈しない） */
function mdToEl(md) {
  const root = el('div', { class: 'md' });
  let list = null;
  const inline = (s) => {
    const span = el('span');
    s.split(/(\*\*[^*]+\*\*)/g).forEach((part) => { if (/^\*\*[^*]+\*\*$/.test(part)) span.append(el('b', {}, part.slice(2, -2))); else if (part) span.append(part); });
    return span;
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,4})\s+(.*)$/), li = line.match(/^\s*(?:[-*・]|\d+[.)])\s+(.*)$/);
    if (h) { list = null; root.append(el(h[1].length <= 2 ? 'h3' : 'h4', {}, inline(h[2]))); }
    else if (li) { if (!list) { list = el('ul'); root.append(list); } list.append(el('li', {}, inline(li[1]))); }
    else if (!line.trim()) list = null;
    else { list = null; root.append(el('p', {}, inline(line))); }
  }
  return root;
}
