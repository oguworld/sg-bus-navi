# SGバスNavi 初期セットアップ設計書

## 1. ユーザーストーリー

- シンガポール在住者として、アプリを開くと即座に最寄りバス停のバス到着情報がカード形式で表示され、系統を探す操作なしに次のバスが分かる。
- 開発者として、既存の姉妹プロジェクト(SG在住Navi/dosuru-app、実体は `/home/masahiko/sg-weekend-app/`)と同じ運用パターン(Node.js+Express+PM2+nginx、JSONファイルベース)でVPSにデプロイでき、保守コストを抑えられる。
- 開発者として、モックアップのHTML/CSSをできるだけそのまま活かしつつ、PWA(マニフェスト・Service Worker)として動作する土台を最短で用意できる。
- 開発者として、LTA DataMall APIキーをブラウザに一切露出させず、バックエンド経由でのみバス到着情報を取得できる。

今回のタスクは「プロジェクト基盤の設計」のみであり、GPS検出・バスカードの実データ表示・経路モーダル等の機能実装そのものは対象外（後続の設計・実装タスクで扱う）。

## 2. 受け入れ基準

### 正常系
- `npm start`（または`pm2 start`）でローカル/VPS上のNode.jsサーバーが起動し、`public/`配下の静的ファイルが配信される。
- ブラウザで`/`にアクセスするとモックアップ相当のホーム画面（静的UI、ダミーデータ可）が表示される。
- `manifest.json`と`sw.js`が配置され、Chrome DevToolsのLighthouse等でPWAとして最低限インストール可能と判定される（アイコン・start_url・display:standaloneが揃っている）。
- LTA DataMall APIキーは`.env`にのみ保持され、フロントエンドのソース（HTML/JS/ネットワークタブ）に一切出現しない。
- サーバー経由のAPIエンドポイント（例: `/api/bus-arrival?stopCode=xxxx`）を叩くと、LTA DataMallのレスポンスがプロキシされて返る（キーはサーバー側で付与）。

### 失敗系
- LTA DataMall APIキー未設定（`.env`欠落）の場合、サーバーは起動時または該当API呼び出し時に明確なエラーログを出し、フロントには汎用エラーメッセージを返す（キー情報を含まない）。
- LTA DataMall側がエラー・タイムアウトを返した場合、プロキシは500系を返しつつサーバーログに詳細を記録する。フロント側でクラッシュしない。
- 不正なバス停コード等の不正リクエストは、サーバー側でバリデーションし400を返す（LTA APIへの無駄なリクエストを防ぐ）。

### エッジケース
- GPS権限がオフ/拒否された場合のフォールバック表示は、CLAUDE.mdの「未決事項」に明記されており、本設計の対象外（別タスクで詳細設計）。
- オフライン時、Service Workerがどこまでキャッシュを返すか（アプリシェルのみか、直近データも返すか）は未決定。sg-weekend-appは「APIはnetwork-only、静的アセットはcache-first」方針だったため、同様の方針を初期案とするが、確定は次フェーズで良い。
- nginxでのbus.willoa.net用serverブロック追加、SSL証明書発行は本設計のタスク分解には含めるが、実際のVPS作業（sudo権限が必要な操作）はplannerの範囲外であり、別途ユーザー自身またはinfra担当が実施する前提。

## 3. スコープ外（作らないものを明示）

- GPSによる最寄りバス停自動検出ロジック、横スワイプ、ドットインジケーター等のホーム画面インタラクション実装
- バスカードの実データ描画（LTA `BusArrivalv2`のレスポンス整形・車種シルエット判定ロジック等）
- 経路モーダル、目的地登録（地図タップ）、バス停検索、履歴機能の実装
- MRT運行障害バナー
- 認証機能（SG在住Naviにある Google/Apple Sign-In 等）は今回のスコープに含めない。バスNaviに認証が必要かどうか自体が未決
- iOSネイティブアプリ化（Capacitor導入、Fastlane、App Store申請）は基盤セットアップの範囲外。将来sg-weekend-appと同じパターンを踏襲できる見込みだが、今回は着手しない
- nginx実機設定・SSL証明書取得などVPSへの実際の変更作業
- LTA DataMall APIキーの新規登録作業そのもの（ユーザー側の対応が必要）
- Obsidianボルトのドキュメント整備

## 4. 技術スタック評価

### 4-1. フロントエンド

| 選択肢 | モックアップとの親和性 | PWA実装のしやすさ | 保守性 | 備考 |
|---|---|---|---|---|
| A. プレーンHTML/CSS/JS（PWA） | 非常に高い（モックアップをほぼそのまま`public/`に配置できる） | 高い（`manifest.json`+`sw.js`を追加するだけ、sg-weekend-appと同一パターン） | 中程度（画面数が少ないうちは問題ないが、状態管理・DOM操作が増えると素のJSでは煩雑になりやすい。ただしsg-weekend-appも同方式で運用実績あり） | ビルドチェーン不要、`vanilla JS + fetch`のみ |
| B. Vite + 素のTS（ビルドあり、フレームワークなし） | 高い（HTML/CSSはほぼ流用可、TSに書き換える手間は発生） | 高い（`vite-plugin-pwa`等で自動化できる） | Aより型安全性の分だけ高いが、ビルドステップが増える | 開発時はHMRが効くが、デプロイ時に`dist/`ビルドが必要になりPM2運用に一手間増える |
| C. React等のUIフレームワーク | 低い（モックアップの構造をコンポーネント分解し直す必要があり、初期コストが大きい） | 高い（エコシステムが充実） | 画面・状態が複雑化した場合は高いが、本アプリの「一目でわかる」コンセプト＝画面数が少なくシンプルな構成には過剰 | 学習コスト・バンドルサイズの増加 |

**推奨: A. プレーンHTML/CSS/JS + PWA（sg-weekend-appと同一パターン）**

理由:
1. モックアップがプレーンHTML+CSS変数+Tabler Iconsで既に作られており、そのまま`public/`配下に配置して育てられる。デザイン移植の手戻りが最小。
2. 姉妹プロジェクトsg-weekend-appが全く同じ構成（Vanilla JS / CSS変数 / PWA、ビルドチェーンなし）で本番運用されている実績があり、保守パターン・デプロイ手順（`pm2 restart`のみ）をそのまま踏襲できる。
3. 画面数が少なく（Home/Search/Saved/Settingsの4タブ＋モーダル）、Reactのような状態管理フレームワークが必要になるほどの複雑度ではない。
4. PWA化（manifest.json+sw.js）は素のJSでも十分に実装しやすい。

未決事項:
- 将来画面数・状態が増えた場合、Viteへの移行は「`public/`をそのまま`src/`にコピーして段階的に型を足す」形で低コストに行える設計にしておくことが望ましい。
- Tailwind CSSを使うかは不明。sg-weekend-appはCLAUDE.mdルール上「Tailwind CSSを使う」とあるが、実`public/app.css`は生CSS変数ベース。モックアップ自体もCSS変数ベースのプレーンCSSのため、SGバスNaviでは**Tailwindを使わずモックアップのCSS変数体系をそのまま踏襲する**方針を初期案とする。

### 4-2. バックエンド

**推奨: Node.js + Express + PM2（sg-weekend-appと完全に同一パターン）**

最小構成案:
- `express`: ルーティング・静的ファイル配信・APIプロキシ
- `dotenv`: `.env`からLTA DataMall APIキー等の秘匿情報を読み込み
- `axios`（またはNode標準`fetch`）: LTA DataMall APIへのサーバーサイドリクエスト
- `express-rate-limit`: 過剰リクエスト防止
- 簡易インメモリキャッシュ（`Map`+TTL、または`node-cache`）: 同一バス停への短時間連続リクエストをLTA DataMallまで飛ばさず返す（TTL等の詳細は未決）

DBは使わず、sg-weekend-appのルールを踏襲して**JSONファイルベース**とする。ただし目的地登録・履歴を「サーバー保存」にするか「ブラウザlocalStorageのみ」で足りるかは未決。

### 4-3. インフラ

CLAUDE.mdの未決事項通り「dosuru-appと同一VPS内で別Node.jsプロセス+PM2、nginx側でbus.willoa.net用serverブロック追加」の方針。sg-weekend-appの`nginx-sg-weekend.conf`が実例として存在し、同パターンを踏襲可能。

未確認:
- 実際にVPS上でdosuru-appが使用しているポート番号（新規プロセスとの衝突回避のため要確認、sshでの`pm2 list`確認が必要）
- bus.willoa.netのDNS設定状況、Cloudflare等の利用有無

## 5. 初期ディレクトリ構成案

```
sg-bus-navi/
├── CLAUDE.md
├── .env                      ← LTA_DATAMALL_API_KEY等（gitignore対象）
├── .env.example               ← キーなしのテンプレート
├── .gitignore
├── package.json
├── server.js                  ← Expressエントリポイント、静的配信+APIルーティング
├── data/                       ← （必要なら）目的地登録・履歴等のJSONファイル。gitignore対象
│   └── .gitkeep
├── public/                     ← フロントエンド一式（モックアップ移植先）
│   ├── index.html              ← ホーム画面
│   ├── css/
│   │   └── style.css           ← モックアップのCSS変数体系をそのまま移植
│   ├── js/
│   │   └── app.js              ← フロントロジック（fetch呼び出し・DOM操作）
│   ├── icons/                   ← assets/icons/ から生成
│   │   ├── icon-72.png 〜 icon-512.png
│   │   ├── apple-touch-icon.png
│   │   └── favicon.png
│   ├── manifest.json
│   └── sw.js
├── assets/
│   └── icons/                  ← 既存（マスター画像、アイコン生成のソース）
│       ├── app-icon-dark.png
│       └── app-icon-light.png
└── .claude/
    ├── plan.md
    └── next.md
```

未決事項:
- 複数画面（Home/Search/Saved/Settings）をマルチページ（`.html`複数）にするか、1つの`index.html`内でタブ切替するSPA的構成にするか。sg-weekend-appは後者（`index.html`1枚に`#screen-*`セクション切替方式）を採用。
- サーバーサイドの`src/routes/`等への分割は現段階では過剰の可能性。sg-weekend-appは単一`server.js`にAPIをベタ書きしており、肥大化したら分割する方が一貫性が高い。初期は`server.js`1ファイルに寄せる案とする。

## 6. データモデルの変更

新規プロジェクトのためデータモデル自体が存在しない。

- LTA DataMallのレスポンスは基本的にそのままプロキシする想定（サーバー側で独自スキーマに変換するかは未決）。
- 目的地登録・最近見たバス停履歴は、**ブラウザのlocalStorageで完結させる**か**サーバー側JSONファイル(`data/`)で永続化する**かが未決。デバイスローカルな個人設定という性質が強く、複数端末同期が要件でなければlocalStorageのみで足りる可能性が高い。

**Web版とApp Store版のデータ共有について**: 現時点でSGバスNaviはWeb版のみで、iOS App Store版はまだ存在しない（今回のタスクではCapacitor導入・iOS化はスコープ外）。したがって**今回の初期セットアップ時点ではWeb/iOS間のデータ共有・後方互換性の問題は発生しない**。ただし将来Capacitorでローカルバンドル方式のiOSアプリを作る場合、Web版と同一の`/api/*`・同一のデータ構造をそのまま参照することになるため、**初回リリース以降にAPIレスポンス構造やデータファイルのスキーマを変更する際は、後方互換性を必ず設計書に明記すること**を運用ルールとして留意する。

## 7. APIの変更

新規作成のため「変更」ではなく「新規作成」。想定する最小API（初期セットアップ段階でルーティングの型だけ用意し、実装は次フェーズ）:

- `GET /api/bus-arrival?stopCode=xxxx` — LTA DataMall `BusArrivalv2`のプロキシ。サーバー側でAPIキーを付与し、LTA側のレスポンスをそのまま（または軽く整形して）返す。
- `GET /api/bus-services` / `GET /api/bus-routes`（系統・経路図描画用、必要になった時点で追加）
- `GET /api/train-alerts`（MRT運行障害バナー用、必要になった時点で追加）

後方互換性についての指針: 現時点ではApp Store版が存在しないため初期スキーマに懸念はないが、将来の破壊的変更を避けられるよう余裕を持ったフィールド設計（例: `version`フィールドを含める等）が望ましい。

## 8. フロントエンドの変更

新規作成のため「変更」ではなく「新規実装」。詳細は次項のタスク分解を参照。

## 9. 「最初の一歩」タスク分解

1. **プロジェクト雛形作成**
   - `package.json`作成（`name`, `scripts.start`, `scripts.dev`、依存: `express`, `dotenv`, 必要なら`axios`/`express-rate-limit`）
   - `.gitignore`作成（`node_modules/`, `.env`, `data/`等）
   - `.env.example`作成（`LTA_DATAMALL_API_KEY=`, `PORT=`等）
   - `server.js`最小構成（Express起動、`public/`の静的配信、ポート番号は環境変数から）
   - ディレクトリ雛形作成

2. **デザイントークンCSS移植**
   - モックアップHTMLのCSS変数定義（`--surface-1`, `--surface-2`, `--text-primary`, `--text-accent`, `--fill-accent`, `--border`等）を`public/css/style.css`として抽出・整理
   - 注意: sg-weekend-appの既存変数命名（`--caramel`/`--sand`等）とは体系が異なるため、そのまま流用せずモックアップ独自の命名を採用する
   - Tabler Icons（`ti ti-*`）のCDN読み込み、またはローカルバンドルするかを決定
   - フォント選定（CLAUDE.mdに明記なし。「英語メイン」を踏まえ要検討）

3. **ホーム画面の静的UI実装**
   - モックアップHTMLをベースに`public/index.html`を作成（ダミーデータでのバスカード3件、ボトム4タブナビ、ヘッダーの「関連のみ」トグル、スワイプドット）
   - 経路モーダル、バス停検索タブの静的UIも同様に移植（実データ連携なし）
   - この時点ではJSは最小限（タブ切替・モーダル開閉等のUI操作のみ）

4. **LTA DataMall API連携**
   - LTA DataMall APIキーの取得（ユーザー側対応）
   - サーバー側に`/api/bus-arrival`等のプロキシルートを実装
   - フロントの`public/js/app.js`から`fetch('/api/bus-arrival?stopCode=...')`で取得しダミーデータを実データに差し替え
   - エラーハンドリング（キー未設定、LTA側エラー、不正パラメータ）

5. **PWA化**
   - `public/manifest.json`作成（アイコンは`assets/icons/`から各サイズを生成、`name`/`short_name`/`start_url`/`display: standalone`/`theme_color`/`background_color`）
   - `public/icons/`配下にアイコン生成
   - `public/sw.js`作成（キャッシュ戦略は要検討。バス到着時刻はリアルタイム性が重要）
   - `index.html`にmanifestリンク・Service Worker登録スクリプトを追加

6. **VPSデプロイ準備（実施はユーザー/infra担当）**
   - PM2の起動設定
   - nginx `bus.willoa.net`用serverブロック作成
   - DNS・SSL証明書設定

上記1〜5が後続タスクとして依頼可能な粒度。6はインフラ作業のためplannerの範囲外。

## 9.5 ユーザー決定事項（2026-09-12確定）

以下3点についてユーザー承認済み。以降のタスクはこの決定に従う。

1. **CSS変数命名**: sg-weekend-appの命名（`--caramel`/`--sand`/`--midnight`等）に合わせる。モックアップの`--surface-1`/`--text-accent`等はそのまま使わず、以下の対応方針で移植する（実際のトーン調整はCSS実装時に微調整可）:
   - `--text-accent` / `--fill-accent` / `--border-accent` → `--caramel`（#6F8F63、柳グリーン）
   - `--bg-accent-muted` → `--caramel-pale`（#EEF3EA）
   - `--on-accent` → `--cream`または白（アクセント背景上の文字色）
   - `--surface-2`（画面背景） → `--cream`
   - `--surface-1`（カード背景・浮いた面） → `--warm-white`
   - `--text-primary` → `--midnight`
   - `--text-secondary` → `--warm-gray`
   - `--text-muted` → `--light-gray`
   - `--border` / `--border-strong` → `--sand` / `--sand-dark`
   - ダークモード切り替えはsg-weekend-appの`app.css`にある`[data-theme="dark"]`相当のオーバーライドブロック（1544行目以降）をそのまま踏襲する
   - フォントは`--font-heading: 'Noto Sans JP', sans-serif'`を流用するか、英語メインのUIのため別途検討（未決のまま次フェーズへ）

2. **画面構成**: 単一HTML（`index.html`）+ JSによるタブ/セクション切替方式（SPA的構成）。sg-weekend-appと同一パターン。

3. **Tailwind CSS**: 導入しない。モックアップ同様、生のCSS変数+プレーンCSSで統一する。

## 10. リスク・未解決の質問

1. **CSS変数命名の不一致**: CLAUDE.mdは「about-shared.css相当のデザイントークンをそのまま流用」と書いているが、sg-weekend-appの実ファイルの変数名は`--caramel`/`--sand`/`--midnight`系であり、モックアップの`--surface-1`/`--text-accent`/`--fill-accent`とは命名が一致しない。
2. **画面構成（マルチページ vs SPA）**: モックアップが3つの独立したHTMLとして提示されたのか、1つのアプリ内タブとして提示されたのか。sg-weekend-appは単一`index.html`+セクション切替方式。
3. **Tailwind CSS利用の要否**: sg-weekend-appのCLAUDE.mdルールには「Tailwind CSSを使う」とあるが、モックアップ自体はプレーンCSS変数ベース。
4. **ポート番号・VPSリソース**: dosuru-app（sg-weekend-app）が使用中のポート番号、VPSの空きリソース状況は未確認。
5. **サーバー側データ永続化の要否**: 目的地登録・バス停履歴をサーバー側JSONで持つか、ブラウザのlocalStorageのみで完結させるか。
6. **LTA DataMallのレート制限・キャッシュ戦略**: 無料APIの具体的なレート制限値、サーバー側キャッシュのTTLは未決。
7. **オフライン時のService Worker戦略**: バス到着時刻はリアルタイム性が命のため、sg-weekend-appのnetwork-first方針をそのまま踏襲してよいか。
8. **認証機能の要否**: 現バージョンのCLAUDE.mdには認証に関する記載が一切ない。今回は明確にスコープ外とした。
9. **iOS化のタイミング**: 今回は完全にスコープ外。将来Capacitorでの導入が見込まれるが、次フェーズでの検討事項とする。
