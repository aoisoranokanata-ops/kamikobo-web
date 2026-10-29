'use strict';
/* アプリ: 本棚 ⇔ ノートの切り替え・ツールバー・道具の設定・ページ一覧・ダイアログ・自動保存。 */

const DEFAULT_SETTINGS = {
  fingerDraws: 'auto',        // 'auto'（Pencil を使ったら指では描かない）| true | false
  fingerAction: 'scroll',     // 指で描かない時の 1 本指: 'scroll' | 'erase'
  twoFinger: 'eraser',        // 2 本指タップ: 'eraser'（消しゴムに切り替え）| 'undo'
  rotateGesture: false,       // 2 本指で画面も回す
  fitPage: false,             // 画面に合わせる: ページ全体（false なら幅）
  shapeHold: true,            // 書いて止めると図形に整える
  transcribe: true,           // 録音しながら文字起こし（Web Speech）
};

const DEFAULT_TOOLS = {
  pen: { pen: 'ball', color: '#1d1d1f', w: 1.0, colors: ['#1d1d1f', '#1f4fd1', '#d12b2b', '#1f8a3c', '#8a3cc2'], widths: [0.6, 1.0, 1.8] },
  hl: { color: '#ffe14d', w: 12, op: 0.4, straight: false, colors: ['#ffe14d', '#9be36b', '#7fd3ff', '#ff9ec7', '#ffb347'], widths: [8, 12, 18] },
  eraser: { mode: 'partial', size: 24, sizes: [12, 24, 48] },
  text: { size: 16, color: '#1d1d1f', font: 'gothic', bold: false, colors: ['#1d1d1f', '#1f4fd1', '#d12b2b', '#1f8a3c', '#8a3cc2'], sizes: [10, 14, 18, 24, 36] },
};

class App {
  constructor() {
    this.settings = loadJSON('settings', DEFAULT_SETTINGS);
    const ts = loadJSON('tools', {});
    this.toolState = {};
    for (const k of Object.keys(DEFAULT_TOOLS)) this.toolState[k] = { ...DEFAULT_TOOLS[k], ...(ts[k] || {}) };
    this.note = null;
    this.clipboard = null;
    this.tools = { pen: new PenTool(this, 'pen'), hl: new PenTool(this, 'hl'), eraser: new EraserTool(this), lasso: new LassoTool(this), hand: null,
      text: new TextTool(this), laser: new LaserTool(this) };
    this.toolName = 'pen';
    this.prevTool = 'pen';
    this.view = new NoteView(this, $('#base'), $('#over'));
    this.zoomWin = new ZoomWindow(this);
    this.recorder = new Recorder(this);
    this.player = new Player(this);
    this.library = new Library(this);
    this.saveSoon = debounce(() => this.saveNote(), 700);
    this.saveViewSoon = debounce(() => this.saveView(), 600);
    this.searchMarks = null;          // ページ id → 当たった所の四角形（検索）
    this.panelSel = null;             // ページ一覧で選んだページの id（選ぶモードの時）
    BgRender.onReady = () => { this.view.invalidate(); };
    ImageCache.onReady = () => { this.view.invalidate(); };
    this.bindEditor();
    this.bindKeys();
    this.bindDrop();
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.saveNote(true); if (this.recorder.active) this.recorder.persist(false); } });
    window.addEventListener('pagehide', () => { this.saveNote(true); if (this.recorder.active) this.recorder.persist(false); });
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
    this.searchMarks = null;
    this.panelSel = null;
    this.closeSearch();
    this.player.close();
    this.closeRecPanel();
    this.closeAiPanel();
    this.view.resize();
    this.view.fit(false);
    if (!this.note.board && item.lastPage) this.view.goToPage(item.lastPage);
    this.view.invalidate();
    this.setTool(this.toolName === 'hand' ? 'pen' : this.toolName);
    this.updateStatus();
  }
  async closeNote() {
    if (!this.note) return;
    if (this.recorder.active) await this.recorder.stop();
    this.player.close();
    this.closeRecPanel();
    this.tools.text.commit(this.view);
    if (this.zoomWin.open) this.zoomWin.toggle(false);
    this.view.ruler.visible = false;
    this.tools.lasso.clear(this.view);
    await this.saveNote(true, true);
    this.note = null;
    saveJSON('session', {});
    $('#editor').hidden = true;
    $('#library').hidden = false;
    this.closePanel();
    this.closeSearch();
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
    const cp = n.board ? null : n.pages[this.view.currentPageIndex()];
    const mb = $('#btn-mark');
    mb.hidden = n.board;
    mb.classList.toggle('on', !!(cp && cp.mark));
  }

  // ================= 道具
  setTool(name) {
    if (name !== 'lasso' && this.tools.lasso.sel) this.tools.lasso.clear(this.view);
    if (name !== 'text' && this.tools.text.edit) this.tools.text.commit(this.view);
    if (name !== this.toolName && this.toolName !== 'eraser') this.prevTool = this.toolName;
    this.toolName = name;
    for (const b of $$('#tools [data-tool]')) b.classList.toggle('on', b.dataset.tool === name);
    this.renderQuick();
    this.view.over.style.cursor = name === 'hand' ? 'grab' : name === 'text' ? 'text' : 'crosshair';
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
        box.append(el('button', { class: 'chip' + (this.settings.shapeHold ? ' on' : ''), title: '書いたままペンを止めると、直線・円・四角などに整えます',
          onclick: () => { this.settings.shapeHold = !this.settings.shapeHold; this.saveSettings(); this.renderQuick(); } }, '図形補正'));
      } else {
        box.append(el('span', { class: 'qsep' }));
        box.append(el('button', { class: 'chip' + (o.straight ? ' on' : ''), onclick: () => { o.straight = !o.straight; this.saveTools(); this.renderQuick(); } }, '直線'));
      }
      box.append(el('button', { class: 'chip' + (this.view.ruler.visible ? ' on' : ''), title: '定規（縁の近くで書くと真っすぐ。2本指で回す）',
        onclick: () => { this.view.ruler.show(); this.renderQuick(); } }, '📏 定規'));
      if (!this.note || !this.note.board) box.append(el('button', { class: 'chip' + (this.zoomWin.open ? ' on' : ''), title: '拡大窓（下に大きく映して書く）',
        onclick: () => this.zoomWin.toggle() }, '🔎 拡大窓'));
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
    } else if (k === 'text') {
      const o = this.toolState.text, T = this.tools.text;
      const cur = T.edit ? T.edit.obj : o;
      const set = (patch) => {
        if (!T.restyle(this.view, patch)) { Object.assign(o, patch); this.saveTools(); }
        else Object.assign(o, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'bg')));
        this.saveTools(); this.renderQuick();
        if (T.edit) setTimeout(() => $('#text-editor').focus(), 0);
      };
      o.colors.forEach((c) => box.append(el('button', { class: 'swatch' + (c.toLowerCase() === (cur.color || '').toLowerCase() ? ' on' : ''), style: { '--c': c },
        onclick: () => set({ color: c }) })));
      box.append(el('span', { class: 'qsep' }));
      for (const sz of o.sizes) box.append(el('button', { class: 'chip' + (Math.abs(sz - cur.size) < 0.01 ? ' on' : ''), onclick: () => set({ size: sz }) }, String(sz)));
      box.append(el('span', { class: 'qsep' }));
      box.append(el('button', { class: 'chip', onclick: (e) => popMenu(e.currentTarget, Object.entries(FONT_FAMILIES).map(([key, f]) =>
        ({ label: (cur.font === key ? '✓ ' : '　 ') + f.label, fn: () => set({ font: key }) }))) }, (FONT_FAMILIES[cur.font] || FONT_FAMILIES.gothic).label + ' ▾'));
      box.append(el('button', { class: 'chip' + (cur.bold ? ' on' : ''), style: { fontWeight: '700' }, onclick: () => set({ bold: !cur.bold }) }, 'B'));
      if (T.edit) {
        box.append(el('span', { class: 'qsep' }));
        box.append(el('button', { class: 'chip' + (!T.edit.obj.bg ? ' on' : ''), onclick: () => set({ bg: null }) }, '地なし'));
        for (const c of STICKY_COLORS) box.append(el('button', { class: 'swatch sq' + (T.edit.obj.bg === c ? ' on' : ''), style: { '--c': c }, title: '付箋の色', onclick: () => set({ bg: c }) }));
        box.append(el('button', { class: 'chip', onclick: () => T.commit(this.view) }, '完了'));
      } else box.append(el('span', { class: 'qhint' }, 'タップで文字を置く（横にドラッグで幅を決める）・文字をタップで直す'));
    } else if (k === 'laser') {
      box.append(el('span', { class: 'qhint' }, 'レーザーポインター: 書いた跡はすぐ消えます（ノートには残りません）'));
    } else if (k === 'lasso') {
      box.append(el('span', { class: 'qhint' }, '囲んで選ぶ（画像・文字・スタンプはタップでも）→ 中をドラッグで移動・□で拡大縮小・○で回転'));
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
  showSelectionBar(x0, y0, x1, y1, label) {
    const bar = $('#selbar');
    bar.hidden = false;
    $('#sel-count').textContent = label;
    $('#sel-color').hidden = !(this.tools.lasso.sel && this.tools.lasso.sel.strokes.length);
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
      { label: p.mark ? '🔖 しおりを外す' : '🔖 しおりを付ける', fn: () => this.toggleMark(p) },
      { label: '↻ このページを右に回転', fn: () => { n.rotatePage(p, 90); this.afterPageChange(); } },
      { label: '↺ このページを左に回転', fn: () => { n.rotatePage(p, -90); this.afterPageChange(); } },
      null,
      { label: '後ろにページを追加', fn: () => this.addPageAfter() },
      { label: 'このページを複製', fn: () => { n.duplicatePage(p); this.afterPageChange(); } },
      { label: 'このページを削除', danger: true, fn: () => this.deletePage(p) },
      { label: 'ここで分割（このページから後ろを新しいノートへ）', fn: () => this.splitAt(n.pageIndex(p)) },
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

  /* ページの一覧（右から出る）: タップで移動、ボタンで回転・複製・削除・並べ替え。「選ぶ」で複数のページをまとめて */
  openPanel() { this.closeSearch(); $('#pagepanel').hidden = false; this.refreshPanel(); }
  closePanel() { const p = $('#pagepanel'); if (p) p.hidden = true; this.panelSel = null; }
  refreshPanel() {
    const panel = $('#pagepanel');
    if (!panel || panel.hidden || !this.note) return;
    const list = $('#pp-list');
    list.innerHTML = '';
    const n = this.note, cur = this.view.currentPageIndex(), sel = this.panelSel;
    $('#pp-select').textContent = sel ? '完了' : '選ぶ';
    $('#pp-selbar').hidden = !sel;
    if (sel) $('#pp-selcount').textContent = `${sel.size} 枚`;
    if (this._ppObs) this._ppObs.disconnect();
    this._ppObs = new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (!e.isIntersecting || e.target.dataset.done) continue;
        e.target.dataset.done = '1';
        const p = n.pages.find((q) => q.id === e.target.dataset.pid);
        if (p) this.thumbAsync(p, 160).then((u) => { e.target.src = u; });
      }
    }, { root: list, rootMargin: '300px' });
    $('#pp-marks').classList.toggle('on', !!this.panelMarks);
    n.pages.forEach((p, i) => {
      if (this.panelMarks && !p.mark) return;
      const img = el('img', { alt: '', 'data-pid': p.id });
      this._ppObs.observe(img);
      const chk = sel ? el('span', { class: 'pp-check' + (sel.has(p.id) ? ' on' : '') }, sel.has(p.id) ? '✓' : '') : null;
      const row = el('div', { class: 'pp-item' + (i === cur && !sel ? ' on' : '') + (sel && sel.has(p.id) ? ' picked' : '') }, img,
        el('div', { class: 'pp-no' }, String(i + 1), p.mark ? el('span', { class: 'pp-mark', title: 'しおりの名前を変える',
          onclick: (e) => { e.stopPropagation(); this.renameMark(p); } }, ' 🔖 ' + (p.mark.title || '')) : null), chk,
        sel ? null : el('div', { class: 'pp-actions' },
          el('button', { title: '上へ', disabled: i === 0, onclick: (e) => { e.stopPropagation(); n.movePage(p, i - 1); this.afterPageChange(); } }, '▲'),
          el('button', { title: '下へ', disabled: i === n.pages.length - 1, onclick: (e) => { e.stopPropagation(); n.movePage(p, i + 1); this.afterPageChange(); } }, '▼'),
          el('button', { title: '右に回転', onclick: (e) => { e.stopPropagation(); n.rotatePage(p, 90); this.afterPageChange(); } }, '↻'),
          el('button', { title: '複製', onclick: (e) => { e.stopPropagation(); n.duplicatePage(p); this.afterPageChange(); } }, '⧉'),
          el('button', { title: '削除', class: 'danger', onclick: (e) => { e.stopPropagation(); this.deletePage(p); } }, '✕')));
      row.addEventListener('click', () => {
        if (sel) { if (sel.has(p.id)) sel.delete(p.id); else sel.add(p.id); this.refreshPanel(); return; }
        this.view.goToPage(i); this.updateStatus(); this.refreshPanel();
      });
      list.append(row);
    });
  }
  selectedPages() { const s = this.panelSel; return s ? this.note.pages.filter((p) => s.has(p.id)) : []; }
  async panelAction(kind) {
    const n = this.note, pages = this.selectedPages();
    if (!pages.length) { toast('ページを選んでください'); return; }
    if (kind === 'pdf') await this.exportPages(pages, `${n.item.name}（${pages.length} ページ）`);
    else if (kind === 'extract') {
      const item = await createNoteFromPages({ name: n.item.name + '（抜き出し）', parent: n.item.parent, pages: pages.map((p) => copyPage(p, '')), size: n.item.size });
      item.thumb = await this.thumbAsync(pages[0], 220); await Store.putItem(item);
      toast(`「${item.name}」を作りました（${pages.length} ページ）`);
    } else if (kind === 'rotate') {
      n.structCmd('ページを回転', () => { for (const p of pages) p.rot = ((p.rot || 0) + 90) % 360; });
      this.afterPageChange();
    } else if (kind === 'delete') {
      if (pages.length >= n.pages.length) { toast('すべてのページは消せません', { error: true }); return; }
      if (!await confirmBox('ページを削除', `${pages.length} ページを削除します（元に戻すで戻せます）。`, '削除', true)) return;
      n.removePages(pages);
      this.panelSel = new Set();
      this.afterPageChange();
    }
  }
  /* このページから後ろを新しいノートへ */
  async splitAt(i) {
    const n = this.note;
    if (i <= 0) { toast('2 ページ目以降で分割してください'); return; }
    const tail = n.pages.slice(i);
    if (!await confirmBox('ここで分割', `${i + 1} ページ目から後ろ（${tail.length} ページ）を新しいノートに移します。`, '分割')) return;
    const item = await createNoteFromPages({ name: n.item.name + '（2）', parent: n.item.parent, pages: tail.map((p) => copyPage(p, '')), size: n.item.size });
    item.thumb = await this.thumbAsync(tail[0], 220); await Store.putItem(item);
    n.removePages(tail, '分割');
    this.afterPageChange();
    toast(`「${item.name}」を作りました`);
  }

  /* 小さな絵（PDF の下地は描き終わるのを待つ） */
  async thumbAsync(p, W) {
    if (p.bg) { try { await BgRender.ensure(p, Math.min(1, (W * 2) / p.w)); } catch { /* 白のまま */ } }
    const tmp = this.note && this.note.pages.includes(p) ? this.note : new Note({ kind: 'paged' }, [p]);
    return makeThumb(tmp, p, W);
  }

  // ================= 挿入（画像・PDF・ほかのノート）
  insertMenu(anchor) {
    const n = this.note;
    const items = [
      { label: '🖼 画像（写真・ファイル）', fn: () => this.insertImagesPick() },
      { label: '🗒 付箋', fn: () => this.addSticky() },
      { label: '🔖 スタンプ…', fn: () => setTimeout(() => this.stampMenu(anchor), 0) },
    ];
    if (!n.board) {
      items.push({ label: '📄 PDF を後ろに挿入', fn: () => this.insertPdfPick() });
      items.push({ label: '📓 ほかのノートを後ろに挿入', fn: () => this.insertNotePick() });
    }
    popMenu(anchor, items);
  }
  async insertImagesPick() {
    const files = (await pickFiles('image/*')).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name));
    if (files.length) await this.insertImages(files);
  }
  /* 画像を今のページ（無限キャンバスは見ている所）に置いて、なげなわで選んだ状態にする */
  async insertImages(files, at = null) {
    const n = this.note, v = this.view;
    if (!n) return;
    const C = at || v.toDocLocal(v.cssW / 2, v.cssH / 2);
    const hit = n.pageAt(C.x, C.y, 1e9), page = hit.page;
    const q = n.docToPage(page, C.x, C.y);
    const added = [];
    let off = 0;
    for (const f of files) {
      try {
        const r = await storeImage(f);
        const maxW = page.infinite ? 360 / v.s : page.w * 0.6, maxH = page.infinite ? 360 / v.s : page.h * 0.5;
        const k = Math.min(maxW / r.w, maxH / r.h, page.infinite ? 1 / v.s : 1);
        const w = r.w * k, h = r.h * k;
        let x = q.x - w / 2 + off, y = q.y - h / 2 + off;
        if (!page.infinite) { x = clamp(x, 0, Math.max(0, page.w - w)); y = clamp(y, 0, Math.max(0, page.h - h)); }
        added.push({ id: uid('m'), src: r.src, x, y, w, h, rot: 0 });
        off += 14;
      } catch (e) { toast(`${f.name}: ${e.message || e}`, { error: true }); }
    }
    if (!added.length) return;
    n.swapBoth(page, page.strokes.slice(), page.strokes.slice(), (page.images || []).slice(), (page.images || []).concat(added), '画像を貼る');
    this.setTool('lasso');
    this.tools.lasso.setSel(page, [], added);
    v.invalidate();
    this.tools.lasso.showBar(v);
    this.updateStatus();
  }
  async insertPdfPick() {
    const files = (await pickFiles('application/pdf,.pdf', false)).filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (!files.length) return;
    const n = this.note, at = this.view.currentPageIndex() + 1;
    const pr = progressBox('PDF を読み込んでいます');
    try {
      const pages = await pagesFromPdf(files[0], (i, k) => pr.set(i, k));
      n.insertPages(at, pages, 'PDF を挿入');
      this.afterPageChange();
      this.view.goToPage(at);
      toast(`${pages.length} ページを挿入しました`);
    } catch (e) { toast(e.message || String(e), { error: true, ms: 6000 }); } finally { pr.close(); }
  }
  async insertNotePick() {
    const n = this.note;
    const notes = this.library.items.filter((it) => it.type === 'note' && !it.trashed && it.id !== n.item.id && it.kind !== 'board');
    if (!notes.length) { toast('ほかのノートがありません'); return; }
    const id = await this.pickNoteDialog('挿入するノート', notes);
    if (!id) return;
    const other = await Note.load(await Store.getItem(id));
    const at = this.view.currentPageIndex() + 1;
    n.insertPages(at, other.pages.map((p) => copyPage(p, n.item.id)), 'ノートを挿入');
    this.afterPageChange();
    this.view.goToPage(at);
    toast(`${other.pages.length} ページを挿入しました`);
  }
  /* ノートを 1 つ選ぶ（フォルダの場所つき） */
  async pickNoteDialog(title, notes) {
    let chosen = null;
    const list = el('div', { class: 'folder-tree' });
    for (const it of notes.sort((a, b) => b.updated - a.updated)) {
      const where = it.parent !== 'root' ? this.library.path(it.parent).map((f) => f.name).join(' › ') + ' › ' : '';
      const b = el('button', { class: 'tree-row' }, '📓 ', el('span', { class: 'muted' }, where), it.name);
      b.addEventListener('click', () => { chosen = it.id; for (const x of $$('.tree-row', list)) x.classList.remove('on'); b.classList.add('on'); });
      list.append(b);
    }
    const ok = await modal(title, list, [{ label: 'キャンセル', value: null }, { label: '選ぶ', primary: true, value: 'ok' }]);
    return ok === 'ok' ? chosen : null;
  }

  // ================= 書き出し・共有
  shareMenu(anchor) {
    popMenu(anchor, [
      { label: '📄 PDF に書き出す・共有…', fn: () => this.exportDialog() },
      { label: '🗂 このノートをファイルで（紙工房 Web で開ける .kmkw）', fn: () => this.exportNoteFile() },
    ]);
  }
  async exportDialog() {
    const n = this.note;
    if (n.board) { await this.exportPages([boardAsPage(n.pages[0])], n.item.name); return; }
    const range = el('select', {}, el('option', { value: 'all' }, `すべてのページ（${n.pages.length}）`), el('option', { value: 'cur' }, `このページ（${this.view.currentPageIndex() + 1}）`),
      el('option', { value: 'custom' }, 'ページを指定…'));
    const spec = el('input', { type: 'text', placeholder: '例: 1-3, 5', class: 'wide', hidden: true });
    range.addEventListener('change', () => { spec.hidden = range.value !== 'custom'; });
    const paper = el('input', { type: 'checkbox', checked: true });
    const v = await modal('PDF に書き出す', el('div', { class: 'settings' }, el('label', { class: 'field' }, '範囲', range, spec),
      el('label', { class: 'row' }, paper, ' 用紙の罫線・方眼も入れる'),
      el('p', { class: 'muted' }, '手書きはベクターのまま入ります（拡大してもきれい）。読み込んだ PDF の文字はそのまま選べます。')),
    [{ label: 'キャンセル', value: null }, { label: '書き出す', primary: true, value: 'ok' }]);
    if (v !== 'ok') return;
    let pages = n.pages;
    if (range.value === 'cur') pages = [n.pages[this.view.currentPageIndex()]];
    else if (range.value === 'custom') {
      pages = parsePageSpec(spec.value, n.pages.length).map((i) => n.pages[i]);
      if (!pages.length) { toast('ページの指定が読めません', { error: true }); return; }
    }
    await this.exportPages(pages, n.item.name, { paper: paper.checked });
  }
  async exportPages(pages, name, opt = {}) {
    await this.saveNote(true);
    const pr = progressBox('PDF を作っています');
    let bytes;
    try { bytes = await exportPdf(pages, { title: name, paper: opt.paper !== false, onProgress: (i, k) => pr.set(i, k) }); }
    catch (e) { console.error(e); toast('PDF を作れませんでした: ' + (e.message || e), { error: true, ms: 6000 }); return; } finally { pr.close(); }
    await offerFile(new Blob([bytes], { type: 'application/pdf' }), safeName(name) + '.pdf');
  }
  async exportNoteFile() {
    await this.saveNote(true);
    const blob = await buildBackup([this.note.item.id], 'note');
    await offerFile(blob, safeName(this.note.item.name) + '.kmkw');
  }

  // ================= ノートの中の検索
  openSearch(q = '') {
    this.closePanel();
    const box = $('#searchpanel');
    box.hidden = false;
    const inp = $('#sp-input');
    if (q) inp.value = q;
    this.runSearch();
    if (!q) setTimeout(() => inp.focus(), 30);
  }
  closeSearch() {
    const box = $('#searchpanel');
    if (box) box.hidden = true;
    if (this.searchMarks) { this.searchMarks = null; this.view.requestOver(); }
  }
  runSearch() {
    const n = this.note, q = $('#sp-input').value.trim(), list = $('#sp-list');
    list.innerHTML = '';
    this.searchMarks = null;
    this.view.requestOver();
    if (!n) return;
    const full = (p) => [p.text || '', objectsText(p), p.hw ? p.hw.text : ''].filter(Boolean).join('\n');
    const withText = n.pages.filter((p) => full(p));
    if (!q) {
      list.append(el('div', { class: 'sp-hint muted' }, withText.length ? `文字のあるページ: ${withText.length} / ${n.pages.length}` :
        'このノートには検索できる文字がありません（読み込んだ PDF の文字と、文字の道具・付箋・スタンプの文字を探せます。手書きの文字はフェーズ6で AI に読ませて探せるようにします）'));
      return;
    }
    let count = 0;
    const hits = [];
    n.pages.forEach((p, i) => {
      const txt = full(p);
      if (!txt) return;
      const sn = snippetOf(txt, q);
      if (!sn) return;
      hits.push(i);
      count++;
      const row = el('button', { class: 'sp-row' }, el('span', { class: 'sp-page' }, `${i + 1}`),
        el('span', { class: 'sp-snip' }, sn.before, el('b', {}, sn.hit), sn.after));
      row.addEventListener('click', () => this.showHit(i, q));
      list.append(row);
    });
    for (const r of n.item.recordings || []) {
      for (const seg of r.transcript || []) {
        const sn = snippetOf(seg.text, q);
        if (!sn) continue;
        count++;
        const row = el('button', { class: 'sp-row' }, el('span', { class: 'sp-page' }, '🎙'),
          el('span', { class: 'sp-snip' }, `${r.name} ${fmtClock(seg.t)}  `, sn.before, el('b', {}, sn.hit), sn.after));
        row.addEventListener('click', () => this.player.play(r, Math.max(0, seg.t - 1000)));
        list.append(row);
      }
    }
    if (!count) list.append(el('div', { class: 'sp-hint muted' }, '見つかりませんでした'));
    else list.prepend(el('div', { class: 'sp-hint muted' }, `${count} ページで見つかりました`));
    this._hits = hits;
  }
  async showHit(i, q) {
    const n = this.note, p = n.pages[i];
    this.view.goToPage(i);
    this.updateStatus();
    try {
      const polys = (await PdfText.findPolys(p, q)).concat((p.images || []).filter((o) => (o.kind === 'text' || o.kind === 'stamp') &&
        normText(o.kind === 'text' ? o.text : stampText(o)).includes(normText(q).trim())).map((o) => imageCorners(o).flat()))
        .concat(((p.hw && p.hw.lines) || []).filter((l) => normText(l.text).replace(/\s+/g, '').includes(normText(q).replace(/\s+/g, '')))
          .map((l) => [l.box[0], l.box[1], l.box[2], l.box[1], l.box[2], l.box[3], l.box[0], l.box[3]]));
      this.searchMarks = new Map([[p.id, polys]]);
      // 当たった所が見えるように
      if (polys.length) {
        const pm = n.pageMatrix(p), q0 = polys[0], V = this.view;
        const cx = (q0[0] + q0[4]) / 2, cy = (q0[1] + q0[5]) / 2;
        const sp = V.toScreen(pm.a * cx + pm.c * cy + pm.e, pm.b * cx + pm.d * cy + pm.f);
        const right = V.cssW - ($('#searchpanel').hidden ? 0 : $('#searchpanel').offsetWidth) - 30;
        if (sp.y > V.cssH * 0.7 || sp.y < 40) V.oy += V.cssH * 0.35 - sp.y;
        if (sp.x > right || sp.x < 30) V.ox += (right + 30) / 2 - sp.x;
        V.fitted = false;
        V.clampScroll();
      }
      this.view.invalidate();
    } catch (e) { console.warn(e); }
  }

  // ================= 貼り付け・落とす（画像・PDF）
  bindDrop() {
    const stage = $('#stage');
    stage.addEventListener('dragover', (e) => { if (this.note && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    stage.addEventListener('drop', (e) => {
      if (!this.note || !e.dataTransfer) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const imgs = files.filter((f) => /^image\//.test(f.type));
      if (imgs.length) this.insertImages(imgs, this.view.toDoc(e.clientX, e.clientY));
    });
    document.addEventListener('paste', (e) => {
      if (!this.note || e.target.closest('input,textarea') || $('.modal-back')) return;
      const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); this.insertImages(files); }
    });
  }

  // ================= ダイアログ
  /* 用紙を選ぶ一覧（基本・勉強・仕事・自作）。state = {cat, type, color, tpl}。onPick で選んだ時に呼ぶ */
  tplPicker(state, getSize, onChange) {
    const box = el('div', {});
    const tabs = el('div', { class: 'tpl-tabs' });
    const grid = el('div', { class: 'tpl-grid' });
    const cats = [['basic', '基本'], ['study', '勉強・仕事'], ['custom', '自作']].concat(state.planner ? [['planner', 'プランナー']] : []);
    const draw = () => {
      tabs.innerHTML = '';
      for (const [k, label] of cats) tabs.append(el('button', { class: 'chip' + (state.cat === k ? ' on' : ''), onclick: () => { state.cat = k; draw(); onChange && onChange(); } }, label));
      grid.innerHTML = '';
      const [size, land] = getSize();
      if (state.cat === 'custom') {
        for (const t of MyTemplates.list()) {
          const b = el('button', { class: 'tpl' + (state.tpl === t.id ? ' on' : '') }, el('img', { src: t.thumb || '', alt: '' }), el('span', {}, t.name),
            el('i', { class: 'tpl-del', title: '消す', onclick: async (e) => { e.stopPropagation(); if (await confirmBox('テンプレートを消す', `「${t.name}」を一覧から消します（使ったノートはそのまま）。`, '消す', true)) { MyTemplates.remove(t.id); if (state.tpl === t.id) state.tpl = null; draw(); } } }, '×'));
          b.addEventListener('click', () => { state.tpl = t.id; draw(); onChange && onChange(); });
          grid.append(b);
        }
        grid.append(el('button', { class: 'tpl add', onclick: async () => {
          const files = await pickFiles('application/pdf,.pdf,image/*', false);
          if (!files.length) return;
          const pr = progressBox('テンプレートを作っています');
          try { const made = await MyTemplates.add(files[0]); if (made.length) state.tpl = made[0].id; } catch (e) { toast(e.message || String(e), { error: true }); } finally { pr.close(); }
          draw(); onChange && onChange();
        } }, el('b', {}, '＋'), el('span', {}, 'PDF・画像から作る')));
      } else if (state.cat === 'planner') {
        grid.append(el('div', { class: 'muted small' }, '年間 → 月間 → 週間 → 1 日のページを作り、ページどうしをリンクでつなぎます（指でタップすると移動）。祝日入り。'));
      } else {
        for (const t of PAPER_TYPES.filter((x) => x.cat === state.cat)) {
          const c = el('canvas', { width: 96, height: 128 });
          paperPreview(c, { type: t.id, color: state.color }, size, land);
          const b = el('button', { class: 'tpl' + (t.id === state.type ? ' on' : '') }, c, el('span', {}, t.label));
          b.addEventListener('click', () => { state.type = t.id; draw(); onChange && onChange(); });
          grid.append(b);
        }
      }
    };
    draw();
    box.append(tabs, grid);
    box.redraw = draw;
    return box;
  }
  colorRow(state, redraw) {
    const colors = el('div', { class: 'tpl-colors' });
    const draw = () => {
      colors.innerHTML = '';
      for (const pc of PAPER_COLORS) colors.append(el('button', { class: 'pcolor' + (pc.id === state.color ? ' on' : ''), style: { '--c': pc.bg }, title: pc.label,
        onclick: () => { state.color = pc.id; draw(); redraw(); } }));
    };
    draw();
    return colors;
  }

  async newNoteDialog(kind) {
    const isBoard = kind === 'board';
    const st = loadJSON('newnote', { type: 'ruled', color: 'white', size: 'A4', landscape: false, cat: 'basic' });
    const name = el('input', { type: 'text', value: isBoard ? '無限キャンバス' : '無題のノート', class: 'wide' });
    const size = el('select', {}, ...Object.keys(PAGE_SIZES).map((k) => el('option', { value: k, selected: k === st.size }, k)));
    const land = el('input', { type: 'checkbox', checked: st.landscape });
    const count = el('select', {}, ...[1, 5, 10, 20, 50, 100].map((k) => el('option', { value: k }, k + ' ページ')));
    if (isBoard) {
      const state = { color: st.color, type: ['grid', 'dot', 'blank', 'ruled'].includes(st.type) ? st.type : 'dot' };
      const types = el('div', { class: 'tpl-grid' });
      const draw = () => {
        types.innerHTML = '';
        for (const t of PAPER_TYPES.filter((x) => ['blank', 'grid', 'dot', 'ruled'].includes(x.id))) {
          const c = el('canvas', { width: 96, height: 128 });
          paperPreview(c, { type: t.id, color: state.color }, 'A4', false);
          const b = el('button', { class: 'tpl' + (t.id === state.type ? ' on' : '') }, c, el('span', {}, t.label));
          b.addEventListener('click', () => { state.type = t.id; draw(); });
          types.append(b);
        }
      };
      draw();
      const ok = await modal('無限キャンバスを作る', el('div', { class: 'newnote' }, el('label', { class: 'field' }, '名前', name),
        el('div', { class: 'field' }, '背景', types), el('div', { class: 'field' }, '紙の色', this.colorRow(state, draw))),
      [{ label: 'キャンセル', value: null }, { label: '作る', primary: true, value: 'ok' }], { wide: true });
      if (ok !== 'ok') return;
      const item = await createNote({ name: name.value.trim() || undefined, parent: this.library.currentFolderForNew(), kind, paper: { type: state.type, color: state.color } });
      await this.library.refresh();
      await this.openNote(item.id);
      return;
    }
    const state = { cat: st.cat === 'planner' ? 'planner' : st.cat || 'basic', type: st.type, color: st.color, tpl: null, planner: true, cover: null };
    const now = new Date();
    const pYear = el('select', {}, ...[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1, now.getFullYear() + 2].map((y) => el('option', { value: y, selected: y === (now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()) }, y + ' 年')));
    const pMonth = el('select', {}, ...Array.from({ length: 12 }, (_, i) => el('option', { value: i }, (i + 1) + ' 月から')));
    if (state.cat === 'planner') pMonth.value = String(st.pMonth || 0);
    const parts = {};
    const partBoxes = [['year', '年間', true], ['month', '月間', true], ['week', '週間', true], ['day', '1 日（365 ページ）', false]].map(([k, label, def]) => {
      const c = el('input', { type: 'checkbox', checked: st.parts ? !!st.parts[k] : def });
      parts[k] = c;
      return el('label', { class: 'row inline' }, c, ' ' + label);
    });
    const plannerOpts = el('div', { class: 'field planner-opts' }, el('div', { class: 'row-buttons' }, pYear, pMonth), el('div', { class: 'row-buttons' }, ...partBoxes));
    const coverBtn = el('button', { class: 'chip', onclick: async () => {
      const v = await coverDialog(state.cover, name.value.trim() || 'ノート');
      if (v !== undefined) { state.cover = v; coverBtn.textContent = v ? '表紙: あり' : '表紙: 1 ページ目'; }
    } }, '表紙: 1 ページ目');
    let picker;
    const sizeRow = el('div', { class: 'field row' }, '大きさ ', size, el('label', { class: 'row inline' }, land, ' 横向き'), count);
    const sync = () => {
      plannerOpts.hidden = state.cat !== 'planner';
      count.hidden = state.cat === 'planner';
      sizeRow.hidden = state.cat === 'custom';
      if (state.cat === 'planner' && /^無題/.test(name.value)) name.value = `${pYear.value}年 プランナー`;
    };
    picker = this.tplPicker(state, () => [size.value, land.checked], sync);
    pYear.addEventListener('change', () => { if (/プランナー$/.test(name.value)) name.value = `${pYear.value}年 プランナー`; });
    size.addEventListener('change', () => picker.redraw());
    land.addEventListener('change', () => picker.redraw());
    const body = el('div', { class: 'newnote' },
      el('label', { class: 'field' }, '名前', name),
      el('div', { class: 'field' }, '用紙・テンプレート', picker),
      plannerOpts,
      el('div', { class: 'field' }, '紙の色', this.colorRow(state, () => picker.redraw())),
      sizeRow,
      el('div', { class: 'field row' }, coverBtn));
    sync();
    const ok = await modal('新しいノート', body, [{ label: 'キャンセル', value: null },
      { label: '作る', primary: true, value: 'ok', check: () => (state.cat !== 'custom' || state.tpl ? true : (toast('テンプレートを選ぶか、PDF・画像から作ってください'), false)) }], { wide: true });
    if (ok !== 'ok') return;
    const landscape = land.checked;
    saveJSON('newnote', { type: state.type, color: state.color, size: size.value, landscape, cat: state.cat, pMonth: +pMonth.value,
      parts: Object.fromEntries(Object.entries(parts).map(([k, c]) => [k, c.checked])) });
    const parent = this.library.currentFolderForNew(), nm = name.value.trim() || undefined;
    let item;
    if (state.cat === 'planner') {
      const P = Object.fromEntries(Object.entries(parts).map(([k, c]) => [k, c.checked]));
      if (!P.year && !P.month && !P.week && !P.day) { toast('作るページを選んでください', { error: true }); return; }
      let [w, h] = PAGE_SIZES[size.value] || PAGE_SIZES.A4;
      if (landscape) [w, h] = [h, w];
      const pages = buildPlanner({ year: +pYear.value, month: +pMonth.value, parts: P, w, h, color: state.color });
      item = await createNoteFromPages({ name: nm || `${pYear.value}年 プランナー`, parent, pages, size: size.value, paper: { type: 'p-day', color: state.color } });
      toast(`${pages.length} ページのプランナーを作りました。日付や「年間・月・週」を指でタップすると移動します`, { ms: 5000 });
    } else if (state.cat === 'custom') {
      const t = MyTemplates.list().find((x) => x.id === state.tpl);
      if (!t) return;
      const pages = Array.from({ length: +count.value }, () => MyTemplates.page(t, state.color));
      item = await createNoteFromPages({ name: nm, parent, pages });
    } else {
      item = await createNote({ name: nm, parent, kind, paper: { type: state.type, color: state.color }, size: size.value, landscape, pages: +count.value });
    }
    if (state.cover) { item.cover = state.cover; await Store.putItem(item); }
    await this.library.refresh();
    await this.openNote(item.id);
  }

  /* 用紙を変える・その用紙でページを足す */
  async paperDialog() {
    const n = this.note;
    const p = this.currentPage();
    const cur = p.paper || {};
    const pt = PAPER_TYPES.find((x) => x.id === cur.type);
    const state = { cat: pt && (pt.cat === 'basic' || pt.cat === 'study') ? pt.cat : 'basic', type: cur.type, color: cur.color || 'white', tpl: null };
    if (n.board) {
      const types = el('div', { class: 'tpl-grid' });
      const draw = () => {
        types.innerHTML = '';
        for (const t of PAPER_TYPES.filter((x) => ['blank', 'grid', 'dot', 'ruled'].includes(x.id))) {
          const c = el('canvas', { width: 96, height: 128 });
          paperPreview(c, { type: t.id, color: state.color }, 'A4', false);
          const b = el('button', { class: 'tpl' + (t.id === state.type ? ' on' : '') }, c, el('span', {}, t.label));
          b.addEventListener('click', () => { state.type = t.id; draw(); });
          types.append(b);
        }
      };
      draw();
      const v = await modal('背景を変更', el('div', { class: 'newnote' }, types, el('div', { class: 'field' }, '紙の色', this.colorRow(state, draw))),
        [{ label: 'キャンセル', value: null }, { label: '変更', primary: true, value: 'one' }], { wide: true });
      if (v) { n.setPaper([p], { type: state.type, color: state.color }); this.afterPageChange(); }
      return;
    }
    const picker = this.tplPicker(state, () => [Object.keys(PAGE_SIZES).find((k) => { const [w, h] = PAGE_SIZES[k]; return (w === p.w && h === p.h) || (w === p.h && h === p.w); }) || 'A4', p.w > p.h], null);
    const v = await modal('用紙・テンプレート', el('div', { class: 'newnote' }, el('div', { class: 'field' }, picker), el('div', { class: 'field' }, '紙の色', this.colorRow(state, () => picker.redraw())),
      el('p', { class: 'muted small' }, '自作テンプレートは「後ろに追加」で新しいページとして入ります。')),
    [{ label: 'キャンセル', value: null }, { label: 'この用紙で後ろに追加', value: 'add' }, { label: 'すべてのページ', value: 'all' }, { label: 'このページ', primary: true, value: 'one' }], { wide: true });
    if (!v) return;
    const i = n.pageIndex(p);
    if (state.cat === 'custom') {
      const t = MyTemplates.list().find((x) => x.id === state.tpl);
      if (!t) { toast('テンプレートを選んでください'); return; }
      n.insertPages(i + 1, [MyTemplates.page(t, state.color)], 'ページを追加');
      this.afterPageChange(); this.view.goToPage(i + 1);
      return;
    }
    const paper = { type: state.type, color: state.color };
    if (v === 'add') { n.addPage(i + 1, null, paper); this.afterPageChange(); this.view.goToPage(i + 1); return; }
    n.setPaper(v === 'all' ? n.pages.slice() : [p], paper);
    if (v === 'all') { n.item.paper = paper; n.itemDirty = true; }
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
      el('div', { class: 'field' }, 'バックアップ',
        el('div', { class: 'row-buttons' },
          el('button', { onclick: () => this.backupAll() }, '本棚をまるごと書き出す（.kmkw）'),
          el('button', { onclick: () => this.restorePick() }, 'バックアップ・.kmkw を読み込む')),
        el('span', { class: 'muted small' }, 'データはこの iPad のブラウザの中にあります。ときどき書き出して「ファイル」や iCloud Drive に置いておくと安心です。')),
      el('p', { class: 'muted' }, `紙工房 Web ${APP_VERSION}　${used}`));
    await modal('設定', body, [{ label: '閉じる', primary: true, value: true }], { wide: true });
  }

  async backupAll() {
    closeModals();
    await this.saveNote(true);
    const pr = progressBox('バックアップを作っています');
    let blob;
    try { blob = await buildBackup(null, 'library'); } catch (e) { toast('書き出せませんでした: ' + (e.message || e), { error: true }); return; } finally { pr.close(); }
    await offerFile(blob, `紙工房バックアップ_${fmtDate(Date.now()).slice(0, 10).replace(/\//g, '')}.kmkw`);
  }
  async restorePick() {
    closeModals();
    const files = await pickFiles('', false);
    if (files.length) await this.importFiles(files);
  }
  /* 本棚への読み込み: PDF → 1 冊ずつ、画像 → まとめて 1 冊（1 枚 1 ページ）、.kmkw → 復元 */
  async importFiles(files, parent = null) {
    parent = parent || this.library.currentFolderForNew();
    const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    const imgs = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name));
    const kmkw = files.filter((f) => /\.kmkw$/i.test(f.name));
    const other = files.filter((f) => !pdfs.includes(f) && !imgs.includes(f) && !kmkw.includes(f));
    let made = 0, lastId = null;
    for (const f of pdfs) {
      const pr = progressBox(`「${f.name}」を読み込んでいます`);
      try {
        const pages = await pagesFromPdf(f, (i, k) => pr.set(i, k));
        const item = await createNoteFromPages({ name: f.name.replace(/\.pdf$/i, ''), parent, pages });
        item.thumb = await this.thumbAsync(pages[0], 220);
        await Store.putItem(item);
        made++; lastId = item.id;
      } catch (e) { toast(`${f.name}: ${e.message || e}`, { error: true, ms: 6000 }); } finally { pr.close(); }
    }
    if (imgs.length) {
      const pr = progressBox('画像を読み込んでいます');
      try {
        const pages = [];
        for (let i = 0; i < imgs.length; i++) {
          pr.set(i, imgs.length);
          try {
            const r = await storeImage(imgs[i]);
            const W = 595, H = Math.round((595 * r.h) / r.w);
            pages.push({ id: uid('p'), w: W, h: H, rot: 0, infinite: false, paper: { type: 'blank', color: 'white' }, strokes: [],
              images: [{ id: uid('m'), src: r.src, x: 0, y: 0, w: W, h: H, rot: 0 }] });
          } catch (e) { toast(`${imgs[i].name}: ${e.message || e}`, { error: true }); }
        }
        if (pages.length) {
          const name = imgs.length === 1 ? imgs[0].name.replace(/\.[^.]+$/, '') : `画像 ${pages.length} 枚`;
          const item = await createNoteFromPages({ name, parent, pages });
          await new Promise((r) => setTimeout(r, 300));       // 画像の読み込みを待って小さな絵を作る
          item.thumb = await this.thumbAsync(pages[0], 220);
          await Store.putItem(item);
          made++; lastId = item.id;
        }
      } finally { pr.close(); }
    }
    for (const f of kmkw) {
      try {
        const r = await restoreBackup(f, parent);
        toast(r.kind === 'library' ? `バックアップから ${r.notes} 冊を「復元」フォルダに戻しました` : `「${f.name}」を読み込みました`);
        made++;
      } catch (e) { toast(`${f.name}: ${e.message || e}`, { error: true, ms: 6000 }); }
    }
    if (other.length) toast(`読み込めない種類のファイルです: ${other.map((f) => f.name).join('、')}`, { error: true, ms: 5000 });
    await this.library.refresh();
    if (made === 1 && lastId && !kmkw.length) await this.openNote(lastId);
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
  onTap(P, type) {
    const n = this.note;
    if (!n) return;
    const hit = n.pageAt(P.x, P.y, 0);
    if (hit.inside) {
      const q = n.docToPage(hit.page, P.x, P.y);
      if (this.player.open && this.player.sync && this.player.seekToStroke(hit.page, q, 10 / this.view.s)) return;
      const link = (hit.page.images || []).slice().reverse().find((o) => o.kind === 'link' && imageHit(o, q.x, q.y));
      if (link) { this.followLink(link); return; }
      if (this.zoomWin.open && !n.board && this.zoomWin.moveTo(hit.page, q)) return;
    }
    if (this.tools.lasso.sel) this.tools.lasso.clear(this.view);
  }
  async followLink(link) {
    const n = this.note, to = link.to || {};
    if (to.page) {
      const i = n.pages.findIndex((p) => p.id === to.page);
      if (i < 0) { toast('リンク先のページがありません（消されたかもしれません）', { error: true }); return; }
      this.view.goToPage(i); this.updateStatus(); this.showBadge(`${i + 1} ページへ`);
    } else if (to.url) {
      if (await confirmBox('リンクを開く', to.url, '開く')) window.open(to.url, '_blank', 'noopener');
    }
  }
  /* なげなわで選んだ所をリンクにする（ページへ／URL へ） */
  async linkDialog() {
    const L = this.tools.lasso, n = this.note;
    if (!L.sel) return;
    const b = L.selectionRect(), page = L.sel.page;
    const sel = el('select', {}, el('option', { value: '' }, '— ページを選ぶ —'),
      ...n.pages.map((p, i) => el('option', { value: p.id }, `${i + 1} ページ${p.mark ? '（' + (p.mark.title || 'しおり') + '）' : ''}`)));
    const url = el('input', { type: 'text', placeholder: 'https://…', class: 'wide' });
    const v = await modal('リンクを付ける', el('div', { class: 'settings' }, el('label', { class: 'field' }, 'このノートのページへ', sel), el('label', { class: 'field' }, 'または Web のアドレス', url),
      el('p', { class: 'muted small' }, '指（または手のひら）でタップするとリンク先へ移ります。PDF に書き出してもリンクになります。')),
    [{ label: 'キャンセル', value: null }, { label: '付ける', primary: true, value: 'ok', check: () => !!(sel.value || /^https?:\/\/\S+/.test(url.value.trim())) }]);
    if (v !== 'ok') return;
    const to = sel.value ? { page: sel.value } : { url: url.value.trim() };
    const pad = 3;
    const o = { id: uid('m'), kind: 'link', x: b[0] - pad, y: b[1] - pad, w: b[2] - b[0] + pad * 2, h: b[3] - b[1] + pad * 2, rot: 0, to };
    const ib = (page.images || []).slice();
    n.swapBoth(page, page.strokes.slice(), page.strokes.slice(), ib, ib.concat([o]), 'リンク');
    L.clear(this.view);
    toast('リンクを付けました（指でタップすると移動します）');
  }

  // ================= AI（Claude）
  aiMenu(anchor) {
    const n = this.note;
    if (!n) return;
    const cards = n.item.cards || [], due = cards.filter(cardDue).length;
    const stale = n.pages.filter((p) => p.strokes.some((s) => s.tool !== 'hl') && (!p.hw || p.hw.sig !== inkSig(p))).length;
    popMenu(anchor, [
      { label: '📝 このノートを要約', fn: () => this.aiSummary(n.pages) },
      n.board ? undefined : { label: '📄 このページを要約', fn: () => this.aiSummary([this.currentPage()]) },
      { label: '💬 ノートについて質問する', fn: () => this.aiChatOpen() },
      null,
      n.board ? undefined : { label: '✍️ このページの手書きを文字に', fn: () => this.aiHandwriting([this.currentPage()]) },
      { label: `✍️ 手書きを文字に（まだのページ ${stale}）`, disabled: !stale, fn: () => this.aiHandwriting(n.pages.filter((p) => p.strokes.some((s) => s.tool !== 'hl') && (!p.hw || p.hw.sig !== inkSig(p)))) },
      null,
      { label: '🃏 暗記カードを作る', fn: () => this.aiMakeCards() },
      { label: `🃏 暗記カードで練習（${cards.length} 枚・今日 ${due}）`, disabled: !cards.length, fn: () => this.cardsPractice() },
      { label: '🗂 ノートを整理（題名・見出し）', fn: () => this.aiOrganize() },
      null,
      { label: '⚙ AI の設定…', fn: () => this.aiSettings() },
    ].filter((x) => x !== undefined));
  }
  /* 使う前の確かめ（キー・送ることへの同意） */
  async aiReady() {
    const c = AIConf.get();
    if (!c.key) { await this.aiSettings(); if (!AIConf.get().key) return false; }
    if (!AIConf.get().agreed) {
      const ok = await confirmBox('AI を使う前に', 'AI を使うと、このノートのページの絵・文字・録音の文字起こしが、あなたの API キーで Anthropic（Claude）に送られます。料金はあなたの API の契約に請求されます。よろしいですか？', '使う');
      if (!ok) return false;
      AIConf.set({ agreed: true });
    }
    if (!navigator.onLine) { toast('オフラインです。AI はインターネットにつながっている時だけ使えます', { error: true }); return false; }
    return true;
  }
  async aiSettings() {
    const c = AIConf.get();
    const key = el('input', { type: 'password', value: c.key || '', placeholder: 'sk-ant-…', class: 'wide', autocomplete: 'off', spellcheck: 'false' });
    const model = el('select', {}, ...AI_MODELS.map((m) => el('option', { value: m.id, selected: m.id === c.model }, `${m.label}　入力 $${m.in}・出力 $${m.out} / 100万トークン`)));
    const month = new Date().toISOString().slice(0, 7);
    const spent = c.month === month ? c.spent || 0 : 0;
    const v = await modal('AI の設定（Claude）', el('div', { class: 'settings' },
      el('label', { class: 'field' }, 'Claude の API キー', key,
        el('span', { class: 'muted small' }, 'console.anthropic.com で作ったキー。この iPad のブラウザの中だけに保存し、Claude API 以外には送りません。')),
      el('label', { class: 'field' }, 'モデル', model),
      el('p', { class: 'muted small' }, `今月この端末で使った目安: 約 $${spent.toFixed(3)}（実際の請求は Anthropic の画面で確かめてください）`),
      el('p', { class: 'muted small' }, '送る内容: ページの絵（長い辺 1568px）・PDF の文字・置いた文字・録音の文字起こし。安全のための断りが出た時は、Anthropic がすすめる別のモデルで続けます。')),
    [{ label: 'キーを消す', danger: true, value: 'clear' }, { label: 'キャンセル', value: null }, { label: '保存', primary: true, value: 'ok' }], { wide: true });
    if (v === 'clear') { AIConf.set({ key: '' }); toast('API キーを消しました'); return; }
    if (v !== 'ok') return;
    AIConf.set({ key: key.value.trim(), model: model.value });
    toast('保存しました');
  }

  // ---- パネル
  aiPanel(title) {
    this.closePanel(); this.closeSearch(); this.closeRecPanel();
    const p = $('#aipanel');
    p.hidden = false;
    $('#ai-title').textContent = title;
    $('#ai-body').innerHTML = '';
    $('#ai-foot').innerHTML = '';
    return $('#ai-body');
  }
  closeAiPanel() { const p = $('#aipanel'); if (p) p.hidden = true; if (this.aiAbort) this.aiAbort.abort(); this.aiChat = null; }
  /* ストリーミングの文字を少しずつ Markdown で見せる箱 */
  aiStreamBox(parent) {
    const box = el('div', { class: 'ai-out' }, el('div', { class: 'ai-wait' }, el('span', { class: 'spin' }), ' 考えています…'));
    parent.append(box);
    let text = '', t = 0;
    const draw = () => { t = 0; box.innerHTML = ''; box.append(mdToEl(text)); parent.scrollTop = parent.scrollHeight; };
    return { box, add(s) { text += s; if (!t) t = setTimeout(draw, 80); }, done() { clearTimeout(t); draw(); }, get text() { return text; } };
  }
  aiCostLine(r) { return el('div', { class: 'muted small ai-cost' }, `${r.model}・入力 ${(r.usage.input_tokens + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0)).toLocaleString()}・出力 ${r.usage.output_tokens.toLocaleString()} トークン・約 $${r.cost.toFixed(4)}`); }
  async aiCall(opts, body) {
    this.aiAbort = new AbortController();
    const stop = el('button', { class: 'small', onclick: () => this.aiAbort && this.aiAbort.abort() }, '止める');
    $('#ai-foot').append(stop);
    try { return await AI.run({ ...opts, signal: this.aiAbort.signal }); }
    catch (e) { const er = aiError(e); if (er.kind !== 'abort') body.append(el('div', { class: 'ai-err' }, er.message)); return null; }
    finally { stop.remove(); this.aiAbort = null; }
  }

  async aiSummary(pages) {
    if (!await this.aiReady()) return;
    const n = this.note, body = this.aiPanel(pages.length === 1 && n.pages.length > 1 ? `p.${n.pageIndex(pages[0]) + 1} の要約` : 'ノートの要約');
    const prog = el('div', { class: 'muted small' }, 'ページを用意しています…');
    body.append(prog);
    const content = await noteContent(n, pages, { onProgress: (i, k) => { prog.textContent = `ページを用意しています… ${i}/${k}`; } });
    prog.remove();
    content.push({ type: 'text', text: '\nこのノートの内容を要約してください。最初に 2〜3 行の全体のまとめ、次に「## 要点」で大事なことを箇条書き（ページ番号つき）、最後に「## 覚えておくこと」で試験・仕事で押さえるべき点を挙げてください。' });
    const sb = this.aiStreamBox(body);
    const r = await this.aiCall({ messages: [{ role: 'user', content }], effort: 'medium', onText: (t) => sb.add(t) }, body);
    sb.done();
    if (!r) return;
    body.append(this.aiCostLine(r));
    this.aiResultButtons(r.text, 'AI の要約');
  }
  aiResultButtons(text, title) {
    const foot = $('#ai-foot');
    foot.append(
      el('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { toast('コピーできませんでした', { error: true }); } } }, 'コピー'),
      el('button', { class: 'small primary', onclick: () => this.pasteAsPage(title, text) }, '新しいページに貼る'));
  }
  /* AI の答えを、ノートの最後に新しいページ（文字）として足す */
  pasteAsPage(title, text) {
    const n = this.note;
    if (!n || n.board) { toast('ページのあるノートで使えます'); return; }
    const plain = text.replace(/^#{1,4}\s+/gm, '■ ').replace(/\*\*([^*]+)\*\*/g, '$1');
    const p = n.addPage(n.pages.length, null, { type: 'blank', color: (n.pages[0].paper || {}).color || 'white' });
    const o = fitTextHeight({ id: uid('m'), kind: 'text', x: 36, y: 40, w: p.w - 72, h: 40, rot: 0, text: `【${title}】\n${plain}`, size: 11, color: '#1d1d1f', font: 'gothic', bold: false, bg: null });
    n.swapBoth(p, [], [], [], [o], 'AI の答えを貼る');
    this.afterPageChange();
    this.view.goToPage(n.pages.length - 1);
    toast('最後のページに貼りました');
  }

  // ---- 質問（チャット）
  async aiChatOpen() {
    if (!await this.aiReady()) return;
    const body = this.aiPanel('ノートについて質問');
    this.aiChat = { messages: [], first: true };
    body.append(el('div', { class: 'muted small' }, 'このノート（ページの手書き・PDF・録音の文字起こし）について何でも聞けます。例:「p.3 の図の意味は？」「この単元で試験に出そうな所は？」'));
    const inp = el('textarea', { class: 'ai-input', rows: 2, placeholder: '質問を入力（⌘+Enter で送る）' });
    const send = el('button', { class: 'primary small', onclick: () => this.aiAsk(inp) }, '送る');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.aiAsk(inp); } });
    $('#ai-foot').append(inp, send);
    setTimeout(() => inp.focus(), 50);
  }
  async aiAsk(inp) {
    const q = inp.value.trim(), C = this.aiChat;
    if (!q || !C || this.aiAbort) return;
    inp.value = '';
    const body = $('#ai-body');
    body.append(el('div', { class: 'ai-q' }, q));
    let content = [{ type: 'text', text: q }];
    if (C.first) {                     // 最初の質問にだけノートを付ける（続きはキャッシュで安く読める）
      const prog = el('div', { class: 'muted small' }, 'ノートを読み込んでいます…');
      body.append(prog);
      content = (await noteContent(this.note, this.note.pages)).concat([{ type: 'text', text: '\n質問: ' + q }]);
      prog.remove();
    }
    C.messages.push({ role: 'user', content });
    const sb = this.aiStreamBox(body);
    const r = await this.aiCall({ messages: C.messages, effort: 'medium', onText: (t) => sb.add(t) }, body);
    sb.done();
    if (!r) { C.messages.pop(); return; }
    C.first = false;
    C.messages.push({ role: 'assistant', content: r.text });
    body.append(this.aiCostLine(r));
  }

  // ---- 手書き → 文字
  async aiHandwriting(pages) {
    if (!await this.aiReady()) return;
    const n = this.note;
    pages = pages.filter((p) => p.strokes.some((s) => s.tool !== 'hl'));
    if (!pages.length) { toast('手書きの線がありません'); return; }
    const body = this.aiPanel('手書きを文字に');
    const prog = el('div', { class: 'muted small' }, '');
    body.append(prog);
    let cost = 0;
    this.aiAbort = new AbortController();
    const stop = el('button', { class: 'small', onclick: () => { this.aiAbortHw = true; } }, '止める');
    $('#ai-foot').append(stop);
    this.aiAbortHw = false;
    for (let i = 0; i < pages.length; i++) {
      if (this.aiAbortHw) break;
      const p = pages[i], no = n.pageIndex(p) + 1;
      prog.textContent = `読み取り中… ${i + 1}/${pages.length}（p.${no}）`;
      try {
        const hw = await recognizeHandwriting(p);
        cost += hw.cost || 0;
        delete hw.cost;
        p.hw = hw;
        n.dirty.add(p.id); n.touch(null);
        body.append(el('div', { class: 'ai-hw' }, el('b', {}, `p.${no}`), el('pre', {}, hw.text || '（文字は見つかりませんでした）')));
      } catch (e) { body.append(el('div', { class: 'ai-err' }, `p.${no}: ${aiError(e).message}`)); if (['auth', 'perm', 'net', 'nokey'].includes(aiError(e).kind)) break; }
    }
    stop.remove(); this.aiAbort = null;
    prog.textContent = `終わりました。手書きの文字も検索（🔍・本棚）で見つかるようになりました。約 $${cost.toFixed(4)}`;
    this.saveSoon();
  }

  // ---- 暗記カード
  async aiMakeCards() {
    if (!await this.aiReady()) return;
    const n = this.note;
    const count = el('select', {}, ...[10, 20, 30, 50].map((k) => el('option', { value: k, selected: k === 20 }, `${k} 枚くらい`)));
    const scope = el('select', {}, el('option', { value: 'all' }, 'ノート全体'), n.board ? null : el('option', { value: 'cur' }, 'このページだけ'));
    const style = el('select', {}, el('option', { value: 'qa' }, '一問一答'), el('option', { value: 'term' }, '用語 → 意味'), el('option', { value: 'blank' }, '穴埋め'));
    const v = await modal('暗記カードを作る', el('div', { class: 'settings' }, el('label', { class: 'field' }, '範囲', scope), el('label', { class: 'field' }, '数', count), el('label', { class: 'field' }, '形', style)),
      [{ label: 'キャンセル', value: null }, { label: '作る', primary: true, value: 'ok' }]);
    if (v !== 'ok') return;
    const pages = scope.value === 'cur' ? [this.currentPage()] : n.pages;
    const body = this.aiPanel('暗記カード');
    const prog = el('div', { class: 'muted small' }, 'ノートを読み込んでいます…');
    body.append(prog);
    const content = await noteContent(n, pages);
    const how = { qa: '一問一答（q は問い、a は短い答え）', term: '用語と意味（q は用語、a はその意味・説明）', blank: '穴埋め（q は大事な語を「（　）」にした文、a は入る語）' }[style.value];
    content.push({ type: 'text', text: `\nこのノートから、覚えるための暗記カードを ${count.value} 枚くらい作ってください。形は ${how}。` +
      'ノートに書かれていることだけを使い、試験に出そうな大事な所を優先します。page はそのカードの元になったページの番号（分からなければ 0）。' });
    prog.textContent = 'カードを作っています…（少し時間がかかります）';
    const r = await this.aiCall({ messages: [{ role: 'user', content }], effort: 'medium', json: CARDS_SCHEMA }, body);
    prog.remove();
    if (!r) return;
    const made = (r.data.cards || []).filter((c) => c.q && c.a).map((c) => ({ id: uid('c'), q: c.q.trim(), a: c.a.trim(), page: c.page || 0, box: 0, due: 0, made: Date.now() }));
    n.item.cards = (n.item.cards || []).concat(made);
    n.itemDirty = true; this.saveSoon();
    body.append(el('p', {}, `${made.length} 枚作りました（このノートのカードは全部で ${n.item.cards.length} 枚）。`));
    for (const c of made.slice(0, 50)) body.append(el('div', { class: 'ai-card' }, el('b', {}, c.q), el('div', {}, c.a)));
    body.append(this.aiCostLine(r));
    $('#ai-foot').append(el('button', { class: 'small primary', onclick: () => this.cardsPractice() }, '練習する'),
      el('button', { class: 'small', onclick: () => this.cardsExport() }, '書き出す（TSV）'));
  }
  cardsExport() {
    const cards = this.note.item.cards || [];
    const esc = (s) => String(s).replace(/[\t\n]+/g, ' ');
    offerFile(new Blob([cards.map((c) => `${esc(c.q)}\t${esc(c.a)}`).join('\n')], { type: 'text/tab-separated-values' }), `${safeName(this.note.item.name)}_暗記カード.tsv`);
  }
  /* 練習: 今日の分（無ければ全部）を順に。答えを見て「覚えた／もう一度」 */
  cardsPractice() {
    const n = this.note, all = n.item.cards || [];
    if (!all.length) return;
    let queue = all.filter(cardDue);
    if (!queue.length) queue = all.slice();
    queue.sort(() => Math.random() - 0.5);
    const total = queue.length;
    let i = 0, shown = false, okCount = 0;
    const back = el('div', { class: 'modal-back cards-back' });
    const box = el('div', { class: 'cards-box' });
    back.append(box);
    document.body.append(back);
    const close = () => { back.remove(); n.itemDirty = true; this.saveSoon(); };
    const draw = () => {
      box.innerHTML = '';
      if (i >= queue.length) {
        box.append(el('h2', {}, 'おつかれさまでした'), el('p', {}, `${total} 枚中 ${okCount} 枚「覚えた」（もう一度の分も練習しました）`),
          el('div', { class: 'modal-buttons' }, el('button', { class: 'primary', onclick: close }, '閉じる')));
        return;
      }
      const c = queue[i];
      box.append(el('div', { class: 'cards-top muted small' }, `${i + 1} / ${queue.length}`, c.page ? el('button', { class: 'ghost small', onclick: () => { close(); this.view.goToPage(c.page - 1); this.updateStatus(); } }, `p.${c.page} を見る`) : null,
        el('button', { class: 'ghost small', onclick: close }, '✕')));
      box.append(el('div', { class: 'cards-q' }, c.q));
      if (shown) box.append(el('div', { class: 'cards-a' }, c.a));
      const btns = el('div', { class: 'modal-buttons' });
      if (!shown) btns.append(el('button', { class: 'primary', onclick: () => { shown = true; draw(); } }, '答えを見る'));
      else btns.append(
        el('button', { class: 'danger', onclick: () => { cardAnswer(c, false); queue.push(c); i++; shown = false; draw(); } }, 'もう一度'),
        el('button', { class: 'primary', onclick: () => { cardAnswer(c, true); okCount++; i++; shown = false; draw(); } }, '覚えた'));
      box.append(btns);
    };
    draw();
  }

  // ---- ノートの整理
  async aiOrganize() {
    if (!await this.aiReady()) return;
    const n = this.note, body = this.aiPanel('ノートを整理');
    const prog = el('div', { class: 'muted small' }, 'ノートを読み込んでいます…');
    body.append(prog);
    const content = await noteContent(n, n.pages, { maxImages: 30 });
    content.push({ type: 'text', text: '\nこのノートを整理します。内容が分かる短い題名（title、30 字以内）、ノート全体の 1〜2 文の説明（summary）、' +
      '内容の区切りになるページの見出し（pages: page はページ番号、heading は 20 字以内。区切りのページだけ、多くても 30 個）を作ってください。' });
    prog.textContent = '考えています…';
    const r = await this.aiCall({ messages: [{ role: 'user', content }], effort: 'medium', json: ORG_SCHEMA }, body);
    prog.remove();
    if (!r) return;
    const d = r.data, title = el('input', { type: 'text', value: d.title || '', class: 'wide' });
    const useTitle = el('input', { type: 'checkbox', checked: true }), useMarks = el('input', { type: 'checkbox', checked: true });
    const heads = (d.pages || []).filter((h) => h.page >= 1 && h.page <= n.pages.length);
    body.append(el('p', {}, d.summary || ''),
      el('label', { class: 'row' }, useTitle, ' 題名を変える'), title,
      el('label', { class: 'row' }, useMarks, ` 見出しをしおりにする（${heads.length} か所）`),
      el('ul', { class: 'ai-heads' }, ...heads.map((h) => el('li', {}, `p.${h.page}　${h.heading}`))),
      this.aiCostLine(r));
    $('#ai-foot').append(el('button', { class: 'small primary', onclick: () => {
      if (useTitle.checked && title.value.trim()) { n.item.name = title.value.trim(); n.itemDirty = true; $('#note-title').textContent = n.item.name; }
      if (useMarks.checked && heads.length) {
        const targets = heads.map((h) => [n.pages[h.page - 1], { title: h.heading }]);
        const before = targets.map(([p]) => p.mark || null);
        const apply = (vals) => { targets.forEach(([p], k) => { if (vals[k]) p.mark = vals[k]; else delete p.mark; n.dirty.add(p.id); }); n.touch(null); this.updateStatus(); this.refreshPanel(); };
        n.push({ label: 'AI の見出し', redo: () => apply(targets.map((t) => t[1])), undo: () => apply(before) });
      }
      this.saveSoon();
      toast('整理しました（しおりはページ一覧の 🔖 で見られます）');
    } }, 'この内容で整理する'));
  }

  // ================= 録音
  bindRec() {
    const R = this.recorder, P = this.player;
    $('#btn-rec').addEventListener('click', (e) => {
      if (R.active) { popMenu(e.currentTarget, [
        { label: R.state === 'paused' ? '▶ 録音を続ける' : '⏸ 一時停止', fn: () => (R.state === 'paused' ? R.resume() : R.pause()) },
        { label: '■ 録音を止めて保存', fn: () => R.stop() }]); return; }
      const recs = (this.note && this.note.item.recordings) || [];
      popMenu(e.currentTarget, [
        { label: '● 録音を始める', fn: () => R.start() },
        { label: (this.settings.transcribe ? '✓ ' : '　 ') + '録音しながら文字起こし', fn: () => { this.settings.transcribe = !this.settings.transcribe; this.saveSettings(); } },
        null,
        { label: `録音の一覧（${recs.length}）`, fn: () => this.openRecPanel() },
      ]);
    });
    $('#rb-pause').addEventListener('click', () => (R.state === 'paused' ? R.resume() : R.pause()));
    $('#rb-stop').addEventListener('click', () => R.stop());
    $('#rp-new').addEventListener('click', () => R.start());
    $('#rp-close').addEventListener('click', () => this.closeRecPanel());
    $('#pb-play').addEventListener('click', () => P.toggle());
    $('#pb-back').addEventListener('click', () => P.skip(-10));
    $('#pb-fwd').addEventListener('click', () => P.skip(10));
    $('#pb-close').addEventListener('click', () => P.close());
    $('#pb-rate').addEventListener('click', () => { const rs = [1, 1.25, 1.5, 2, 0.75]; P.setRate(rs[(rs.indexOf(P.rate || 1) + 1) % rs.length]); });
    $('#pb-sync').addEventListener('click', () => { P.sync = !P.sync; this.updatePlayBar(); this.view.invalidate(); });
    const seek = $('#pb-seek');
    seek.addEventListener('input', () => { const d = this.recDur(); if (d) P.seek((seek.value / 1000) * d); });
  }
  recDur() { const P = this.player; if (!P.rec) return 0; const a = P.audio; return a && isFinite(a.duration) && a.duration > 0 ? a.duration * 1000 : P.rec.dur || 0; }
  showRecBar() { $('#recbar').hidden = false; $('#btn-rec').classList.add('rec-on'); this.updateRecBar(); }
  hideRecBar() { $('#recbar').hidden = true; $('#btn-rec').classList.remove('rec-on'); }
  updateRecBar() {
    const R = this.recorder;
    if (!R.active) return;
    $('#rb-time').textContent = fmtClock(R.pos());
    $('#rb-pause').textContent = R.state === 'paused' ? '続ける' : '一時停止';
    $('#recbar').classList.toggle('paused', R.state === 'paused');
    const tr = R.rec.transcript, last = tr.length ? tr[tr.length - 1].text : '';
    $('#rb-text').textContent = R.interim || last || (this.settings.transcribe && SpeechRec ? '（話すと文字になります）' : '');
  }
  showPlayBar() { $('#playbar').hidden = false; this.updatePlayBar(); }
  hidePlayBar() { $('#playbar').hidden = true; }
  updatePlayBar() {
    const P = this.player;
    if (!P.rec) return;
    const pos = P.posMs(), d = this.recDur();
    $('#pb-play').textContent = P.audio && !P.audio.paused ? '⏸' : '▶';
    $('#pb-time').textContent = fmtClock(pos);
    $('#pb-dur').textContent = fmtClock(d);
    if (document.activeElement !== $('#pb-seek')) $('#pb-seek').value = d ? Math.round((pos / d) * 1000) : 0;
    $('#pb-rate').textContent = (P.rate || 1) + '×';
    $('#pb-sync').classList.toggle('on', P.sync);
    $('#pb-name').textContent = P.rec.name;
  }
  openRecPanel() { this.closePanel(); this.closeSearch(); $('#recpanel').hidden = false; this.refreshRecPanel(); }
  closeRecPanel() { const p = $('#recpanel'); if (p) p.hidden = true; }
  refreshRecPanel() {
    const panel = $('#recpanel');
    if (!panel || panel.hidden || !this.note) return;
    const list = $('#rp-list'), item = this.note.item, recs = (item.recordings || []).slice().sort((a, b) => b.created - a.created);
    list.innerHTML = '';
    if (!recs.length) list.append(el('div', { class: 'sp-hint muted' }, '録音はまだありません。「● 録音する」で始めると、書いた線と音声がつながり、あとで線を光らせながら聞き直せます。'));
    for (const r of recs) {
      const tr = el('div', { class: 'rp-tr' });
      for (const seg of r.transcript || []) {
        const b = el('button', { class: 'sp-row' }, el('span', { class: 'sp-page' }, fmtClock(seg.t)), el('span', { class: 'sp-snip' }, seg.text));
        b.addEventListener('click', () => this.player.play(r, Math.max(0, seg.t - 1000)));
        tr.append(b);
      }
      list.append(el('div', { class: 'rp-item' },
        el('div', { class: 'rp-head' },
          el('button', { class: 'pb-play small', title: '再生', onclick: () => this.player.play(r, 0) }, '▶'),
          el('div', { class: 'rp-meta' }, el('b', {}, r.name), el('span', { class: 'muted small' }, `${fmtDate(r.created)}・${fmtClock(r.dur)}${(r.transcript || []).length ? '・文字起こしあり' : ''}`)),
          el('button', { class: 'ghost small', title: 'その他', onclick: (e) => this.recMenu(r, e.currentTarget) }, '⋯')),
        tr));
    }
  }
  recMenu(r, anchor) {
    const item = this.note.item;
    const save = async () => { item.updated = Date.now(); await Store.saveNote(item, [], [], recTextRecs(item)); this.refreshRecPanel(); };
    popMenu(anchor, [
      { label: '名前を変える', fn: async () => { const nm = await askText('録音の名前', r.name); if (nm) { r.name = nm; await save(); } } },
      { label: '音声を書き出す・共有', fn: async () => {
        const v = await Src.get(r.src).catch(() => null);
        if (!v) { toast('録音のデータが見つかりません', { error: true }); return; }
        const ext = /webm/.test(v.type) ? 'webm' : /ogg/.test(v.type) ? 'ogg' : 'm4a';
        await offerFile(new Blob([v.data], { type: v.type }), `${safeName(r.name)}.${ext}`);
      } },
      { label: '文字起こしを書き出す（テキスト）', disabled: !(r.transcript || []).length, fn: () => offerFile(new Blob([(r.transcript || []).map((x) => `[${fmtClock(x.t)}] ${x.text}`).join('\n')], { type: 'text/plain' }), `${safeName(r.name)}.txt`) },
      null,
      { label: '削除', danger: true, fn: async () => {
        if (!await confirmBox('録音を削除', `「${r.name}」を削除します（書いた線は残ります）。`, '削除', true)) return;
        if (this.player.rec && this.player.rec.id === r.id) this.player.close();
        item.recordings = (item.recordings || []).filter((x) => x.id !== r.id);
        await Store.saveNote(item, [], [], [{ pageId: 'rec|' + r.id, noteId: item.id, text: '', obj: '' }].concat(recTextRecs(item)));
        Store.gcBlobs().catch(() => {});
        this.refreshRecPanel();
      } },
    ]);
  }

  // ================= しおり
  toggleMark(p = this.currentPage()) {
    const n = this.note;
    if (!n || !p || n.board) return;
    const before = p.mark || null, after = before ? null : { title: `${n.pageIndex(p) + 1} ページ` };
    const apply = (m) => { if (m) p.mark = m; else delete p.mark; n.dirty.add(p.id); n.touch(null); this.updateStatus(); this.refreshPanel(); };
    n.push({ label: 'しおり', redo: () => apply(after), undo: () => apply(before) });
    this.showBadge(after ? 'しおりを付けました' : 'しおりを外しました');
  }
  async renameMark(p) {
    const name = await askText('しおりの名前', p.mark.title || '');
    if (!name) return;
    const n = this.note, before = p.mark, after = { ...p.mark, title: name };
    const apply = (m) => { p.mark = m; n.dirty.add(p.id); n.touch(null); this.refreshPanel(); };
    n.push({ label: 'しおりの名前', redo: () => apply(after), undo: () => apply(before) });
  }

  // ================= スタンプ・付箋
  stampMenu(anchor) {
    const grid = el('div', { class: 'stamp-grid' });
    const done = (st) => { closePopMenus(); this.placeObject((x, y) => newStamp(st, x, y)); };
    for (const st of STAMPS) {
      const o = newStamp(st, 0, 0), c = el('canvas', { width: Math.ceil(o.w * 2), height: Math.ceil(o.h * 2) });
      c.style.width = o.w + 'px'; c.style.height = o.h + 'px';
      const g = c.getContext('2d'); g.scale(2, 2); drawObject(g, { ...o, x: 0, y: 0 });
      grid.append(el('button', { class: 'stamp-cell', onclick: () => done(st) }, c));
    }
    const m = popMenu(anchor, []);
    m.append(grid);
    const r = m.getBoundingClientRect();          // 中身を入れた後で画面からはみ出さないように
    if (r.right > innerWidth - 8) m.style.left = Math.max(8, innerWidth - 8 - r.width) + 'px';
    if (r.bottom > innerHeight - 8) m.style.top = Math.max(8, innerHeight - 8 - r.height) + 'px';
  }
  /* 見ている所の真ん中に物を置いて、なげなわで選ぶ */
  placeObject(make) {
    const n = this.note, v = this.view;
    const C = v.toDocLocal(v.cssW / 2, v.cssH / 2), hit = n.pageAt(C.x, C.y, 1e9), page = hit.page, q = n.docToPage(page, C.x, C.y);
    const o = make(q.x, q.y);
    if (!page.infinite) { o.x = clamp(o.x, 0, Math.max(0, page.w - o.w)); o.y = clamp(o.y, 0, Math.max(0, page.h - o.h)); }
    const ib = (page.images || []).slice();
    n.swapBoth(page, page.strokes.slice(), page.strokes.slice(), ib, ib.concat([o]), '置く');
    this.setTool('lasso');
    this.tools.lasso.setSel(page, [], [o]);
    v.invalidate();
    this.tools.lasso.showBar(v);
    return { page, o };
  }
  addSticky() {
    const n = this.note, v = this.view;
    const C = v.toDocLocal(v.cssW / 2, v.cssH / 2), hit = n.pageAt(C.x, C.y, 1e9), page = hit.page, q = n.docToPage(page, C.x, C.y);
    const o = this.toolState.text;
    const obj = fitTextHeight({ id: uid('m'), kind: 'text', x: q.x - 90, y: q.y - 60, w: 180, h: 120, rot: 0, text: '', size: 14, color: '#1d1d1f', font: o.font, bold: false, bg: STICKY_COLORS[0] });
    if (!page.infinite) { obj.x = clamp(obj.x, 0, Math.max(0, page.w - obj.w)); obj.y = clamp(obj.y, 0, Math.max(0, page.h - obj.h)); }
    this.setTool('text');
    this.tools.text.open(v, page, obj, true);
  }

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
    $('#btn-search').addEventListener('click', () => ($('#searchpanel').hidden ? this.openSearch() : this.closeSearch()));
    $('#btn-insert').addEventListener('click', (e) => this.insertMenu(e.currentTarget));
    $('#btn-share').addEventListener('click', (e) => this.shareMenu(e.currentTarget));
    $('#sp-close').addEventListener('click', () => this.closeSearch());
    const runSoon = debounce(() => this.runSearch(), 220);
    $('#sp-input').addEventListener('input', runSoon);
    $('#sp-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && this._hits && this._hits.length) this.showHit(this._hits[0], $('#sp-input').value.trim()); });
    $('#pp-select').addEventListener('click', () => { this.panelSel = this.panelSel ? null : new Set(); this.refreshPanel(); });
    for (const b of $$('#pp-selbar [data-act]')) b.addEventListener('click', () => this.panelAction(b.dataset.act));
    $('#pp-close').addEventListener('click', () => this.closePanel());
    $('#pp-add').addEventListener('click', () => { const n = this.note; n.addPage(n.pages.length); this.afterPageChange(); this.view.goToPage(n.pages.length - 1); });
    const L = () => this.tools.lasso, V = () => this.view;
    $('#sel-del').addEventListener('click', () => L().remove(V()));
    $('#sel-copy').addEventListener('click', () => { L().copy(); this.renderQuick(); });
    $('#sel-cut').addEventListener('click', () => { L().cut(V()); this.renderQuick(); });
    $('#sel-dup').addEventListener('click', () => L().duplicate(V()));
    $('#sel-link').addEventListener('click', () => this.linkDialog());
    $('#btn-mark').addEventListener('click', () => this.toggleMark());
    this.bindRec();
    $('#btn-ai').addEventListener('click', (e) => this.aiMenu(e.currentTarget));
    $('#ai-close').addEventListener('click', () => this.closeAiPanel());
    $('#pp-marks').addEventListener('click', () => { this.panelMarks = !this.panelMarks; this.refreshPanel(); });
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
      if (mod && k === 'v') { if (this.clipboard) { e.preventDefault(); this.paste(); } return; }     // 画像の貼り付けは paste の出来事で
      if (mod && k === 'f') { e.preventDefault(); this.openSearch(); return; }
      if ((k === 'delete' || k === 'backspace') && this.tools.lasso.sel) { e.preventDefault(); this.tools.lasso.remove(this.view); return; }
      if (mod) return;
      const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', ' ': 'hand', t: 'text', k: 'laser' };
      if (k === 'r') { e.preventDefault(); this.view.ruler.show(); this.renderQuick(); return; }
      if (k === 'b') { e.preventDefault(); this.toggleMark(); return; }
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

/* "1-3, 5" → [0,1,2,4] */
function parsePageSpec(s, n) {
  const out = [];
  for (const part of String(s).replace(/[，、]/g, ',').replace(/[－ー〜~]/g, '-').split(',')) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) continue;
    let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) if (!out.includes(i - 1)) out.push(i - 1);
  }
  return out;
}
function closeModals() { for (const m of $$('.modal-back')) m.remove(); }

/* ページの小さな絵（dataURL）。無限キャンバスは書いた範囲 */
function makeThumb(note, p, W) {
  if (!p) return '';
  let r;
  if (p.infinite) {
    const things = p.strokes.concat((p.images || []).map((im) => ({ _bb: imageBBox(im) })));
    r = things.length ? unionBBox(things) : [-300, -200, 300, 200];
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
    drawImages(g, p);
    drawStrokes(g, p.strokes, null, { minW: 0.9 / k });
  } else {
    const pm = note.pageMatrix(p);
    g.setTransform(k, 0, 0, k, -p.disp.x * k, -p.disp.y * k);
    g.transform(pm.a, pm.b, pm.c, pm.d, pm.e, pm.f);
    drawPaper(g, p, k * 1.5);
    if (p.bg) BgRender.draw(g, p);
    drawImages(g, p);
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
