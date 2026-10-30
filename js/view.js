'use strict';
/* ノートの表示とジェスチャー。
   下地の canvas（用紙と確定した線）は表示が変わった時だけ描き直し、上の canvas（描いている線・なげなわ・選択・ホバー）は毎回。
   画面 = 文書 × 拡大(s)・回転(rot)・移動(ox, oy)。
   2本指: つまんで拡大縮小・移動（設定で回転）、素早いタップ = 設定の動作（元に戻す／消しゴムに切り替え）。3本指タップ = やり直し
   （2本指が消しゴム切り替えのときは元に戻す）。Apple Pencil を使うと「指では描かない」（1本指 = スクロール）に切り替わる。 */

class NoteView {
  constructor(app, base, over) {
    this.app = app;
    this.base = base;
    this.over = over;
    this.gb = base.getContext('2d');
    this.go = over.getContext('2d', { desynchronized: true }) || over.getContext('2d');
    this.s = 1; this.rot = 0; this.ox = 0; this.oy = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = 1; this.cssH = 1;
    this.pointers = new Map();
    this.mode = null;               // 'tool' | 'pan' | 'pinch'
    this.toolPointer = null;
    this.gesture = null;
    this.hover = null;
    this.hidden = null;             // 下地に描かない線の id（なげなわで動かしている間）
    this._raf = 0;
    this._baseDirty = true;
    this._baseKey = '';
    this.fitted = true;
    this.momentum = null;
    this.ruler = new Ruler(this);

    new ResizeObserver(() => this.resize()).observe(over);
    over.addEventListener('pointerdown', (e) => this.onDown(e));
    over.addEventListener('pointermove', (e) => this.onMove(e));
    over.addEventListener('pointerup', (e) => this.onUp(e));
    over.addEventListener('pointercancel', (e) => this.onUp(e, true));
    over.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !this.pointers.size) { this.hover = null; this.requestOver(); } });
    over.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    over.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => { if (this.note) e.preventDefault(); }, { passive: false });
    over.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });   // 拡大鏡・選択を出さない
    over.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }
  get note() { return this.app.note; }

  resize() {
    const r = this.over.getBoundingClientRect();
    const pw = this.cssW, ph = this.cssH;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    for (const c of [this.base, this.over]) { c.width = Math.round(this.cssW * this.dpr); c.height = Math.round(this.cssH * this.dpr); }
    if (this.note) {
      if (this.fitted || pw < 10) this.fit(false);
      else { this.ox += (this.cssW - pw) / 2; this.oy += (this.cssH - ph) / 2; }
    }
    this.invalidate();
  }

  // ---- 変換
  get m() {
    const c = Math.cos(this.rot), s = Math.sin(this.rot), k = this.s;
    return { a: k * c, b: k * s, c: -k * s, d: k * c, e: this.ox, f: this.oy };
  }
  toScreen(X, Y) { const m = this.m; return { x: m.a * X + m.c * Y + m.e, y: m.b * X + m.d * Y + m.f }; }
  toDocLocal(x, y) {
    const m = this.m, det = m.a * m.d - m.b * m.c, X = x - m.e, Y = y - m.f;
    return { x: (m.d * X - m.c * Y) / det, y: (-m.b * X + m.a * Y) / det };
  }
  local(e) { const r = this.over.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  toDoc(cx, cy) { const r = this.over.getBoundingClientRect(); return this.toDocLocal(cx - r.left, cy - r.top); }
  pin(P, at) {          // 文書の点 P が画面の at に来るよう移動
    const m = this.m;
    this.ox = at.x - (m.a * P.x + m.c * P.y);
    this.oy = at.y - (m.b * P.x + m.d * P.y);
  }
  visibleDocRect() {
    const cs = [this.toDocLocal(0, 0), this.toDocLocal(this.cssW, 0), this.toDocLocal(0, this.cssH), this.toDocLocal(this.cssW, this.cssH)];
    return { x0: Math.min(...cs.map((c) => c.x)), y0: Math.min(...cs.map((c) => c.y)), x1: Math.max(...cs.map((c) => c.x)), y1: Math.max(...cs.map((c) => c.y)) };
  }

  // ---- ページの並べ方（ノートごと）: 1 ページずつ（single）か続けて、縦（v）か横（h）
  get single() { const n = this.note; return !!(n && !n.board && this.app.layoutOf(n).single); }
  get dirH() { const n = this.note; return !!(n && !n.board && this.app.layoutOf(n).dir === 'h'); }
  /* i ページ目を画面いっぱい（全体が見える大きさ）で真ん中に */
  pageFit(i) {
    const p = this.note.pages[clamp(i, 0, this.note.pages.length - 1)], m = 14;
    const s = clamp(Math.min((this.cssW - m * 2) / p.disp.w, (this.cssH - m * 2) / p.disp.h), 0.05, 10);
    return { s, ox: this.cssW / 2 - (p.disp.x + p.disp.w / 2) * s, oy: this.cssH / 2 - (p.disp.y + p.disp.h / 2) * s };
  }
  atFit() { return this.single && this.s <= this.pageFit(this.pageI || 0).s * 1.04; }
  /* なめらかに動かす（ページ送り） */
  animateTo(t, ms = 230, done = null) {
    const from = { s: this.s, ox: this.ox, oy: this.oy }, t0 = performance.now(), token = {};
    this._anim = token;
    const step = () => {
      if (this._anim !== token) return;
      const k = Math.min(1, (performance.now() - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      this.s = from.s + (t.s - from.s) * e; this.ox = from.ox + (t.ox - from.ox) * e; this.oy = from.oy + (t.oy - from.oy) * e;
      this.invalidate();
      if (k < 1) requestAnimationFrame(step); else { this._anim = null; this.invalidate(); if (done) done(); }
    };
    requestAnimationFrame(step);
  }
  /* 次・前のページへ（d = +1 / -1） */
  turnPage(d) {
    const n = this.note;
    if (!n || n.board) return false;
    const i = this.currentPageIndex() + d;
    if (i < 0 || i >= n.pages.length) {
      this.app.showBadge(i < 0 ? '最初のページです' : '最後のページです');
      if (this.single) this.animateTo(this.pageFit(this.pageI));
      return false;
    }
    this.goToPage(i, true);
    this.app.updateStatus();
    this.app.saveView();
    this.app.refreshPanel();
    return true;
  }
  /* 1 ページずつ: 拡大していればページの中だけ動ける、全体表示ならその位置に */
  clampSingle() {
    const p = this.note.pages[this.pageI || 0], s = this.s, W = p.disp.w * s, H = p.disp.h * s;
    const L = p.disp.x * s + this.ox, T = p.disp.y * s + this.oy;
    if (W <= this.cssW) this.ox = this.cssW / 2 - (p.disp.x + p.disp.w / 2) * s;
    else { if (L > 0) this.ox -= L; else if (L + W < this.cssW) this.ox += this.cssW - (L + W); }
    if (H <= this.cssH) this.oy = this.cssH / 2 - (p.disp.y + p.disp.h / 2) * s;
    else { if (T > 0) this.oy -= T; else if (T + H < this.cssH) this.oy += this.cssH - (T + H); }
  }
  /* 1 ページずつ: 指で払った向きでページを送る（少しなら元の位置へ） */
  endSwipe(G, lp) {
    const d = this.dirH ? lp.x - G.sx : lp.y - G.sy;
    const h = G.hist, a = h[Math.max(0, h.length - 3)], b = h[h.length - 1];
    const vel = a && b && b[0] > a[0] ? ((this.dirH ? b[1] - a[1] : b[2] - a[2]) / (b[0] - a[0])) : 0;
    if (d < -50 || vel < -0.6) this.turnPage(1);
    else if (d > 50 || vel > 0.6) this.turnPage(-1);
    else this.animateTo(this.pageFit(this.pageI));
  }

  fit(redraw = true) {
    const n = this.note;
    if (!n) return;
    this.rot = 0;
    if (n.board) {
      this.s = 1;
      this.ox = this.cssW / 2; this.oy = this.cssH / 3;
      if (n.item.view) { this.s = n.item.view.s; this.ox = n.item.view.ox; this.oy = n.item.view.oy; }
    } else if (this.single) {
      this.pageI = clamp(this.pageI || 0, 0, n.pages.length - 1);
      Object.assign(this, this.pageFit(this.pageI));
    } else if (this.dirH) {
      const margin = 24;
      this.s = clamp((this.cssH - margin * 2) / (n.height || 842), 0.1, 4);
      if (this.app.settings.fitPage) this.s = Math.min(this.s, (this.cssW - margin * 2) / (n.pages[0] ? n.pages[0].disp.w : 595));
      this.oy = this.cssH / 2;
      this.ox = margin;
    } else {
      const margin = 24;
      this.s = clamp((this.cssW - margin * 2) / (n.width || 595), 0.1, 4);
      if (this.app.settings.fitPage) this.s = Math.min(this.s, (this.cssH - margin * 2) / (n.pages[0] ? n.pages[0].disp.h : 842));
      this.ox = this.cssW / 2;
      this.oy = margin;
    }
    this.fitted = true;
    if (redraw) this.invalidate();
  }
  /* 無限キャンバス: 書いた線がぜんぶ収まるように */
  fitContent() {
    const n = this.note;
    const pg = n && n.board ? n.pages[0] : null;
    if (!pg || !pg.strokes.length) { this.fit(); return; }
    const [x0, y0, x1, y1] = unionBBox(pg.strokes);
    const m = 40;
    this.rot = 0;
    this.s = clamp(Math.min((this.cssW - m * 2) / Math.max(1, x1 - x0), (this.cssH - m * 2) / Math.max(1, y1 - y0)), 0.05, 4);
    this.ox = this.cssW / 2 - (x0 + x1) / 2 * this.s;
    this.oy = this.cssH / 2 - (y0 + y1) / 2 * this.s;
    this.fitted = false;
    this.invalidate();
  }
  goToPage(i, animate = false) {
    const n = this.note;
    if (!n || n.board) return;
    const idx = clamp(i, 0, n.pages.length - 1), p = n.pages[idx];
    this.rot = 0;
    let t;
    if (this.single) { this.pageI = idx; t = this.pageFit(idx); }
    else if (this.dirH) t = { s: this.s, ox: 16 - p.disp.x * this.s, oy: this.cssH / 2 };
    else t = { s: this.s, oy: 16 - p.disp.y * this.s, ox: this.cssW / 2 };
    if (animate) this.animateTo(t);
    else { this._anim = null; Object.assign(this, t); }
    this.fitted = this.single;
    this.invalidate();
  }
  currentPageIndex() {
    const n = this.note;
    if (!n || n.board) return 0;
    if (this.single) return clamp(this.pageI || 0, 0, n.pages.length - 1);
    const P = this.dirH ? this.toDocLocal(this.cssW / 3, this.cssH / 2) : this.toDocLocal(this.cssW / 2, this.cssH / 3);
    return n.pageIndex(n.pageAt(P.x, P.y).page);
  }
  zoomAt(k, x, y) {
    const P = this.toDocLocal(x, y);
    this.s = clamp(this.s * k, this.note && this.note.board ? 0.05 : 0.1, 10);
    this.pin(P, { x, y });
    this.fitted = false;
    if (this.single) { if (this.s < this.pageFit(this.pageI).s) { Object.assign(this, this.pageFit(this.pageI)); this.fitted = true; } else this.clampSingle(); }
    this.invalidate();
  }

  // ---- 描画
  invalidate() { this._baseDirty = true; this.request(); }
  requestOver() { this.request(); }
  request() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  render() {
    const n = this.note;
    const pb = this.app.player && this.app.player.open ? this.app.player.baseKey() : '';
    const key = n ? `${n.version}|${this.s}|${this.rot}|${this.ox}|${this.oy}|${this.cssW}|${this.cssH}|${this.hidden ? this.hidden.size : 0}|${pb}` : '';
    if (this._baseDirty || key !== this._baseKey) {
      this.renderBase(); this._baseKey = key; this._baseDirty = false;
      if (this.app.zoomWin && this.app.zoomWin.open) this.app.zoomWin.request();
    }
    this.renderOver();
  }
  renderBase() {
    const g = this.gb, n = this.note;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#3b3e44';
    g.fillRect(0, 0, this.base.width, this.base.height);
    if (!n) return;
    const m = this.m, d = this.dpr;
    g.setTransform(d * m.a, d * m.b, d * m.c, d * m.d, d * m.e, d * m.f);
    const vr = this.visibleDocRect();
    const hide = this.hidden;
    const visible = (list) => (hide && hide.size ? list.filter((s) => !hide.has(s.id)) : list);
    // 録音の再生中: まだ書いていない線は薄く
    const P = this.app.player && this.app.player.open && this.app.player.sync ? this.app.player : null;
    const drawInk = (list, clip, opt) => {
      if (!P) { drawStrokes(g, list, clip, opt); return; }
      drawStrokes(g, list.filter((s) => !P.isFuture(s)), clip, opt);
      drawStrokes(g, list.filter((s) => P.isFuture(s)), clip, { ...opt, alpha: 0.16 });
    };
    g.imageSmoothingQuality = 'high';
    if (n.board) {
      const p = n.pages[0];
      drawBoardPaper(g, p, vr, this.s);
      drawImages(g, p, hide, { screen: true });
      drawInk(visible(p.strokes), [vr.x0, vr.y0, vr.x1, vr.y1], { minW: 0.8 / this.s });
      return;
    }
    const midY = (vr.y0 + vr.y1) / 2;
    const onlyCur = this.single && !this._anim && this.mode !== 'pan' && this.mode !== 'pinch' ? n.pages[this.pageI || 0] : null;
    for (const p of n.pages) {
      if (onlyCur && p !== onlyCur) continue;
      const r = p.disp;
      if (p.bg && r.y < vr.y1 + r.h && r.y + r.h > vr.y0 - r.h) {       // 前後 1 ページも先に描いておく
        const near = r.x > vr.x1 || r.x + r.w < vr.x0 || r.y > vr.y1 || r.y + r.h < vr.y0;
        if (near) BgRender.want(p, Math.min(this.s * d, BgRender.capK(p)), null, 10 + Math.abs(r.y + r.h / 2 - midY) / 1000);
      }
      if (r.x > vr.x1 || r.x + r.w < vr.x0 || r.y > vr.y1 || r.y + r.h < vr.y0) continue;
      g.save();
      g.shadowColor = 'rgba(0,0,0,.35)';
      g.shadowBlur = 10 * this.s * d;
      g.shadowOffsetY = 2 * this.s * d;
      g.fillStyle = '#fff';
      g.fillRect(r.x, r.y, r.w, r.h);
      g.restore();
      g.save();
      const pm = n.pageMatrix(p);
      g.transform(pm.a, pm.b, pm.c, pm.d, pm.e, pm.f);
      g.beginPath(); g.rect(0, 0, p.w, p.h); g.clip();
      drawPaper(g, p, this.s);
      // 見えている範囲をページの座標で
      const c1 = n.docToPage(p, vr.x0, vr.y0), c2 = n.docToPage(p, vr.x1, vr.y1);
      const clip = [Math.min(c1.x, c2.x), Math.min(c1.y, c2.y), Math.max(c1.x, c2.x), Math.max(c1.y, c2.y)];
      if (p.bg) {
        BgRender.draw(g, p);
        BgRender.want(p, this.s * d, [Math.max(0, clip[0]), Math.max(0, clip[1]), Math.min(p.w, clip[2]), Math.min(p.h, clip[3])],
          Math.abs(r.y + r.h / 2 - midY) / 1000);
      }
      drawImages(g, p, hide, { screen: true });
      drawInk(visible(p.strokes), clip, { minW: 0.8 / this.s });
      g.restore();
    }
  }
  renderOver() {
    const g = this.go;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.over.width, this.over.height);
    const n = this.note;
    if (!n) return;
    const mk = this.app.searchMarks;
    if (mk) for (const p of n.pages) {
      const polys = mk.get(p.id);
      if (!polys || !polys.length) continue;
      this.withPage(g, p, (gg) => {
        gg.beginPath();
        for (const q of polys) { gg.moveTo(q[0], q[1]); for (let i = 2; i < q.length; i += 2) gg.lineTo(q[i], q[i + 1]); gg.closePath(); }
        gg.fillStyle = 'rgba(255,170,0,.38)'; gg.fill();
      });
    }
    if (this.app.zoomWin) this.app.zoomWin.drawMarker(g, this);
    if (this.app.player && this.app.player.open) this.app.player.drawOverlay(g, this);
    const tool = this.app.tool;
    if (tool && tool.drawOverlay) tool.drawOverlay(g, this);
    if (tool !== this.app.tools.laser && this.app.tools.laser.trails.length) this.app.tools.laser.drawOverlay(g, this);
    this.ruler.draw(g);
    if (this.app.tools.text.edit) this.app.tools.text.place(this);
    if (this.hover && tool && tool.showsHover && this.mode !== 'tool') tool.drawHover(g, this, this.hover);
  }
  /* 文書の空間の g（上の canvas）: ページの座標で描く時は withPage */
  docCtx(g) {
    const m = this.m, d = this.dpr;
    g.setTransform(d * m.a, d * m.b, d * m.c, d * m.d, d * m.e, d * m.f);
    return g;
  }
  withPage(g, p, fn) {
    g.save();
    this.docCtx(g);
    const pm = this.note.pageMatrix(p);
    g.transform(pm.a, pm.b, pm.c, pm.d, pm.e, pm.f);
    fn(g);
    g.restore();
  }

  // ---- 入力
  pointInfo(e) {
    const P = this.toDoc(e.clientX, e.clientY);
    return { X: P.x, Y: P.y, type: e.pointerType, pressure: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5,
      t: e.timeStamp, shift: e.shiftKey, alt: e.altKey };
  }
  touchCount() { let k = 0; for (const p of this.pointers.values()) if (p.type === 'touch') k++; return k; }

  onDown(e) {
    if (!this.note) return;
    this.app.closePopups();
    this._hadMomentum = !!this.momentum || !!this._anim;
    this.momentum = null;
    this._anim = null;
    try { this.over.setPointerCapture(e.pointerId); } catch { /* */ }
    const lp = this.local(e);
    this.pointers.set(e.pointerId, { x: lp.x, y: lp.y, type: e.pointerType });
    if (this.app.tools.text.edit && this.app.toolName !== 'text') this.app.tools.text.commit(this);
    // 定規: 1本指（ペン・マウスは真ん中）でつかんで動かす、2本目の指で回す
    const R = this.ruler;
    if (R.visible) {
      if (this.mode === 'ruler' && e.pointerType === 'touch') {
        const a = this.pointers.get(this.gesture.id), b = this.pointers.get(e.pointerId);
        if (a && b) {
          this.mode = 'rulerRot';
          this.gesture = { ids: [this.gesture.id, e.pointerId], ang0: Math.atan2(b.y - a.y, b.x - a.x), rang: R.ang,
            mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cx: R.cx, cy: R.cy };
          return;
        }
      }
      if (!this.mode && R.knobHit(lp.x, lp.y) && (e.pointerType !== 'touch' || this.touchCount() === 1)) {
        this.mode = 'rulerKnob';
        this.gesture = { id: e.pointerId };
        return;
      }
      if (!this.mode && (e.pointerType === 'touch' ? this.touchCount() === 1 && R.hit(lp.x, lp.y) : R.grip(lp.x, lp.y))) {
        this.mode = 'ruler';
        this.gesture = { id: e.pointerId, sx: lp.x, sy: lp.y, cx: R.cx, cy: R.cy };
        return;
      }
    }
    const st = this.app.settings;
    if (e.pointerType === 'pen' && st.fingerDraws === 'auto') {
      st.fingerDraws = false;
      this.app.saveSettings();
      toast('Apple Pencil を検出しました。指では描かない設定にしました（1本指＝スクロール）', { ms: 4200 });
    }
    if (e.pointerType === 'touch') {
      if (this.mode === 'tool' && this.toolPointer && this.toolPointer.type === 'pen') return;   // 描いている最中の手のひら
      const k = this.touchCount();
      if (k >= 2) {
        if (this.mode === 'tool' && this.toolPointer && this.toolPointer.type === 'touch') this.cancelTool();
        this.startPinch();
        return;
      }
      const fingerDraws = st.fingerDraws === true || st.fingerDraws === 'auto';
      if (!fingerDraws && st.fingerAction === 'erase' && this.app.toolName !== 'hand') { this.startTool(e, 'eraser'); return; }
      if (!fingerDraws || this.app.toolName === 'hand') { this.startPan(e); return; }
      this.startTool(e);
      return;
    }
    if (this.mode === 'pinch' || this.mode === 'pan') { if (e.pointerType === 'pen') this.endGesture(true); else return; }
    if (e.button === 1 || e.button === 2 || this.app.toolName === 'hand') { this.startPan(e); return; }
    this.startTool(e);
  }
  startTool(e, override = null) {
    const tool = override ? this.app.tools[override] : this.app.tool;
    if (!tool) return;
    this.mode = 'tool';
    this.activeTool = tool;
    this.toolPointer = { id: e.pointerId, type: e.pointerType };
    this.hover = null;
    tool.down(this.pointInfo(e), this);
    this.request();
  }
  cancelTool() {
    if (this.activeTool && this.activeTool.cancel) this.activeTool.cancel(this);
    this.mode = null; this.toolPointer = null; this.activeTool = null;
    this.invalidate();
  }
  startPan(e) {
    const lp = this.local(e);
    this.mode = 'pan';
    this.gesture = { sx: lp.x, sy: lp.y, ox: this.ox, oy: this.oy, id: e.pointerId, moved: false, hist: [[performance.now(), lp.x, lp.y]], single: this.atFit() };
  }
  startPinch() {
    const pts = [...this.pointers.values()].filter((p) => p.type === 'touch');
    const [a, b] = pts;
    const prev = this.mode === 'pinch' && this.gesture ? this.gesture : null;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.mode = 'pinch';
    this.gesture = {
      mid, P: this.toDocLocal(mid.x, mid.y), dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x),
      s: this.s, rot: this.rot, ids: [...this.pointers.entries()].filter(([, p]) => p.type === 'touch').slice(0, 2).map(([id]) => id),
      t0: prev ? prev.t0 : performance.now(), maxTouches: Math.max(pts.length, prev ? prev.maxTouches : 0), moved: prev ? prev.moved : 0,
    };
  }
  onMove(e) {
    const lp = this.local(e);
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) { ptr.x = lp.x; ptr.y = lp.y; }
    if (this.mode === 'rulerKnob') { if (e.pointerId === this.gesture.id) this.ruler.turnTo(lp.x, lp.y); return; }
    if (this.mode === 'ruler' || this.mode === 'rulerRot') {
      const G = this.gesture, R = this.ruler;
      if (this.mode === 'ruler') { if (e.pointerId === G.id) { R.cx = G.cx + lp.x - G.sx; R.cy = G.cy + lp.y - G.sy; this.requestOver(); } return; }
      const a = this.pointers.get(G.ids[0]), b = this.pointers.get(G.ids[1]);
      if (!a || !b) return;
      let ang = G.rang + Math.atan2(b.y - a.y, b.x - a.x) - G.ang0;
      const snap = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      if (Math.abs(ang - snap) < (2.5 * Math.PI) / 180) ang = snap;
      R.ang = ang;
      R.cx = G.cx + (a.x + b.x) / 2 - G.mid.x; R.cy = G.cy + (a.y + b.y) / 2 - G.mid.y;
      this.requestOver();
      return;
    }
    if (this.mode === 'pinch') {
      if (e.pointerType !== 'touch') return;
      const G = this.gesture;
      const a = this.pointers.get(G.ids[0]), b = this.pointers.get(G.ids[1]);
      if (!a || !b) return;
      G.maxTouches = Math.max(G.maxTouches, this.touchCount());
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1, ang = Math.atan2(b.y - a.y, b.x - a.x);
      G.moved = Math.max(G.moved, Math.hypot(mid.x - G.mid.x, mid.y - G.mid.y), Math.abs(dist - G.dist));
      if (G.moved < 8) return;                      // タップかもしれない間は動かさない
      this.fitted = false;
      const n = this.note;
      this.s = clamp(G.s * (dist / G.dist), n && n.board ? 0.05 : 0.1, 10);
      if (this.app.settings.rotateGesture && !this.single) {
        let r = G.rot + (ang - G.ang);
        const snap = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(r - snap) < (5 * Math.PI) / 180) r = snap;
        this.rot = Math.atan2(Math.sin(r), Math.cos(r));
      }
      this.pin(G.P, mid);
      this.app.showBadge(Math.round(this.s * 100) + '%' + (this.rot ? '  ' + Math.round((this.rot * 180) / Math.PI) + '°' : ''));
      this.invalidate();
      return;
    }
    if (this.mode === 'pan') {
      const G = this.gesture;
      if (G && e.pointerId === G.id) {
        if (Math.hypot(lp.x - G.sx, lp.y - G.sy) > 6) G.moved = true;
        if (!G.moved) return;
        if (G.single) {                 // 1 ページずつ（全体表示）: 送る向きにだけ動かす → 離した時に送る
          if (this.dirH) this.ox = G.ox + lp.x - G.sx; else this.oy = G.oy + lp.y - G.sy;
          G.hist.push([performance.now(), lp.x, lp.y]);
          if (G.hist.length > 6) G.hist.shift();
          this.invalidate();
          return;
        }
        this.fitted = false;
        this.ox = G.ox + lp.x - G.sx; this.oy = G.oy + lp.y - G.sy;
        G.hist.push([performance.now(), lp.x, lp.y]);
        if (G.hist.length > 6) G.hist.shift();
        this.clampScroll();
        this.invalidate();
      }
      return;
    }
    if (this.mode === 'tool') {
      if (!this.toolPointer || e.pointerId !== this.toolPointer.id) return;
      const tool = this.activeTool;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (evs.length > 1) for (const ce of evs) tool.move(this.pointInfo(ce), this);
      else tool.move(this.pointInfo(e), this);
      const pr = e.getPredictedEvents ? e.getPredictedEvents() : [];
      this.predicted = pr.length ? pr.map((q) => this.toDoc(q.clientX, q.clientY)) : null;
      this.request();
      return;
    }
    if (e.pointerType !== 'touch') {               // 押していない時（Apple Pencil のホバー・マウス）
      this.hover = this.toDoc(e.clientX, e.clientY);
      const t = this.app.tool;
      if (t && t.showsHover) this.request();
    }
  }
  onUp(e, cancelled = false) {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!had) return;
    if (this.mode === 'ruler' || this.mode === 'rulerRot' || this.mode === 'rulerKnob') { if (!this.pointers.size) { this.mode = null; this.gesture = null; } return; }
    if (this.mode === 'pinch') { if (this.touchCount() === 0) this.endGesture(); return; }
    if (this.mode === 'pan') {
      const G = this.gesture;
      if (G && e.pointerId === G.id) {
        this.mode = null; this.gesture = null;
        const lp = this.local(e);
        if (G.moved) { if (G.single) this.endSwipe(G, lp); else if (!this.single) this.startMomentum(G.hist); }
        else this.app.onTap(this.toDocLocal(lp.x, lp.y), e.pointerType, lp, this._hadMomentum);
      }
      return;
    }
    if (this.mode === 'tool' && this.toolPointer && e.pointerId === this.toolPointer.id) {
      const tool = this.activeTool;
      this.predicted = null;
      if (cancelled && tool.cancel) tool.cancel(this);
      else tool.up(this.pointInfo(e), this);
      this.mode = null; this.toolPointer = null; this.activeTool = null;
      this.request();
    }
  }
  endGesture(silent = false) {
    const G = this.gesture;
    this.mode = null; this.gesture = null;
    if (this.single) {             // 小さくし過ぎたら全体表示に戻す
      const f = this.pageFit(this.pageI);
      if (this.s < f.s * 1.04) this.animateTo(f, 180, () => { this.fitted = true; }); else this.clampSingle();
    }
    this.app.saveView();
    if (silent || !G || G.moved >= 12) return;
    if (performance.now() - G.t0 > 350) return;
    if (G.maxTouches === 2) this.app.twoFingerTap();
    else if (G.maxTouches >= 3) this.app.threeFingerTap();
  }
  /* 指を離した後の慣性スクロール */
  startMomentum(hist) {
    if (hist.length < 2) return;
    const [t0, x0, y0] = hist[0], [t1, x1, y1] = hist[hist.length - 1];
    const dt = Math.max(8, t1 - t0);
    let vx = ((x1 - x0) / dt) * 16, vy = ((y1 - y0) / dt) * 16;
    if (performance.now() - t1 > 80 || Math.hypot(vx, vy) < 2) { this.app.saveView(); return; }
    const token = {};
    this.momentum = token;
    const step = () => {
      if (this.momentum !== token) return;
      this.ox += vx; this.oy += vy;
      vx *= 0.93; vy *= 0.93;
      this.clampScroll();
      this.invalidate();
      if (Math.hypot(vx, vy) > 0.4) requestAnimationFrame(step);
      else { this.momentum = null; this.app.saveView(); }
    };
    requestAnimationFrame(step);
  }
  /* ノートの外へ行き過ぎないように（縦に並んだページのとき） */
  clampScroll() {
    const n = this.note;
    if (!n || n.board || this.rot) return;
    if (this.single) { this.clampSingle(); return; }
    if (this.dirH) {                // 横に並べた時: 左右はノートの端まで、上下は真ん中寄り
      const left = this.ox + (n.pages[0] ? n.pages[0].disp.x : 0) * this.s, right = left + n.width * this.s;
      const minLeft = this.cssW * 0.6 - (right - left);
      if (left > this.cssW * 0.4) this.ox -= left - this.cssW * 0.4;
      if (left < minLeft) this.ox += minLeft - left;
      const lim = Math.max(0, (n.height * this.s) / 2 - this.cssH * 0.3);
      this.oy = clamp(this.oy, this.cssH / 2 - lim - this.cssH * 0.2, this.cssH / 2 + lim + this.cssH * 0.2);
      return;
    }
    const top = this.toScreen(0, 0).y, bottom = this.toScreen(0, n.height).y;
    const minTop = this.cssH * 0.6 - (bottom - top);
    if (top > this.cssH * 0.4) this.oy -= top - this.cssH * 0.4;
    if (top < minTop) this.oy += minTop - top;
    const half = (n.width * this.s) / 2;
    const cx = this.ox;
    const lim = Math.max(0, half - this.cssW * 0.3);
    if (cx < this.cssW / 2 - lim - this.cssW * 0.2) this.ox = this.cssW / 2 - lim - this.cssW * 0.2;
    if (cx > this.cssW / 2 + lim + this.cssW * 0.2) this.ox = this.cssW / 2 + lim + this.cssW * 0.2;
  }
  onWheel(e) {
    if (!this.note) return;
    e.preventDefault();
    const lp = this.local(e);
    if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), lp.x, lp.y);
    else if (this.atFit()) {        // 1 ページずつ: ホイールでページ送り
      this._wacc = (this._wacc || 0) + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
      clearTimeout(this._wt); this._wt = setTimeout(() => { this._wacc = 0; }, 250);
      if (!this._wlock && Math.abs(this._wacc) > 60) {
        this.turnPage(this._wacc > 0 ? 1 : -1);
        this._wacc = 0; this._wlock = true; setTimeout(() => { this._wlock = false; }, 450);
      }
      return;
    } else if (this.dirH && !e.shiftKey && !e.deltaX) { this.ox -= e.deltaY; this.fitted = false; this.clampScroll(); this.invalidate(); }
    else { this.ox -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; this.oy -= e.shiftKey && !e.deltaX ? 0 : e.deltaY; this.fitted = false; this.clampScroll(); this.invalidate(); }
    this.app.saveViewSoon();
  }
}
