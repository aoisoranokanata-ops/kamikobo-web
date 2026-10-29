'use strict';
/* 本棚: フォルダ（サブフォルダは何段でも）とノートの一覧・新規作成・名前・移動・複製・色・ゴミ箱・並べ替え・題名の検索。 */

const FOLDER_COLORS = ['#5b8def', '#e0864a', '#4caf7a', '#c65bd6', '#e05a6a', '#8a8f99', '#d8b13a'];

class Library {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.folder = 'root';            // 今いるフォルダ（'trash' はゴミ箱）
    this.query = '';
    this.sort = loadJSON('library', { sort: 'updated' }).sort;
    this.root = $('#library');
    this.grid = $('#shelf');
    $('#lib-new').addEventListener('click', (e) => this.newMenu(e.currentTarget));
    $('#lib-sort').addEventListener('click', (e) => this.sortMenu(e.currentTarget));
    $('#lib-trash').addEventListener('click', () => this.open('trash'));
    $('#lib-settings').addEventListener('click', () => this.app.settingsDialog());
    const q = $('#lib-search');
    q.addEventListener('input', () => { this.query = q.value.trim(); this.render(); });
  }

  async refresh() { this.items = await Store.allItems(); this.render(); }
  byId(id) { return this.items.find((it) => it.id === id); }
  children(folderId) { return this.items.filter((it) => it.parent === folderId && !it.trashed); }
  path(id) {
    const out = [];
    let cur = this.byId(id);
    while (cur) { out.unshift(cur); cur = cur.parent === 'root' ? null : this.byId(cur.parent); }
    return out;
  }
  open(folderId) { this.folder = folderId; this.query = ''; $('#lib-search').value = ''; this.render(); }

  sorted(list) {
    const k = this.sort;
    return list.slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      if (k === 'name') return a.name.localeCompare(b.name, 'ja', { numeric: true });
      if (k === 'created') return b.created - a.created;
      return b.updated - a.updated;
    });
  }

  render() {
    const g = this.grid;
    g.innerHTML = '';
    this.renderCrumbs();
    let list;
    if (this.query) {
      const q = this.query.toLowerCase();
      list = this.items.filter((it) => !it.trashed && !this.path(it.parent).some((f) => f.trashed) && it.name.toLowerCase().includes(q));
    } else if (this.folder === 'trash') {
      list = this.items.filter((it) => it.trashed && !(it.parent !== 'root' && this.byId(it.parent) && this.byId(it.parent).trashed));
    } else list = this.children(this.folder);
    list = this.sorted(list);
    if (this.folder === 'trash' && !this.query) {
      g.append(el('div', { class: 'shelf-note' }, list.length ? 'ゴミ箱の中身（元に戻すか、完全に削除できます）' : 'ゴミ箱は空です',
        list.length ? el('button', { class: 'danger small', onclick: () => this.emptyTrash() }, 'ゴミ箱を空にする') : null));
    }
    if (!list.length && this.folder !== 'trash') {
      g.append(el('div', { class: 'shelf-empty' }, this.query ? '見つかりませんでした' : 'ここにはまだ何もありません。右上の「＋ 新規」から作れます。'));
    }
    for (const it of list) g.append(this.card(it));
  }

  renderCrumbs() {
    const c = $('#lib-crumbs');
    c.innerHTML = '';
    c.append(el('button', { class: 'crumb', onclick: () => this.open('root') }, '本棚'));
    if (this.query) { c.append(el('span', { class: 'crumb-sep' }, '›'), el('span', { class: 'crumb cur' }, `「${this.query}」の検索`)); return; }
    if (this.folder === 'trash') { c.append(el('span', { class: 'crumb-sep' }, '›'), el('span', { class: 'crumb cur' }, 'ゴミ箱')); return; }
    for (const f of this.path(this.folder)) {
      c.append(el('span', { class: 'crumb-sep' }, '›'), el('button', { class: 'crumb' + (f.id === this.folder ? ' cur' : ''), onclick: () => this.open(f.id) }, f.name));
    }
  }

  card(it) {
    const isFolder = it.type === 'folder';
    const thumb = isFolder
      ? el('div', { class: 'folder-icon', style: { '--fc': it.color || FOLDER_COLORS[0] } },
        el('span', {}, String(this.children(it.id).length)))
      : el('div', { class: 'cover' + (it.kind === 'board' ? ' board' : '') }, it.thumb ? el('img', { src: it.thumb, alt: '' }) : null,
        it.kind === 'board' ? el('span', { class: 'cover-tag' }, '∞') : null);
    const sub = isFolder ? 'フォルダ' : `${fmtDate(it.updated)}${it.pageIds && it.kind !== 'board' ? ' ・ ' + it.pageIds.length + ' ページ' : ''}`;
    const where = this.query && it.parent !== 'root' ? this.path(it.parent).map((f) => f.name).join(' › ') : '';
    const more = el('button', { class: 'card-more', title: 'その他', onclick: (e) => { e.stopPropagation(); this.itemMenu(it, e.currentTarget); } }, '⋯');
    const card = el('div', { class: 'card' + (isFolder ? ' is-folder' : '') }, thumb,
      el('div', { class: 'card-name' }, it.name), el('div', { class: 'card-sub' }, where || sub), more);
    // 長押しでメニュー（その後の click では開かない）
    let t = 0;
    card.addEventListener('click', () => {
      if (t === -1) { t = 0; return; }
      if (it.trashed) { this.itemMenu(it, more); return; }
      if (isFolder) this.open(it.id); else this.app.openNote(it.id);
    });
    card.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') t = setTimeout(() => { t = -1; this.itemMenu(it, card); }, 520); });
    const stop = () => { if (t > 0) { clearTimeout(t); t = 0; } };
    card.addEventListener('pointerup', stop);
    card.addEventListener('pointercancel', stop);
    card.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch' && Math.abs(e.movementY) > 4) stop(); });
    return card;
  }

  itemMenu(it, anchor) {
    if (it.trashed) {
      popMenu(anchor, [
        { label: '元に戻す', fn: () => this.restore(it) },
        { label: '完全に削除', danger: true, fn: () => this.destroy(it) },
      ]);
      return;
    }
    const items = [
      { label: it.type === 'folder' ? '開く' : 'ノートを開く', fn: () => (it.type === 'folder' ? this.open(it.id) : this.app.openNote(it.id)) },
      { label: '名前を変更', fn: () => this.rename(it) },
      { label: '移動…', fn: () => this.moveDialog([it]) },
    ];
    if (it.type === 'note') items.push({ label: '複製', fn: () => this.duplicate(it) });
    if (it.type === 'folder') items.push({ label: '色…', fn: () => this.colorMenu(it, anchor) });
    items.push(null, { label: 'ゴミ箱へ', danger: true, fn: () => this.trash(it) });
    popMenu(anchor, items);
  }
  colorMenu(it, anchor) {
    popMenu(anchor, FOLDER_COLORS.map((c) => ({ label: '●', fn: async () => { it.color = c; it.updated = Date.now(); await Store.putItem(it); this.render(); } })));
    const m = $('.popmenu');
    if (m) [...m.children].forEach((b, i) => { b.style.color = FOLDER_COLORS[i]; b.style.fontSize = '22px'; });
  }

  newMenu(anchor) {
    popMenu(anchor, [
      { label: '📓 新しいノート', fn: () => this.app.newNoteDialog('paged') },
      { label: '∞ 無限キャンバス', fn: () => this.app.newNoteDialog('board') },
      { label: '📁 新しいフォルダ', fn: () => this.newFolder() },
    ]);
  }
  sortMenu(anchor) {
    const set = (k) => { this.sort = k; saveJSON('library', { sort: k }); this.render(); };
    popMenu(anchor, [
      { label: (this.sort === 'updated' ? '✓ ' : '　 ') + '更新した順', fn: () => set('updated') },
      { label: (this.sort === 'created' ? '✓ ' : '　 ') + '作った順', fn: () => set('created') },
      { label: (this.sort === 'name' ? '✓ ' : '　 ') + '名前の順', fn: () => set('name') },
    ]);
  }
  currentFolderForNew() { return this.folder === 'trash' || this.query ? 'root' : this.folder; }

  async newFolder() {
    const name = await askText('新しいフォルダ', '新しいフォルダ');
    if (!name) return;
    const now = Date.now();
    const it = { id: uid('f'), type: 'folder', parent: this.currentFolderForNew(), name, created: now, updated: now, trashed: false,
      color: FOLDER_COLORS[this.items.filter((x) => x.type === 'folder').length % FOLDER_COLORS.length] };
    await Store.putItem(it);
    await this.refresh();
  }
  async rename(it) {
    const name = await askText('名前を変更', it.name);
    if (!name || name === it.name) return;
    it.name = name; it.updated = Date.now();
    await Store.putItem(it);
    this.render();
  }
  async duplicate(it) {
    const pages = (await Store.getPages(it.pageIds)).filter(Boolean);
    const now = Date.now();
    const copy = { ...it, id: uid('n'), name: it.name + ' のコピー', created: now, updated: now };
    const newPages = pages.map((p) => ({ ...p, id: uid('p'), noteId: copy.id, strokes: p.strokes.map((s) => ({ ...s, id: uid('s') })) }));
    copy.pageIds = newPages.map((p) => p.id);
    await Store.saveNote(copy, newPages);
    await this.refresh();
    toast('複製しました');
  }
  async trash(it) {
    it.trashed = true; it.trashedAt = Date.now();
    await Store.putItem(it);
    await this.refresh();
    toast(`「${it.name}」をゴミ箱へ移しました`);
  }
  async restore(it) {
    it.trashed = false;
    if (it.parent !== 'root' && (!this.byId(it.parent) || this.byId(it.parent).trashed)) it.parent = 'root';
    await Store.putItem(it);
    await this.refresh();
  }
  async destroy(it) {
    if (!await confirmBox('完全に削除', `「${it.name}」${it.type === 'folder' ? '（中身ごと）' : ''}を完全に削除します。元に戻せません。`, '削除', true)) return;
    await Store.deleteForever([it.id]);
    await this.refresh();
  }
  async emptyTrash() {
    const list = this.items.filter((it) => it.trashed);
    if (!list.length) return;
    if (!await confirmBox('ゴミ箱を空にする', `${list.length} 個を完全に削除します。元に戻せません。`, '空にする', true)) return;
    await Store.deleteForever(list.map((it) => it.id));
    await this.refresh();
  }

  /* 移動先のフォルダを選ぶ（木の形で。自分自身と自分の中へは移せない） */
  async moveDialog(list) {
    const bad = new Set();
    const mark = (id) => { bad.add(id); for (const c of this.items) if (c.parent === id) mark(c.id); };
    for (const it of list) if (it.type === 'folder') mark(it.id);
    let chosen = null;
    const tree = el('div', { class: 'folder-tree' });
    const row = (id, name, depth) => {
      const b = el('button', { class: 'tree-row', style: { paddingLeft: 10 + depth * 18 + 'px' }, disabled: bad.has(id) },
        id === 'root' ? '🏠 ' : '📁 ', name);
      b.addEventListener('click', () => { chosen = id; for (const x of $$('.tree-row', tree)) x.classList.remove('on'); b.classList.add('on'); });
      tree.append(b);
      const kids = this.items.filter((x) => x.type === 'folder' && x.parent === id && !x.trashed).sort((a, b2) => a.name.localeCompare(b2.name, 'ja'));
      for (const k of kids) row(k.id, k.name, depth + 1);
    };
    row('root', '本棚（いちばん上）', 0);
    const ok = await modal('移動先のフォルダ', tree, [
      { label: '新しいフォルダ…', value: 'new' }, { label: 'キャンセル', value: null }, { label: '移動', primary: true, value: 'ok' }]);
    if (ok === 'new') {
      const name = await askText('新しいフォルダ', '新しいフォルダ');
      if (!name) return;
      const now = Date.now();
      const f = { id: uid('f'), type: 'folder', parent: chosen || this.currentFolderForNew(), name, created: now, updated: now, trashed: false, color: FOLDER_COLORS[0] };
      await Store.putItem(f);
      chosen = f.id;
    } else if (ok !== 'ok' || !chosen) return;
    for (const it of list) { it.parent = chosen; it.updated = Date.now(); }
    await Store.putItems(list);
    await this.refresh();
    toast('移動しました');
  }
}
