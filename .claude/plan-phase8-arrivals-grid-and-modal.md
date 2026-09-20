# SGBusNavi フェーズ8 設計書（Arrivalsビュー: ヒーローグリッド化＋経路モーダル縮小）

バージョン1.0.1向け追加変更。直前のフェーズ7（`.claude/plan-phase7-arrivals-queue-cards.md`、正方形カード＋S字カーブの縦一列キューイングデザイン）実装直後のユーザーフィードバック「少しスペースを無駄遣いしすぎてしまっているので、縦一列じゃない形がよさそう」を受けた変更。

## 0. 背景（経緯）

フェーズ7で縦一列のS字カーブ・キューイングカードを実装したが、実機確認でスペース効率の悪さが指摘された。3パターン（フロー折り返しグリッド/2レーン/ヒーローセル+グリッド）を`mockups/arrivals-queue-multicolumn-v1.html`で提示し、ユーザーは**Option 3「ヒーローセル+グリッド」**を選択。

実装着手後、コーディネーターから段階的に方針の追加修正が入り、最終的に以下の経緯で確定した:

1. 第1弾: カード背景を白(`--surface-1`)に統一し混雑度の色塗りつぶしを廃止、混雑度は小さい色ドットで表現、目的地一致バッジを復活、文字色をニュートラルに統一（`mockups/arrivals-card-white-saved-v1.html`）。
2. 第2弾（ユーザー指示「2階建てと1階建ての情報も表示したい。例のアイコンと窓の色の形で」）: 「色ドット＋SD/DDテキスト」案を撤回し、**フェーズ4〜6で確立していたバスイラストSVG（`buildBusIllustrationSvg()`、形=単一/二階建てのシルエット、窓の色=混雑度）を復活**させる方針に変更。当初「本体色はグレーグラデーション」との指示があったが、実際にgit履歴（コミット`36bdd0c`、フェーズ6時点）を確認した結果、本体は塗りつぶしなしの輪郭線のみ（`fill="none" stroke="var(--text-muted)"`）だったため、この実装をそのまま復元・流用した（グラデーション化は行っていない）。
3. 最終版（`mockups/arrivals-card-white-saved-v2.html`、**ユーザー正式承認済み**）: バスイラストはヒーロー・通常セルの両方に表示する（1台のイラストで車種+混雑度の両方を表現するため、通常セルでも省略しない）。Operator（バス会社）テキストのみスペースの都合上ヒーローセル限定で表示する。

参考モックアップ: `mockups/arrivals-queue-multicolumn-v1.html`（レイアウト）、`mockups/arrivals-card-white-saved-v1.html`（初期案、不採用）、`mockups/arrivals-card-white-saved-v2.html`（**最終承認版**）。

## 1. デザイン仕様（最終、v2モックアップ準拠）

### 1-1. レイアウト（グリッド化）
- `#bus-card-list` を `display:grid; grid-template-columns: repeat(3, 1fr); gap:10px;` に変更。
- **最も到着が近い1件のみ**ヒーローセル(`grid-column:span 2; grid-row:span 2;`)として2×2で強調表示。文字・イラストサイズも大きくする。
- 残りは全て同一サイズの1×1セル（tierの多段階サイズ縮小・S字カーブオフセット・margin-top重ねは廃止）。
- 各セルは`aspect-ratio:1/1`を維持。
- スクロールは既存どおり親の`#home-scroll-content`が担う。`#bus-card-list`自体はスクロールしない。

### 1-2. カードの見た目
- 背景は白(`--surface-1`)＋細い枠線(`--border`)＋薄いshadow。混雑度による背景色塗りは廃止。
- 表示情報: 系統番号(大)・ETA・バスイラスト(車種+混雑度、ヒーロー/通常セル両方)・バス会社(Operator略記、ヒーローセルのみ)。行き先は引き続き非表示。色ドット・SD/DDテキストラベルは**不採用**（バスイラスト1つで代替するため不要）。
- 文字色: 系統番号は`--text-primary`、ETA/Operatorは`--text-secondary`/`--text-muted`（モックの`--warm-gray`/`--light-gray`に対応するSGBusNavi既存トークン）。
- バスイラストのサイズは`mockups/arrivals-card-white-saved-v2.html`の値をそのまま採用: ヒーローセルはsvg width 46px、通常セルは26px（heightはviewBoxのアスペクト比に従いautoで決まる）。

### 1-3. バスイラスト（車種+混雑度）
- フェーズ4〜6で確立し、フェーズ7で一時未使用になっていた`buildBusIllustrationSvg(typeCode, loadCode)`をそのまま復元・再利用する（関数定義自体はフェーズ7時点でも削除せず残置されていたため、コードの再作成は不要だった）。
- 形（横長=一階建て／窓2段の縦長=二階建て）で車種を、窓の色（緑=SEA/黄=SDA/赤=LSD）で混雑度を表現。本体の輪郭線は`var(--text-muted)`の線画のみで、塗りつぶし・グラデーションは行わない。

### 1-4. Operator（バス会社）表示
- LTA DataMall `BusServices` の `Operator` フィールド(`SBST`/`SMRT`/`TTS`/`GAS`)をそのまま略記表示する。ヒーローセルのみ表示（通常セルは省略、CSS側`.bus-card-operator`が`.bus-card--hero`配下でのみ`display:inline`）。
- サーバー側 `busServicesCache` に既に `Operator` フィールドが存在するため、新たなLTA APIコールは不要。`ServiceNo -> Operator` のマップをサーバー側に新設し、`/api/bus-arrival` のレスポンスへ `Services[].Operator` として付与する(`enrichBusArrivalWithDestinationNames`と同様の非破壊追加パターン)。方向(Direction)によらずOperatorは同一のため、`ServiceNo`単位のシンプルなMapで十分。
- クライアント側は`extractArrivalInstancesFromService()`で各到着インスタンスに`Operator`をコピーして持たせ、`buildBusCard()`がそのまま表示する。
- 「バスの色」（車体塗装色）はLTA DataMallにデータが存在しないため、実装しない（見送り、変更なし）。

### 1-5. 目的地一致バッジ
- 既存の`renderMatchTag()`ロジックをそのまま流用。`.bus-badge-match-icon--1`/`--2`要素をカード直下に維持し、右上角に表示する（最大2件、既存仕様のまま）。
- カード背景が白になったことに伴い、アイコンの縁取り色（`border: 2px solid var(--surface-1)`）はそのまま維持（白背景カードの上で「バッジが浮いて見える」効果を保つ）。

### 1-6. tier再計算の簡略化
- フェーズ7の`reapplyQueueTiers()`（t1〜t7の6段階サイズ＋S字カーブオフセット計算）を廃止し、「先頭(index===0)かどうか」だけを判定する単純なロジックに置き換える（関数名自体は既存呼び出し元との整合を優先しそのまま`reapplyQueueTiers()`を維持し、内部実装のみ簡略化した）。
- 先頭カードに`.bus-card--hero`を付与、それ以外は通常セル（クラスなし）。
- 出発演出（`.bus-card--departing`）中のカードは順位カウントから除外する既存方針を維持。

## 2. 実装方針の決定事項

1. カードのDOM構造は`buildBusCard()`を書き換え、`.bus-card-sub-row`（`.bus-card-vehicle-icon-wrap` + `.bus-card-operator`）を新設。
2. `reapplyQueueTiers()`は関数名を維持したまま内部実装のみ「先頭かどうか」の単純判定に簡略化。呼び出し元（`applyArrivalDiff()`末尾・`loadBusArrivals()`カード生成直後）は変更なし。
3. 目的地一致・フィルターロジック自体（`renderMatchTag()`/`applyRouteEnrichment()`/`applyRelatedOnlyFilter()`）は変更しない。
4. カードタップで経路モーダルを開く挙動（フェーズ7で確定）は維持する。
5. 経路モーダルは中央配置カードパターンへの変更が実装済み（`public/css/style.css`の`.route-modal-overlay`/`.route-modal`/`.route-modal-header`）。今回のタスクでは以下を確認・仕上げる:
   - `openModal()`/`closeModal()`にフルスクリーン専用処理が残っていないか（確認の結果、スクロール制御等の特別なDOM操作は元々なく、`classList.add/remove('visible')`のみで問題なし）
   - `.route-modal-map`(flex:2)・`.route-modal-stop-list`(flex:1)の比率が`max-height:78vh`内で破綻しないか
   - `map.fitBounds()`のpadding(`[50,60]`)が縮小されたモーダル内でも問題ないか

## 3. 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `server.js` | `ServiceNo -> Operator`マップを新設し、`/api/bus-arrival`レスポンスの各`Services[]`に`Operator`を付与する。 |
| `public/js/app.js` | `buildBusCard()`書き換え(グリッドセルDOM、白背景カード、バスイラスト+Operator表示)。`extractArrivalInstancesFromService()`に`Operator`のコピーを追加。`updateBusCardEta()`をイラスト再生成に対応。`reapplyQueueTiers()`の内部実装を先頭判定のみに簡略化。呼び出し箇所は維持。 |
| `public/css/style.css` | `.bus-card-list`をgridに変更。`.bus-card`を白背景カードに全面書き換え。tier(t1〜t7)クラスを削除し、`.bus-card--hero`/通常セルの2値に統一。バスイラスト・Operatorのサイズ出し分けCSSを新設。経路モーダルのpadding等を必要なら微調整。 |
| `public/index.html` | `#bus-card-list`内の静的プレースホルダーマークアップを新デザインに合わせて更新。 |
| `public/sw.js` | `CACHE_VERSION`をインクリメント。 |
| `CLAUDE.md` | 「バスカード」節・「経路モーダル」節を更新。フェーズ7のS字カーブ・tier階層は「後にグリッド化により置き換えられた」旨を明記。 |

## 4. 受け入れ基準

- `#bus-card-list`が3列グリッドになり、最も近い1件が2×2のヒーローセルとして強調される。
- カード背景は白＋細い枠線。混雑度はバスイラストの窓の色で表現される（色ドット・SD/DDテキストは使わない）。
- 系統番号・ETA・バスイラスト(ヒーロー・通常セル両方)・Operator(略記、ヒーローのみ)が表示され、行き先テキストは表示されない。
- 目的地一致時、カード右上角に色付きアイコンバッジが表示される(既存の複数一致最大2件ロジックも維持)。
- カードタップで経路モーダルが開き、中央配置の小さいモーダルとして表示される。
- 「関連のみ」フィルターが引き続き機能する。
- ポーリングで1台出発した場合、ヒーロー判定が正しく繰り上がる。
- Timetableビュー・地図パネル・ピル行は変更なし。

## 5. スコープ外

- Timetableビュー自体
- 地図パネル・フリップボタン・バス停ピル行
- 「関連のみ」フィルターの判定ロジック自体
- WABアイコン、「Next: N min」併記、行き先テキスト、バス車体色の実装

## 6. 進め方

builder(実装)→checker(plan照合)→closer(session-log/CLAUDE.md/next.md更新・ローカルコミット)の順で実施。本番PM2再起動はユーザー承認が必要なため行わない。動作確認は`PORT=3099 node server.js`で行う。
