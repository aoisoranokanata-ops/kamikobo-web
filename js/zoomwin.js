'use strict';
/* 拡大窓: 画面の下に、ページの一部（青い枠）を大きく映す。窓の中にペンで書くとページのその場所に入る。
   書き進めて右端に近づいたら枠が自動で右へ、ページの右端まで来たら次の行の左へ。指でドラッグ＝枠を動かす。
   道具（ペン・蛍光ペン・消しゴム）は本体のものをそのまま使う。このための小さな「view」を持つ。 */

class ZoomWindow {
  constructor(app) {
    this.app = app;
    this.open = false;
    this.page = null;
    this.box = { x: 40, y: 80, w: 200 };
    this.root = $('#zoomwin');
    this.canvas = $('#zw-canvas');
    this.g = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.rot = 0;
    this.hidden = null;
    this.predicted = null;
    this.drag = null;
    this.tool = null;
    this._raf = 0;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    c.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    $('#zw-left').addEventListener('click', () => this.step(-1));
    $('#zw-right').addEventListener('click', () => this.step(1));
    $('#zw-newline').addEventListener('click', () => this.newline());
    $('#zw-smaller').addEventListener('click', () => this.zoom(1.25));
    $('#zw-bigger').addEventListener('click', () => this.zoom(0.8));
    $('#zw-close').addEventListener('click', () => this.toggle(false));
    new ResizeObserver(() => { if (this.open) this.resize(); }).observe(c);
  }
  get note() { return this.app.note; }
  get main() { return this.app.view; }
  /* 窓の大きさ（CSS px）と倍率 k（px / pt） */
  get W() { return this.cssW || 1; }
  get H() { return this.cssH || 1; }
  get s() { return this.W / this.box.w; }
  get boxH() { return this.box.w * (this.H / this.W); }

  toggle(on = !this.open) {
    const n = this.note;
    if (on && (!n || n.board)) { toast('拡大窓はページのあるノートで使えます'); return; }
    this.open = on;
    this.root.hidden = !on;
    $('#editor').classList.toggle('with-zoom', on);
    if (on) {
      const p = this.app.currentPage();
      this.resize();
      if (this.page !== p) {
        this.page = p;
        // 本体の 2.5 倍くらいの大きさで映す
        const w = clamp(this.W / (this.main.s * 2.5), p.w * 0.15, p.w * 0.8);
        this.box = { x: p.w * 0.07, y: p.h * 0.12, w };
      }
    }
    this.main.resize();
    this.main.requestOver();
    this.app.renderQuick();
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cssW * this.dpr); this.canvas.height = Math.round(this.cssH * this.dpr);
    this.request();
  }
  /* ページの座標 → 窓 */
  toPanel(x, y) { return { x: (x - this.box.x) * this.s, y: (y - this.box.y) * this.s }; }
  fromPanel(px, py) { return { x: this.box.x + px / this.s, y: this.box.y + py / this.s }; }
  /* 文書の座標 ⇔ 窓（道具は文書の座標で点を受け取る） */
  toScreen(X, Y) { const q = this.note.docToPage(this.page, X, Y); return this.toPanel(q.x, q.y); }
  docOf(px, py) {
    const q = this.fromPanel(px, py), pm = this.note.pageMatrix(this.page);
    return { x: pm.a * q.x + pm.c * q.y + pm.e, y: pm.b * q.x + pm.d * q.y + pm.f };
  }
  withPage(g, p, fn) {
    g.save();
    const k = this.s * this.dpr;
    if (p === this.page) g.setTransform(k, 0, 0, k, -this.box.x * k, -this.box.y * k);
    else { g.restore(); return; }            // 別のページは映さない
    fn(g);
    g.restore();
  }
  invalidate() { this.main.invalidate(); this.request(); }
  requestOver() { this.main.requestOver(); this.request(); }
  request() {
    if (this._raf || !this.open) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  clampBox() {
    const p = this.page, b = this.box;
    b.w = clamp(b.w, p.w * 0.12, p.w);
    b.x = clamp(b.x, -b.w * 0.2, p.w - b.w * 0.8);
    b.y = clamp(b.y, -this.boxH * 0.2, p.h - this.boxH * 0.8);
  }
  step(dir) { this.box.x += dir * this.box.w * 0.6; if (dir > 0 && this.box.x + this.box.w > this.page.w + this.box.w * 0.3) { this.newline(); return; } this.clampBox(); this.follow(); }
  newline() { this.box.x = this.page.w * 0.07; this.box.y += this.boxH * 0.85; this.clampBox(); this.follow(); }
  zoom(k) { const cx = this.box.x + this.box.w / 2; this.box.w *= k; this.box.x = cx - this.box.w / 2; this.clampBox(); this.follow(); }
  /* 本体の表示が枠を見えるように */
  follow() {
    const v = this.main, n = this.note, pm = n.pageMatrix(this.page);
    const cx = this.box.x + this.box.w / 2, cy = this.box.y + this.boxH / 2;
    const sp = v.toScreen(pm.a * cx + pm.c * cy + pm.e, pm.b * cx + pm.d * cy + pm.f);
    if (sp.y < 40 || sp.y > v.cssH - 40) { v.oy += v.cssH * 0.4 - sp.y; v.fitted = false; v.clampScroll(); }
    v.invalidate();
    this.request();
  }
  /* 本体の画面でタップした所に枠を移す */
  moveTo(page, q) {
    if (!this.open) return false;
    this.page = page;
    this.box.x = q.x - this.box.w * 0.1; this.box.y = q.y - this.boxH / 2;
    this.clampBox();
    this.follow();
    return true;
  }

  // ---- 入力
  info(e) {
    const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const P = this.docOf(px, py);
    return { X: P.x, Y: P.y, type: e.pointerType, pressure: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5, t: e.timeStamp, px, py };
  }
  onDown(e) {
    if (!this.note || this.tool || this.drag) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* */ }
    const st = this.app.settings;
    const fingerDraws = st.fingerDraws === true;
    if (e.pointerType === 'touch' && !fingerDraws) { const i = this.info(e); this.drag = { id: e.pointerId, px: i.px, py: i.py, x: this.box.x, y: this.box.y }; return; }
    const name = ['pen', 'hl', 'eraser'].includes(this.app.toolName) ? this.app.toolName : 'pen';
    this.tool = { t: this.app.tools[name], id: e.pointerId };
    this.tool.t.down(this.info(e), this);
    this.request();
  }
  onMove(e) {
    if (this.drag && e.pointerId === this.drag.id) {
      const i = this.info(e);
      this.box.x = this.drag.x - (i.px - this.drag.px) / this.s;
      this.box.y = this.drag.y - (i.py - this.drag.py) / this.s;
      this.clampBox();
      this.main.requestOver();
      this.request();
      return;
    }
    if (!this.tool || e.pointerId !== this.tool.id) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (evs.length > 1) for (const ce of evs) this.tool.t.move(this.info(ce), this); else this.tool.t.move(this.info(e), this);
    this.request();
  }
  onUp(e, cancelled = false) {
    if (this.drag && e.pointerId === this.drag.id) { this.drag = null; this.follow(); return; }
    if (!this.tool || e.pointerId !== this.tool.id) return;
    const t = this.tool.t, info = this.info(e);
    this.tool = null;
    if (cancelled && t.cancel) t.cancel(this); else t.up(info, this);
    // 右の端まで書いたら自動で次へ
    if (t instanceof PenTool && !cancelled && info.px > this.W * 0.8) this.step(1);
    this.app.updateStatus();
    this.invalidate();
  }

  // ---- 描画
  render() {
    if (!this.open || !this.note || !this.page) return;
    const g = this.g, p = this.page, k = this.s * this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#3b3e44';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(k, 0, 0, k, -this.box.x * k, -this.box.y * k);
    g.save();
    g.beginPath(); g.rect(0, 0, p.w, p.h); g.clip();
    drawPaper(g, p, this.s);
    if (p.bg) { BgRender.draw(g, p); BgRender.want(p, k, [Math.max(0, this.box.x), Math.max(0, this.box.y), Math.min(p.w, this.box.x + this.box.w), Math.min(p.h, this.box.y + this.boxH)], 0); }
    drawImages(g, p, null, { screen: true });
    drawStrokes(g, p.strokes, [this.box.x, this.box.y, this.box.x + this.box.w, this.box.y + this.boxH], { minW: 0.8 / this.s });
    g.restore();
    // 自動で進む目安の線
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.strokeStyle = 'rgba(79,134,232,.45)'; g.setLineDash([6, 5]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(this.W * 0.8, 0); g.lineTo(this.W * 0.8, this.H); g.stroke(); g.setLineDash([]);
    if (this.tool && this.tool.t.drawOverlay) this.tool.t.drawOverlay(g, this);
  }
  /* 本体の画面に枠を描く */
  drawMarker(g, v) {
    if (!this.open || !this.page || !this.note.pages.includes(this.page)) return;
    v.withPage(g, this.page, (gg) => {
      gg.strokeStyle = '#3d7be0'; gg.lineWidth = 2 / v.s;
      gg.fillStyle = 'rgba(70,130,230,.07)';
      gg.fillRect(this.box.x, this.box.y, this.box.w, this.boxH);
      gg.strokeRect(this.box.x, this.box.y, this.box.w, this.boxH);
    });
  }
}
