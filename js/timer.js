'use strict';
/* タイマー: タイムキーパー（残り時間・予鈴・超過）・ストップウォッチ（ラップ）・ポモドーロ（作業と休憩をくり返す）と、終わりのアラーム。
   - 時刻は壁時計（Date.now）で持つ＝読み込み直し・画面を離れても進みがずれない。動いている物は localStorage `timer-run`、設定は `timer`、
     今日のポモドーロの数は `pomo-log`。
   - 音は Web Audio で作る（音のファイルは要らない）。iPad はタップの中でしか音を出し始められないので、スタートを押した時と
     タイマーがある間のタップで AudioContext を起こしておく。
   - iPad では紙工房を閉じている間・画面が消えている間は JS が止まって鳴らせない → 動いている間は画面を消さない（Wake Lock）。
     戻った時に過ぎていたら「◯分前に終わっていました」と知らせる（5 秒より遅れたら鳴らし続けない）。
   - 表示: 動いている間は小さな札（ドラッグで動かせる、タップで操作の小窓）。終わったら画面いっぱいのお知らせ。
     ポモドーロで「自動で次へ」の時は、短く鳴らしてトーストだけ（書いている手を止めない）。 */

const TIMER_DEFAULTS = {
  mode: 'timer',                 // 'timer' | 'stopwatch' | 'pomodoro'
  dur: 10 * 60000,               // タイマーの長さ（ms）
  warns: [],                     // 予鈴: 残り何分で鳴らすか
  overtime: true,                // 終わった後も超過を数える（タイムキーパー）
  pomo: { work: 25, short: 5, long: 15, every: 4, auto: true },
  sound: 'bell',                 // 'bell' | 'beep' | 'soft' | 'none'
  vol: 0.8,
  ring: 20,                      // 鳴らす秒数（0 = 止めるまで）
  awake: true,                   // 動いている間は画面を消さない
  chip: null,                    // 札の場所 {x, y}（ドラッグで動かした時）
};
const TIMER_MODES = { timer: 'タイマー', stopwatch: 'ストップウォッチ', pomodoro: 'ポモドーロ' };
const POMO_PHASES = { work: '作業', short: '休憩', long: '長い休憩' };
const TIMER_PRESETS = [1, 3, 5, 10, 15, 20, 30, 45, 60, 90];
const TIMER_WARNS = [10, 5, 3, 1];

/* 時間の表示: 1 時間以上は h:mm:ss。up=true は切り捨て（数え上げ）、false は切り上げ（残り） */
function tmFmt(ms, up = false, tenths = false) {
  ms = Math.max(0, ms);
  const s = up ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  const t = h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  return tenths ? t + '.' + Math.floor((ms % 1000) / 100) : t;
}
function tmToday() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

class Timer {
  constructor() {
    const c = loadJSON('timer', TIMER_DEFAULTS);
    c.pomo = { ...TIMER_DEFAULTS.pomo, ...(c.pomo || {}) };
    this.conf = c;
    const r = loadJSON('timer-run', {});
    this.run = r.mode ? r : null;
    this.ctx = null; this.out = null;
    this.lock = null; this.locking = false;
    this.panel = null; this.alarmEl = null; this.ringT = 0; this.iv = 0;
    this.buildChip();
    for (const id of ['#btn-timer', '#lib-timer']) { const b = $(id); if (b) b.addEventListener('click', () => this.openPanel()); }
    document.addEventListener('pointerdown', () => { if (this.run) this.unlockAudio(); }, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.tick(); this.awake(); });
    window.addEventListener('resize', () => this.placeChip());
    this.loop();
    this.tick();
  }
  saveConf() { saveJSON('timer', this.conf); }
  save() {
    if (this.run) saveJSON('timer-run', this.run);
    else { try { localStorage.removeItem(LS + 'timer-run'); } catch { /* */ } }
  }
  elapsed() { const r = this.run; return r ? r.acc + (r.running ? Date.now() - r.startAt : 0) : 0; }
  pomoCount() { const l = loadJSON('pomo-log', { d: '', n: 0 }); return l.d === tmToday() ? l.n : 0; }

  // ================= 操作
  fresh(mode) {
    const c = this.conf;
    if (mode === 'stopwatch') return { mode, running: false, startAt: 0, acc: 0, laps: [] };
    if (mode === 'pomodoro') return { mode, running: false, startAt: 0, acc: 0, phase: 'work', round: 1, target: c.pomo.work * 60000 };
    return { mode, running: false, startAt: 0, acc: 0, target: c.dur, fired: [], ended: false };
  }
  start(mode = this.conf.mode) {
    this.unlockAudio();
    if (!this.run || this.run.mode !== mode || (this.run.ended && !this.run.running)) this.run = this.fresh(mode);
    const r = this.run;
    if (!r.running) { r.running = true; r.startAt = Date.now(); }
    this.closeAlarm();
    this.save(); this.awake(); this.loop(); this.update();
  }
  pause() {
    const r = this.run;
    if (!r || !r.running) return;
    r.acc = this.elapsed(); r.running = false;
    this.save(); this.awake(); this.update();
  }
  toggle() { if (this.run && this.run.running) this.pause(); else this.start(this.run ? this.run.mode : this.conf.mode); }
  reset() { this.run = null; this.closeAlarm(); this.save(); this.awake(); this.update(); }
  lap() { const r = this.run; if (r && r.mode === 'stopwatch') { r.laps.push(this.elapsed()); this.save(); } }
  /* タイマーを延ばす（終わった後の「+1 分」も） */
  add(ms) {
    const r = this.run;
    if (!r || r.mode !== 'timer') return;
    r.target += ms;
    const left = r.target - this.elapsed();
    if (left > 0) { r.ended = false; r.fired = r.fired.filter((m) => left <= m * 60000); }
    if (!r.running && left > 0 && r.acc > 0) { r.running = true; r.startAt = Date.now(); }       // 超過を数えない設定で止まっていた
    this.closeAlarm();
    this.save(); this.awake(); this.loop(); this.update();
  }
  /* ポモドーロの次の段へ（count = 作業を 1 回と数える） */
  advance(count) {
    const r = this.run, p = this.conf.pomo;
    const was = r.phase;
    if (was === 'work') {
      if (count) { const n = this.pomoCount() + 1; saveJSON('pomo-log', { d: tmToday(), n }); }
      r.phase = r.round % p.every === 0 ? 'long' : 'short';
    } else { r.round = was === 'long' ? 1 : r.round + 1; r.phase = 'work'; }
    r.target = p[r.phase] * 60000;
    r.acc = 0;
    return was === 'work' ? (r.phase === 'long' ? '作業おわり。長い休憩です' : '作業おわり。ひと休みしましょう') : '休憩おわり。作業を始めましょう';
  }
  skip() {
    const r = this.run;
    if (!r || r.mode !== 'pomodoro') return;
    const running = r.running;
    this.advance(false);
    r.running = running; r.startAt = Date.now();
    this.save(); this.update();
  }

  // ================= 時を進める
  loop() {
    if (this.run && !this.iv) this.iv = setInterval(() => this.tick(), 200);
  }
  tick() {
    const r = this.run;
    if (!r) { clearInterval(this.iv); this.iv = 0; this.update(); return; }
    if (r.running && r.mode === 'timer') {
      const left = r.target - this.elapsed();
      const warns = this.conf.warns.filter((m) => m * 60000 < r.target).sort((a, b) => b - a);
      warns.forEach((m, i) => {
        if (left > m * 60000 || r.fired.includes(m) || left <= 0) return;
        r.fired.push(m);
        this.save();
        if (m * 60000 - left < 5000) { this.play(this.conf.sound, Math.min(3, i + 1)); toast(`残り ${m} 分です`, { ms: 4000 }); }
      });
      if (left <= 0 && !r.ended) {
        r.ended = true;
        if (!this.conf.overtime) { r.acc = r.target; r.running = false; }
        this.save(); this.awake();
        this.alarm({ title: '時間です', late: -left > 5000 ? -left : 0, kind: 'timer' });
      }
    } else if (r.running && r.mode === 'pomodoro') {
      const left = r.target - this.elapsed();
      if (left <= 0) {
        const endWall = Date.now() + left, late = -left > 5000;
        const msg = this.advance(true);
        const auto = this.conf.pomo.auto && !late;
        r.running = auto; r.startAt = auto ? endWall : 0;
        this.save(); this.awake();
        if (auto) { this.play(this.conf.sound, 2); toast(msg, { ms: 5000 }); }
        else this.alarm({ title: msg, late: late ? -left : 0, kind: 'pomo' });
      }
    }
    this.update();
  }

  // ================= 表示: 札
  buildChip() {
    const c = el('div', { class: 'tm-chip', hidden: true });
    this.cIc = el('span', { class: 'tm-ic' });
    this.cTime = el('span', { class: 'tm-time' });
    this.cSub = el('span', { class: 'tm-sub' });
    this.cBtn = el('button', { class: 'tm-pp', title: '一時停止・再開' });
    c.append(this.cIc, this.cTime, this.cSub, this.cBtn);
    this.cBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.cBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    let d = null;
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = c.getBoundingClientRect();
      d = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: r.left, oy: r.top, moved: false };
      try { c.setPointerCapture(e.pointerId); } catch { /* */ }
    });
    c.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 6) return;
      d.moved = true;
      this.conf.chip = { x: d.ox + dx, y: d.oy + dy };
      this.placeChip();
    });
    const up = (e) => {
      if (!d || e.pointerId !== d.id) return;
      const moved = d.moved;
      d = null;
      if (moved) this.saveConf(); else if (e.type === 'pointerup') this.openPanel();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    document.body.append(c);
    this.chip = c;
    this.placeChip();
  }
  placeChip() {
    const p = this.conf.chip, c = this.chip;
    if (!p) { c.style.left = c.style.top = ''; return; }
    const w = c.offsetWidth || 150, h = c.offsetHeight || 44;
    c.style.left = clamp(p.x, 4, innerWidth - w - 4) + 'px';
    c.style.top = clamp(p.y, 4, innerHeight - h - 4) + 'px';
  }
  /* いまの表示（札・小窓・お知らせ）。文字は変わった時だけ書く */
  view() {
    const r = this.run;
    if (!r) return null;
    const e = this.elapsed();
    if (r.mode === 'stopwatch') return { ic: '⏱', time: tmFmt(e, true), big: tmFmt(e, true, true), sub: r.laps.length ? `ラップ ${r.laps.length}` : '', over: false };
    const left = r.target - e;
    const time = left >= 0 ? tmFmt(left) : '+' + tmFmt(-left, true);
    if (r.mode === 'pomodoro') {
      return { ic: r.phase === 'work' ? '🍅' : '☕', time, big: time, over: false,
        sub: `${POMO_PHASES[r.phase]} ${r.phase === 'work' ? r.round + '/' + this.conf.pomo.every : ''}`.trim() };
    }
    return { ic: '⏲', time, big: time, sub: left < 0 ? '超過' : '', over: left < 0 };
  }
  update() {
    const r = this.run, v = this.view(), c = this.chip;
    c.hidden = !r;
    if (v) {
      const set = (n, t) => { if (n.textContent !== t) n.textContent = t; };
      set(this.cIc, v.ic); set(this.cTime, v.time); set(this.cSub, v.sub); set(this.cBtn, r.running ? '⏸' : '▶');
      const cls = 'tm-chip' + (r.running ? '' : ' paused') + (v.over ? ' over' : '') + (r.mode === 'pomodoro' ? ' ' + r.phase : '');
      if (c.className !== cls) { c.className = cls; this.placeChip(); }
    }
    for (const id of ['#btn-timer', '#lib-timer']) { const b = $(id); if (b) b.classList.toggle('on', !!r); }
    if (this.panel) this.panel.live();
    if (this.alarmEl) this.alarmEl.live();
  }

  // ================= 表示: 操作の小窓
  openPanel() {
    this.closePanel();
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: 'modal tm-panel' });
    back.append(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) this.closePanel(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closePanel(); });
    document.body.append(back);
    this.panel = { back, box, live: () => {} };
    this.renderPanel();
  }
  closePanel() { if (this.panel) { this.panel.back.remove(); this.panel = null; } }
  renderPanel() {
    const P = this.panel;
    if (!P || !P.back.isConnected) { this.panel = null; return; }
    const c = this.conf, r = this.run, mode = c.mode, mine = !!r && r.mode === mode;
    const box = P.box;
    box.innerHTML = '';
    const re = () => this.renderPanel();
    box.append(el('div', { class: 'tm-head' }, el('h2', {}, 'タイマー'), el('button', { class: 'ghost', onclick: () => this.closePanel() }, '✕')));
    box.append(el('div', { class: 'tm-tabs' }, ...[['timer', '⏲ タイマー'], ['stopwatch', '⏱ ストップウォッチ'], ['pomodoro', '🍅 ポモドーロ']]
      .map(([k, l]) => el('button', { class: k === mode ? 'on' : '', onclick: () => { c.mode = k; this.saveConf(); re(); } }, l))));
    if (r && !mine) box.append(el('p', { class: 'tm-note' }, `${TIMER_MODES[r.mode]}が動いています（${this.view().time}）。ここでスタートすると、そちらは終わります。`));

    const big = el('div', { class: 'tm-big' }), sub = el('div', { class: 'tm-bigsub' });
    box.append(big, sub);
    const lapList = el('div', { class: 'tm-laps' });
    P.live = () => {
      const run = this.run, now = mine && run === r ? this.view() : null;
      let b, s = '', over = false;
      if (mode === 'timer') {
        b = now ? now.big : tmFmt(c.dur);
        over = !!(now && now.over);
        if (now) {
          const left = run.target - this.elapsed();
          s = left < 0 ? `超過 ${tmFmt(-left, true)}` : run.running ? `終わり ${fmtDate(Date.now() + left).slice(11)}` : '一時停止中';
        }
      } else if (mode === 'stopwatch') {
        b = now ? now.big : '0:00.0';
        if (now && !run.running) s = '一時停止中';
      } else {
        const ph = now ? run.phase : 'work', rd = now ? run.round : 1;
        b = now ? now.big : tmFmt(c.pomo.work * 60000);
        s = `${now ? '' : 'これから '}${POMO_PHASES[ph]}${ph === 'work' ? `（${rd}/${c.pomo.every} 回目）` : ''}${now && !run.running ? '・一時停止中' : ''}　今日の 🍅 ${this.pomoCount()}`;
      }
      if (big.textContent !== b) big.textContent = b;
      if (sub.textContent !== s) sub.textContent = s;
      big.className = 'tm-big' + (over ? ' over' : '') + (mode === 'pomodoro' && now && run.phase !== 'work' ? ' rest' : '');
      if (mode === 'stopwatch' && now && lapList.childElementCount !== run.laps.length) {
        lapList.innerHTML = '';
        run.laps.map((t, i) => [i, t, t - (run.laps[i - 1] || 0)]).reverse()
          .forEach(([i, t, d]) => lapList.append(el('div', { class: 'tm-lap' }, el('span', {}, `ラップ ${i + 1}`), el('span', {}, tmFmt(d, true, true)), el('span', { class: 'muted' }, tmFmt(t, true, true)))));
      }
    };

    // ---- 操作のボタン
    const ctl = el('div', { class: 'tm-ctrl' });
    const btn = (label, fn, cls = '') => el('button', { class: cls, onclick: () => { fn(); re(); } }, label);
    if (mine && r.running) ctl.append(btn('一時停止', () => this.pause()));
    else ctl.append(btn(mine && r.acc > 0 && !r.ended ? '再開' : 'スタート', () => { if (!mine) this.run = null; this.start(mode); }, 'primary'));
    if (mine && mode === 'stopwatch' && r.running) ctl.append(btn('ラップ', () => this.lap()));
    if (mine && mode === 'timer') ctl.append(btn('+1 分', () => this.add(60000)), btn('+5 分', () => this.add(300000)));
    if (mine && mode === 'pomodoro') ctl.append(btn('次へ（スキップ）', () => this.skip()));
    if (mine) ctl.append(btn('リセット', () => this.reset(), 'danger'));
    box.append(ctl);

    // ---- それぞれの設定
    const num = (val, min, max, onset) => {
      const i = el('input', { type: 'number', min, max, step: 1, value: val, inputmode: 'numeric', class: 'tm-num' });
      i.addEventListener('change', () => { const v = clamp(Math.round(+i.value || 0), min, max); i.value = v; onset(v); this.saveConf(); P.live(); });
      return i;
    };
    const chk = (on, label, onset) => {
      const i = el('input', { type: 'checkbox', checked: !!on });
      i.addEventListener('change', () => { onset(i.checked); this.saveConf(); });
      return el('label', { class: 'row' }, i, ' ' + label);
    };
    const opts = el('div', { class: 'settings tm-opts' });
    if (mode === 'timer') {
      const later = mine ? '（いま動いているタイマーには「+1 分」「+5 分」を）' : '';
      opts.append(
        el('div', { class: 'field' }, '長さ' + later,
          el('div', { class: 'tm-presets' }, ...TIMER_PRESETS.map((m) => el('button', { class: 'small' + (c.dur === m * 60000 ? ' on' : ''),
            onclick: () => { c.dur = m * 60000; this.saveConf(); re(); } }, m + ' 分'))),
          el('div', { class: 'tm-custom' }, num(Math.floor(c.dur / 60000), 0, 999, (v) => { c.dur = v * 60000 + (c.dur % 60000); }), ' 分 ',
            num(Math.floor((c.dur % 60000) / 1000), 0, 59, (v) => { c.dur = Math.floor(c.dur / 60000) * 60000 + v * 1000; }), ' 秒')),
        el('div', { class: 'field' }, '予鈴（残りの時間で短く鳴らす。1 つ目は 1 回、2 つ目は 2 回…）',
          el('div', { class: 'tm-presets' }, ...TIMER_WARNS.map((m) => {
            const i = el('input', { type: 'checkbox', checked: c.warns.includes(m) });
            i.addEventListener('change', () => { c.warns = c.warns.filter((x) => x !== m).concat(i.checked ? [m] : []); this.saveConf(); });
            return el('label', { class: 'row tm-warn' }, i, ` 残り ${m} 分`);
          }))),
        chk(c.overtime, '終わった後も超過の時間を数える（タイムキーパー）', (v) => { c.overtime = v; }));
    } else if (mode === 'stopwatch') {
      opts.append(lapList);
    } else {
      const p = c.pomo;
      opts.append(
        el('div', { class: 'tm-pomo' },
          el('label', {}, '作業 ', num(p.work, 1, 180, (v) => { p.work = v; }), ' 分'),
          el('label', {}, '休憩 ', num(p.short, 1, 60, (v) => { p.short = v; }), ' 分'),
          el('label', {}, '長い休憩 ', num(p.long, 1, 120, (v) => { p.long = v; }), ' 分'),
          el('label', {}, num(p.every, 1, 12, (v) => { p.every = v; }), ' 回ごとに長い休憩')),
        chk(p.auto, '終わったら自動で次を始める（短く鳴らしてお知らせだけ）', (v) => { p.auto = v; }),
        el('p', { class: 'muted small' }, '長さを変えると、次の作業・休憩から使います。'));
    }
    box.append(opts);

    // ---- アラーム（音・音量・長さ・画面）
    const sound = el('select', {}, ...[['bell', 'チーン（ベル）'], ['beep', 'ピピピ（電子音）'], ['soft', 'ポロン（やさしい音）'], ['none', '鳴らさない']]
      .map(([v, l]) => el('option', { value: v, selected: c.sound === v }, l)));
    sound.addEventListener('change', () => { c.sound = sound.value; this.saveConf(); });
    const vol = el('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: c.vol, class: 'tm-vol' });
    vol.addEventListener('change', () => { c.vol = +vol.value; this.saveConf(); if (this.out) this.out.gain.value = c.vol; });
    const ring = el('select', {}, ...[[5, '5 秒'], [20, '20 秒'], [60, '1 分'], [0, '止めるまで']].map(([v, l]) => el('option', { value: v, selected: c.ring === v }, l)));
    ring.addEventListener('change', () => { c.ring = +ring.value; this.saveConf(); });
    const alarm = el('details', { class: 'tm-alarmset' }, el('summary', {}, '🔔 アラームの音と設定'),
      el('div', { class: 'settings' },
        el('div', { class: 'tm-row' }, el('span', {}, '音'), sound, el('button', { class: 'small', onclick: () => { this.unlockAudio(); this.play(c.sound, 3); } }, '試す')),
        el('div', { class: 'tm-row' }, el('span', {}, '音量'), vol),
        el('div', { class: 'tm-row' }, el('span', {}, '終わりに鳴らす長さ'), ring),
        chk(c.awake, '動いている間は画面を消さない', (v) => { c.awake = v; this.awake(); }),
        el('p', { class: 'muted small' }, 'iPad では、紙工房を閉じている間や画面が消えている間は鳴りません。その間に終わっていた時は、戻った時にお知らせします。')));
    box.append(alarm);
    P.live();
  }

  // ================= 終わりのお知らせ
  alarm({ title, late, kind }) {
    this.closeAlarm();
    const r = this.run;
    const sub = el('div', { class: 'tm-al-sub' });
    const btns = el('div', { class: 'tm-al-btns' });
    const b = (label, fn, cls = '') => btns.append(el('button', { class: cls, onclick: () => { fn(); if (this.panel) this.renderPanel(); } }, label));
    if (kind === 'timer') {
      b('+1 分', () => this.add(60000));
      b('+5 分', () => this.add(300000));
      b('リセット', () => this.reset());
      b(this.conf.overtime ? '止める（超過を数える）' : '止める', () => this.closeAlarm(), 'primary');
    } else {
      b('ここで終わる', () => this.reset());
      b(r.phase === 'work' ? '作業を始める' : '休憩を始める', () => this.start('pomodoro'), 'primary');
    }
    const box = el('div', { class: 'tm-al-box' }, el('div', { class: 'tm-al-ic' }, kind === 'timer' ? '⏰' : r.phase === 'work' ? '🍅' : '☕'),
      el('div', { class: 'tm-al-title' }, title), sub, btns);
    const ov = el('div', { class: 'tm-alarm' }, box);
    ov.live = () => {
      const run = this.run;
      let s = late ? `${tmFmt(late, true)} 前に終わっていました` : '';
      if (kind === 'timer' && run && run.mode === 'timer' && run.running) s = `超過 ${tmFmt(this.elapsed() - run.target, true)}` + (s ? '（' + s + '）' : '');
      if (sub.textContent !== s) sub.textContent = s;
    };
    this._alarmKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); this.closeAlarm(); } };
    document.addEventListener('keydown', this._alarmKey, true);
    document.body.append(ov);
    this.alarmEl = ov;
    ov.live();
    if (late) this.play(this.conf.sound, 1); else this.ring();
    if (this.panel) this.renderPanel();
  }
  closeAlarm() {
    this.stopRing();
    if (this.alarmEl) { this.alarmEl.remove(); this.alarmEl = null; }
    if (this._alarmKey) { document.removeEventListener('keydown', this._alarmKey, true); this._alarmKey = null; }
  }

  // ================= 音（Web Audio で作る）
  unlockAudio() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const s = this.ctx.createBufferSource();          // iPad: タップの中で一度鳴らすと、その後も鳴らせる
        s.buffer = this.ctx.createBuffer(1, 1, 22050);
        s.connect(this.ctx.destination);
        s.start(0);
      }
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    } catch { /* 音が出せなくても表示は動く */ }
  }
  newOut() {
    if (this.out) { try { this.out.disconnect(); } catch { /* */ } }
    this.out = this.ctx.createGain();
    this.out.gain.value = this.conf.vol;
    this.out.connect(this.ctx.destination);
  }
  /* kind の音を n 回分。かかる秒数を返す */
  play(kind, n = 1) {
    if (kind === 'none' || !this.ctx) return 0;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (!this.out) this.newOut();
    const g = this.ctx, t0 = g.currentTime + 0.02;
    const tone = (t, f, dur, type, amp, attack = 0.005) => {
      const o = g.createOscillator(), e = g.createGain();
      o.type = type; o.frequency.value = f;
      e.gain.setValueAtTime(0.0001, t);
      e.gain.exponentialRampToValueAtTime(amp, t + attack);
      e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(e); e.connect(this.out);
      o.start(t); o.stop(t + dur + 0.05);
    };
    let t = t0;
    for (let i = 0; i < n; i++) {
      if (kind === 'beep') {
        for (let k = 0; k < 3; k++) tone(t + k * 0.16, 2093, 0.1, 'square', 0.12, 0.003);
        t += 0.75;
      } else if (kind === 'soft') {
        [523.25, 659.25, 783.99].forEach((f, k) => tone(t + k * 0.16, f, 0.9, 'triangle', 0.32, 0.01));
        t += 1.0;
      } else {                           // ベル: 倍音を重ねて余韻を長く
        [[1, 0.5], [2.76, 0.18], [5.4, 0.08], [0.5, 0.12]].forEach(([k, a]) => tone(t, 1318.5 * k, 1.8 / Math.max(1, k * 0.6), 'sine', a));
        t += 0.55;
      }
    }
    return t - t0;
  }
  ring() {
    this.stopRing();
    const until = Date.now() + (this.conf.ring || 600) * 1000;      // 「止めるまで」も 10 分で止める
    const once = () => {
      if (Date.now() > until) { this.ringT = 0; return; }
      const sec = this.play(this.conf.sound, this.conf.sound === 'bell' ? 3 : 2);
      this.ringT = setTimeout(once, Math.max(1200, sec * 1000 + 900));
    };
    once();
  }
  stopRing() {
    clearTimeout(this.ringT); this.ringT = 0;
    if (this.ctx && this.out) this.newOut();          // 鳴っている途中の音も切る
  }

  // ================= 画面を消さない
  async awake() {
    const want = !!(this.conf.awake && this.run && this.run.running && !document.hidden);
    if (this.locking || !navigator.wakeLock) return;
    this.locking = true;
    try {
      if (want && !this.lock) {
        const l = await navigator.wakeLock.request('screen');
        l.addEventListener('release', () => { if (this.lock === l) this.lock = null; });
        this.lock = l;
      } else if (!want && this.lock) {
        const l = this.lock;
        this.lock = null;
        await l.release();
      }
    } catch { this.lock = null; } finally { this.locking = false; }
    const now = !!(this.conf.awake && this.run && this.run.running && !document.hidden);
    if (now !== want) this.awake();               // 待っている間に変わった
  }
}
