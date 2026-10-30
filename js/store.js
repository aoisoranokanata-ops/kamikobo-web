'use strict';
/* 保存（IndexedDB "kamikobo-web"）。
   items: {id, type:'folder'|'note', parent:(フォルダの id or 'root'), name, created, updated, trashed, color,
           // ノート: kind:'paged'|'board', pageIds:[...], thumb(dataURL), paper(既定の用紙), size(既定の大きさ)}
   pages: {id, noteId, w, h (pt), rot (0/90/180/270), paper:{type, color, spacing}, infinite, strokes:[線...],
           bg:{src, page(0 始まり), vt(pdf.js の表示行列 scale 1)}（PDF のページが下地のとき）, images:[画像...]}
   線は {id, tool:'pen'|'hl', pen:'ball'|'fountain'|'brush', color, w, op, pts: Float32Array [x,y,p,t,...]}
   画像は {id, src, x, y, w, h (pt), rot(ラジアン、中心まわり)}
   blobs: キー 'src|…'（PDF・画像の中身）→ {type, name, data: ArrayBuffer}
   texts: {pageId, noteId, text(PDF の文字), obj(文字・付箋・スタンプの文字)}（本棚の文字検索用に、ページとは別に軽く持つ）
   （構造化複製でそのまま入る。Blob は使わない＝iPad の WebKit で失敗することがあるため） */

const Store = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('kamikobo-web', 2);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('noteId', 'noteId');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');      // PDF・画像・録音
        if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'pageId' }).createIndex('noteId', 'noteId');
      };
      rq.onsuccess = () => {
        const db = rq.result;
        db.onclose = () => { if (this.db === db) this.db = null; };
        db.onversionchange = () => { db.close(); if (this.db === db) this.db = null; };
        this.db = db;
        res(db);
      };
      rq.onerror = () => rej(rq.error || new Error('保存領域を開けません'));
    });
  },
  async tx(stores, mode, fn) {
    try { return await this._tx(stores, mode, fn); } catch (e) {
      if (e && (e.name === 'InvalidStateError' || e.name === 'UnknownError' || /connection|closing|lost/i.test(e.message || ''))) {
        try { this.db && this.db.close(); } catch { /* */ }
        this.db = null;
        return this._tx(stores, mode, fn);      // 接続が切れていたら開き直して 1 回だけやり直す
      }
      throw e;
    }
  },
  _tx(stores, mode, fn) {
    return this.open().then((db) => new Promise((res, rej) => {
      let t;
      try { t = db.transaction(stores, mode); } catch (e) { rej(e); return; }
      let out, reqErr = null;
      t.oncomplete = () => res(out);
      t.onerror = (ev) => { reqErr = (ev && ev.target && ev.target.error) || reqErr; };
      t.onabort = () => rej(t.error || reqErr || new Error('保存が中断されました（容量不足の可能性）'));
      try { out = fn(...stores.map((s) => t.objectStore(s))); } catch (e) { try { t.abort(); } catch { /* */ } rej(e); }
    }));
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },

  async allItems() { return (await this.tx(['items'], 'readonly', (s) => this.req(s.getAll()))) || []; },
  async getItem(id) { return this.tx(['items'], 'readonly', (s) => this.req(s.get(id))); },
  async putItem(it) { await this.tx(['items'], 'readwrite', (s) => { s.put(it); }); },
  async putItems(list) { await this.tx(['items'], 'readwrite', (s) => { for (const it of list) s.put(it); }); },
  async getPages(ids) {
    return this.tx(['pages'], 'readonly', (s) => Promise.all(ids.map((id) => this.req(s.get(id)))));
  },
  /* ノートとページをまとめて書く（変わったページだけ・消えたページは消す）。texts = [{pageId, noteId, text}] */
  async saveNote(item, pages, removedPageIds = [], texts = []) {
    await this.tx(['items', 'pages', 'texts'], 'readwrite', (si, sp, st) => {
      si.put(item);
      for (const p of pages) sp.put(p);
      for (const id of removedPageIds) { sp.delete(id); st.delete(id); }
      for (const r of texts) { if (r.text || r.obj) st.put(r); else st.delete(r.pageId); }
    });
  },
  async putTexts(list) { await this.tx(['texts'], 'readwrite', (s) => { for (const r of list) { if (r.text || r.obj) s.put(r); else s.delete(r.pageId); } }); },
  async getTexts(noteId) { return this.tx(['texts'], 'readonly', (s) => this.req(s.index('noteId').getAll(noteId))); },
  async allTexts() { return (await this.tx(['texts'], 'readonly', (s) => this.req(s.getAll()))) || []; },
  async putBlob(key, rec) { await this.tx(['blobs'], 'readwrite', (s) => { s.put(rec, key); }); },
  async getBlob(key) { return this.tx(['blobs'], 'readonly', (s) => this.req(s.get(key))); },
  async delBlob(key) { await this.tx(['blobs'], 'readwrite', (s) => { s.delete(key); }); },
  async hasBlob(key) { return !!(await this.tx(['blobs'], 'readonly', (s) => this.req(s.getKey(key)))); },
  /* どのページからも使われていない PDF・画像を消す */
  async gcBlobs() {
    const used = new Set();
    await this.tx(['pages'], 'readonly', (s) => new Promise((res) => {
      const rq = s.openCursor();
      rq.onsuccess = () => {
        const c = rq.result;
        if (!c) { res(); return; }
        const p = c.value;
        if (p.bg) used.add(p.bg.src);
        if (p.paper && p.paper.src) used.add(p.paper.src);
        for (const im of p.images || []) used.add(im.src);
        c.continue();
      };
      rq.onerror = () => res();
    }));
    for (const t of MyTemplates.list()) used.add(t.src);          // 自作テンプレートの中身も残す
    for (const it of await this.allItems()) for (const r of it.recordings || []) used.add(r.src);     // 録音も
    const keys = await this.tx(['blobs'], 'readonly', (s) => this.req(s.getAllKeys()));
    const gone = keys.filter((k) => String(k).startsWith('src|') && !used.has(k));
    if (gone.length) await this.tx(['blobs'], 'readwrite', (s) => { for (const k of gone) s.delete(k); });
    return gone.length;
  },
  /* 完全に消す（ゴミ箱を空にする）: 中身のフォルダ・ノート・ページごと */
  async deleteForever(ids) {
    const all = await this.allItems();
    const kill = new Set();
    const walk = (id) => { kill.add(id); for (const c of all) if (c.parent === id) walk(c.id); };
    for (const id of ids) walk(id);
    const pageIds = [];
    for (const it of all) if (kill.has(it.id) && it.type === 'note') {
      pageIds.push(...(it.pageIds || []));
      for (const r of it.recordings || []) pageIds.push('rec|' + r.id);      // 録音の文字（texts）も消す
    }
    await this.tx(['items', 'pages', 'blobs', 'texts'], 'readwrite', (si, sp, sb, st) => {
      for (const id of kill) { si.delete(id); sb.delete(IDBKeyRange.bound(id + '|', id + '|￿')); }
      for (const id of pageIds) { sp.delete(id); st.delete(id); }
    });
    try { await this.gcBlobs(); } catch { /* 次の機会に */ }
    return kill.size;
  },
  async estimate() {
    try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
  },
};

/* ページの保存用の形（表示用のキャッシュ _path などを落とす） */
function pageRecord(pg) {
  const r = { id: pg.id, noteId: pg.noteId, w: pg.w, h: pg.h, rot: pg.rot || 0, infinite: !!pg.infinite, paper: pg.paper,
    strokes: pg.strokes.map(strokeRecord) };
  if (pg.bg) r.bg = { src: pg.bg.src, page: pg.bg.page, vt: pg.bg.vt, ...(pg.bg.tpl ? { tpl: true } : {}) };
  if (pg.mark) r.mark = { ...pg.mark };
  if (pg.images && pg.images.length) r.images = pg.images.map(imageRecord);
  return r;
}
/* ページに置く物（画像・文字・スタンプ・リンク）。表示用のキャッシュ（_ で始まる）は落とす */
function imageRecord(im) {
  const r = {};
  for (const k of Object.keys(im)) if (k[0] !== '_' && im[k] !== undefined) r[k] = im[k];
  r.rot = im.rot || 0;
  return r;
}
function strokeRecord(s) {
  const r = { id: s.id, tool: s.tool, pen: s.pen, color: s.color, w: s.w, op: s.op, t0: s.t0 || 0, pts: s.pts };
  if (s.fill) r.fill = s.fill;            // 図形ツールの塗り
  return r;
}
