# SGBusNavi フェーズ7 設計書（Arrivalsビュー: 遠近クイーニングカード）

バージョン1.0.1向け追加変更。前フェーズ（フェーズ6: 地図+Timetableビュー切替）は完了済み。

## 0. 背景（ユーザー発言の要旨）

「ArrivalのUIを少しがらっとかえたい。余計な情報はいらないので、系統番号と本当に必要な情報だけに残して、カードをもっと正方形に近い形にして、バスがキューイングして、バス停に近づいてくる様を視覚的に表現したい」。行き先は不要。車種(SD/DD)は必要。

3パターン(遠近クイーニング/密度グリッド/ロードレーン)を提示 → 「一つの画面で全部表示できないのでスクロールは前提」のフィードバックを受け、遠近クイーニング案をスクロール対応・サイズ底打ち付きで4バリエーション(直線/蛇行/一方向カーブ/S字カーブ)に発展 → **ユーザーは「A-4（S字カーブ）」を選択**。

参考モックアップ: `mockups/arrivals-queue-patternA-variants-v1.html` の `variant-s`（`.t1`〜`.t10`のサイズ階層・`translateX`値）。

## 1. デザイン仕様（モックアップから確定）

- カードは正方形に近い形。表示情報は**系統番号(大)・ETA(分)・車種(SD/DD)のみ**。行き先テキストなし。ミニ経路図(`.bus-card-mini-route`)・「Next: N min」も非表示。
- 背景色は混雑度(Load: SEA=緑/SDA=黄/LSD=赤)で塗りつぶし。数字・時間は白文字。
- 到着が近い順に上から表示、サイズが段階的に縮小(tier 1〜6、112px→98px→86px→74px→64px→56px)。7件目以降はモックアップの50pxで底打ち(既存の最小サイズ規約に合わせ実装では`t7`相当を最小固定とする)。
- 各カードは`margin-top`負値で縦に重なる。
- 横オフセットはS字カーブ(モックアップ`.variant-s`の`.t1`〜`.t10`のtranslateX値をそのまま採用、11件目以降は周期を繰り返す)。
- 車種ラベルは最小tier(t7以降)では省略可。
- `#bus-card-list`自体がスクロールコンテナ(既存`#home-scroll-content`構造は変更しない)。

## 2. 実装方針の決定事項

1. **目的地一致ハイライトは維持**。角に`.bus-badge-match-icon`相当の色付きアイコンバッジを重ねる。カード背景色(混雑度)とは別レイヤー。
2. **カードタップで経路モーダルを開く**。正方形の小カードに「Route」ボタンを置くスペースがないため、カード全体をタップ可能にする(2026-09-14の「ボタン化」からタップに戻す)。`data-route-*`属性は既存のまま維持し、経路モーダルの`openModal()`はカード要素からこれらを読むだけなので変更不要。
3. **フィルター・一致判定ロジック自体は変更しない**。`.bus-card`が持つ`data-route-number`等の属性名・`renderMatchTag()`/`applyRouteEnrichment()`/`applyRelatedOnlyFilter()`はそのまま。バッジのDOM(`.bus-badge-number`/`.bus-badge-match-icon--1`/`--2`)も構造は維持し、位置・サイズのみ正方形カードに合わせて調整する。
4. **tier再計算**: `applyArrivalDiff()`の出発演出・新規挿入・ETA更新が全て終わった後、`#bus-card-list`内の現在の`.bus-card`を上から順に走査し、`t1`〜`t6`+底打ちクラス(`t7`)を再度付け直す`reapplyQueueTiers()`を新設。`applyArrivalDiff()`末尾と`loadBusArrivals()`のカード生成直後の両方で呼ぶ。
5. `Next: X min`は表示しない（`buildEtaBlockHtml()`のqueueカード向け経路を新設し、nextMinutes引数自体を渡さない/使わない形にする）。
6. WABアイコンは今回のスコープで非表示。
7. box-shadow・角丸は既存トークンと調和させる（モックアップ数値の完全一致は必須としない）。

## 3. 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `public/js/app.js` | `buildBusCard()`の全面書き換え(正方形DOM、背景色クラス、tierクラスなし初期状態でOK・reapplyで付与)。`applyArrivalDiff()`末尾で`reapplyQueueTiers()`呼び出し追加。`loadBusArrivals()`のカード生成後にも`reapplyQueueTiers()`呼び出し追加。カードクリックで`openModal(card)`を呼ぶリスナーに変更（`.bus-card-route-btn`ボタン参照の削除）。`buildEtaBlockHtml`のqueueカード用の簡略版を追加または既存を条件分岐。`.bus-card-list`のコンテナ自体のレイアウト(flex-wrap等)はCSS側で対応するためJS構造変更は最小限。 |
| `public/css/style.css` | `.bus-card`関連スタイルの全面書き換え: 正方形化、Load背景色クラス(`.bus-card--load-green/amber/red`)、tierクラス`.t1`〜`.t7`(サイズ・margin-top・z-index・opacity)、S字カーブのtranslateX、白文字ETA/系統番号、バッジ位置調整(角一致アイコン)、`.bus-card-list`をflex-wrap無しの縦積みcolumn(align-items:centerでS字カーブの左右余白を確保)に変更。旧`.bus-card-mini-route`系・`.bus-card-actions`/`.bus-card-route-btn`関連は新カードでは使わなくなるため出力しないが、CSS定義自体は他画面で不使用なら削除、Timetableビュー等で共有されていれば残置判断。出発演出`@keyframes bus-card-depart`は正方形カードでも自然に見えるよう調整要否を確認。 |
| `public/sw.js` | `CACHE_VERSION`を`v110`→`v111`にインクリメント(静的アセット変更必須事項)。 |
| `CLAUDE.md` | 「バスカード」節を新デザイン(遠近クイーニング、S字カーブ、正方形、情報を絞る、カードタップで経路モーダル)に合わせて更新。 |

## 4. 受け入れ基準

- Arrivalsビュー(`#bus-card-list`)のカードが正方形に近い形になり、系統番号・ETA・車種(SD/DD、最小tierでは省略可)のみを表示する。行き先テキストは表示されない。
- カード背景色が混雑度(緑/黄/赤)で塗られ、数字が白文字で視認できる。
- 到着が近い順に上から並び、下に行くほどカードが段階的に小さくなり、7件目以降は同じ最小サイズで底打ちする。
- 横方向のオフセットがS字カーブ状に揺れる。
- 目的地一致時、カード角に色付きアイコンバッジが表示される(既存の複数一致最大2件ロジックも維持)。
- カードタップで経路モーダルが開く。
- 「関連のみ」フィルターがカードのhidden切替として引き続き機能する。
- ポーリングで1台出発した場合、残りカードのtier(サイズ・オフセット)が正しく繰り上がって再計算される。
- Timetableビュー(`#home-timetable-list`)・地図パネル・ピル行は変更なし。

## 5. スコープ外

- Timetableビュー自体
- 地図パネル・フリップボタン・バス停ピル行
- 「関連のみ」フィルターの判定ロジック自体（表示側の見た目のみ変更）
- WABアイコン、「Next: N min」併記

## 6. 進め方

builder(実装)→checker(plan照合)→closer(session-log/CLAUDE.md/next.md更新・ローカルコミット)の順で実施。本番PM2再起動はユーザー承認が必要なため行わない。動作確認は`PORT=3099 node server.js`で行う。
