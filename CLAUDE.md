# 紙工房 Web（kamikobo-web）— iPad で使う手書きノート＋PDF アプリ

GoodNotes 相当（を超える）を目標にした、ブラウザで動く日本語のノート・PDF 書き込みアプリ。
姉妹: Windows の PDF 編集 exe「紙工房」（`../kamikobo/`）。PDF でやり取りする。
主な使い道は **iPad Air 13インチ（M4）＋ Apple Pencil**（Safari／ホーム画面に追加した PWA）。
公開は GitHub Pages（`aoisoranokanata-ops/kamikobo-web`、ブランチ main）。iPad はローカル HTML を開けないため。

## 方針
- **ビルドなし**。`index.html` ＋ `css/app.css` ＋ `js/*.js`（**普通の script、module にしない**）。
  各 js のトップレベル宣言はグローバルで共有される（index.html の読み込み順に注意）。
  外部ライブラリは PDF の読み書きだけ（フェーズ2: pdf.js・pdf-lib を `vendor/` に同梱。CDN に頼らずオフラインで動かす）。
- データは IndexedDB `kamikobo-web`。localStorage のキーは `kamikobo-web.` 始まり。
  Pages は他の PWA と同じオリジン → sw.js は**自分の接頭辞 `kamikobo-web-` のキャッシュだけ**消す・参照する。
- ファイルを直したら `sw.js` の VERSION と `js/util.js` の APP_VERSION を両方上げる。
- 開発サーバー: `python tools/devserver.py 8677`（no-store、tools/fixtures への PUT）。launch.json の `kamikobo-web`。
- CSS の先頭に `[hidden]{display:none!important}`。

## Web では出来ないこと（割り切り）
- Apple Pencil のダブルタップ・スクイーズは Safari に届かない → 画面のボタン・2本指/3本指タップで代用。
  筆圧・傾き・ホバー（M4 iPad Air は対応）は使う。
- 手書き文字の認識は Safari に API が無い → フェーズ6で AI（Claude、利用者の API キー）に読ませて検索できる文字にする。

## 設計の要点（フェーズ1: 基盤）
- **手書きはベクター**（点の列: x, y, 筆圧, 時刻）。なげなわで動かす・拡大してもにじまない・PDF にベクターで出せる・
  無限キャンバスが軽い。座標は**ページの pt**（1pt = 1/72 inch、A4 = 595×842）。無限キャンバスは原点の無い 1 枚のページ。
- 本棚: items（フォルダとノート、`parent` で入れ子＝サブフォルダは何段でも）。ゴミ箱は `trashed`。
  ノート = ページ id の並び。ページは pages（用紙・大きさ・回転・線）に 1 ページ 1 レコードで保存（書いたページだけ書き直す）。
- 表示: 文書の空間にページを縦に並べ（間 24pt）、画面 = 文書 × 拡大・回転・移動。下地の canvas（用紙と確定した線）は
  表示が変わった時だけ描き直し、上の canvas（描いている線・なげなわ・選択・ホバー）は毎回。
- ページの回転（0/90/180/270）は「表示の向き」。線は回転前のページ座標で持つ（PDF と同じ考え方）。
- 線の形: ボールペン＝一定の太さの滑らかな線、万年筆・筆ペン＝筆圧で太さが変わる（点ごとの円＋つなぎの台形を 1 つの Path2D で塗る
  ＝半透明でも重なりが濃くならない）。蛍光ペン＝半透明・乗算、ペンの線の下に描く。Path2D は線ごとにキャッシュ。
- 消しゴム: 線ごと消す／部分消し（当たった点を抜いて線を分ける）。なげなわ: 囲んだ線（点の半分以上が中）を選び、
  移動・拡大縮小・回転・色・複製・コピー・切り取り・削除。
- 履歴はノートごと: 「ページ・消えた線・増えた線」の組（取り消し＝入れ替え）。ページの追加・削除・並べ替え・回転も履歴に入る。
- ジェスチャー: 2本指でつまむ＝拡大縮小・移動（設定で回転も）、2本指タップ＝設定で「元に戻す」か「消しゴムに切り替え」、
  3本指タップ＝やり直し（2本指が消しゴムのときは元に戻す）。Apple Pencil を使うと「指では描かない」（1本指＝スクロール）に自動で切り替わる。

## 設計の要点（フェーズ2: PDF・画像）
- 部品は `vendor/`: pdf.js 3.11.174（UMD の `pdf.min.js`＋worker、cmaps・standard_fonts）、pdf-lib 1.17.1。必要になった時に `Lib` が読み込む。
  sw.js は vendor も全部最初にキャッシュする（オフラインで日本語 PDF を開くため）。
- PDF のページ = 下地 `bg:{src, page, vt}`。ページの座標は pdf.js の表示座標（scale 1、PDF 自身の /Rotate 込み）、`vt` はその行列。
  中身は blobs `src|…`（ArrayBuffer）。どのページからも使われなくなった src はゴミ箱を空にした時に `Store.gcBlobs` が消す。
- 下地の描画 `BgRender`: ページ全体（長い辺 2400px まで、合計 36M px で古い物から捨てる）＋拡大時は見えている所だけ細かく（止まって 220ms 後）。
  捨てる時に canvas を縮めない（小さな絵を作る途中で使っていることがある＝白くなる不具合があった）。
- PDF の文字はページの `text`、保存は別の store `texts`（本棚の文字検索で全ページを読まずに済む）。当たった所の四角形は pdf.js の textContent から作る（`PdfText.findPolys`）。
- 画像はページの `images:[{id, src, x, y, w, h, rot}]`（JPEG/PNG・長い辺 3000px に直して保存）。用紙 → PDF 下地 → 画像 → 蛍光ペン → ペンの順に重ねる。
  なげなわで線と一緒に選べる（タップで画像 1 枚）。履歴は `swapBoth`。消しゴムは画像を消さない。
- PDF 書き出し（`exportPdf`）: 下地は元の PDF から copyPages（文字も選べる・同じ文書はまとめて写す）、`page.node.normalize()` で元の中身を q…Q で包み、
  自前の content stream を足す（`vt` の逆行列で表示座標→PDF 座標）。線はベクター（ボールペン・蛍光ペン＝なぞる、万年筆・筆＝外形の多角形を塗る）、
  蛍光ペンは ExtGState の Multiply。用紙の罫線もベクター、見出しの日本語だけ小さな画像。回転は元の /Rotate ＋ ページの rot。暗号化 PDF は画像で代用。
- バックアップ `.kmkw`: 先頭 8 バイト `KMKWEB1`＋改行 ＋ヘッダ長＋JSON＋中身（線の点 Float32・PDF・画像）。復元はいつも「追加」（id を付け直す、本棚まるごとは「復元 日付」フォルダへ）。
- 共有は iPad の共有シートが「押した時」にしか開けないので、作り終えてから「共有…」ボタンを押してもらう（`offerFile`）。

## 設計の要点（フェーズ3: 編集を強く）
- ページに置く物は全部 `page.images`（kind 無し＝画像、`text`＝文字・付箋（bg 付き）、`stamp`、`link`）。なげなわ・履歴（swapBoth）・
  拡大縮小（文字は size も）を画像と共通にした。`imageRecord` は _ で始まるキャッシュ以外を全部写す。
- 文字の道具（js/objects.js）: タップ＝新しい文字／既存の文字を直す、横ドラッグ＝幅。入力は本物の textarea（iPad のスクリブルが使える）を
  文字の上に重ね、確定は「キャンバスに触れた・道具を変えた・閉じた・Esc・完了」。折り返しは canvas で字ごと（英単語は語ごと・句読点はぶら下げ）。
- PDF 書き出しでは文字・付箋・スタンプは 4 倍の画像（日本語フォントを埋め込まないため。PDF の中では文字として選べない）。リンクは Link 注釈、しおりは PDF の目次。
- 検索用の文字は texts の `obj`（置いた文字・スタンプ）。本棚・ノート内検索とも text と obj を合わせて探す。
- 図形補正（js/shapes.js）: 書いたまま 520ms 止める（3px 以内の手ぶれは止まったまま）→ 直線・矢印・円/楕円・三角・四角・5〜8 角形。角は点を 2 回入れて丸まらないように。
- 定規（js/ruler.js）は画面の座標。1本指（ペン・マウスは真ん中）で移動、2本目の指で回転（15° に吸い付く）。縁の近くで書き始めた線は縁に投影。
- 拡大窓（js/zoomwin.js）: 自前の小さな view（toScreen・withPage・s など）を持ち、本体のペン・蛍光ペン・消しゴムをそのまま使う。
  80% の線を越えて書いたら右へ、右端なら次の行。指でドラッグ＝枠を動かす、本体を指でタップ＝枠をそこへ。倍率は本体の 2.5 倍から。
- レーザーは over canvas に描くだけ（保存しない・0.9 秒で消える）。リンクは指（手のひら）のタップでたどる。

## 設計の要点（フェーズ4: テンプレート集）
- js/templates.js。用紙は「描く物の並び」（`Lay`: text・lines・rect とリンクの場所）で作り、`drawLayout` で canvas にも PdfCtx（PDF）にも描く。
  `templateLayout(pg, pc)` が種類・色・大きさ・年月日をキーにキャッシュ。paper.js の drawPaper の default から呼ぶ。
- 勉強・仕事（PAPER_TYPES の cat:'study'）: コーネル・勉強ノート・議事録・ToDo・習慣トラッカー・2 段・絵コンテ・原稿用紙。
- プランナー（cat:'planner'、一覧には出さない）: paper = {type:'p-year'|'p-month'|'p-week'|'p-day', y, m, d}。週は月曜はじまり・ISO 週番号。
  祝日は `jpHolidays`（振替休日・国民の休日、春分・秋分は計算式）。`buildPlanner` が全ページを作り、レイアウトのリンクの場所に
  見えないリンク（kind:'link', hidden:true）を置く（行き先の日ページが無ければその週へ）。なげなわは hidden を選ばない。
  PDF に書き出すと Link 注釈になる。PdfCtx の文字の画像は「字・フォント・色」が同じなら 1 回だけ埋め込む（431 ページで約 8MB・11 秒）。
- 自作テンプレート `MyTemplates`: 一覧は localStorage `templates`、中身は blobs（gcBlobs が消さないよう一覧の src も残す）。
  PDF からは 1 ページ 1 テンプレート（`bg.tpl = true`。ページを足すと同じ下地が付く）、画像からは paper {type:'image', src}
  （PDF では PdfCtx.drawPaperImage で差し込む）。
- 表紙: item.cover = {style:'plain'|'stripe'|'dots'|'band'|'grad'|'image', color, img(dataURL 360×480)}。本棚のカードは CSS で描く（color-mix を使う）。

## 設計の要点（フェーズ5: 録音）
- js/recorder.js。録音はノートの `item.recordings`（{id, src, name, type, created, dur, segs:[{wall, audio}], transcript:[{t, text}]}）、音声は blobs。
  MediaRecorder（iPad は audio/mp4）、1 秒ごとの断片をためて 60 秒ごと・画面を離れた時にも保存（落ちても残る）。一時停止は segs で区切る。
- 同期: 線の t0（書いた時計の時刻）と点ごとの ms → `wallOf(rec, 音声の位置)` で「今の時刻」。下地はまだ書いていない線を薄く（鍵は書き終えた線の数）、
  上の canvas に書いている途中の線を少しずつ光らせて描く。再生中に線を指でタップ → その線を書いた 0.8 秒前から。別のページの線になったら自動でめくる。
- 文字起こしは Web Speech（ja-JP、continuous、止まったら自動で再開）。マイクからの同時だけ（録音ファイルを後から文字にはできない）。
  許可が無い・対応していない時は録音だけ続ける。検索用に texts に `rec|<id>` の記録（ノート内・本棚の検索で 🎙 として出る）。
- gcBlobs は items の録音の src も残す。完全に削除すると録音の texts も消す。バックアップ・複製は録音ごと。

## 設計の要点（フェーズ6: AI）
- js/ai.js。公式 SDK（@anthropic-ai/sdk 1.3.0）を esbuild で IIFE にして `vendor/anthropic-sdk.min.js`（window.Anthropic）。
  `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })` でブラウザから直接。キーは localStorage `kamikobo-web.ai` だけ（設定で消せる）。
  SDK を更新する時は同じ手順でビルドし直す（`import Anthropic from '@anthropic-ai/sdk'; window.Anthropic = Anthropic;` を `--format=iife --platform=browser --target=safari16`）。
- モデルは既定 `claude-opus-5-5`（設定で Sonnet 5.5・Haiku 5.5 も選べる）。thinking は付けない（Opus 5.5 は常に adaptive）、
  `output_config.effort`（要約・質問・カード・整理 = medium、手書き = low）。Opus/Sonnet は `fallbacks: 'default'`（beta `server-side-fallback-2026-07-01`）。
  `client.beta.messages.stream(...).finalMessage()`、`stop_reason === 'refusal'` を先に見る。JSON は `output_config.format = {type:'json_schema', schema}`。
  `cache_control: {type:'ephemeral'}`（質問の続きはノート部分がキャッシュから）。例外は SDK の型で日本語に（aiError）。
- 送る物（noteContent）: ページごとに PDF の文字・置いた文字・読み取った手書き（文字）＋手書き/画像のあるページの絵（JPEG 長辺 1568px、最大 20 枚）＋録音の文字起こし。
- 手書き→文字: 手書きの線だけを白地に描いて書いた範囲を切り出した PNG → 行ごとの {text, box(0〜1000)} → ページの座標に戻して page.hw = {text, lines, sig}。
  sig（線の数と最初/最後の id）が変わったら「まだのページ」。検索（ノート内は行の位置に色、本棚は texts の hw）で見つかる。
- 暗記カード: item.cards = [{id, q, a, page, box, due}]、ライトナー式（箱 0〜5、間隔 0/1/3/7/16/35 日）。TSV で書き出し。
- 整理: 題名と区切りのページの見出し → 題名の変更・見出しをしおりに（取り消せる）。
- 使った金額の目安を月ごとに数える（usage × 料金表）。初めて使う時に「送られる」ことの同意を取る。

## フェーズ
1. **基盤**（済）: 本棚（フォルダ・サブフォルダ・移動・名前・色・ゴミ箱・並べ替え・題名検索）・ノート（用紙テンプレート・大きさ・向き・紙の色）・
   無限キャンバス・ペン 3 種＋蛍光ペン・消しゴム 2 種・なげなわ・ページの追加/削除/並べ替え/回転・ジェスチャー・Pencil 優先・自動保存・PWA
2. **PDF・画像**（済）: PDF を読み込んで書き込む（pdf.js）・PDF の文字の検索・ページの結合/分割/抽出・PDF 書き出し（pdf-lib、手書きはベクター）・
   画像の貼り付け・共有（ファイル・AirDrop）・バックアップと復元
3. **編集を強く**（済）: テキスト（日本語）・図形の自動補正（書いて止める）・定規・付箋・スタンプ・レーザーポインター・拡大窓・しおり・リンク
4. **テンプレート集**（済）: プランナー（年・月・週・日、ページ間リンク）・議事録・コーネル・習慣トラッカー・原稿用紙・自作テンプレート（PDF/画像から）・表紙
5. **録音**（済）: 録音と書き込みの同期再生（書いた時刻の線が光る）・文字起こし（Web Speech）・録音の検索
6. **AI**（済）: Claude（利用者の API キー）で要約・質問・手書き→文字（検索できる）・暗記カード・ノートの整理
