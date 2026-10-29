'use strict';
/* 録音と同期再生。
   録音 = ノートの item.recordings に {id, src(blobs のキー), name, type, created, dur(ms), segs:[{wall, audio}], transcript:[{t(ms), text}]}。
   segs は「時計の時刻 wall のとき音声の位置は audio」の対応（一時停止で区切る）。線は書いた時刻 t0（時計）を持つので、
   再生中の音声の位置 → 時計の時刻 → その時刻までに書いた線、が分かる。
   文字起こしは Web Speech（マイクから。録音しながらだけ。後から録音ファイルを文字にはできない）。 */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
}
/* 音声の位置 ⇔ 時計の時刻 */
function wallOf(rec, pos) {
  const segs = rec.segs && rec.segs.length ? rec.segs : [{ wall: rec.created, audio: 0 }];
  let s = segs[0];
  for (const x of segs) if (x.audio <= pos) s = x;
  return s.wall + (pos - s.audio);
}
function audioOf(rec, wall) {
  const segs = rec.segs && rec.segs.length ? rec.segs : [{ wall: rec.created, audio: 0 }];
  let best = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], next = segs[i + 1];
    const end = next ? s.wall + (next.audio - s.audio) : s.wall + (rec.dur - s.audio);
    if (wall >= s.wall && wall <= end) return s.audio + (wall - s.wall);
    if (wall > end) best = next ? next.audio : rec.dur;         // 一時停止の間に書いた線 → 再開した所
  }
  return best == null ? 0 : best;
}
function recText(rec) { return (rec.transcript || []).map((x) => x.text).join(' '); }
/* 検索用の記録（録音ごと） */
function recTextRecs(item) {
  return (item.recordings || []).map((r) => ({ pageId: 'rec|' + r.id, noteId: item.id, text: [r.name, recText(r)].join('\n'), obj: '' }));
}

// ================= 録音
class Recorder {
  constructor(app) { this.app = app; this.rec = null; this.mr = null; this.chunks = []; this.state = 'idle'; this.recog = null; this._tick = 0; }
  get active() { return this.state !== 'idle'; }
  pickType() {
    for (const t of ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t; } catch { /* */ }
    }
    return '';
  }
  /* 今の音声の位置（ms） */
  pos() {
    if (!this.rec) return 0;
    const last = this.rec.segs[this.rec.segs.length - 1];
    return this.state === 'recording' ? last.audio + (Date.now() - last.wall) : this._pausedAt || 0;
  }
  async start() {
    const n = this.app.note;
    if (!n || this.active) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('このブラウザは録音に対応していません', { error: true }); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast('マイクを使えません（設定でマイクを許可してください）: ' + (e.message || e.name), { error: true, ms: 6000 }); return; }
    const type = this.pickType();
    this.stream = stream;
    this.mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined);
    this.chunks = [];
    const now = Date.now();
    this.rec = { id: uid('r'), src: 'src|' + uid('a'), name: `録音 ${fmtDate(now).slice(5)}`, type: this.mr.mimeType || type || 'audio/mp4',
      created: now, dur: 0, segs: [{ wall: now, audio: 0 }], transcript: [] };
    this.note = n;
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start(1000);
    this.state = 'recording';
    if (this.app.settings.transcribe) this.startRecog();
    this._tick = setInterval(() => this.onTick(), 500);
    this._autosave = setInterval(() => this.persist(false), 60000);       // 落ちても 1 分前までは残る
    this.app.showRecBar();
  }
  onTick() { this.app.updateRecBar(); }
  pause() {
    if (this.state !== 'recording') return;
    this._pausedAt = this.pos();
    this.mr.pause();
    this.state = 'paused';
    this.stopRecog();
    this.app.updateRecBar();
  }
  resume() {
    if (this.state !== 'paused') return;
    this.rec.segs.push({ wall: Date.now(), audio: this._pausedAt });
    this.mr.resume();
    this.state = 'recording';
    if (this.app.settings.transcribe) this.startRecog();
    this.app.updateRecBar();
  }
  async stop() {
    if (!this.active) return null;
    clearInterval(this._tick); clearInterval(this._autosave);
    this.rec.dur = this.pos();
    this.stopRecog();
    const done = new Promise((res) => { this.mr.onstop = res; });
    try { this.mr.stop(); } catch { /* */ }
    await Promise.race([done, new Promise((r) => setTimeout(r, 2500))]);
    for (const t of this.stream.getTracks()) t.stop();
    this.state = 'idle';
    const rec = this.rec;
    await this.persist(true);
    this.rec = null; this.mr = null; this.chunks = [];
    this.app.hideRecBar();
    toast(`「${rec.name}」を保存しました（${fmtClock(rec.dur)}）`);
    return rec;
  }
  /* 今までの音声を保存し、ノートの録音の一覧に入れる */
  async persist(final) {
    const rec = this.rec, item = this.note && this.note.item;
    if (!rec || !item || !this.chunks.length) return;
    if (!final) rec.dur = this.pos();
    try {
      const data = await new Blob(this.chunks, { type: rec.type }).arrayBuffer();
      await Store.putBlob(rec.src, { type: rec.type, name: rec.name, data });
      const list = (item.recordings || []).filter((r) => r.id !== rec.id);
      item.recordings = list.concat([{ ...rec, transcript: rec.transcript.slice(), segs: rec.segs.slice() }]);
      item.updated = Date.now();
      await Store.saveNote(item, [], [], recTextRecs(item));
      if (this.app.note && this.app.note.item === item) this.app.refreshRecPanel();
    } catch (e) { toast('録音を保存できませんでした: ' + (e.message || e), { error: true }); }
  }

  // ---- 文字起こし（Web Speech）
  startRecog() {
    if (!SpeechRec) { if (!this._warned) { this._warned = true; toast('このブラウザは文字起こしに対応していません（録音は続けます）'); } return; }
    if (this.recog) return;
    const r = new SpeechRec();
    r.lang = 'ja-JP'; r.continuous = true; r.interimResults = true;
    this.recog = r;
    let startAt = null;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (startAt == null) startAt = Math.max(0, this.pos() - 1500);
        if (res.isFinal) {
          const text = res[0].transcript.trim();
          if (text) this.rec.transcript.push({ t: startAt, text });
          startAt = null;
        } else interim += res[0].transcript;
      }
      this.interim = interim;
      this.app.updateRecBar();
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { toast('文字起こしが許可されていません（iPad の「設定」→ Siri・音声入力を確認）', { error: true, ms: 6000 }); this._deny = true; }
    };
    r.onend = () => {
      this.recog = null;
      if (this.state === 'recording' && !this._deny) setTimeout(() => { if (this.state === 'recording') this.startRecog(); }, 300);    // 止まっても続ける
    };
    try { r.start(); } catch { this.recog = null; }
  }
  stopRecog() {
    const r = this.recog;
    this.recog = null;
    this.interim = '';
    if (r) { r.onend = null; try { r.stop(); } catch { /* */ } }
  }
}

// ================= 再生（線と同期）
class Player {
  constructor(app) { this.app = app; this.rec = null; this.audio = null; this.sync = true; this.index = []; this._raf = 0; this._ver = -1; }
  get open() { return !!this.rec; }
  async play(rec, at = 0) {
    this.close(true);
    const v = await Src.get(rec.src).catch(() => null);
    if (!v) { toast('録音のデータが見つかりません', { error: true }); return; }
    this.rec = rec;
    this.url = URL.createObjectURL(new Blob([v.data], { type: v.type || rec.type }));
    const a = new Audio();
    a.src = this.url;
    a.preload = 'auto';
    a.playbackRate = this.rate || 1;
    this.audio = a;
    a.addEventListener('ended', () => this.app.updatePlayBar());
    a.addEventListener('pause', () => this.app.updatePlayBar());
    a.addEventListener('play', () => { this.app.updatePlayBar(); this.loop(); });
    a.addEventListener('loadedmetadata', () => { if (isFinite(a.duration) && a.duration > 0 && !rec.dur) rec.dur = a.duration * 1000; this.app.updatePlayBar(); });
    this.buildIndex();
    this.app.showPlayBar();
    this.seek(at);
    try { await a.play(); } catch { /* iPad: 押してから再生 */ }
    this.app.view.invalidate();
  }
  close(quiet = false) {
    if (!this.rec) return;
    if (this.audio) { this.audio.pause(); this.audio.src = ''; }
    if (this.url) URL.revokeObjectURL(this.url);
    this.rec = null; this.audio = null; this.index = [];
    if (!quiet) { this.app.hidePlayBar(); this.app.view.invalidate(); }
  }
  toggle() { if (!this.audio) return; if (this.audio.paused) this.audio.play().catch(() => {}); else this.audio.pause(); }
  seek(ms) { if (this.audio) { this.audio.currentTime = Math.max(0, ms / 1000); this.app.updatePlayBar(); this.app.view.invalidate(); } }
  skip(sec) { if (this.audio) this.seek(this.audio.currentTime * 1000 + sec * 1000); }
  setRate(r) { this.rate = r; if (this.audio) this.audio.playbackRate = r; this.app.updatePlayBar(); }
  posMs() { return this.audio ? this.audio.currentTime * 1000 : 0; }
  at() { return wallOf(this.rec, this.posMs()); }
  /* 録音している間に書いた線の一覧（書き始めの順） */
  buildIndex() {
    const n = this.app.note, rec = this.rec;
    this.index = [];
    if (!n || !rec) return;
    const w0 = wallOf(rec, 0) - 500, w1 = wallOf(rec, rec.dur || 0) + 500;
    for (const p of n.pages) for (const s of p.strokes) {
      if (!s.t0 || s.t0 < w0 || s.t0 > w1) continue;
      const pts = s.pts, last = pts.length ? pts[pts.length - 1] : 0;
      this.index.push({ s, p, t0: s.t0, t1: s.t0 + last });
    }
    this.index.sort((a, b) => a.t0 - b.t0);
    this._ver = n.version;
  }
  /* 今の時刻で「まだ書いていない」線の数（下地の描き直しの鍵） */
  baseKey() {
    if (!this.rec || !this.sync) return '';
    if (this.app.note && this.app.note.version !== this._ver) this.buildIndex();
    const at = this.at();
    let k = 0;
    while (k < this.index.length && this.index[k].t1 <= at) k++;
    return 'pb' + k;
  }
  /* 下地: まだ書いていない線・書いている途中の線は薄く */
  isFuture(s) {
    if (!this.rec || !this.sync || !s.t0) return false;
    const at = this.at();
    if (s.t0 < wallOf(this.rec, 0) - 500 || s.t0 > wallOf(this.rec, this.rec.dur || 0) + 500) return false;
    const pts = s.pts, last = pts.length ? pts[pts.length - 1] : 0;
    return s.t0 + last > at;
  }
  loop() {
    if (this._raf) return;
    const step = () => {
      this._raf = 0;
      if (!this.audio || this.audio.paused) { this.app.view.request(); return; }
      this.app.updatePlayBar();
      this.follow();
      this.app.view.request();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  /* 書いている途中の線のページが見えていなければ、そこへめくる */
  follow() {
    if (!this.sync || this.app.view.pointers.size) return;
    const at = this.at();
    const cur = this.index.find((x) => x.t0 <= at && x.t1 >= at);
    if (!cur || cur === this._lastFollow) return;
    this._lastFollow = cur;
    const n = this.app.note, i = n.pageIndex(cur.p);
    if (i >= 0 && !n.board && i !== this.app.view.currentPageIndex()) { this.app.view.goToPage(i); this.app.updateStatus(); }
  }
  /* 上の canvas: 書いている途中の線を少しずつ・書き終えたばかりの線を光らせて */
  drawOverlay(g, v) {
    if (!this.rec || !this.sync) return;
    const at = this.at();
    for (const x of this.index) {
      if (x.t0 > at) break;
      const s = x.s, pts = s.pts;
      let part = null;
      if (x.t1 > at) {           // 書いている途中
        let k = 0;
        while (k < pts.length / 4 && x.t0 + pts[k * 4 + 3] <= at) k++;
        if (k < 1) continue;
        part = { ...s, _path: null, _bb: null, pts: pts.subarray(0, k * 4) };
      } else if (at - x.t1 > 1200) continue;
      v.withPage(g, x.p, (gg) => {
        gg.save();
        gg.shadowColor = 'rgba(255,170,30,.95)';
        gg.shadowBlur = 10 * v.dpr;
        drawStroke(gg, part || s, { noMultiply: true });
        gg.restore();
      });
    }
  }
  /* 線をタップ → その線を書いた所から再生 */
  seekToStroke(page, q, r) {
    const hit = this.index.filter((x) => x.p === page && strokeHit(x.s, q.x, q.y, r)).pop();
    if (!hit) return false;
    this.seek(Math.max(0, audioOf(this.rec, hit.t0) - 800));
    if (this.audio.paused) this.audio.play().catch(() => {});
    return true;
  }
}
