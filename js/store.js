'use strict';
/* 保存（IndexedDB "kamikobo-web"）。
   items: {id, type:'folder'|'note', parent:(フォルダの id or 'root'), name, created, updated, trashed, color,
           // ノート: kind:'paged'|'board', pageIds:[...], thumb(dataURL), paper(既定の用紙), size(既定の大きさ)}
   pages: {id, noteId, w, h (pt), rot (0/90/180/270), paper:{type, color, spacing}, infinite, strokes:[線...]}
   線は {id, tool:'pen'|'hl', pen:'ball'|'fountain'|'brush', color, w, op, pts: Float32Array [x,y,p,t,...]}
   （構造化複製でそのまま入る。Blob は使わない＝iPad の WebKit で失敗することがあるため） */

const Store = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('kamikobo-web', 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('noteId', 'noteId');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');      // フェーズ2以降（PDF・画像・録音）
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
  /* ノートとページをまとめて書く（変わったページだけ・消えたページは消す） */
  async saveNote(item, pages, removedPageIds = []) {
    await this.tx(['items', 'pages'], 'readwrite', (si, sp) => {
      si.put(item);
      for (const p of pages) sp.put(p);
      for (const id of removedPageIds) sp.delete(id);
    });
  },
  /* 完全に消す（ゴミ箱を空にする）: 中身のフォルダ・ノート・ページごと */
  async deleteForever(ids) {
    const all = await this.allItems();
    const kill = new Set();
    const walk = (id) => { kill.add(id); for (const c of all) if (c.parent === id) walk(c.id); };
    for (const id of ids) walk(id);
    const pageIds = [];
    for (const it of all) if (kill.has(it.id) && it.type === 'note') pageIds.push(...(it.pageIds || []));
    await this.tx(['items', 'pages', 'blobs'], 'readwrite', (si, sp, sb) => {
      for (const id of kill) { si.delete(id); sb.delete(IDBKeyRange.bound(id + '|', id + '|￿')); }
      for (const id of pageIds) sp.delete(id);
    });
    return kill.size;
  },
  async estimate() {
    try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
  },
};

/* ページの保存用の形（表示用のキャッシュ _path などを落とす） */
function pageRecord(pg) {
  return { id: pg.id, noteId: pg.noteId, w: pg.w, h: pg.h, rot: pg.rot || 0, infinite: !!pg.infinite, paper: pg.paper,
    strokes: pg.strokes.map(strokeRecord) };
}
function strokeRecord(s) {
  return { id: s.id, tool: s.tool, pen: s.pen, color: s.color, w: s.w, op: s.op, t0: s.t0 || 0, pts: s.pts };
}
