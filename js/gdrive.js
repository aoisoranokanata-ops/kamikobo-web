'use strict';
/* Google Drive: バックアップ（本棚まるごと・書き出したファイル）と読み込み（PDF・画像・.kmkw、Google ドキュメントは PDF にして）。
   ライブラリは使わず、OAuth 2.0（トークンだけの流れ）＋ Drive REST v3 を fetch で直接呼ぶ。
   - クライアント ID は利用者が Google Cloud で作って設定に貼る（GDRIVE_CLIENT_ID に書いておけば全端末で使える）。
   - サインイン: Safari のタブでは小窓、ホーム画面アプリ（standalone）・小窓が開けない時はこのページごと Google へ移り oauth.html で戻る。
     トークンは localStorage `gdrive-token`（1 時間で切れる。切れたら次に使う時にまたサインイン＝login_hint でほぼ 1 タップ）。
     ページごと移った時は、戻ってから resume() がやりかけの事を続ける（保存しかけのファイルは blobs の 'tmp|gdrive' に置いておく）。
   - 権限: drive.file（紙工房が作ったファイルの読み書き）＋ drive.readonly（ドライブの PDF・画像を読む）。
   - 保存先はマイドライブの「紙工房 Web」フォルダ（無ければ作る）。 */

const GDRIVE_CLIENT_ID = '';
const GDRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';
const GDRIVE_FOLDER = '紙工房 Web';
const GDRIVE_API = 'https://www.googleapis.com/drive/v3';
const GDRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const GDRIVE_TMP = 'tmp|gdrive';
const GD_ICON = { folder: '📁', pdf: '📄', image: '🖼', kmkw: '🗂', gdoc: '📝' };

function gdKind(f) {
  const m = f.mimeType || '', n = f.name || '';
  if (m === GDRIVE_FOLDER_MIME) return 'folder';
  if (/\.kmkw$/i.test(n)) return 'kmkw';
  if (m === 'application/pdf' || /\.pdf$/i.test(n)) return 'pdf';
  if (/^image\//.test(m) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(n)) return 'image';
  if (/^application\/vnd\.google-apps\.(document|spreadsheet|presentation|drawing)$/.test(m)) return 'gdoc';
  return '';
}
const gdEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

const GDrive = {
  // ---- 設定・トークン
  conf() { return loadJSON('gdrive', { clientId: '', email: '', folderId: '', lastBackup: 0 }); },
  setConf(patch) { saveJSON('gdrive', { ...this.conf(), ...patch }); },
  clientId() { return (this.conf().clientId || GDRIVE_CLIENT_ID || '').trim(); },
  configured() { return !!this.clientId(); },
  redirectUri() { return new URL('oauth.html', location.href).href; },
  token() { const t = loadJSON('gdrive-token', {}); return t.token && t.exp > Date.now() + 60000 ? t.token : null; },
  dropToken() { try { localStorage.removeItem(LS + 'gdrive-token'); } catch { /* */ } },
  standalone() { return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); },
  authError(code) { return code === 'access_denied' ? 'Google Drive へのアクセスが許可されませんでした' : `Google にサインインできませんでした（${code || '不明'}）`; },

  /* クリックの中で呼ぶ（小窓はクリックの中でしか開けない）。サインインが要れば済ませてから r の事をする */
  async go(app, r) {
    if (!this.configured()) { await this.setupDialog(); return; }
    try {
      if (!this.token()) await this.signIn(app, r);
      await this.act(app, r);
    } catch (e) { if (e && e.message !== 'cancel') toast(e.message || String(e), { error: true, ms: 6000 }); }
  },
  async act(app, r) {
    switch (r.kind) {
      case 'backup': return this.backupNow(app);
      case 'restore': return this.restoreDialog(app);
      case 'import': { const f = await this.pick(); if (f.length) await app.importFiles(f); return; }
      case 'insert-image': {
        if (!app.note) return;
        const f = await this.pick({ kinds: ['image'], title: 'Google Drive の画像を貼る' });
        if (f.length) await app.insertImages(f);
        return;
      }
      case 'insert-pdf': {
        if (!app.note || app.note.board) return;
        const f = await this.pick({ kinds: ['pdf', 'gdoc'], multiple: false, title: 'Google Drive の PDF を後ろに挿入' });
        if (f.length) await app.insertPdf(f[0]);
        return;
      }
      case 'upload': return r.blob && this.saveFile(r.blob, r.name);
    }
  },

  async signIn(app, r = null) {
    const state = uid('s');
    const q = new URLSearchParams({ client_id: this.clientId(), redirect_uri: this.redirectUri(), response_type: 'token',
      scope: GDRIVE_SCOPES, include_granted_scopes: 'true', state });
    const email = this.conf().email;
    if (email) q.set('login_hint', email);
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
    if (!this.standalone()) {
      saveJSON('gdrive-auth', { state, at: Date.now(), mode: 'popup' });
      const w = window.open(url, 'kamikobo-gauth', 'width=520,height=700');
      if (w) { await this.waitToken(state); await this.afterSignIn(); return; }
    }
    // ページごと Google へ（ホーム画面アプリ・小窓が開けない時）。戻ったら resume() が続きをする
    const keep = r ? { ...r, blob: undefined } : null;
    if (r && r.blob) { await Store.putBlob(GDRIVE_TMP, { type: r.blob.type, name: r.name, data: await r.blob.arrayBuffer() }); keep.stashed = true; }
    if (app) await app.saveNote(true);
    saveJSON('gdrive-auth', { state, at: Date.now(), mode: 'redirect', resume: keep });
    location.href = url;
    await new Promise(() => {});          // ページを離れるのでここで止まる
  },
  /* 小窓の oauth.html が localStorage に置くトークンを待つ（Google の画面を通ると opener が切れることがあるので postMessage には頼らない） */
  waitToken(state) {
    return new Promise((res, rej) => {
      const back = el('div', { class: 'modal-back' }, el('div', { class: 'modal' }, el('h2', {}, 'Google にサインイン'),
        el('p', { class: 'muted' }, '開いた画面で Google アカウントを選び、Google Drive へのアクセスを許可してください。'),
        el('div', { class: 'modal-buttons' }, el('button', { onclick: () => done(rej, new Error('cancel')) }, 'やめる'))));
      document.body.append(back);
      const check = () => {
        const t = loadJSON('gdrive-token', {});
        if (t.state !== state) return;
        if (t.token) done(res, t.token); else done(rej, new Error(this.authError(t.error)));
      };
      const onMsg = (e) => { if (e.origin === location.origin && e.data && e.data.kamikoboGauth) check(); };
      const iv = setInterval(check, 500);
      addEventListener('message', onMsg);
      addEventListener('storage', check);
      function done(f, v) { clearInterval(iv); removeEventListener('message', onMsg); removeEventListener('storage', check); back.remove(); f(v); }
    });
  },
  async afterSignIn() {
    const t = loadJSON('gdrive-token', {});
    if (t.scope && !t.scope.includes('drive.file') && !/auth\/drive(\s|$)/.test(t.scope)) {
      this.dropToken();
      throw new Error('Google Drive へのアクセスが許可されていません。サインインの画面で Google Drive のチェックを入れてください');
    }
    try {
      const a = await this.json('/about?fields=user(emailAddress)');
      const mail = a.user && a.user.emailAddress;
      if (mail && mail !== this.conf().email) this.setConf({ email: mail, folderId: '' });
    } catch { /* メールが分からなくても使える */ }
  },
  /* 起動時: ページごとサインインして戻ってきたら、やりかけの事を続ける */
  async resume(app) {
    const a = loadJSON('gdrive-auth', {});
    if (a.mode !== 'redirect' || !a.state) return;
    try { localStorage.removeItem(LS + 'gdrive-auth'); } catch { /* */ }
    const t = loadJSON('gdrive-token', {});
    const r = a.resume || {};
    let blob = null;
    if (r.stashed) {
      const v = await Store.getBlob(GDRIVE_TMP);
      await Store.delBlob(GDRIVE_TMP);
      if (v) blob = new Blob([v.data], { type: v.type });
    }
    if (t.state !== a.state || Date.now() - a.at > 30 * 60000) return;
    if (!t.token) { toast(this.authError(t.error), { error: true, ms: 6000 }); return; }
    try {
      await this.afterSignIn();
      if (!r.kind) { toast('Google にサインインしました'); return; }
      await this.act(app, { ...r, blob });
    } catch (e) { toast(e.message || String(e), { error: true, ms: 6000 }); }
  },
  async signOut() {
    const t = this.token();
    this.dropToken();
    this.setConf({ email: '', folderId: '' });
    if (t) {
      try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch { /* */ }
    }
  },

  // ---- Drive API
  async api(url, opt = {}) {
    const token = this.token();
    if (!token) throw new Error('Google のサインインが切れました。もう一度押してください');
    const res = await fetch(url.startsWith('http') ? url : GDRIVE_API + url, { ...opt, headers: { Authorization: 'Bearer ' + token, ...(opt.headers || {}) } });
    if (res.status === 401) { this.dropToken(); throw new Error('Google のサインインが切れました。もう一度押してください'); }
    if (!res.ok) {
      let m = '';
      try { const j = await res.json(); m = j.error && j.error.message; } catch { /* */ }
      throw new Error(`Google Drive: ${m || res.status}`);
    }
    return res;
  },
  async json(url, opt) { return (await this.api(url, opt)).json(); },
  async list(q, opt = {}) {
    const p = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)', pageSize: '200',
      orderBy: opt.orderBy || 'folder,name_natural', spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (opt.pageToken) p.set('pageToken', opt.pageToken);
    return this.json('/files?' + p);
  },
  /* 保存先「紙工房 Web」フォルダ（id は覚えておく。消されていたら探す・作る） */
  async folder() {
    const c = this.conf();
    if (c.folderId) {
      try { const f = await this.json(`/files/${encodeURIComponent(c.folderId)}?fields=id,trashed`); if (!f.trashed) return f.id; } catch (e) { if (!this.token()) throw e; }
    }
    const q = `name='${gdEsc(GDRIVE_FOLDER)}' and mimeType='${GDRIVE_FOLDER_MIME}' and 'root' in parents and trashed=false`;
    const r = await this.json('/files?' + new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' }));
    let id = r.files[0] && r.files[0].id;
    if (!id) {
      id = (await this.json('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: GDRIVE_FOLDER, mimeType: GDRIVE_FOLDER_MIME, parents: ['root'] }) })).id;
    }
    this.setConf({ folderId: id });
    return id;
  },
  /* 「紙工房 Web」フォルダへ送る（再開できる形のアップロード。送り先が受け取れない時は 1 回でまとめて送る） */
  async upload(blob, name, onProgress) {
    const parent = await this.folder();
    const type = blob.type || 'application/octet-stream';
    const meta = JSON.stringify({ name, parents: [parent], mimeType: type });
    const res = await this.api(GDRIVE_UPLOAD + '/files?uploadType=resumable&fields=id,name', {
      method: 'POST', body: meta,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) } });
    const loc = res.headers.get('Location');
    if (loc) return this.xhr('PUT', loc, blob, { 'Content-Type': type }, onProgress);
    const b = 'kamikobo' + Math.random().toString(36).slice(2);
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`]);
    return this.xhr('POST', GDRIVE_UPLOAD + '/files?uploadType=multipart&fields=id,name', body,
      { 'Content-Type': 'multipart/related; boundary=' + b, Authorization: 'Bearer ' + this.token() }, onProgress);
  },
  xhr(method, url, body, headers, onProgress) {          // fetch では送る進み具合が分からないので
    return new Promise((ok, ng) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) { try { ok(JSON.parse(x.responseText)); } catch { ok({}); } }
        else ng(new Error(`Google Drive: 送れませんでした（${x.status}）`));
      };
      x.onerror = () => ng(new Error('Google Drive: 通信できませんでした'));
      x.send(body);
    });
  },
  /* ファイルを受け取って File に（Google ドキュメントなどは PDF にして） */
  async download(f, onProgress) {
    const gdoc = gdKind(f) === 'gdoc';
    const res = await this.api(gdoc ? `/files/${encodeURIComponent(f.id)}/export?mimeType=application%2Fpdf`
      : `/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`);
    const type = gdoc ? 'application/pdf' : (f.mimeType || res.headers.get('Content-Type') || '');
    const name = gdoc ? f.name + '.pdf' : f.name;
    const total = +f.size || +res.headers.get('Content-Length') || 0;
    if (!res.body || !res.body.getReader) return new File([await res.blob()], name, { type });
    const rd = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value);
      got += value.byteLength;
      if (onProgress) onProgress(got, total);
    }
    return new File(parts, name, { type });
  },
  async fetchFiles(list) {
    const out = [];
    const pr = progressBox('Google Drive から受け取っています');
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        pr.set(i, list.length, f.name);
        try {
          out.push(await this.download(f, (g, t) => pr.set(i + (t ? g / t : 0), list.length, `${f.name}　${fmtSize(g)}${t ? ' / ' + fmtSize(t) : ''}`)));
        } catch (e) {
          if (!this.token()) throw e;
          toast(`${f.name}: ${e.message || e}`, { error: true, ms: 6000 });
        }
      }
    } finally { pr.close(); }
    return out;
  },

  // ---- 画面
  async backupNow(app) {
    closeModals();
    await app.saveNote(true);
    const pr = progressBox('Google Drive にバックアップしています');
    try {
      pr.set(0, 0, 'バックアップを作っています…');
      const blob = await buildBackup(null, 'library');
      const name = `紙工房バックアップ_${fmtDate(Date.now()).replace(/\//g, '').replace(' ', '_').replace(':', '')}.kmkw`;
      await this.upload(blob, name, (i, n) => pr.set(i, n, `送っています ${fmtSize(i)} / ${fmtSize(n)}`));
      this.setConf({ lastBackup: Date.now() });
      toast(`Google Drive の「${GDRIVE_FOLDER}」に保存しました（${fmtSize(blob.size)}）`, { ms: 4000 });
    } finally { pr.close(); }
  },
  async saveFile(blob, name) {
    const pr = progressBox('Google Drive に保存しています');
    try {
      await this.upload(blob, name, (i, n) => pr.set(i, n, `${fmtSize(i)} / ${fmtSize(n)}`));
      toast(`Google Drive の「${GDRIVE_FOLDER}」に保存しました`, { ms: 4000 });
    } finally { pr.close(); }
  },
  /* 「紙工房 Web」フォルダのバックアップ（.kmkw）の一覧: 復元・削除 */
  async restoreDialog(app) {
    closeModals();
    const box = el('div', { class: 'gd-backups' }, el('p', { class: 'muted' }, '読み込み中…'));
    modal('Google Drive のバックアップ', box, [{ label: '閉じる', value: null }], { wide: true });
    try {
      const folder = await this.folder();
      const r = await this.list(`'${gdEsc(folder)}' in parents and trashed=false`, { orderBy: 'modifiedTime desc' });
      const files = r.files.filter((f) => gdKind(f) === 'kmkw');
      box.innerHTML = '';
      if (!files.length) box.append(el('p', { class: 'muted' }, `マイドライブの「${GDRIVE_FOLDER}」フォルダにバックアップがありません。`));
      for (const f of files) {
        const row = el('div', { class: 'gd-backup' },
          el('span', { class: 'gd-ic' }, GD_ICON.kmkw),
          el('span', { class: 'gd-name' }, f.name, el('br'), el('span', { class: 'gd-meta' }, `${fmtDate(Date.parse(f.modifiedTime))}　${fmtSize(+f.size || 0)}`)),
          el('button', { class: 'small primary', onclick: async () => {
            closeModals();
            try {
              const got = await this.fetchFiles([f]);
              if (got.length) await app.importFiles(got);
            } catch (e) { toast(e.message || String(e), { error: true, ms: 6000 }); }
          } }, '復元'),
          el('button', { class: 'small danger', onclick: async () => {
            if (!await confirmBox('バックアップを削除', `「${f.name}」を Google Drive のゴミ箱へ移します。`, '削除', true)) return;
            try {
              await this.api(`/files/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
              row.remove();
            } catch (e) { toast(e.message || String(e), { error: true, ms: 6000 }); }
          } }, '削除'));
        box.append(row);
      }
      box.append(el('p', { class: 'muted small' }, '復元はいつも「追加」です（今の本棚は消えません）。本棚まるごとのバックアップは「復元 日付」フォルダに入ります。'
        + 'ほかの場所の .kmkw は「＋ 新規 → Google Drive から読み込む」で選べます。'));
    } catch (e) { box.innerHTML = ''; box.append(el('p', { class: 'muted' }, e.message || String(e))); }
  },
  /* ドライブのファイルを選んでもらい、受け取った File の配列を返す。kinds: 'pdf' 'image' 'kmkw' 'gdoc' */
  async pick(opt = {}) {
    closeModals();
    const kinds = opt.kinds || ['pdf', 'image', 'kmkw', 'gdoc'];
    const multiple = opt.multiple !== false;
    const scope = loadJSON('gdrive-token', {}).scope || '';
    const sel = new Map();
    const TABS = [['my', 'マイドライブ'], ['shared', '共有アイテム'], ['recent', '最近'], ['app', GDRIVE_FOLDER]];
    let tab = 'my', stack = [{ id: 'root', name: 'マイドライブ' }], query = '', next = null, seq = 0;
    const tabRow = el('div', { class: 'gd-tabs' });
    const search = el('input', { type: 'search', placeholder: '名前で検索', autocomplete: 'off' });
    const crumbs = el('div', { class: 'gd-crumbs' });
    const list = el('div', { class: 'gd-list' });
    const foot = el('div', { class: 'muted small gd-foot' });
    const drawFoot = () => { foot.textContent = sel.size ? `${sel.size} 個を選んでいます` : 'ファイルをタップして選びます' + (multiple ? '（いくつでも）' : ''); };
    const drawTabs = () => {
      tabRow.innerHTML = '';
      for (const [k, label] of TABS) tabRow.append(el('button', { class: 'small' + (k === tab && !query ? ' on' : ''), onclick: () => openTab(k) }, label));
    };
    const drawCrumbs = () => {
      crumbs.innerHTML = '';
      if (query) { crumbs.append(el('span', {}, `「${query}」の検索結果`)); return; }
      stack.forEach((f, i) => {
        if (i) crumbs.append(el('span', { class: 'crumb-sep' }, '›'));
        crumbs.append(el('button', { class: 'crumb' + (i === stack.length - 1 ? ' cur' : ''), onclick: () => { stack = stack.slice(0, i + 1); load(); } }, f.name));
      });
    };
    const openTab = async (k) => {
      tab = k; query = ''; search.value = '';
      if (k === 'my') stack = [{ id: 'root', name: 'マイドライブ' }];
      else if (k === 'shared') stack = [{ id: ':shared', name: '共有アイテム' }];
      else if (k === 'recent') stack = [{ id: ':recent', name: '最近' }];
      else {
        try { stack = [{ id: await this.folder(), name: GDRIVE_FOLDER }]; } catch (e) { toast(e.message || String(e), { error: true }); return; }
      }
      load();
    };
    const row = (f) => {
      const k = gdKind(f);
      const meta = k === 'folder' ? '' : [f.modifiedTime ? fmtDate(Date.parse(f.modifiedTime)).slice(0, 10) : '', f.size ? fmtSize(+f.size) : ''].filter(Boolean).join('　');
      const b = el('button', { class: 'gd-row' + (sel.has(f.id) ? ' on' : '') },
        el('span', { class: 'gd-ic' }, GD_ICON[k]), el('span', { class: 'gd-name' }, f.name), el('span', { class: 'gd-meta' }, k === 'gdoc' ? 'PDF にして ' + meta : meta));
      b.addEventListener('click', () => {
        if (k === 'folder') { stack.push({ id: f.id, name: f.name }); query = ''; search.value = ''; load(); return; }
        if (sel.has(f.id)) sel.delete(f.id);
        else {
          if (!multiple) { sel.clear(); for (const x of $$('.gd-row.on', list)) x.classList.remove('on'); }
          sel.set(f.id, f);
        }
        b.classList.toggle('on', sel.has(f.id));
        drawFoot();
      });
      return b;
    };
    const load = async (more = false) => {
      const my = ++seq;
      drawTabs(); drawCrumbs();
      if (!more) { list.innerHTML = ''; list.scrollTop = 0; }
      const wait = el('div', { class: 'muted gd-wait' }, '読み込み中…');
      list.append(wait);
      const top = stack[stack.length - 1];
      let q, orderBy;
      if (query) { q = `name contains '${gdEsc(query)}' and trashed=false`; orderBy = 'modifiedTime desc'; }
      else if (top.id === ':shared') { q = 'sharedWithMe=true and trashed=false'; orderBy = 'sharedWithMeTime desc'; }
      else if (top.id === ':recent') { q = `mimeType!='${GDRIVE_FOLDER_MIME}' and trashed=false`; orderBy = 'recency desc'; }
      else { q = `'${gdEsc(top.id)}' in parents and trashed=false`; orderBy = 'folder,name_natural'; }
      try {
        const r = await this.list(q, { orderBy, pageToken: more ? next : null });
        if (my !== seq) return;
        wait.remove();
        for (const f of r.files) { const k = gdKind(f); if (k === 'folder' || kinds.includes(k)) list.append(row(f)); }
        next = r.nextPageToken || null;
        if (next) list.append(el('button', { class: 'small gd-more', onclick: (e) => { e.currentTarget.remove(); load(true); } }, 'もっと見る'));
        else if (!list.querySelector('.gd-row')) list.append(el('div', { class: 'muted gd-wait' }, 'ここには読み込めるファイルがありません'));
      } catch (e) { if (my === seq) wait.textContent = e.message || String(e); }
    };
    const searchSoon = debounce(() => { query = search.value.trim(); load(); }, 450);
    search.addEventListener('input', searchSoon);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); searchSoon.flush(); } });
    const names = { pdf: 'PDF', image: '画像', kmkw: '紙工房ファイル（.kmkw）', gdoc: 'Google ドキュメント・スプレッドシート・スライド（PDF にして）' };
    const body = el('div', { class: 'gd-pick' },
      el('div', { class: 'gd-top' }, tabRow, search), crumbs, list, foot,
      el('p', { class: 'muted small' }, '表示するのはフォルダと ' + kinds.map((k) => names[k]).join('・') + ' だけです。'),
      scope && !scope.includes('drive.readonly') && !/auth\/drive(\s|$)/.test(scope)
        ? el('p', { class: 'muted small' }, 'ドライブ全体を読む許可が無いため、紙工房が作ったファイルだけが見えます（設定でサインアウトし、もう一度サインインして許可のチェックを入れてください）。') : null);
    drawFoot();
    const p = modal(opt.title || 'Google Drive から読み込む', body, [{ label: 'キャンセル', value: null },
      { label: '読み込む', primary: true, value: 'ok', check: () => sel.size > 0 || (toast('ファイルを選んでください'), false) }], { wide: true, noFocus: true });
    load();
    const v = await p;
    seq++;
    if (v !== 'ok' || !sel.size) return [];
    return this.fetchFiles([...sel.values()]);
  },
  /* クライアント ID の設定（作り方つき）。保存したら true */
  async setupDialog() {
    const inp = el('input', { type: 'text', class: 'wide', value: this.conf().clientId || GDRIVE_CLIENT_ID, placeholder: '123456789-xxxx.apps.googleusercontent.com',
      autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const ro = (v) => el('input', { type: 'text', class: 'wide', readonly: true, value: v, onfocus: (e) => e.target.select() });
    const body = el('div', { class: 'settings gd-setup' },
      el('p', {}, 'Google Drive を使うには、Google Cloud で「OAuth クライアント ID」を 1 つ作って下に貼ります（無料・最初の 1 回だけ）。'),
      el('ol', {},
        el('li', {}, 'console.cloud.google.com を開いて、プロジェクトを作る'),
        el('li', {}, '「API とサービス」→「ライブラリ」で「Google Drive API」を有効にする'),
        el('li', {}, '「OAuth 同意画面」で「外部」を選び、アプリ名（例: 紙工房 Web）を入れ、「テストユーザー」に自分の Gmail を追加する'),
        el('li', {}, '「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」で、次の 2 つを登録する',
          el('div', { class: 'muted small' }, '承認済みの JavaScript 生成元'), ro(location.origin),
          el('div', { class: 'muted small' }, '承認済みのリダイレクト URI'), ro(this.redirectUri())),
        el('li', {}, 'できた「クライアント ID」を下に貼る')),
      el('label', { class: 'field' }, 'クライアント ID', inp),
      el('p', { class: 'muted small' }, 'サインインで「このアプリは Google で確認されていません」と出たら「続行」を押します（自分で作ったアプリのため）。'
        + '許可の画面では Google Drive の項目にチェックを入れてください。'));
    const ok = (s) => !s || /\.apps\.googleusercontent\.com$/.test(s);
    const v = await modal('Google Drive の設定', body, [{ label: 'キャンセル', value: null },
      { label: '保存', primary: true, value: () => inp.value.trim(), check: () => ok(inp.value.trim()) || (toast('「….apps.googleusercontent.com」の形の ID を貼ってください', { error: true }), false) }],
    { wide: true, noFocus: true });
    if (v == null) return false;
    if (v !== this.conf().clientId) { this.dropToken(); this.setConf({ clientId: v, folderId: '' }); }
    toast(this.configured() ? 'Google Drive を使えるようにしました' : 'Google Drive の設定を消しました');
    return true;
  },
  /* 設定の画面の「Google Drive」の欄 */
  settingsSection(app) {
    const reopen = () => { closeModals(); app.settingsDialog(); };
    if (!this.configured()) {
      return el('div', {},
        el('div', { class: 'row-buttons' }, el('button', { onclick: async () => { if (await this.setupDialog()) reopen(); } }, 'Google Drive を使えるようにする…')),
        el('span', { class: 'muted small' }, 'バックアップを Google Drive に置いたり、ドライブの PDF・画像・.kmkw を読み込んだりできます。'));
    }
    const c = this.conf();
    const who = this.token() ? `サインイン中${c.email ? '（' + c.email + '）' : ''}` : c.email ? `${c.email}（使う時にサインインします）` : 'まだサインインしていません（使う時にサインインします）';
    return el('div', {},
      el('div', { class: 'row-buttons' },
        el('button', { onclick: () => this.go(app, { kind: 'backup' }) }, '☁️ Google Drive にバックアップ'),
        el('button', { onclick: () => this.go(app, { kind: 'restore' }) }, 'Google Drive のバックアップから復元…'),
        el('button', { onclick: () => this.go(app, { kind: 'import' }) }, 'Google Drive から読み込む…')),
      el('span', { class: 'muted small' }, `${who}　最後のバックアップ: ${c.lastBackup ? fmtDate(c.lastBackup) : 'まだ'}　保存先: マイドライブの「${GDRIVE_FOLDER}」`),
      el('div', { class: 'row-buttons' },
        el('button', { class: 'small', onclick: async () => { if (await this.setupDialog()) reopen(); } }, 'クライアント ID…'),
        c.email || this.token() ? el('button', { class: 'small', onclick: async () => { await this.signOut(); reopen(); toast('サインアウトしました'); } }, 'サインアウト') : null));
  },
};
