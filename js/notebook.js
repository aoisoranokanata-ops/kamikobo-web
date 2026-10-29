'use strict';
/* 開いているノート: ページの並び・表示上の位置（文書の空間）・取り消しの履歴・自動保存。
   文書の空間: ページを縦に並べ、横は中央が 0。無限キャンバスは 1 枚のページ＝文書の空間そのもの。
   ページの回転 rot（時計回り 0/90/180/270）は表示の向き。線は回転前のページ座標で持つ。 */

const PAGE_GAP = 24;

class Note {
  constructor(item, pages) {
    this.item = item;
    this.pages = pages;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = new Set();        // 書き直すページの id
    this.removed = [];             // 消したページの id（保存時に消す）
    this.itemDirty = false;
    this.version = 0;              // 表示のキャッシュの鍵
    this.listeners = [];
    this._known = new Set(pages.map((p) => p.id));     // 保存済みのページ（消えたら保存時に消す）
    this.layout();
  }
  get board() { return this.item.kind === 'board'; }

  static async load(item) {
    const [recs, texts] = await Promise.all([Store.getPages(item.pageIds), Store.getTexts(item.id)]);
    const tmap = new Map(texts.map((r) => [r.pageId, r.text]));
    const pages = recs.map((r, i) => r || blankPage(item, item.pageIds[i]));
    for (const p of pages) {
      p.noteId = item.id; p.strokes = p.strokes || []; p.images = p.images || [];
      if (tmap.has(p.id)) p.text = tmap.get(p.id);
    }
    return new Note(item, pages);
  }

  // ---- 位置
  layout() {
    let y = 0;
    for (const p of this.pages) {
      const rot = p.rot || 0;
      const [dw, dh] = rot % 180 ? [p.h, p.w] : [p.w, p.h];
      p.disp = { x: -dw / 2, y, w: dw, h: dh };
      y += dh + PAGE_GAP;
    }
    this.height = Math.max(0, y - PAGE_GAP);
    this.width = Math.max(0, ...this.pages.map((p) => p.disp.w));
  }
  /* ページの座標 → 文書の空間 の行列 */
  pageMatrix(p) {
    if (p.infinite) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const { x, y } = p.disp, w = p.w, h = p.h;
    switch (p.rot || 0) {
      case 90: return { a: 0, b: 1, c: -1, d: 0, e: x + h, f: y };
      case 180: return { a: -1, b: 0, c: 0, d: -1, e: x + w, f: y + h };
      case 270: return { a: 0, b: -1, c: 1, d: 0, e: x, f: y + w };
      default: return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
    }
  }
  docToPage(p, X, Y) {
    const m = this.pageMatrix(p), det = m.a * m.d - m.b * m.c, x = X - m.e, y = Y - m.f;
    return { x: (m.d * x - m.c * y) / det, y: (-m.b * x + m.a * y) / det };
  }
  /* 文書の点がどのページにあるか（ページの外なら一番近いページと、外かどうか） */
  pageAt(X, Y, slack = 0) {
    if (this.board) return { page: this.pages[0], inside: true };
    let best = null, bd = Infinity;
    for (const p of this.pages) {
      const r = p.disp;
      const dx = X < r.x ? r.x - X : X > r.x + r.w ? X - r.x - r.w : 0;
      const dy = Y < r.y ? r.y - Y : Y > r.y + r.h ? Y - r.y - r.h : 0;
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = p; }
    }
    return { page: best, inside: bd <= slack };
  }
  pageIndex(p) { return this.pages.indexOf(p); }

  // ---- 変更と履歴
  touch(page) {
    if (page) this.dirty.add(page.id);
    this.version++;
    for (const f of this.listeners) f();
  }
  /* 線の入れ替え（消した線・増えた線）。取り消しは逆の入れ替え */
  strokesCmd(page, removed, added, label = '書き込み') {
    if (!removed.length && !added.length) return;
    const idx = removed.map((s) => page.strokes.indexOf(s));
    const cmd = {
      label,
      redo: () => {
        const rm = new Set(removed.map((s) => s.id));
        page.strokes = page.strokes.filter((s) => !rm.has(s.id)).concat(added);
        this.touch(page);
      },
      undo: () => {
        const ad = new Set(added.map((s) => s.id));
        const list = page.strokes.filter((s) => !ad.has(s.id));
        removed.map((s, k) => [s, idx[k]]).sort((a, b) => a[1] - b[1]).forEach(([s, i]) => list.splice(i < 0 ? list.length : Math.min(i, list.length), 0, s));
        page.strokes = list;
        this.touch(page);
      },
    };
    this.push(cmd);
  }
  /* ページの線の並びを丸ごと入れ替える（消しゴム・なげなわ: 途中で何度も変えた結果をまとめて 1 回の取り消しに） */
  swapCmd(page, before, after, label) {
    const apply = (list) => { page.strokes = list.slice(); this.touch(page); };
    this.push({ label, redo: () => apply(after), undo: () => apply(before) }, false);
    apply(after);
  }
  /* 線と画像をいっしょに入れ替える（なげなわで画像も動かしたとき） */
  swapBoth(page, sBefore, sAfter, iBefore, iAfter, label) {
    const apply = (s, i) => { page.strokes = s.slice(); page.images = i.slice(); this.touch(page); };
    this.push({ label, redo: () => apply(sAfter, iAfter), undo: () => apply(sBefore, iBefore) }, false);
    apply(sAfter, iAfter);
  }
  push(cmd, run = true) {
    if (run) cmd.redo();
    this.undoStack.push(cmd);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() { const c = this.undoStack.pop(); if (!c) return null; c.undo(); this.redoStack.push(c); return c.label; }
  redo() { const c = this.redoStack.pop(); if (!c) return null; c.redo(); this.undoStack.push(c); return c.label; }

  // ---- ページの操作（すべて履歴に入る）
  structCmd(label, fn) {
    const before = this.pages.slice();
    const beforeRot = new Map(this.pages.map((p) => [p, p.rot || 0]));
    fn();
    const after = this.pages.slice();
    const afterRot = new Map(this.pages.map((p) => [p, p.rot || 0]));
    const apply = (list, rots) => {
      this.pages = list.slice();
      for (const [p, r] of rots) p.rot = r;
      this.item.pageIds = this.pages.map((p) => p.id);
      for (const p of this.pages) this.dirty.add(p.id);
      this.itemDirty = true;
      this.layout();
      this.touch(null);
    };
    this.push({ label, redo: () => apply(after, afterRot), undo: () => apply(before, beforeRot) }, false);
    apply(after, afterRot);
  }
  addPage(at, like = null, paper = null) {
    const ref = like || this.pages[Math.min(at, this.pages.length - 1)] || this.pages[0];
    const p = blankPage(this.item, uid('p'), ref ? { w: ref.w, h: ref.h, rot: ref.rot, paper: paper || ref.paper, bg: paper ? null : ref.bg } : null);
    this.structCmd('ページを追加', () => this.pages.splice(at, 0, p));
    return p;
  }
  deletePage(p) {
    if (this.pages.length <= 1) throw new Error('ページは 1 枚以上必要です');
    this.structCmd('ページを削除', () => this.pages.splice(this.pages.indexOf(p), 1));
  }
  duplicatePage(p) {
    const q = copyPage(p, this.item.id);
    this.structCmd('ページを複製', () => this.pages.splice(this.pages.indexOf(p) + 1, 0, q));
    return q;
  }
  /* よそ（PDF・別のノート）から来たページを at の位置に入れる */
  insertPages(at, list, label = 'ページを挿入') {
    for (const q of list) { q.noteId = this.item.id; q.strokes = q.strokes || []; q.images = q.images || []; }
    this.structCmd(label, () => this.pages.splice(at, 0, ...list));
  }
  removePages(list, label = 'ページを削除') {
    if (list.length >= this.pages.length) throw new Error('ページは 1 枚以上必要です');
    const kill = new Set(list);
    this.structCmd(label, () => { this.pages = this.pages.filter((p) => !kill.has(p)); });
  }
  movePage(p, to) {
    this.structCmd('ページを移動', () => {
      const i = this.pages.indexOf(p);
      this.pages.splice(i, 1);
      this.pages.splice(clamp(to, 0, this.pages.length), 0, p);
    });
  }
  rotatePage(p, deg) {
    this.structCmd('ページを回転', () => { p.rot = (((p.rot || 0) + deg) % 360 + 360) % 360; });
  }
  setPaper(pages, paper) {
    const before = pages.map((p) => p.paper);
    const apply = (vals) => { pages.forEach((p, i) => { p.paper = vals[i]; this.dirty.add(p.id); }); this.touch(null); };
    this.push({ label: '用紙を変更', redo: () => apply(pages.map(() => paper)), undo: () => apply(before) });
  }

  // ---- 保存
  async save() {
    const dirtyPages = this.pages.filter((p) => this.dirty.has(p.id));
    const pages = dirtyPages.map(pageRecord);
    const texts = textRecs(dirtyPages, this.item.id, true);
    if (!pages.length && !this.itemDirty && !this.removed.length) return false;
    const live = new Set(this.pages.map((p) => p.id));
    const gone = [...new Set(this.removed.concat(this._known ? [...this._known].filter((id) => !live.has(id)) : []))];
    this.item.pageIds = this.pages.map((p) => p.id);
    this.item.updated = Date.now();
    this.dirty.clear();
    this.itemDirty = false;
    this.removed = [];
    try {
      await Store.saveNote(this.item, pages, gone, texts);
    } catch (e) {
      for (const p of pages) this.dirty.add(p.id);
      this.itemDirty = true;
      throw e;
    }
    this._known = live;
    return true;
  }
}

function blankPage(item, id, like = null) {
  const size = item.size || 'A4';
  let [w, h] = PAGE_SIZES[size] || PAGE_SIZES.A4;
  if (item.landscape) [w, h] = [h, w];
  const p = {
    id, noteId: item.id, w: like ? like.w : w, h: like ? like.h : h, rot: like ? like.rot || 0 : 0,
    paper: like ? like.paper : { ...(item.paper || { type: 'ruled', color: 'white' }) },
    infinite: item.kind === 'board', strokes: [], images: [],
  };
  if (like && like.bg && like.bg.tpl) p.bg = { ...like.bg };      // 自作テンプレート（PDF）は次のページにも
  return p;
}

/* 検索用の文字の記録（PDF の文字と、置いた文字）。all = 空のページも（保存先の古い記録を消すため） */
function textRecs(pages, noteId, all = false) {
  const out = [];
  for (const p of pages) {
    const r = { pageId: p.id, noteId, text: p.text || '', obj: objectsText(p), hw: p.hw ? p.hw.text : '' };
    if (all || r.text || r.obj || r.hw) out.push(r);
  }
  return out;
}

/* ページの写し（線・画像・PDF の下地・文字ごと。id は新しく） */
function copyPage(p, noteId) {
  const q = { ...pageRecord(p), id: uid('p'), noteId };
  q.strokes = p.strokes.map((s) => ({ ...strokeRecord(s), id: uid('s'), pts: s.pts.slice() }));
  q.images = (p.images || []).map((im) => ({ ...imageRecord(im), id: uid('m') }));
  if (p.text !== undefined) q.text = p.text;
  return q;
}

/* 新しいノート（またはホワイトボード）を作って保存する */
async function createNote({ name, parent, kind = 'paged', paper, size = 'A4', landscape = false, pages = 1 }) {
  const now = Date.now();
  const item = { id: uid('n'), type: 'note', kind, parent: parent || 'root', name: name || (kind === 'board' ? '無限キャンバス' : '無題のノート'),
    created: now, updated: now, trashed: false, paper: paper || { type: 'ruled', color: 'white' }, size, landscape, pageIds: [] };
  const list = [];
  for (let i = 0; i < (kind === 'board' ? 1 : Math.max(1, pages)); i++) list.push(blankPage(item, uid('p')));
  item.pageIds = list.map((p) => p.id);
  await Store.saveNote(item, list.map(pageRecord));
  return item;
}

/* 出来上がったページの並びから新しいノートを作る（PDF の読み込み・結合・抽出・分割） */
async function createNoteFromPages({ name, parent, pages, paper, size, thumb }) {
  const now = Date.now();
  const item = { id: uid('n'), type: 'note', kind: 'paged', parent: parent || 'root', name: name || '無題のノート',
    created: now, updated: now, trashed: false, paper: paper || { type: 'blank', color: 'white' }, size: size || 'A4', landscape: false, pageIds: [] };
  for (const p of pages) { p.noteId = item.id; p.strokes = p.strokes || []; p.images = p.images || []; }
  item.pageIds = pages.map((p) => p.id);
  if (thumb) item.thumb = thumb;
  await Store.saveNote(item, pages.map(pageRecord), [], textRecs(pages, item.id));
  return item;
}
