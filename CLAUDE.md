# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code (claude.ai/code) への指針です。**簡潔さを保つため、決定事項の詳細な経緯・過去の不具合修正のストーリーは`CLAUDE_HISTORY.md`に分離してある**（本ファイルは毎ターン自動読み込みされるため）。ある挙動を変更する前に「過去に同じ変更が一往復していないか」「なぜ今の実装になっているか」を確認したい場合は、該当キーワードで`CLAUDE_HISTORY.md`をgrepしてから読むこと。

## プロジェクト概要

**SGBusNavi** — Willoaブランドの新規アプリ。SG在住Naviとは別プロジェクトとして独立させるが、デザインシステム(柳グリーン系配色・カードUI・PWA構成)は完全踏襲する。

- **ブランド**: Willoaの一環(SG在住Naviの姉妹アプリという位置づけ)
- **ドメイン**: `bus.willoa.net`(willoa.netのサブドメイン)
- **プロジェクトパス**: `/home/masahiko/sg-bus-navi/`
- **対象ユーザー**: シンガポール在住者全員(日本人限定ではない)
- **UI言語**: 英語のみ(i18n機構は導入しない)。ユーザー向け文字列は英語で書く。サーバーログ・コードコメントは日本語で良い

## 開発コマンド

- 起動: `npm start`（`node server.js`）、開発時ホットリロード: `npm run dev`
- ポート: `.env`の`PORT`（デフォルト3010）。ローカル確認: `http://localhost:3010`
- 本番: PM2プロセス名`sg-bus-navi`（VPS上、`bus.willoa.net`にnginx経由で公開）。動作確認は別ポート（例: `PORT=3099 node server.js`）で一時起動して行い、本番PM2再起動（`pm2 restart sg-bus-navi`）はユーザー承認後に実施する
- **必須ルール: `public/`配下のファイルを1つでも変更したら、対象がPRECACHE_URLS掲載の有無に関わらず必ず`public/sw.js`の`CACHE_VERSION`をインクリメントする**。Service Workerのcache-first戦略は`/api/*`以外の同一オリジンGET全てに適用されるため、上げ忘れると訪問済みユーザーに変更が反映されない（詳細経緯: `CLAUDE_HISTORY.md`「開発コマンド」節）
- PWA更新は`public/js/app.js`の`controllerchange`リスナー（新SW有効化時に自動リロード）+ `visibilitychange`時の`registration.update()`（iOSホーム画面PWAは`load`イベントが発火しないケースがあるため）でカバー済み。それでも反映されない端末は、ホーム画面アイコン削除→Safariで再アクセス→再度ホーム画面に追加で解消する（SW登録がゼロから作り直される）

## コアコンセプト

「一目でわかる」を最優先。日常利用でタップ操作を極力発生させない。

既存のバスアプリ(SingBus等)は系統番号ごとの時刻表型UIで、見たい情報にたどり着くまでの確認項目が多い。本アプリはGPSで自動検出したバス停の情報をカード形式でそのまま表示し、探す・選ぶ操作を排除する。

## データソース

- **LTA DataMall** (`https://datamall.lta.gov.sg`) 公式・無料API。ベースURL: `https://datamall2.mytransport.sg/ltaodataservice/`。認証は全エンドポイント共通でリクエストヘッダー`AccountKey`
  - `v3/BusArrival`(旧`BusArrivalv2`は404。**`v3/`が必要なのはこのAPIのみの特例**、他は無印パス): バス停コード指定でリアルタイム到着時刻取得。`OriginCode`/`DestinationCode`は`Services[]`直下ではなく`NextBus`/`NextBus2`/`NextBus3`配下にのみ存在。`DestinationCode`は`BusStops`の`BusStopCode`と直接突き合わせ可能(解決率100%)。**`Direction`フィールドはこのAPIに存在しない**。`EstimatedArrival`は同一の実バスでもポーリングごとに数十秒〜1分変動するため、到着インスタンスの同一性判定には完全一致ではなく「系統番号・起点(OriginCode)が同じ中で最も時刻が近いものを同一実体とみなす近似マッチング(許容誤差3分)」が必要(`matchArrivalAcrossPolls()`)
  - `BusStops`: バス停マスタ。`BusStopCode`/`RoadName`/`Description`/`Latitude`/`Longitude`。全5,207件
  - `BusServices`: 系統マスタ。`ServiceNo`/`Operator`/`Direction`(数値1/2)/`Category`/`OriginCode`/`DestinationCode`/`LoopDesc`等。全801件。同一`ServiceNo`で`Direction`違いの複数レコードあり。`LoopDesc`が非空なら循環路線(全体の約32%)。`Category`はBusRoutesには存在しない
  - `BusRoutes`: 系統の経由停留所情報。`ServiceNo`/`Direction`/`StopSequence`/`BusStopCode`/`Distance`等。全26,823件(`data/bus-routes.json`約2.27MB)。**`StopSequence`には欠番がある**(配列インデックス=StopSequenceという前提を置かないこと)。`direction`不明時はBusArrivalの`OriginCode`/`DestinationCode`とBusServicesの`origin`/`destination`を突き合わせて判定(フロント側2回fetch方式、`public/js/app.js`)。**同一`ServiceNo`でもDirection1/2で経由する`BusStopCode`は基本的に別物**
  - `Train Service Alerts`: MRT運行障害情報。レスポンスの`value`は配列ではなく単一オブジェクト。`Status:1`(平常)でも`Message`に計画工事等の案内が入りうるため、`Status`だけでなく`Message`内容の種別判定が必要。**現状未実装**(このAPIの仕様調査のみ済み。CLAUDE.md画面構成節の「MRT運行障害バナー」は未実装機能として記述、2026-09-20判明)
  - サーバー側レート制限は2段構成: `/api/bus-arrival`のみ30リクエスト/分(`busArrivalLimiter`)、実際にLTAへ問い合わせるのはこのエンドポイントだけ。`/api/bus-routes/*`・`/api/bus-stops/*`・`/api/bus-services/*`はインメモリキャッシュのみで完結し300リクエスト/分(`generalApiLimiter`)
  - `/api/bus-routes/contains-stop`は方向だけでなく`fromStopCode`（現在地）指定時は「そのStopSequence以降か」も判定する(`isAheadMatch()`)。目的地一致ハイライトが「すでに通過済みの逆方向」を誤って一致扱いしないための仕組み
  - MRT路線色マッピング(`server.js`の`MRT_STATION_LINES`/`MRT_LINE_COLORS`)はLTA非提供の自作静的データ(公式路線図の配色を元に手動作成)。乗換駅は配列先頭を代表路線として簡略化。誤り・抜けがあれば直接修正する

## 画面構成

### メイン画面(ホーム、フェーズ6で地図+Timetableビュー追加)

1. GPSで現在地から最寄りのバス停を自動検出し、即座に表示(バス停選択の操作なし)
2. 横スワイプ・ピル行タップ・地図上のピンタップのいずれでも近傍バス停に切替(`buildStopPillRow()`/`switchToStopIndex()`/`renderHomeMapPins()`内のマーカークリック、3手段とも共通の`switchToStopIndex()`に集約され全て同期する)。近傍バス停取得件数`NEARBY_LIMIT`=5(反対方向のバス停も別エントリのため、上限`NEARBY_MAX_LIMIT`=10)。ピルは`${BusStopCode} ${Description}`形式で番号を前に表示。バス停切替時はアクティブピルが`scrollIntoView`で常に表示範囲内に入る。**ピル行(`#stop-pill-row`)はヘッダーではなく地図パネルの直下に配置**(2026-09-20ユーザー指示「バス停の横スクロールは地図の下にもってきてください」、ヘッダーはタイトル+「関連のみ」フィルターのみの1行に縮小)
3. ヘッダー右上に「関連のみ」トグル(星アイコン)。ONで登録済み目的地行きの系統のみ絞り込み表示。Arrivals/Timetable両ビューに共通適用され、ビュー切替をまたいでも状態は保持される(セッション内のみ、永続化はしない)
4. MRT運行障害バナー: **未実装**(データソース節参照)。実装時は画面最上部・`.app-header`より上に配置する想定
5. `#screen-home`は`height:100dvh; overflow:hidden;`の4段構成: `.app-header`(flex-shrink:0、タイトル「Home」+「関連のみ」フィルターのみ)→`.home-map-panel`(flex-shrink:0、地図。Arrivals/Timetable切替ボタンを内部に浮遊配置、下記7参照)→`#stop-pill-row`(flex-shrink:0、バス停ピル行)→`#home-scroll-content`(flex:1, overflow-y:auto、カード一覧またはTimetableテーブル)。ボトムナビ分の余白は`padding-bottom: calc(84px + env(safe-area-inset-bottom))`で統一(固定84pxだとセーフエリア込みの実高さに対して不足し、スクロール最下部のカードがボトムナビに隠れる)
6. **地図パネル(`.home-map-panel`、`height:28%; min-height:170px;`)**: 現在地(青丸、`--current-location-blue`、20px)+周辺バス停ピン(最大`NEARBY_LIMIT`件、`nearbyStops`をそのまま流用・別APIは叩かない)をLeafletで表示。バス停ピンは20px/border4px(2026-09-20ユーザー指示「バス停はもう少し印を大きくして目立たせて」により13px/border3pxから拡大、JS側`iconSize`もCSSと同じ値に揃える)。タイル・グレースケールCSSフィルター(`grayscale(0.92) brightness(1.4) saturate(0.25) contrast(0.85)` opacity 0.88)は経路モーダルの`.route-modal-map-el`と完全に同一の値を`.home-map-el`に適用し一貫性を保つ。選択中バス停のピンのみ常時ラベル表示、非選択ピンはドットのみ(密集回避)。GPS未確定・`/api/bus-stops/nearby`失敗・Leaflet未読み込み(`window.L === 'undefined'`)のいずれでも`.home-map-fallback`にフォールバックし、下部のビュー切替・カード一覧・テーブルの動作は妨げない(`ensureHomeMap()`/`renderHomeMapPins()`/`showHomeMapFallback()`)
7. **Arrivals/Timetable切替(`#home-view-flip`)**: 当初は地図直下の専用行(横幅いっぱいの帯)だったが、2026-09-20ユーザー指示「Time<>Arrivalのふりっぷは場所を取りたくない」により、**地図パネル右下隅に浮かせる円形フローティングボタン**(46px、`position:absolute`、`.home-map-panel`内、地図の高さ自体は変えずレイアウトフロー外で完結)に変更した。タップのたびにアイコンが180度回転し現在のビューを示す(テキストラベルはDOM上に残すがsr-only化、`aria-label`で代替)。初期表示はTimetableビュー。選択状態は`sgbusnavi_home_view`(localStorage、値`'timetable'`/`'arrivals'`)に永続化し次回起動時も復元する(`toggleHomeView()`/`initHomeViewFlip()`、DOM位置に依存せずid参照のみのためレイアウト変更の影響を受けない)
8. **Timetableビュー(`#home-timetable-list`、`.tt-row`)**: `/api/bus-arrival`の生の`Services[]`(フラット化前、`NextBus`/`NextBus2`/`NextBus3`をそのまま3列として使う)を系統番号1行のテーブルとして表示。系統番号の自然順(`compareServiceNumbers()`、`localeCompare`の`numeric:true`)でソートし、到着時刻順にはしない(ポーリングのたびに行の位置が入れ替わるのを防ぐため)。各時刻セルは分数値(0分は「Now」)+混雑度色(`load-green`/`amber`/`red`)+車種コード(SD/DD/BD)+車椅子アイコンを小さく併記。到着予定なしの枠は「–」。上限なし・全件表示(Arrivalsビューの`MAX_DISPLAYED_ARRIVALS`=10件とは別概念)。系統番号バッジ(`.tt-badge`)タップで経路モーダルを開く(Arrivalsビューの専用「Route」ボタンに相当する導線)。Arrivals/Timetableの両ビューは`loadBusArrivals()`/`pollBusArrivals()`が同一の取得結果から常に同期して描画するため、ビュー切替自体は再フェッチを伴わない
9. **両ビュー共有の目的地一致ハイライト・フィルター**: `applyRouteEnrichment()`/`applyRelatedOnlyFilter()`/`showAllBusCards()`は`#bus-card-list .bus-card`と`#home-timetable-list .tt-row`を合わせた要素集合(`collectEnrichableElements()`)に対して1回だけ判定・適用する(系統単位キャッシュ`serviceRouteInfoCache`も共有、両ビュー分で二重にAPIを叩かない)。`.tt-row`は`.bus-card`と同じ`data-route-number`/`data-origin-code`/`data-destination-code`/`data-current-stop-code`属性を持つため、既存の判定ロジックをそのまま使い回せる

### バスカード(Arrivalsビュー、ヒーローセル+グリッド、フェーズ8で全面刷新)

「バスがキューイングしてバス停に近づいてくる様を視覚的に表現したい」というユーザー要望を受け2026-09-20にフェーズ7で「正方形カード+S字カーブの縦一列キューイング」に刷新したが(`.claude/plan-phase7-arrivals-queue-cards.md`、採用モックアップ`mockups/arrivals-queue-patternA-variants-v1.html`の`variant-s`=A-4)、実機確認直後にユーザーから「少しスペースを無駄遣いしすぎてしまっているので、縦一列じゃない形がよさそう」とのフィードバックがあり、同日中に**「ヒーローセル+グリッド」**へ再刷新した(`.claude/plan-phase8-arrivals-grid-and-modal.md`、採用モックアップ`mockups/arrivals-queue-multicolumn-v1.html` Option 3、最終デザインは`mockups/arrivals-card-white-saved-v2.html`でユーザー正式承認済み)。フェーズ7のtier(`.t1`〜`.t7`の6段階サイズ縮小)・S字カーブオフセット(`--queue-offset-x`)・`margin-top`重ねは全て廃止された。旧デザイン(行き先・メタ行・ミニ経路図・「Next: N min」等を含む横長カード)の詳細はgit履歴を参照。

- **レイアウト**: `#bus-card-list`は`display:grid; grid-template-columns:repeat(3,1fr); gap:10px;`の3列グリッド。**最も到着が近い1件のみ**`grid-column:span 2; grid-row:span 2;`の2×2ヒーローセルとして強調表示し、残りは全て同一サイズの1×1セル(`aspect-ratio:1/1`)。スクロールは従来通り親`#home-scroll-content`が担う
- **カードの見た目**: 背景は白(`--surface-1`)＋細い枠線(`--border`)＋薄いshadow(フェーズ7の混雑度による背景色塗りつぶしは廃止)。系統番号は`--text-primary`、ETA/Operatorは`--text-secondary`/`--text-muted`のニュートラル文字色
- **表示情報**: 系統番号(大きな数字)・ETA(分)・バスイラスト(車種+混雑度、ヒーロー/通常セル両方に表示)・バス会社Operator略記(ヒーローセルのみ)。行き先(終点)・ミニ経路図・「Next: N min」・車椅子(WAB)アイコンは引き続き非表示
- **バスイラスト(車種+混雑度)**: フェーズ4〜6で確立し一時未使用だった`buildBusIllustrationSvg(typeCode, loadCode)`を復元・再利用。形(横長=一階建て/窓2段の縦長=二階建て)で車種を、窓の色(`Load`: SEA=緑/SDA=黄/LSD=赤)で混雑度を表現。本体の輪郭線は`var(--text-muted)`の線画のみで塗りつぶし・グラデーションは行わない(「色ドット+SD/DDテキスト」案は一時検討されたが「2階建て/1階建ての情報も表示したい」との指摘で撤回・不採用)。サイズはヒーローセル46px/通常セル26px(svg widthのみ指定、heightはviewBoxのアスペクト比に従いauto)
- **Operator(バス会社)表示**: LTA DataMall `BusServices`の`Operator`フィールド(`SBST`/`SMRT`/`TTS`/`GAS`)をそのまま略記表示。サーバー側`server.js`に`ServiceNo -> Operator`のMap(`busServiceNoToOperatorMap`)を新設し、`/api/bus-arrival`レスポンスの各`Services[]`に`Operator`を付与する(`enrichBusArrivalWithDestinationNames()`に統合、新たなLTA APIコールは不要)。既存の`data/bus-services.json`キャッシュにOperatorフィールドが無い場合(フェーズ8以前に保存されたファイル)は24時間の鮮度チェックとは別に強制的に1回再取得する(`initBusServicesCache()`の`missingOperatorField`判定)。クライアント側は`extractArrivalInstancesFromService()`で各到着インスタンスに`Operator`をコピーする。「バスの色」(車体塗装色)はLTA DataMallにデータが存在しないため実装しない(見送り)
- **目的地一致インジケーターは維持**: カード自体がバッジ相当のため、角に小さい色付きアイコン(`.bus-badge-match-icon`、最大2件まで重ね表示、通常20px/ヒーロー24px)を直接重ねる(`renderMatchTag()`がArrivalsカードでは`card`自身を「バッジ」として扱う、フェーズ7から変更なし)。テキストラベルは表示せず`aria-label`/`title`で補足
- **ヒーロー判定の再計算(`reapplyQueueTiers()`、関数名はフェーズ7から維持しつつ内部実装のみ簡略化)**: 「先頭(`index===0`)かどうか」だけを判定し、`.bus-card--hero`を付け外しする。カード生成直後(`loadBusArrivals()`)・出発演出/新規挿入/ETA差分更新の完了後(`applyArrivalDiff()`末尾)の両方で呼ぶ。出発アニメーション中のカード(`.bus-card--departing`)は順位カウントから除外するが、**除外前に一旦全カードから`.bus-card--hero`を外してから再判定する**(2026-09-20 jsdomスモークテストで発見・修正: 除外するだけだと直前までヒーローだった出発中カードに`.bus-card--hero`が残ったまま新ヒーローとの2件同時表示になり、2×2グリッド領域を2件が同時に主張してレイアウトが崩れる不具合があった)
- **カードタップで経路モーダルを開く**: 正方形の小さいカードには専用「Route」ボタンを置くスペースがないため、`.bus-card`自体がbutton要素になりカード全体がタップ対象(フェーズ7で確定、フェーズ8でも維持)
- Home画面フィード表示件数は最大10件(`MAX_DISPLAYED_ARRIVALS`、到着時刻昇順)。この上限自体はフェーズ7・8でも変更なし
- **現在表示中のバス停自体が登録済み目的地の場合、それを目的地一覧の判定対象から除外する**(`applyRouteEnrichment()`/`applyRelatedOnlyFilter()`)。除外しないと自宅最寄りバス停をSaveした場合に全カードが無条件でハイライトされてしまう
- 出発演出(`.bus-card--departing`)はその場でスケールダウン+フェードアウトする(フェーズ7から変更なし)。新規挿入(`.bus-card--entering`)も同様にスケール+フェードで統一
- **ミニ経路図(`renderMiniRoute()`)はArrivalsカードでは非表示**: `buildBusCard()`が`.bus-card-mini-route`要素自体を生成しないため、`applyRouteEnrichment()`から呼ばれても対象要素が見つからず自然に何もしない(関数自体・Timetableビュー向けの経由地情報取得ロジックは削除していない)。**Timetableビュー(`.tt-row`)は今回のスコープ対象外のため、行き先・系統番号バッジ(`.tt-badge`)等は変更なし**

### 絞り込みフィルター(ヘッダー右上)

星アイコンのトグルボタン、ON/OFFタップ1回で完結。経路モーダルの系統番号バッジ(`#route-modal-badge`)にも、タップ元カードの一致判定DOM状態をそのまま複製して角アイコンを表示する(再フェッチ不要)。

### 経路モーダル(Arrivalsビューはカードタップ、Timetableビューは系統番号バッジタップで展開)

2026-09-20フェーズ8(`.claude/plan-phase8-arrivals-grid-and-modal.md`)でフルスクリーンシートから**中央配置の小さいモーダルカード**に変更した(ユーザー指示「系統をタップしたときのモーダルは、全画面表示よりも上でいいです」)。`destination-map-modal-overlay`と同じ「暗い背景オーバーレイ+中央配置カード」パターン(`.route-modal-overlay`は`position:fixed; inset:0; background:rgba(0,0,0,0.45);`、`.route-modal`は`max-width:420px; max-height:78vh; border-radius:20px;`)。ヘッダー(系統番号バッジ・区間・閉じるボタン、固定)+地図(flex:2)+バス停リスト(flex:1、`max-height:78vh`内で画面の約2/3:1/3比率を維持)の3段構成は変更なし。**フルスクリーン時代の`env(safe-area-inset-top)`加算(ステータスバー回避用)・ボトムナビ回避用の`bottom`調整は不要になった**(中央配置カードの背後はダーク背景オーバーレイのみで、ボトムナビも他の中央配置モーダルと同様に隠れる標準的な挙動)。`openModal()`/`closeModal()`自体には元々スクロール制御等のフルスクリーン専用DOM操作がなく(`classList.add/remove('visible')`のみ)、パターン変更に伴う追加修正は不要だった。`map.fitBounds()`の`padding`はモーダルが小さくなったことに伴い`[50,60]`→`[36,44]`に縮小した(値が大きいままだと地図の実高さに対して余白の比率が大きくなり、短い区間でも不必要に大きくズームアウトしてしまうため)。

- 下部リストは「代表ウェイポイントのみ」ではなく**区間内の全停車バス停**を停車順の縦積みリストで表示(`renderRouteModalStopList()`、`/api/bus-routes/path`の`stops`配列を使用)。MRT駅は路線色、目的地一致停留所はアイコン色+カテゴリアイコンで強調。現在地行「You are here」・終点行「Destination」タグ
- **系統番号バッジ**: `.bus-badge`(Home画面と同じニュートラル配色、`--fill-accent`緑ではない)。4文字以上は`bus-badge--long`で縮小(Home画面と共通)
- **地図**: `/api/bus-routes/path`で取得した「現在地(表示中のバス停)→終点」の実座標をLeafletでポリライン表示(バスの発車地点=`NextBus.OriginCode`ではなく、現在画面表示中のバス停を起点にする)。循環路線を起点以外から乗車する場合は`toIndex === 0`のとき「ループの残り区間」(`stops.slice(fromIndex)`)として扱う特別分岐あり(`server.js`)。タイルは標準OSM+CSSフィルター`grayscale(0.92) brightness(1.4) saturate(0.25) contrast(0.85)` opacity 0.88 (**必ず`.leaflet-tile-pane`だけに適用**。コンテナ全体にかけると経路線・MRTマーカーの色まで薄まる)。CartoDB Positronは「API KEY REQUIRED」透かしのため使用不可。経路線の色は柳グリーン(`--fill-accent`)、白いケーシング線でコントラスト確保
- **出発点・終点マーカー**: 出発点=青い丸(`--current-location-blue`)、終点=`--midnight`の`ti-map-pin`(`-filled`系クラスは`@tabler/icons-webfont`に存在しないため使用不可)。両方に黒文字permanentツールチップラベル。現在地ラベルは`direction:'top'`(MRT駅ラベルは右方向のため衝突回避)
- **MRT駅マーカー**: `resolveMrtLineColor()`で判定した路線の公式色の丸+ラベル(12px、目的地一致は13px+塗りつぶしバッジ)。近接マーカーはラベルを左右交互配置(`map.latLngToContainerPoint()`によるピクセル距離、しきい値70px。実距離ベースだとズーム倍率依存で誤判定するため不採用)。**この近接判定・マーカー描画は`map.fitBounds()`の後に呼ぶ必要がある**(ズーム確定前は`latLngToContainerPoint()`が正しい値を返さない)
- 経由地リスト(地図下部、代表点のみ): MRT駅は路線色文字、目的地一致はアイコン色塗りつぶし+太字+box-shadowで強調
- waypoints選定ロジック(`selectWaypoints()`)優先順位: 1. MRT駅・インターチェンジ 2. 認知度の高い主要地名。全停留所は列挙しない
- 閉じるボタンのみ(ズーム・現在地ボタン等はなし、地図はドラッグのみ可)

### 目的地登録

2つの入口をタブ切替(By Mapは廃止済み、地図タップでの登録フローは存在しない):

- **By Route**: 系統番号入力→`GET /api/bus-services/:serviceNo/stops`で両方向マージした全バス停一覧→選んで登録
- **By Bus Stop**: バス停名・番号検索(`/api/bus-stops/search`)→選んで登録

いずれのタブも下部「Nearby bus stops」候補は**検索ボックスが空の時のみ表示**(`.destination-nearby-section`を入力時に`hidden`)。一覧から選ぶと確認ダイアログなしで即登録(+ボタン→チェックマーク)。

- **重複登録防止**: `saveDestination()`が保存前に同一`busStopCode`をチェックし、重複時は追加せず`'duplicate'`を返す。`loadDestinations()`側でも読み込み時に重複を自動クリーンアップ
- 登録時のカテゴリピッカーは廃止(`other`固定で保存)。アイコン種類・色・カスタムタイトルはSaved画面で登録後に編集(`destination-item-category-badge`タップでインライン編集パネル展開、「Done」ボタン=`.destination-item-editor-done`で閉じる、カラーピッカー直後・パネル最下部右寄せ)
- カスタムタイトル欄には常時ラベル「Title」を表示(`.destination-item-title-row`)。`innerHTML`挿入時は`escapeHtml()`必須(XSS対策)
- **カテゴリ一覧**: `Home`/`Office`/`Mall`/`School`/`Other`(`DESTINATION_CATEGORIES`)。旧値(`work`/`lessons`等)は`normalizeDestinationCategory()`で自動的に`other`扱い
- **アイコン色パレット**: `Gold`/`Lime`/`Turquoise`/`Indigo`/`Magenta`/`Rose`(`DESTINATION_ICON_COLORS`、MRT7路線色と被らない色相を採用)。旧キー(green/blue/orange/purple/red/teal)は`LEGACY_DESTINATION_ICON_COLOR_MAP`で1:1変換。経路モーダルの「現在地」丸マーカーは独立トークン`--current-location-blue`を使用(目的地カテゴリ色とは無関係)
- カスタムタイトル未設定の目的地には常時「+ Add a title」プロンプトを表示(設定されると自動的に隠れる)
- ドラッグ&ドロップ並べ替え(`initDestinationListDragReorder()`、`.destination-item-drag-handle`、プレースホルダー方式。ハンドルに`touch-action: none`必須、確定時に`persistDestinations()`)
- タブ切替UIパターン: `.filter-toggle`の`aria-pressed`パターン(非活性=ニュートラル、活性=`--fill-accent`塗り+太字)。今後の同様タブUIもこれを踏襲する

### Settings画面

sg-weekend-app(姉妹アプリ)のSettings画面ロジックをベースに実装。SGBusNaviには認証機構がないため「アカウント」節は実装しない。

- **Profile & App Settings**(統合セクション): ニックネーム入力(`sgbusnavi_nickname`)+ダークモード切替(`sgbusnavi_theme`、Auto/On/Offの3値循環)。プッシュ通知トグルは対象外
- **Support & Info**: Website(`/about`)/Privacy Policy(`https://willoa.net/privacy-policy/en`、英語版)/Version(`GET /api/version`、ネイティブアプリ内は`@capacitor/app`の`App.getInfo()`でビルド番号も表示「v1.0.0 (11)」形式)。Contact行は削除済み。リンクはいずれも`target="_blank"`なし・同一ウィンドウ内遷移(standalone PWA/ネイティブアプリに戻るボタンがないため)。ネイティブアプリ内は`_isCapacitorApp`判定でクリックをインターセプトし`@capacitor/browser`のin-appブラウザで開く(Stripe決済リンクのみ`target="_blank"`のまま維持)
- **Willoa**(統合セクション): About Willoa(`https://willoa.net`)/SG在住Navi姉妹アプリリンク(`https://about.dosuru.app`、紹介ページ)/Share with friends(QRコードボトムシート、`qrcode-generator.js`使用、`SHARE_URL`=`https://bus.willoa.net`固定)/Support the app(Stripe決済リンク、sg-weekend-appと**同一リンクを流用**`https://buy.stripe.com/28EfZ9eN56aZaEEbmY4c800`、SGBusNavi専用リンクなし)
- **Feedback**: テキストエリア+送信→`POST /api/feedback`→LINE Messaging API(Push)で開発者に通知。サーバー側にデータ保存なし
- GPSフォールバック画面(`#gps-fallback`)に「Try Again」ボタン(`#gps-fallback-retry-btn`)あり、タップで`initGpsLocation()`再実行

### バス停検索(GPSに依らない手動検索) — 廃止済み

ボトムナビの「Search」タブ・Search画面は削除済み。ボトムナビはHome/Saved/Settingsの3タブ構成。バス停名・番号検索自体は目的地登録モーダルの「By Bus Stop」タブとして存続。

### 一時デバッグ機構 — 2026-09-17削除済み

目的地保存バグ調査用の一時的なクライアントエラー収集機構(`POST /api/client-error`等)は、App Store申請準備にあたりユーザーへの開示なき利用状況トラッキングに該当するため全削除済み。現在サーバーに送信される個人関連データは位置情報(最寄りバス停検出用、アカウント非紐付け)とフィードバック本文(LINE中継のみ、サーバー保存なし)の2つのみ。

## デザイン方針

- SG在住Naviの`public/app.css`のデザイントークン(柳グリーン配色、カード角丸、フォント)を流用
- フォントファミリーは`'Inter', sans-serif`(視認性最優先、Google Fonts経由)。ボトムナビ・カードUI等の寸法(font-size, padding, gap等)はSG在住Naviと一致させる方針
- 共通コンポーネントは寸法(font-size, padding, gap, border-radius, box-shadow等)までSG在住Naviと一致させる。デザイン一貫性チェックには`design-checker`エージェントを使う
- 密度が重要な画面(バスカードリスト等)では、SG在住Navi基準のpadding/gapを意図的に縮小する例外を許容する。**2026-09-15 Pattern A(横長カード時代)の具体値は、その後フェーズ7(正方形キューイングカード)→フェーズ8(ヒーローセル+グリッド)の全面刷新で`.bus-card`のDOM構造自体が変わったため陳腐化した(値の詳細はgit履歴を参照)。現行のArrivalsカード仕様は上記「バスカード」節を参照**
- フィルターピル/チップ系は`.filter-chip`パターン(非活性=ニュートラル背景+枠線、活性=アクセント塗り+太字)で統一
- CSS変数のエイリアス対応(`--surface-1`→`--warm-white`等)は`public/css/style.css`冒頭の「2. 意味的エイリアス」ブロック参照
- ボトムナビ: Home / Saved / Settings の3タブ構成
- PWA化。アイコン・マニフェストもSG在住Naviの制作フローを踏襲
- **`<input>`要素のfont-sizeは必ず16px以上**(iOS Safariはフォーカス時に16px未満だと自動ズームする)
- **localStorage書き込み関数はサイレント失敗禁止**: 成功可否をboolean等で返し、呼び出し元は失敗時に必ずユーザーに通知する
- **ボタン押下時の前提条件チェックで早期returnする場合も、必ずユーザーに理由を伝える**(無反応のまま終わらせない)

## 未決事項(今後詰める)

- Obsidianボルトの`willoa`配下に本プロジェクト用サブディレクトリを新設するか検討
- MRT運行障害バナーの実装要否(未実装のまま、データソース節参照)

## iOSネイティブアプリ化

Capacitorでラップし、姉妹アプリSG在住Navi(sg-weekend-app)と同じ「`release`ブランチへのpush→GitHub Actions(macOSランナー)→Fastlane→TestFlight」方式でビルド・配信。詳細手順は`ios-app/README.md`参照。GitHubリポジトリ`oguworld/sg-bus-navi`(public)。**現在TestFlight配信中(1.0.0)、App Store提出済み**(審査ステータスは案件ごとに確認)。

- **基本情報**: バンドルID`net.willoa.bus`、App Store Connect登録済み(アプリ名SGBusNavi、プライマリ言語English(UK)、SKU`sgbusnavi`)。詳細はauto memoryの`project_appstore_registration`参照
- **sg-weekend-appからの簡略化**: ログイン・プッシュ通知・Google/Apple認証を一切使わないため、APNs bridge・Google Sign-In URL Scheme・プライバシーマニフェスト・通知アイコン生成・App.entitlementsは全て不要。`ensure-min-ios-version.py`(iOS 15.0引き上げ)のみ汎用処理のため移植
- **証明書管理**: `fastlane match`は使わず、手動作成した証明書(.p12)・プロビジョニングプロファイル(`sgbusnavi_appstore`)をBase64化してGitHub Secretsに登録する方式(sg-weekend-appと同じ実態ベース)。証明書作成はMac不要でOpenSSLのみで完結可能(CSR生成・.p12書き出しは`openssl genrsa`/`openssl req -new`/`openssl pkcs12 -export -legacy`で代替。**`-legacy`必須**: OpenSSL 3.x系のデフォルトAES-256暗号化はmacOS Keychainと非互換)
- **GPS取得**: ネイティブアプリ内は`navigator.geolocation`ではなく`@capacitor/geolocation`を使う(`window.Capacitor.isNativePlatform()`で分岐)。標準Web APIのままだとWebKit内蔵の「localhost」表記ダイアログが別途出てしまうため。粗い位置(`enableHighAccuracy:false`, `GPS_FAST_TIMEOUT_MS`=5秒, `maximumAge`=`GPS_FAST_MAX_AGE_MS`60秒)と高精度GPS(`enableHighAccuracy:true`, `GPS_TIMEOUT_MS`=10秒, `maximumAge`=`GPS_ACCURATE_MAX_AGE_MS`10秒)を並行リクエストし、粗い位置で暫定表示→高精度到着時に`currentStopIndex===0`の場合のみ差し替え。加えて直近成功座標をlocalStorageキャッシュ(`sgbusnavi_last_location`、7日間有効)し起動直後は即座に暫定表示する3段階構成。取得経路は`getCurrentCoords()`、エラー分岐は`buildGpsErrorMessage()`に共通化
- **`API_BASE`パターン必須**: `capacitor.config.js`は`server.url`を指定せずローカルバンドル同梱構成のため、WebViewのoriginは`bus.willoa.net`ではない。相対パスの`fetch('/api/...')`は静かに失敗するため、`public/js/app.js`冒頭の`_isCapacitorApp`/`API_BASE`(ネイティブ時`https://bus.willoa.net`)を必ず全`/api/*`呼び出しに付与する。`server.js`側も`ALLOWED_ORIGINS`(`capacitor://localhost`等)のCORSミドルウェアが必要。**新規にAPI呼び出しを追加する際は必ずこのパターンに従うこと**(忘れると気づきにくい形でネイティブ版だけ壊れる)
- ネイティブアプリ内の外部リンク(Website/Privacy/Support/Share)は`_isCapacitorApp`時のみクリックをインターセプトし、相対パスをAPI_BASEで絶対URL化した上で`@capacitor/browser`のin-appブラウザで開く(標準ブラウザ遷移だと戻る手段がなくなるため)
- ヘッダーの`padding-top`には`env(safe-area-inset-top)`を含める(`.app-header`/`.saved-header`、`contentInset:'never'`+`viewport-fit=cover`の組み合わせでステータスバーに重なるため)
- スプラッシュ画面: `scripts/generate-splash.js`、sg-weekend-appと同じ構図(canvas 2732px、アイコン560px、タイトルはアイコン下160px)。フォントは`Poppins`(比較モックで選定)。**このVPSで`@fontsource`のフォントをsharp/librsvg経由のSVGレンダリングに使う場合、`.woff2`のままでは無警告で別フォントにフォールバックする(バンドルfontconfigがbrotli非対応)。`wawoff2`パッケージで`.ttf`に変換してから`~/.local/share/fonts/`に配置すること**
- 証明書とセットになる秘密鍵は`.p12`を作り直すたびに必要になるため、不要と判断して安易に削除しない

## モックアップ(参考実装)

`mockups/`配下に多数のHTMLモックアップが蓄積されている(デザイン検討の記録)。CSS変数(`--surface-1`, `--surface-2`, `--text-primary`, `--text-accent`, `--fill-accent`, `--border` 等)を用いたデザイントークンベースの実装。Tabler Icons(`ti ti-*`)を使用。新しいUI検討時もこのパターンでモックを作り、ユーザーに選択肢を提示してから実装する運用を踏襲する。
