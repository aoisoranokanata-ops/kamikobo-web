'use strict';
/* アプリ: 本棚 ⇔ ノートの切り替え・ツールバー・道具の設定・ページ一覧・ダイアログ・自動保存。 */

const DEFAULT_SETTINGS = {
  fingerDraws: 'auto',        // 'auto'（Pencil を使ったら指では描かない）| true | false
  fingerAction: 'scroll',     // 指で描かない時の 1 本指: 'scroll' | 'erase'
  twoFinger: 'eraser',        // 2 本指タップ: 'eraser'（消しゴムに切り替え）| 'undo'
  rotateGesture: false,       // 2 本指で画面も回す
  fitPage: false,             // 画面に合わせる: ページ全体（false なら幅）
};

const DEFAULT_TOOLS = {
  pen: { pen: 'ball', color: '#1d1d1f', w: 1.0, colors: ['#1d1d1f', '#1f4fd1', '#d12b2b', '#1f8a3c', '#8a3cc2'], widths: [0.6, 1.0, 1.8] },
  hl: { color: '#ffe14d', w: 12, op: 0.4, straight: false, colors: ['#ffe14d', '#9be36b', '#7fd3ff', '#ff9ec7', '#ffb347'], widths: [8, 12, 18] },
  eraser: { mode: 'partial', size: 24, sizes: [12, 24, 48] },
};

class App {
  constructor() {
    this.settings = loadJSON('settings', DEFAULT_SETTINGS);
    const ts = loadJSON('tools', {});
    this.toolState = {};
    for (const k of Object.keys(DEFAULT_TOOLS)) this.toolState[k] = { ...DEFAULT_TOOLS[k], ...(ts[k] || {}) };
    this.note = null;
    this.clipboard = null;
    this.tools = { pen: new PenTool(this, 'pen'), hl: new PenTool(this, 'hl'), eraser: new EraserTool(this), lasso: new LassoTool(this), hand: null };
    this.toolName = 'pen';
    this.prevTool = 'pen';
    this.view = new NoteView(this, $('#base'), $('#over'));
    this.library = new Library(this);
    this.saveSoon = debounce(() => this.saveNote(), 700);
    this.saveViewSoon = debounce(() => this.saveView(), 600);
    this.bindEditor();
    this.bindKeys();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveNote(true); });
    window.addEventListener('pagehide', () => this.saveNote(true));
  }
  get tool() { return this.tools[this.toolName]; }
  saveSettings() { saveJSON('settings', this.settings); }
  saveTools() {
    const out = {};
    for (const [k, v] of Object.entries(this.toolState)) out[k] = { ...v };
    saveJSON('tools', out);
  }

  async start() {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* */ }
    await this.library.refresh();
    const last = loadJSON('session', {}).open;
    if (last && this.library.byId(last) && !this.library.byId(last).trashed) await this.openNote(last);
  }

  // ================= ノートを開く・閉じる
  async openNote(id) {
    const item = await Store.getItem(id);
    if (!item) { toast('ノートが見つかりません', { error: true }); return; }
    this.note = await Note.load(item);
    this.note.listeners.push(() => { this.saveSoon(); this.updateStatus(); });
    $('#library').hidden = true;
    $('#editor').hidden = false;
    $('#note-title').textContent = item.name;
    saveJSON('session', { open: id });
    this.tools.lasso.clear(null);
    this.hideSelectionBar();
    this.view.resize();
    this.view.fit(false);
    if (!this.note.board && item.lastPage) this.view.goToPage(item.lastPage);
    this.view.invalidate();
    this.setTool(this.toolName === 'hand' ? 'pen' : this.toolName);
    this.updateStatus();
  }
  async closeNote() {
    if (!this.note) return;
    this.tools.lasso.clear(this.view);
    await this.saveNote(true, true);
    this.note = null;
    saveJSON('session', {});
    $('#editor').hidden = true;
    $('#library').hidden = false;
    this.closePanel();
    await this.library.refresh();
  }
  async saveNote(now = false, withThumb = false) {
    const n = this.note;
    if (!n) return;
    try {
      if (withThumb || (n.dirty.size && !this._thumbAt) || Date.now() - (this._thumbAt || 0) > 15000) {
        if (n.dirty.size || withThumb) { n.item.thumb = makeThumb(n, n.pages[0], 220); n.itemDirty = true; this._thumbAt = Date.now(); }
      }
      const did = await n.save();
      this._saveErr = false;
      if (did) this.updateStatus();
    } catch (e) {
      this._saveErr = true;
      this.updateStatus();
      if (now) toast('保存できませんでした: ' + (e.message || e), { error: true, ms: 5000 });
      setTimeout(() => this.saveSoon(), 3000);
    }
  }
  saveView() {
    const n = this.note;
    if (!n) return;
    if (n.board) n.item.view = { s: this.view.s, ox: this.view.ox, oy: this.view.oy };
    else n.item.lastPage = this.view.currentPageIndex();
    n.itemDirty = true;
    this.updateStatus();
    this.saveSoon();
  }
  updateStatus() {
    const n = this.note;
    if (!n) return;
    const unsaved = n.dirty.size || n.itemDirty;
    const st = $('#save-state');
    st.textContent = this._saveErr ? '● 未保存' : unsaved ? '…' : '保存済み';
    st.classList.toggle('err', !!this._saveErr);
    $('#btn-undo').disabled = !n.undoStack.length;
    $('#btn-redo').disabled = !n.redoStack.length;
    if (!n.board) $('#page-ind').textContent = `${this.view.currentPageIndex() + 1} / ${n.pages.length}`;
    else $('#page-ind').textContent = '∞';
  }

  // ================= 道具
  setTool(name) {
    if (name !== 'lasso' && this.tools.lasso.sel) this.tools.lasso.clear(this.view);
    if (name !== this.toolName && this.toolName !== 'eraser') this.prevTool = this.toolName;
    this.toolName = name;
    for (const b of $$('#tools [data-tool]')) b.classList.toggle('on', b.dataset.tool === name);
    this.renderQuick();
    this.view.over.style.cursor = name === 'hand' ? 'grab' : 'crosshair';
    this.view.requestOver();
  }
  twoFingerTap() {
    if (this.settings.twoFinger === 'eraser') this.setTool(this.toolName === 'eraser' ? (this.prevTool || 'pen') : 'eraser');
    else this.undo();
  }
  threeFingerTap() { if (this.settings.twoFinger === 'eraser') this.undo(); else this.redo(); }
  undo() {
    if (!this.note) return;
    this.tools.lasso.clear(this.view);
    const l = this.note.undo();
    if (l) this.showBadge('元に戻す: ' + l);
    this.view.invalidate();
    this.updateStatus();
  }
  redo() {
    if (!this.note) return;
    this.tools.lasso.clear(this.view);
    const l = this.note.redo();
    if (l) this.showBadge('やり直す: ' + l);
    this.view.invalidate();
    this.updateStatus();
  }

  /* 道具ごとの「よく使う色・太さ」 */
  renderQuick() {
    const box = $('#quick');
    box.innerHTML = '';
    const k = this.toolName;
    if (k === 'pen' || k === 'hl') {
      const o = this.toolState[k];
      o.colors.forEach((c, i) => {
        const b = el('button', { class: 'swatch' + (c.toLowerCase() === o.color.toLowerCase() ? ' on' : ''), style: { '--c': c }, title: '色（長押しで変更）' });
        b.addEventListener('click', () => { if (b._long) { b._long = false; return; } o.color = c; this.saveTools(); this.renderQuick(); });
        longPress(b, () => { b._long = true; this.pickColor(c, (nc) => { o.colors[i] = nc; o.color = nc; this.saveTools(); this.renderQuick(); }); });
        box.append(b);
      });
      box.append(el('span', { class: 'qsep' }));
      o.widths.forEach((w, i) => {
        const dot = Math.max(3, Math.min(18, k === 'hl' ? w * 0.7 : w * 5));
        const b = el('button', { class: 'width' + (Math.abs(w - o.w) < 1e-6 ? ' on' : ''), title: `太さ ${w}（長押しで変更）` },
          el('i', { style: { width: dot + 'px', height: dot + 'px', background: k === 'hl' ? o.color : '#ddd' } }));
        b.addEventListener('click', () => { if (b._long) { b._long = false; return; } o.w = w; this.saveTools(); this.renderQuick(); });
        longPress(b, async () => {
          b._long = true;
          const v = await askText('太さ（pt）', String(w));
          const nv = parseFloat(v);
          if (nv > 0 && nv < 80) { o.widths[i] = nv; o.w = nv; this.saveTools(); this.renderQuick(); }
        });
        box.append(b);
      });
      if (k === 'pen') {
        box.append(el('span', { class: 'qsep' }));
        box.append(el('button', { class: 'chip', onclick: (e) => this.penKindMenu(e.currentTarget) }, PEN_KINDS[o.pen].label + ' ▾'));
      } else {
        box.append(el('span', { class: 'qsep' }));
        box.append(el('button', { class: 'chip' + (o.straight ? ' on' : ''), onclick: () => { o.straight = !o.straight; this.saveTools(); this.renderQuick(); } }, '直線'));
      }
    } else if (k === 'eraser') {
      const o = this.toolState.eraser;
      for (const [m, label] of [['partial', '部分消し'], ['stroke', '線ごと']]) {
        box.append(el('button', { class: 'chip' + (o.mode === m ? ' on' : ''), onclick: () => { o.mode = m; this.saveTools(); this.renderQuick(); } }, label));
      }
      box.append(el('span', { class: 'qsep' }));
      for (const sz of o.sizes) {
        box.append(el('button', { class: 'width' + (sz === o.size ? ' on' : ''), onclick: () => { o.size = sz; this.saveTools(); this.renderQuick(); } },
          el('i', { style: { width: sz / 3 + 4 + 'px', height: sz / 3 + 4 + 'px', background: 'transparent', border: '1.5px solid #ddd' } })));
      }
    } else if (k === 'lasso') {
      box.append(el('span', { class: 'qhint' }, '囲んで選ぶ → 中をドラッグで移動・□で拡大縮小・○で回転'));
      if (this.clipboard) box.append(el('button', { class: 'chip', onclick: () => this.paste() }, '貼り付け'));
    } else if (k === 'hand') {
      box.append(el('span', { class: 'qhint' }, 'ドラッグで移動・2本指でつまんで拡大縮小'));
    }
  }
  penKindMenu(anchor) {
    const o = this.toolState.pen;
    popMenu(anchor, Object.entries(PEN_KINDS).map(([k, v]) => ({ label: (o.pen === k ? '✓ ' : '　 ') + v.label, fn: () => { o.pen = k; this.saveTools(); this.renderQuick(); } })));
  }
  pickColor(cur, cb) {
    const inp = el('input', { type: 'color', value: cur, class: 'color-input' });
    const grid = el('div', { class: 'palette' });
    const PALETTE = ['#1d1d1f', '#5c5f66', '#9aa0a6', '#ffffff', '#1f4fd1', '#2a8bd8', '#16a3a3', '#1f8a3c', '#7bbf2a', '#d8b13a',
      '#f08c1c', '#d12b2b', '#e0478f', '#8a3cc2', '#6b4a2b', '#ffe14d', '#9be36b', '#7fd3ff', '#ff9ec7', '#ffb347'];
    for (const c of PALETTE) grid.append(el('button', { class: 'swatch', style: { '--c': c }, onclick: () => { inp.value = c; } }));
    modal('色を選ぶ', el('div', {}, grid, el('label', { class: 'row' }, '自由な色 ', inp)), [
      { label: 'キャンセル', value: null }, { label: 'OK', primary: true, value: () => inp.value }]).then((v) => { if (v) cb(v); });
  }

  // ================= なげなわの浮かぶバー
  showSelectionBar(x0, y0, x1, y1, count) {
    const bar = $('#selbar');
    bar.hidden = false;
    $('#sel-count').textContent = `${count} 本`;
    const r = this.view.over.getBoundingClientRect();
    const bw = bar.offsetWidth || 320, bh = bar.offsetHeight || 40;
    let x = r.left + (x0 + x1) / 2 - bw / 2, y = r.top + y0 - bh - 34;
    if (y < r.top + 4) y = r.top + y1 + 14;
    x = clamp(x, 6, innerWidth - bw - 6);
    y = clamp(y, r.top + 4, innerHeight - bh - 6);
    bar.style.left = x + 'px'; bar.style.top = y + 'px';
  }
  hideSelectionBar() { const b = $('#selbar'); if (b) b.hidden = true; }
  paste() {
    const n = this.note;
    if (!n || !this.clipboard) return;
    const P = this.view.toDocLocal(this.view.cssW / 2, this.view.cssH / 2);
    const hit = n.pageAt(P.x, P.y, 1e9);
    const q = n.docToPage(hit.page, P.x, P.y);
    this.setTool('lasso');
    this.tools.lasso.paste(this.view, hit.page, q);
  }

  // ================= ページ
  currentPage() { const n = this.note; return n ? n.pages[this.view.currentPageIndex()] : null; }
  async addPageAfter() {
    const n = this.note;
    if (!n || n.board) return;
    const i = this.view.currentPageIndex();
    n.addPage(i + 1);
    this.view.invalidate();
    this.view.goToPage(i + 1);
    this.updateStatus();
    this.refreshPanel();
  }
  pageMenu(anchor) {
    const n = this.note;
    if (!n) return;
    const p = this.currentPage();
    const items = n.board ? [
      { label: '用紙（背景）を変更…', fn: () => this.paperDialog() },
      { label: '書いたもの全体を表示', fn: () => this.view.fitContent() },
      { label: '中心に戻す', fn: () => { n.item.view = null; this.view.fit(); } },
    ] : [
      { label: '↻ このページを右に回転', fn: () => { n.rotatePage(p, 90); this.afterPageChange(); } },
      { label: '↺ このページを左に回転', fn: () => { n.rotatePage(p, -90); this.afterPageChange(); } },
      null,
      { label: '後ろにページを追加', fn: () => this.addPageAfter() },
      { label: 'このページを複製', fn: () => { n.duplicatePage(p); this.afterPageChange(); } },
      { label: 'このページを削除', danger: true, fn: () => this.deletePage(p) },
      null,
      { label: '用紙を変更…', fn: () => this.paperDialog() },
      { label: 'ページの一覧', fn: () => this.openPanel() },
      { label: '画面に合わせる', fn: () => this.view.fit() },
    ];
    items.push(null, { label: '設定…', fn: () => this.settingsDialog() });
    popMenu(anchor, items);
  }
  afterPageChange() { this.view.invalidate(); this.updateStatus(); this.refreshPanel(); }
  async deletePage(p) {
    const n = this.note;
    if (n.pages.length <= 1) { toast('ページは 1 枚以上必要です', { error: true }); return; }
    if (p.strokes.length && !await confirmBox('ページを削除', `${n.pageIndex(p) + 1} ページ目を削除します（元に戻すで戻せます）。`, '削除', true)) return;
    n.deletePage(p);
    this.afterPageChange();
  }

  /* ページの一覧（右から出る）: タップで移動、ボタンで回転・複製・削除・並べ替え */
  openPanel() { $('#pagepanel').hidden = false; this.refreshPanel(); }
  closePanel() { const p = $('#pagepanel'); if (p) p.hidden = true; }
  refreshPanel() {
    const panel = $('#pagepanel');
    if (!panel || panel.hidden || !this.note) return;
    const list = $('#pp-list');
    list.innerHTML = '';
    const n = this.note, cur = this.view.currentPageIndex();
    n.pages.forEach((p, i) => {
      const img = el('img', { src: makeThumb(n, p, 160), alt: '' });
      const row = el('div', { class: 'pp-item' + (i === cur ? ' on' : '') }, img,
        el('div', { class: 'pp-no' }, String(i + 1)),
        el('div', { class: 'pp-actions' },
          el('button', { title: '上へ', disabled: i === 0, onclick: (e) => { e.stopPropagation(); n.movePage(p, i - 1); this.afterPageChange(); } }, '▲'),
          el('button', { title: '下へ', disabled: i === n.pages.length - 1, onclick: (e) => { e.stopPropagation(); n.movePage(p, i + 1); this.afterPageChange(); } }, '▼'),
          el('button', { title: '右に回転', onclick: (e) => { e.stopPropagation(); n.rotatePage(p, 90); this.afterPageChange(); } }, '↻'),
          el('button', { title: '複製', onclick: (e) => { e.stopPropagation(); n.duplicatePage(p); this.afterPageChange(); } }, '⧉'),
          el('button', { title: '削除', class: 'danger', onclick: (e) => { e.stopPropagation(); this.deletePage(p); } }, '✕')));
      row.addEventListener('click', () => { this.view.goToPage(i); this.updateStatus(); this.refreshPanel(); });
      list.append(row);
    });
  }

  // ================= ダイアログ
  async newNoteDialog(kind) {
    const isBoard = kind === 'board';
    const st = loadJSON('newnote', { type: 'ruled', color: 'white', size: 'A4', landscape: false });
    const name = el('input', { type: 'text', value: isBoard ? '無限キャンバス' : '無題のノート', class: 'wide' });
    const state = { ...st, type: isBoard && st.type !== 'grid' && st.type !== 'dot' && st.type !== 'blank' ? 'dot' : st.type };
    const types = el('div', { class: 'tpl-grid' });
    const colors = el('div', { class: 'tpl-colors' });
    const size = el('select', {}, ...Object.keys(PAGE_SIZES).map((k) => el('option', { value: k, selected: k === st.size }, k)));
    const land = el('label', { class: 'row' }, el('input', { type: 'checkbox', checked: st.landscape }), ' 横向き');
    const draw = () => {
      types.innerHTML = '';
      const list = isBoard ? PAPER_TYPES.filter((t) => ['blank', 'grid', 'dot', 'ruled'].includes(t.id)) : PAPER_TYPES;
      for (const t of list) {
        const c = el('canvas', { width: 96, height: 128 });
        paperPreview(c, { type: t.id, color: state.color }, isBoard ? 'A4' : size.value, !isBoard && land.firstChild.checked);
        const b = el('button', { class: 'tpl' + (t.id === state.type ? ' on' : '') }, c, el('span', {}, t.label));
        b.addEventListener('click', () => { state.type = t.id; draw(); });
        types.append(b);
      }
      colors.innerHTML = '';
      for (const pc of PAPER_COLORS) {
        colors.append(el('button', { class: 'pcolor' + (pc.id === state.color ? ' on' : ''), style: { '--c': pc.bg }, title: pc.label,
          onclick: () => { state.color = pc.id; draw(); } }));
      }
    };
    size.addEventListener('change', draw);
    land.firstChild.addEventListener('change', draw);
    draw();
    const body = el('div', { class: 'newnote' },
      el('label', { class: 'field' }, '名前', name),
      el('div', { class: 'field' }, isBoard ? '背景' : '用紙', types),
      el('div', { class: 'field' }, '紙の色', colors),
      isBoard ? null : el('div', { class: 'field row' }, '大きさ ', size, land));
    const ok = await modal(isBoard ? '無限キャンバスを作る' : '新しいノート', body, [{ label: 'キャンセル', value: null }, { label: '作る', primary: true, value: 'ok' }], { wide: true });
    if (ok !== 'ok') return;
    const landscape = land.firstChild.checked;
    if (!isBoard) saveJSON('newnote', { type: state.type, color: state.color, size: size.value, landscape });
    const item = await createNote({ name: name.value.trim() || undefined, parent: this.library.currentFolderForNew(), kind,
      paper: { type: state.type, color: state.color }, size: size.value, landscape });
    await this.library.refresh();
    await this.openNote(item.id);
  }

  async paperDialog() {
    const n = this.note;
    const p = this.currentPage();
    const state = { ...(p.paper || {}) };
    const types = el('div', { class: 'tpl-grid' }), colors = el('div', { class: 'tpl-colors' });
    const draw = () => {
      types.innerHTML = '';
      for (const t of PAPER_TYPES) {
        const c = el('canvas', { width: 96, height: 128 });
        paperPreview(c, { type: t.id, color: state.color }, 'A4', false);
        const b = el('button', { class: 'tpl' + (t.id === state.type ? ' on' : '') }, c, el('span', {}, t.label));
        b.addEventListener('click', () => { state.type = t.id; draw(); });
        types.append(b);
      }
      colors.innerHTML = '';
      for (const pc of PAPER_COLORS) colors.append(el('button', { class: 'pcolor' + (pc.id === state.color ? ' on' : ''), style: { '--c': pc.bg }, onclick: () => { state.color = pc.id; draw(); } }));
    };
    draw();
    const v = await modal('用紙を変更', el('div', { class: 'newnote' }, el('div', { class: 'field' }, types), el('div', { class: 'field' }, '紙の色', colors)),
      [{ label: 'キャンセル', value: null }, n.board ? null : { label: 'すべてのページ', value: 'all' }, { label: n.board ? '変更' : 'このページ', primary: true, value: 'one' }].filter(Boolean), { wide: true });
    if (!v) return;
    n.setPaper(v === 'all' ? n.pages.slice() : [p], { type: state.type, color: state.color });
    if (v === 'all') { n.item.paper = { type: state.type, color: state.color }; n.itemDirty = true; }
    this.afterPageChange();
  }

  async settingsDialog() {
    const s = this.settings;
    const sel = (key, opts) => {
      const e = el('select', {}, ...opts.map(([v, l]) => el('option', { value: String(v), selected: String(s[key]) === String(v) }, l)));
      e.addEventListener('change', () => { const v = e.value; s[key] = v === 'true' ? true : v === 'false' ? false : v; this.saveSettings(); });
      return e;
    };
    const chk = (key, label) => {
      const c = el('input', { type: 'checkbox', checked: !!s[key] });
      c.addEventListener('change', () => { s[key] = c.checked; this.saveSettings(); });
      return el('label', { class: 'row' }, c, ' ' + label);
    };
    const est = await Store.estimate();
    const used = est && est.usage != null ? `使用中 ${(est.usage / 1048576).toFixed(1)} MB` + (est.quota ? ` ／ 上限の目安 ${(est.quota / 1073741824).toFixed(1)} GB` : '') : '';
    const body = el('div', { class: 'settings' },
      el('label', { class: 'field' }, '指で描く', sel('fingerDraws', [['auto', '自動（Apple Pencil を使ったら指では描かない）'], [true, 'いつも描く'], [false, '描かない']])),
      el('label', { class: 'field' }, '指で描かない時の 1 本指', sel('fingerAction', [['scroll', 'スクロール'], ['erase', 'こすって消す（指消しゴム）']])),
      el('label', { class: 'field' }, '2 本指でタップ', sel('twoFinger', [['eraser', '消しゴムに切り替え（もう一度で戻る）／3本指で元に戻す'], ['undo', '元に戻す／3本指でやり直す']])),
      chk('rotateGesture', '2 本指で画面も回す'),
      chk('fitPage', '「画面に合わせる」でページ全体を表示（オフ = 幅に合わせる）'),
      el('p', { class: 'muted' }, `紙工房 Web ${APP_VERSION}　${used}`));
    await modal('設定', body, [{ label: '閉じる', primary: true, value: true }], { wide: true });
  }

  // ================= その他の UI
  showBadge(text) {
    const b = $('#badge');
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(this._badgeT);
    this._badgeT = setTimeout(() => b.classList.remove('show'), 900);
  }
  closePopups() { closePopMenus(); }
  onTapEmpty() { if (this.tools.lasso.sel) this.tools.lasso.clear(this.view); }

  bindEditor() {
    $('#btn-back').addEventListener('click', () => this.closeNote());
    $('#note-title').addEventListener('click', async () => {
      const n = this.note;
      const name = await askText('ノートの名前', n.item.name);
      if (name) { n.item.name = name; n.itemDirty = true; $('#note-title').textContent = name; this.saveSoon(); }
    });
    for (const b of $$('#tools [data-tool]')) {
      b.addEventListener('click', () => {
        const t = b.dataset.tool;
        if (t === this.toolName && t === 'pen') { this.penKindMenu(b); return; }
        this.setTool(t);
      });
    }
    $('#btn-undo').addEventListener('click', () => this.undo());
    $('#btn-redo').addEventListener('click', () => this.redo());
    $('#btn-addpage').addEventListener('click', () => this.addPageAfter());
    $('#btn-pages').addEventListener('click', () => ($('#pagepanel').hidden ? this.openPanel() : this.closePanel()));
    $('#btn-more').addEventListener('click', (e) => this.pageMenu(e.currentTarget));
    $('#pp-close').addEventListener('click', () => this.closePanel());
    $('#pp-add').addEventListener('click', () => { const n = this.note; n.addPage(n.pages.length); this.afterPageChange(); this.view.goToPage(n.pages.length - 1); });
    const L = () => this.tools.lasso, V = () => this.view;
    $('#sel-del').addEventListener('click', () => L().remove(V()));
    $('#sel-copy').addEventListener('click', () => { L().copy(); this.renderQuick(); });
    $('#sel-cut').addEventListener('click', () => { L().cut(V()); this.renderQuick(); });
    $('#sel-dup').addEventListener('click', () => L().duplicate(V()));
    $('#sel-color').addEventListener('click', () => {
      const cur = L().sel && L().sel.strokes[0] ? L().sel.strokes[0].color : '#000000';
      this.pickColor(cur, (c) => L().recolor(V(), c));
    });
    window.addEventListener('resize', () => this.hideSelectionBar());
  }
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (!this.note || e.target.closest('input,textarea,select') || $('.modal-back')) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
      if (mod && k === 'c' && this.tools.lasso.sel) { e.preventDefault(); this.tools.lasso.copy(); return; }
      if (mod && k === 'x' && this.tools.lasso.sel) { e.preventDefault(); this.tools.lasso.cut(this.view); return; }
      if (mod && k === 'v') { e.preventDefault(); this.paste(); return; }
      if ((k === 'delete' || k === 'backspace') && this.tools.lasso.sel) { e.preventDefault(); this.tools.lasso.remove(this.view); return; }
      if (mod) return;
      const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', ' ': 'hand' };
      if (map[k]) { e.preventDefault(); this.setTool(map[k]); }
    });
  }
}

function longPress(elm, fn, ms = 480) {
  let t = 0;
  elm.addEventListener('pointerdown', () => { t = setTimeout(() => { t = 0; fn(); }, ms); });
  const stop = () => { if (t) { clearTimeout(t); t = 0; } };
  elm.addEventListener('pointerup', stop);
  elm.addEventListener('pointerleave', stop);
  elm.addEventListener('pointercancel', stop);
}

/* ページの小さな絵（dataURL）。無限キャンバスは書いた範囲 */
function makeThumb(note, p, W) {
  if (!p) return '';
  let r;
  if (p.infinite) {
    r = p.strokes.length ? unionBBox(p.strokes) : [-300, -200, 300, 200];
    const pad = 30;
    r = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
    const w = r[2] - r[0], h = r[3] - r[1], need = (w * 4) / 3;
    if (h < need) { r[1] -= (need - h) / 2; r[3] += (need - h) / 2; } else { r[0] -= (h * 0.75 - w) / 2; r[2] += (h * 0.75 - w) / 2; }
  }
  const dw = p.infinite ? r[2] - r[0] : p.disp.w, dh = p.infinite ? r[3] - r[1] : p.disp.h;
  const k = W / dw, H = Math.round(dh * k);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (p.infinite) {
    g.setTransform(k, 0, 0, k, -r[0] * k, -r[1] * k);
    drawBoardPaper(g, p, { x0: r[0], y0: r[1], x1: r[2], y1: r[3] }, k);
    drawStrokes(g, p.strokes, null, { minW: 0.9 / k });
  } else {
    const pm = note.pageMatrix(p);
    g.setTransform(k, 0, 0, k, -p.disp.x * k, -p.disp.y * k);
    g.transform(pm.a, pm.b, pm.c, pm.d, pm.e, pm.f);
    drawPaper(g, p, k * 1.5);
    drawStrokes(g, p.strokes, null, { minW: 0.9 / k });
  }
  return c.toDataURL('image/jpeg', 0.82);
}

// ---- 起動
let app;
window.addEventListener('DOMContentLoaded', () => {
  app = new App();
  app.start().catch((e) => { console.error(e); toast('起動に失敗しました: ' + (e.message || e), { error: true, ms: 8000 }); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;            // 初回は知らせない
      const bar = $('#update-bar');
      if (bar) bar.hidden = false;
    });
  }
});
