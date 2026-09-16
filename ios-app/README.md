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

## 初回セットアップ（Macなしで完結する方法・実績あり）

SGBusNavi 1.0.0はMacを一切使わず、Linux上のOpenSSLコマンドとApple Developer
portal(ブラウザ操作のみ)だけで証明書・プロビジョニングプロファイルを作成し、
TestFlightへのアップロードまで成功させました。以下はその実際の手順です
(Keychain Accessの代わりにOpenSSLでCSR/`.p12`を作る、という発想の置き換えが
すべてです)。

### 前提条件

- Apple Developer Programに登録済みであること（$99/年）
- App IDを登録済みであること: `net.willoa.bus`(Certificates, Identifiers & Profiles → Identifiers)
- App Store ConnectでApp本体を作成済みであること（名前: SGBusNavi）

### 1. CSR(証明書署名要求)をOpenSSLで作成 — Mac不要

Keychain Accessの「証明書アシスタント」の代わりに、ローカル(Linuxでも可)で以下を実行します。

```bash
openssl genrsa -out ios_distribution.key 2048
openssl req -new -key ios_distribution.key -out ios_distribution.csr \
  -subj "/emailAddress=oguworld@gmail.com/CN=WILLOA PTE. LTD./C=SG"
```

**`ios_distribution.key`(秘密鍵)は証明書が実際に発行され、TestFlightアップロードが
成功するまで絶対に削除しないこと。** この鍵は証明書と1対1で紐づいており、鍵を失うと
証明書ごと失効させてCSR作成からやり直しになります(実際にこのミスを1回やり、証明書の
失効・プロビジョニングプロファイルの作り直しが発生しました)。

### 2. Distribution証明書の作成(ブラウザのみ)

Apple Developer portal → Certificates → 「+」→ **Apple Distribution** を選択し、
手順1で作った`ios_distribution.csr`をアップロードして作成、`.cer`をダウンロードします。

### 3. `.p12`へのバンドル — `-legacy`フラグが必須

```bash
openssl x509 -inform DER -in distribution.cer -out distribution.pem -outform PEM
openssl pkcs12 -export -legacy \
  -inkey ios_distribution.key \
  -in distribution.pem \
  -out distribution.p12 \
  -passout pass:<任意のパスワード、これが DIST_CERT_PASSWORD>
```

**`-legacy`を付け忘れると失敗します。** OpenSSL 3.0以降は`.p12`のデフォルト暗号化が
AES-256-CBCになっており、これをmacOS側(fastlaneが内部で呼ぶ`security`コマンド、
`SecKeychainItemImport`)がインポートできず、CI上で
`SecKeychainItemImport: One or more parameters passed to a function were not valid`
というエラーで失敗します。`-legacy`を付けると旧来の
`pbeWithSHA1And40BitRC2-CBC`/`pbeWithSHA1And3-KeyTripleDES-CBC`方式になり、
macOS側で問題なくインポートできます(実機のCIログで原因特定・解決済み)。

### 4. App Store用プロビジョニングプロファイルの作成(ブラウザのみ)

Apple Developer portal → Profiles → 「+」→ **App Store Connect** を選択し、
App ID `net.willoa.bus`・手順2で作ったDistribution証明書を指定して作成します。
プロファイル名は **`sgbusnavi_appstore`** にしてください(`Fastfile`にこの名前がハードコードされています)。
`.mobileprovision`をダウンロードします。

証明書を作り直した場合(鍵を失った等)、既存のプロファイルは無効になるため、
プロファイルも必ず作り直してください。

### 5. 証明書・プロファイルをBase64化

Macがない場合はLinux/WSLの`base64`コマンドでも同じ結果になります(`pbcopy`の代わりに
ファイル出力してそこからコピーするだけ)。

```bash
base64 -w0 distribution.p12 > dist_cert_base64.txt                    # DIST_CERT_BASE64
base64 -w0 sgbusnavi_appstore.mobileprovision > provision_base64.txt  # PROVISION_PROFILE_BASE64
```

(Mac環境なら`base64 -i distribution.p12 | pbcopy`のように`pbcopy`で直接クリップボードへ)

### 6. App Store Connect APIキーの作成

App Store Connect → ユーザとアクセス → 統合 → App Store Connect API →「+」で新規キーを作成し、
`.p8`ファイルをダウンロード(ダウンロードできるのは1回のみ)。Key ID・Issuer IDも控えておきます。

### 7. GitHub Secretsに登録

`gh secret set`でコマンドラインから登録できます(GitHub CLIログイン済みが前提)。

```bash
gh secret set ASC_KEY_ID --repo oguworld/sg-bus-navi --body "<Key ID>"
gh secret set ASC_ISSUER_ID --repo oguworld/sg-bus-navi --body "<Issuer ID>"
gh secret set ASC_PRIVATE_KEY --repo oguworld/sg-bus-navi < AuthKey_XXXXXXXXXX.p8
gh secret set DIST_CERT_BASE64 --repo oguworld/sg-bus-navi < dist_cert_base64.txt
gh secret set DIST_CERT_PASSWORD --repo oguworld/sg-bus-navi --body "<手順3で設定したパスワード>"
gh secret set PROVISION_PROFILE_BASE64 --repo oguworld/sg-bus-navi < provision_base64.txt
gh secret set APPLE_TEAM_ID --repo oguworld/sg-bus-navi --body "<Team ID>"
```

または、リポジトリの Settings → Secrets and variables → Actions からブラウザで登録:

| Secret名 | 内容 |
|---|---|
| `ASC_KEY_ID` | App Store Connect APIキーのID |
| `ASC_ISSUER_ID` | App Store Connect APIキーの発行者ID |
| `ASC_PRIVATE_KEY` | `.p8`ファイルの中身(改行含む文字列そのまま) |
| `DIST_CERT_BASE64` | 手順5でBase64化した`.p12`の中身 |
| `DIST_CERT_PASSWORD` | `.p12`エクスポート時に設定したパスワード |
| `PROVISION_PROFILE_BASE64` | 手順5でBase64化した`.mobileprovision`の中身 |
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

### `SecKeychainItemImport: One or more parameters passed to a function were not valid`

`.p12`エクスポート時に`-legacy`フラグを付け忘れているのが原因です。上記「初回セットアップ
手順3」を参照し、`-legacy`付きで`.p12`を作り直し、Base64化→`DIST_CERT_BASE64`を更新してください
(秘密鍵`ios_distribution.key`と証明書`distribution.cer`さえ残っていれば、Apple Developer
portalでの再作成は不要です)。

### バージョン番号について

`ios-app/package.json`の`version`(例: `1.0.0`)がアプリのマーケティングバージョンとして
Fastfileから読み込まれます。ビルド番号(`CFBundleVersion`)は`github.run_number`
(`BUILD_NUMBER`環境変数)から自動採番されるため、**同じ`version`のままpushを繰り返しても
ビルド番号は毎回自動で増え、TestFlightへの再アップロードに支障はありません**。
`version`自体を上げる必要があるのは、App Store審査に提出する新しいマーケティング
バージョンとして公開したいときだけです(TestFlightでの内部テスト段階では上げなくてよい)。
