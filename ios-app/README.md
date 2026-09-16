# SGBusNavi iOS アプリ — セットアップ手順

## 概要

このディレクトリにはCapacitorを使ったiOSアプリのビルド設定が入っています。
姉妹アプリSG在住Navi(sg-weekend-app)と同じ方式で、`release`ブランチへの
pushだけでGitHub Actions(macOSランナー)がビルドしTestFlightに自動アップロード
します。SGBusNaviはログイン・プッシュ通知・Google/Apple認証を使わないため、
sg-weekend-app側にあるそれらの複雑な設定(APNs bridge・Google Sign-Inスキーム
注入・プライバシーマニフェスト等)は不要で、その分シンプルな構成にしてあります。

証明書・プロビジョニングプロファイルは`fastlane match`は使わず、手動で作成した
ものをBase64エンコードしてGitHub Secretsに登録する方式です(実際に動いている
`.github/workflows/ios-deploy.yml`/`fastlane/Fastfile`がこの前提で書かれている
ため、ドキュメントもこちらに合わせています)。

---

## 初回セットアップ（Mac、またはApple Developer portal操作のみでOK）

### 前提条件

- Apple Developer Programに登録済みであること（$99/年）
- App IDを登録済みであること: `net.willoa.bus`(Certificates, Identifiers & Profiles → Identifiers)
- App Store ConnectでApp本体を作成済みであること（名前: SGBusNavi）

### 1. Distribution証明書の作成

Apple Developer portal → Certificates → 「+」→ **Apple Distribution** を選択して作成し、
`.cer`をダウンロード。Keychain Accessから秘密鍵とセットで`.p12`としてエクスポートします
(パスワードを設定、これが後の`DIST_CERT_PASSWORD`になります)。

### 2. App Store用プロビジョニングプロファイルの作成

Apple Developer portal → Profiles → 「+」→ **App Store Connect** を選択し、
App ID `net.willoa.bus`・上記のDistribution証明書を指定して作成します。
プロファイル名は **`sgbusnavi_appstore`** にしてください(`Fastfile`にこの名前がハードコードされています)。
`.mobileprovision`をダウンロードします。

### 3. 証明書・プロファイルをBase64化

```bash
base64 -i distribution.p12 | pbcopy       # DIST_CERT_BASE64
base64 -i sgbusnavi_appstore.mobileprovision | pbcopy   # PROVISION_PROFILE_BASE64
```

### 4. App Store Connect APIキーの作成

App Store Connect → ユーザとアクセス → 統合 → App Store Connect API →「+」で新規キーを作成し、
`.p8`ファイルをダウンロード(ダウンロードできるのは1回のみ)。Key ID・Issuer IDも控えておきます。

### 5. GitHub Secretsに登録

リポジトリの Settings → Secrets and variables → Actions に以下を登録:

| Secret名 | 内容 |
|---|---|
| `ASC_KEY_ID` | App Store Connect APIキーのID |
| `ASC_ISSUER_ID` | App Store Connect APIキーの発行者ID |
| `ASC_PRIVATE_KEY` | `.p8`ファイルの中身(改行含む文字列そのまま) |
| `DIST_CERT_BASE64` | 手順3でBase64化した`.p12`の中身 |
| `DIST_CERT_PASSWORD` | `.p12`エクスポート時に設定したパスワード |
| `PROVISION_PROFILE_BASE64` | 手順3でBase64化した`.mobileprovision`の中身 |
| `APPLE_TEAM_ID` | Apple DeveloperのTeam ID(developer.apple.com右上の所属チームから確認可) |

---

## 日常的なリリース手順

```bash
git checkout release
git merge main
git push origin release
```

pushすると自動で以下が実行されます: Capacitorのios追加→アイコン/スプラッシュ生成→
`pod install`→最低iOSバージョン15.0への引き上げ(ITMS-90068対応)→ビルド→
TestFlightへアップロード(内部テストのみ、`distribute_external: false`)。

外部テスターへの公開・本番App Store提出は、TestFlight/App Store Connect側の
画面から別途手動で行います(このワークフローは内部テスト用ビルドのアップロードまで)。

---

## アイコン・スプラッシュ画像について

| ファイル | サイズ | 備考 |
|---|---|---|
| `resources/icon.png` | 1024×1024px | `assets/icons/app-icon-light.png`から生成済み |
| `resources/splash.png` | 2732×2732px | 背景`#FAFAF8`(--cream)+中央にアイコン、生成済み |
| `resources/splash-dark.png` | 2732×2732px | 背景`#2B2B27`(--midnight)+中央にアイコン、生成済み |

デザインを変更する場合は`assets/icons/app-icon-light.png`を差し替え、
プロジェクトルートでsharpを使って同様に再生成してください。

---

## トラブルシューティング

### Xcodeビルドが失敗する場合

ローカルでMacがあれば`cd ios-app && npx cap sync ios`を実行してから再度試してください。
CI環境ではワークフローが毎回`npx cap add ios`から作り直すため、通常は状態が残りません。

### 証明書エラーが出る場合

`DIST_CERT_BASE64`/`PROVISION_PROFILE_BASE64`のGitHub Secretsが正しくBase64化されているか、
プロファイル名が`sgbusnavi_appstore`と完全一致しているか確認してください。
