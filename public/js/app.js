/*
 * SGBusNavi — フロントエンドUIロジック
 *
 * ステップ3: 画面切替・モーダル開閉・フィルタートグルの見た目操作
 * ステップ4: LTA DataMall API連携（/api/bus-arrival から実データ取得しバスカード描画）
 * フェーズ2 タスク4: GPS取得とホーム画面連携（/api/bus-stops/nearby との連携）
 * フェーズ2 タスク5: 横スワイプ・ドットインジケーター連携
 *
 * 2026-09-13: ボトムナビの「Search」タブおよびSearch画面を削除（ユーザー指示、
 * 実質使われていなかったため）。ボトムナビはHome/Saved/Settingsの3タブ構成。
 * バス停検索ロジック（/api/bus-stops/search）自体は目的地登録の「By Bus Stop」
 * タブで引き続き使用しているため、サーバー側API・関連関数の一部は残置している。
 *
 * 注意（本番環境の制約）:
 * - navigator.geolocation はセキュアコンテキスト（HTTPS）または localhost でのみ
 *   動作する。ローカル開発（http://localhost:3010）では動作するが、
 *   本番（bus.willoa.net）では必ずHTTPS配信すること。
 */
(function () {
  'use strict';

  /* ══════════════════════════════════════════════
   * ネイティブアプリ(Capacitor)判定とAPIベースURL
   *
   * 2026-09-16実機(TestFlight)で発見・修正: ネイティブアプリはCapacitorの
   * webDir設定により静的アセットをアプリバンドル内にローカル同梱している
   * (server.urlを指定していないため)。そのためWebViewのoriginは実サーバー
   * (bus.willoa.net)ではなくcapacitor://localhost相当のローカルオリジンになり、
   * fetch('/api/...')のような相対パスは実サーバーではなくこのローカル
   * オリジンに対して発行されてしまい、必ず失敗する(ユーザー指摘「位置情報取れない」
   * →実際はGPS取得自体は成功しており、後続の/api/bus-stops/nearby呼び出しが
   * 全滅していたのが真因だった)。SG在住Navi（sg-weekend-app/public/app.js
   * の_isCapacitorApp/API_BASE）と同じパターンで、ネイティブアプリ内では
   * 本番オリジンを明示的に絶対URLとして先頭に付与する。
   * ══════════════════════════════════════════════ */
  const _isCapacitorApp = Boolean(
    window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
  );
  const API_BASE = _isCapacitorApp ? 'https://bus.willoa.net' : '';

  /* ══════════════════════════════════════════════
   * ネイティブアプリ内の外部/自サイトリンク（2026-09-17実機で発見・修正）
   *
   * ユーザー指摘「アプリ版のWebサイトのリンクがおかしい」で発見: Settings画面の
   * 「Website」・Shareシートの「Website」リンクは`href="/about"`という相対パスの
   * ままだった。ネイティブアプリはCapacitorのローカルバンドル同梱構成
   * （webDirにserver.url未指定、上記API_BASEと同じ理由）のため、WebViewの
   * originはbus.willoa.netではなくローカルオリジンになり、`/about`（拡張子なし、
   * サーバー側express routeとして存在するだけでローカルバンドルには同名ファイルが
   * ない）へのリンクはローカルには存在せず読み込みに失敗していた。
   * 加えて、たとえURLを絶対パス化しても、ネイティブアプリのWebViewを外部サイトへ
   * そのまま遷移させると、standalone PWAで先に発見した「戻るボタンがなく元の
   * アプリに戻れない」不具合(2026-09-14)のネイティブ版になってしまう
   * （ブラウザのタブ・戻るボタンに相当するUIが一切ないため）。
   * sg-weekend-app（姉妹アプリ）と同じ`@capacitor/browser`プラグインで
   * in-appブラウザ（システム標準の「完了」ボタンで確実にアプリへ戻れる）として
   * 開くことで両方を解決する。対象はアプリ内でサイト外へ誘導するリンクのみ
   * （それ以外はJSによる画面遷移のみのSPAのため対象なし。2026-09-17、Willoa本体・
   * 姉妹アプリSG在住Naviへの相互リンクを追加した際も同じ対応が必要なため対象に追加）。
   * ══════════════════════════════════════════════ */
  if (_isCapacitorApp) {
    document.addEventListener('click', (event) => {
      const anchor = event.target.closest(
        '#settings-website-link, #settings-privacy-link, #settings-support-link, ' +
          '#settings-willoa-link, #settings-sister-app-link, .share-sheet-link'
      );
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!href) return;
      event.preventDefault();
      const absoluteUrl = /^https?:\/\//i.test(href) ? href : API_BASE + href;
      if (window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
        window.Capacitor.Plugins.Browser.open({ url: absoluteUrl });
      }
    });
  }

  // GPSタイムアウト（ミリ秒）。plan.md 4節の「8〜10秒案」を踏まえ10秒に設定。
  const GPS_TIMEOUT_MS = 10000;

  // 粗い位置（Wi-Fi/セルタワーベース、enableHighAccuracy:false）用の短いタイムアウト。
  // 2026-09-17ユーザー指示: 高精度GPSの初回取得は数秒〜10秒かかることがあるため、
  // まず粗い位置で素早く暫定表示し、高精度の結果が届き次第正確な結果に差し替える
  // 段階的取得を導入した（initGpsLocation()参照）。
  const GPS_FAST_TIMEOUT_MS = 5000;

  // 2026-09-17ユーザー指摘「Google Mapとかは一瞬で現在地が出る」で発見: 従来maximumAge
  // を指定しておらず(Web版のデフォルト実装で0扱い)、OS側に直近の位置情報がキャッシュ
  // 済みでも毎回必ず新規に位置を計算させていたため、他の地図アプリの体感速度に
  // 大きく劣っていた。粗い位置は最大1分・高精度GPSも直近10秒以内のキャッシュがあれば
  // 許容し、OSキャッシュがあれば即座に返るようにする(不正確になるリスクは、歩行者が
  // 10秒〜1分でバス停を跨いで移動することは稀なため許容範囲と判断)。
  const GPS_FAST_MAX_AGE_MS = 60000;
  const GPS_ACCURATE_MAX_AGE_MS = 10000;

  // 2026-09-17ユーザー指示「アプリを立ち上げた瞬間に現在地が分かるようにしたい」
  // →「粗くていいので最短で大まかな場所を取り、その後詳細な情報で上書きしていく
  // 段階的なやつがいい」。OS側のGPS/位置情報キャッシュ(上記maximumAge)だけでなく、
  // アプリ自身も直近成功した座標をlocalStorageに保存しておき、起動直後は
  // GPS/位置情報の取得すら待たずに即座にその座標でバス停一覧を表示する
  // （その後、通常通り粗い位置→高精度GPSの結果で静かに上書きされる3段階構成）。
  // 到着時刻自体は鮮度が命のため、キャッシュするのは座標のみで到着情報は
  // 毎回必ずサーバーから取り直す（stale become敵なので古いバス到着時刻を
  // 表示することは絶対に避ける）。
  const LAST_LOCATION_STORAGE_KEY = 'sgbusnavi_last_location';
  const LAST_LOCATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7日

  function saveLastLocation(lat, lng) {
    try {
      window.localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify({ lat, lng, ts: Date.now() }));
    } catch (err) {
      // 起動高速化のための補助的なキャッシュのため、保存失敗は無視してよい
      // （保存できなくても通常のGPS取得フローにフォールバックするだけで実害はない）
    }
  }

  function loadLastLocation() {
    try {
      const raw = window.localStorage.getItem(LAST_LOCATION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed.lat !== 'number' ||
        typeof parsed.lng !== 'number' ||
        typeof parsed.ts !== 'number'
      ) {
        return null;
      }
      if (Date.now() - parsed.ts > LAST_LOCATION_MAX_AGE_MS) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  // 近傍バス停の取得件数（横スワイプで2番目以降まで使う）。当初3件固定
  // だったが、ユーザー指摘「反対側もあるし3つだとちょっと少ないかも」を受け
  // 5件に増やした(2026-09-14)。道路の反対側(逆方向)のバス停も別エントリとして
  // 候補に挙がるため、3件だと同じ場所の往復2方向+αですぐ埋まってしまい
  // 選択肢が狭かった。
  const NEARBY_LIMIT = 5;

  // GPSで取得した近傍バス停（距離昇順、最大NEARBY_LIMIT件）。横スワイプでの
  // 「2番目以降に近いバス停への切替」に使うため、モジュールスコープに保持する。
  let nearbyStops = [];

  // 現在表示中の近傍バス停配列内でのインデックス（0 = 最寄り）。
  // 次ステップの横スワイプ実装が参照できるよう今回から用意しておく。
  let currentStopIndex = 0;

  // 現在Home画面に表示中のバス停の完全な情報（BusStopCode/Description/
  // Latitude/Longitude）。GPS検出・スワイプいずれの経路で表示中でも
  // 同じ変数から取り出せるよう、バス停切替の全経路（loadNearbyStopsAndArrivals/
  // switchToStopIndex）で更新する（フェーズ5第8-3節、
  // Home画面への目的地追加ボタンの実装に使用）。
  let currentDisplayedStop = null;

  // 目的地ハイライトピッカー（2026-09-21新規）: 選択中の目的地id
  // （loadDestinations()の各エントリのid）。nullは未選択（ハイライトなし）。
  // セッション内のみ保持し、localStorageへの永続化はしない（旧「関連のみ」
  // フィルターと同方針）。initHighlightPicker()/selectHighlightDestination()参照。
  let highlightDestinationId = null;

  /* ══════════════════════════════════════════════
   * フェーズ6: Home画面 地図パネル
   * （.claude/plan-phase6-map-timetable-toggle.md 2-1節〜2-12節、8節、10節）
   * 2026-09-20: Arrivals/Timetable切替は廃止し、Timetableのみの単一ビューに
   * なった（Approachingバーとの1画面統合、CLAUDE.md画面構成節参照）。
   * ══════════════════════════════════════════════ */

  // Leafletの地図インスタンス（モジュールスコープで使い回す、経路モーダルの
  // routeModalMapInstanceと同じパターン）。
  let homeMapInstance = null;
  let homeMapCurrentMarker = null;
  let homeMapStopMarkers = []; // { marker, index }[]

  /* ══════════════════════════════════════════════
   * ボトムナビによる画面切替
   * ══════════════════════════════════════════════ */

  // 指定した画面（'home' / 'saved' / 'settings'）に切り替える。
  // ボトムナビのクリック等、複数の経路から呼べるよう共通化している。
  //
  // フェーズ4 タスク分解ステップ6（出発演出用の自動ポーリング）: Home以外に
  // 切り替わった間は無駄なAPI呼び出しを避けるためポーリングを止め、Homeに
  // 戻ったら再開する（.claude/plan.md 第2-6節）。
  function switchToScreen(target) {
    if (!target) return;

    const screens = document.querySelectorAll('.screen');
    const navItems = document.querySelectorAll('.bottom-nav-item');

    screens.forEach((screen) => {
      screen.classList.toggle('visible', screen.id === `screen-${target}`);
    });

    navItems.forEach((navItem) => {
      navItem.classList.toggle('active', navItem.getAttribute('data-screen') === target);
    });

    isHomeScreenActive = target === 'home';

    // Homeタップ時は、横スワイプで2番目・3番目のバス停に移動していても
    // 必ず最寄り(0番目)のバス停表示に戻す（2026-09-13ユーザー指示）。
    if (target === 'home') {
      switchToStopIndex(0);

      // 2026-09-14ユーザー指示「Arrivalを押した時に上のバス停の横スクロール
      // も一番左に戻して」対応。switchToStopIndex(0)はcurrentStopIndexが
      // 既に0の場合(早期return)何もしないため、ピル行のスクロール位置だけ
      // 右にずれたまま残ってしまう不具合があった。スクロール位置のリセットは
      // switchToStopIndex()の早期returnと無関係に、ここで確実に行う。
      const stopPillRow = document.getElementById('stop-pill-row');
      if (stopPillRow) stopPillRow.scrollTo({ left: 0, behavior: 'smooth' });

      // 2026-09-21ユーザー指摘「Homeを押した時、Approachingバーの横スクロール
      // が元に戻っていない」対応。同じ理由でカード一覧の縦スクロール位置も
      // 併せてリセットする（他のバス停まで下にスクロールした状態のまま
      // Homeタブに戻ると、切り替わった内容が画面外になってしまうため）。
      const homeScrollContent = document.getElementById('home-scroll-content');
      if (homeScrollContent) homeScrollContent.scrollTo({ top: 0, behavior: 'smooth' });
      resetApproachingBarScroll();

      // Saved画面で目的地を追加・削除した後にHomeへ戻った場合に備え、
      // ハイライトピッカーボタンの表示/非表示・ラベルを最新の状態に同期する。
      updateHighlightButtonUI();
    }
  }

  function initBottomNav() {
    const navItems = document.querySelectorAll('.bottom-nav-item');

    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const target = item.getAttribute('data-screen');
        switchToScreen(target);

        // 2026-09-14ユーザー指示「経路モーダル画面にもボトムメニュー出す
        // ようにして」対応。route-modal-overlayがボトムナビ分の高さを避けて
        // 表示されるようになった結果、モーダル表示中でもナビをタップできて
        // しまうため、タップ時はモーダルを閉じてから画面遷移した状態に揃える
        // （モーダルを開いたまま背後の画面だけ切り替わる不整合を防ぐ）。
        const routeModalOverlay = document.getElementById('route-modal-overlay');
        if (routeModalOverlay) routeModalOverlay.classList.remove('visible');
      });
    });
  }

  /* ══════════════════════════════════════════════
   * 経路モーダルの開閉・実地図(Leaflet)ベースのルート表示
   * Timetable行は動的に描画されるため、リスナーは
   * イベント委譲（home-timetable-list への委譲）で登録する。
   *
   * 2026-09-13改修: 従来の模式的な直線SVG図から、実際のシンガポール地図上に
   * 実座標（/api/bus-routes/path、全停留所のStopSequence順の緯度経度）で
   * ルートをプロットする方式に変更（ユーザー指示「地図をベースにきちっとプロット」）。
   * ルート線を目立たせるため、地図タイルは標準OSMより明度の高い
   * CartoDB Positron（薄いグレースケール基調）を使用する。
   * ══════════════════════════════════════════════ */

  // ローディング表示（回転アイコンは既存のti-loader-2アイコンパターンを流用。
  // 経路モーダルは小さい領域のため、Home画面のrenderLoadingStateよりコンパクトにする）
  function buildRouteStatusLoadingHtml() {
    return `
      <div class="route-modal-status">
        <i class="ti ti-loader-2" aria-hidden="true"></i>
        <p>Loading route information…</p>
      </div>
    `;
  }

  // 取得失敗時（404/503/ネットワークエラー等）のフォールバック表示。
  function buildRouteStatusFallbackHtml(message) {
    return `
      <div class="route-modal-status">
        <i class="ti ti-map-off" aria-hidden="true"></i>
        <p>${message || 'Unable to load route information'}</p>
      </div>
    `;
  }

  // 経路モーダルのLeaflet地図インスタンス（モジュールスコープで使い回す。
  // 一度だけ生成し、以後は既存インスタンスをクリアして再利用する方式）。
  let routeModalMapInstance = null;
  let routeModalPolyline = null;
  let routeModalPolylineCasing = null;
  let routeModalMarkers = [];

  function ensureRouteModalMap() {
    if (routeModalMapInstance) return routeModalMapInstance;
    if (typeof window.L === 'undefined') return null; // Leaflet未読み込み（CDN障害等）

    const mapEl = document.getElementById('route-modal-map-el');
    if (!mapEl) return null;

    const map = window.L.map(mapEl, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: false,
      dragging: true,
    }).setView(MAP_INITIAL_CENTER, MAP_INITIAL_ZOOM);

    // 2026-09-14実機で発見・修正: CartoDB Positron（light_all）タイルは
    // 「API KEY REQUIRED」の透かし入りで配信されるようになっており本番で
    // 使用できなかった（CARTOの無認証アクセスが制限された模様）。
    // 標準の無認証OSMタイルに戻し、代わりにCSSフィルター（grayscale/
    // brightness/saturate、.route-modal-map-el参照）で薄いグレースケール
    // 調の見た目を再現する（ユーザー指示「地図の色をもっと薄くして」は
    // このCSSフィルターで引き続き満たす）。
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    routeModalMapInstance = map;
    return map;
  }

  // 直前に描画したポリライン・始点/終点マーカーを消してから新しいルートを描く
  // （モーダルを開くたびに同じ地図インスタンスへ描き直すため）。
  function clearRouteModalLayers() {
    if (!routeModalMapInstance) return;
    if (routeModalPolylineCasing) {
      routeModalMapInstance.removeLayer(routeModalPolylineCasing);
      routeModalPolylineCasing = null;
    }
    if (routeModalPolyline) {
      routeModalMapInstance.removeLayer(routeModalPolyline);
      routeModalPolyline = null;
    }
    routeModalMarkers.forEach((marker) => routeModalMapInstance.removeLayer(marker));
    routeModalMarkers = [];
  }

  // /api/bus-routes/pathのレスポンス（{lat,lng}[]）を実地図上にプロットする。
  // isLoopの場合、起点=終点のためポリラインが自然に輪の形になる
  // （サーバー側でfromStopCode===toStopCodeを「ループ全体」として扱うよう対応済み）。
  // waypoints（summary.waypoints、mrtColor/Latitude/Longitude付き）のうち
  // MRT駅であるものを、その路線の色の丸＋駅名ラベルで地図上にプロットする
  // （2026-09-14ユーザー指示「路線の色の駅名＋路線の色の〇がいい」）。
  // destinationByStopCodeが渡された場合、登録済み目的地に一致するMRT駅は
  // ラベルを目的地のアイコン色で強調する（2026-09-14ユーザー指示
  // 「自分の目的地がある場合は、そこもハイライトしてほしい」）。
  function addMrtWaypointMarkers(map, waypoints, destinationByStopCode) {
    if (!Array.isArray(waypoints)) return;

    // 2026-09-14ユーザー指示「セーブしているバス停は経路図の地図にも必ず
    // 表示したい」対応。従来はmrtColorありのwaypointのみをマーカー表示して
    // いたが、登録済み目的地に一致するwaypoint(reason: 'saved_destination'、
    // MRT駅ではない一般のバス停)も表示対象に含める。
    const plottable = waypoints.filter(
      (wp) =>
        wp &&
        (wp.mrtColor || wp.reason === 'saved_destination') &&
        wp.Latitude != null &&
        wp.Longitude != null
    );

    // 2026-09-14ユーザー指摘「見にくいところない？」で発見: MRT駅同士が
    // 地理的に近接する区間（例: The Nexus付近のBeauty World StnとKing
    // Albert Pk Stn）では、ラベルが常に丸の右側に伸びる作りのため互いに
    // 重なって読めなくなっていた（現在地ラベルとの重なり対策(direction:'top')
    // は別途対応済みだが、MRT駅ラベル同士の重なりは未対応だった）。直前の
    // マーカーと画面上のピクセル距離が近い場合、ラベルを反対側(左)に出す
    // ことで重なりを軽減する（3駅以上が連続で近接する場合も交互に切り替わる）。
    // 判定は実距離(メートル)ではなく画面上のピクセル距離で行う: 当初メートル
    // 基準(350m)で実装したが、King Albert Pk StnとBeauty World Stn Exit Cは
    // 実距離約930mも離れているにも関わらず、この経路のズーム倍率では画面上
    // わずか数十pxしか離れておらずラベルが重なる実例があった。ズーム倍率は
    // 経路ごとにfitBounds()が動的に決めるため、実距離では正しく判定できない
    // （呼び出し元でfitBounds()の後にこの関数を呼ぶよう順序も修正済み）。
    const PROXIMITY_THRESHOLD_PX = 70;
    let prevPoint = null;
    let labelOnLeft = false;

    plottable.forEach((wp) => {
      const point = map.latLngToContainerPoint([wp.Latitude, wp.Longitude]);
      if (prevPoint) {
        const dx = point.x - prevPoint.x;
        const dy = point.y - prevPoint.y;
        const pixelDist = Math.sqrt(dx * dx + dy * dy);
        labelOnLeft = pixelDist < PROXIMITY_THRESHOLD_PX ? !labelOnLeft : false;
      }
      prevPoint = point;

      const dest = destinationByStopCode ? destinationByStopCode.get(wp.BusStopCode) : null;
      const isDestMatch = Boolean(dest);
      const dotColor = isDestMatch
        ? getCategoryColorHex(normalizeDestinationIconColor(dest.iconColor)) || wp.mrtColor
        : wp.mrtColor;
      const labelText = isDestMatch && dest.title && dest.title.trim() ? escapeHtml(dest.title.trim()) : (wp.Description || '');
      const dotSize = isDestMatch ? 14 : 9;
      // 2026-09-14ユーザー指摘「Saveした地点は太字か何かでもっと目立たせて」対応。
      // 通常のMRT駅は文字色のみの控えめなラベルのままだが、登録済み目的地に
      // 一致する経由地だけは背景を塗りつぶした実心のバッジにして、地図が
      // 薄い色調になった分と合わせて視認性のコントラストを強める。
      const labelHtml = isDestMatch
        ? `<span class="route-modal-mrt-label route-modal-mrt-label--dest" style="background:${dotColor};">${labelText}</span>`
        : `<span class="route-modal-mrt-label" style="color:${wp.mrtColor};">${labelText}</span>`;
      const classNames = [
        'route-modal-mrt-marker',
        isDestMatch ? 'route-modal-mrt-marker--dest' : '',
        labelOnLeft ? 'route-modal-mrt-marker--label-left' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const icon = window.L.divIcon({
        className: classNames,
        html:
          `<span class="route-modal-mrt-dot" style="background:${dotColor}; width:${dotSize}px; height:${dotSize}px;"></span>` +
          labelHtml,
        iconSize: null,
      });
      const marker = window.L.marker([wp.Latitude, wp.Longitude], { icon }).addTo(map);
      routeModalMarkers.push(marker);
    });
  }

  function renderRouteModalMap(path, waypoints, origin, destination) {
    const map = ensureRouteModalMap();
    const mapEl = document.getElementById('route-modal-map-el');
    const statusEl = document.getElementById('route-modal-status');
    if (!map || !mapEl) {
      if (statusEl) statusEl.innerHTML = buildRouteStatusFallbackHtml('Unable to load the map');
      return;
    }

    clearRouteModalLayers();

    if (statusEl) statusEl.innerHTML = '';
    mapEl.hidden = false;

    // モーダルが直前まで非表示（display:none）だった場合、Leafletが
    // 誤ったコンテナサイズを記憶しないよう、表示直後にinvalidateSizeする。
    map.invalidateSize();

    const latLngs = path.map((point) => [point.lat, point.lng]);
    // 2026-09-14: 一度はMRT東西線(EWL)の路線色（緑系）との混同を避けるため
    // ニュートラルな濃色（--midnight）に変更していたが、ユーザーから改めて
    // 「経路は柳グリーンにして」との指示があったため、アプリ共通のアクセント
    // カラー（--fill-accent、系統番号バッジ等と同じ柳グリーン）に戻した。
    // MRT駅マーカーの文字色は路線色をそのまま使うため、地図タイルにだけ
    // CSSフィルターをかける方式（.route-modal-map-el .leaflet-tile-pane参照）
    // に変更済みで、経路線・MRT色が薄まって視認性が落ちる問題は解消している。
    const routeLineColor = window.getComputedStyle(document.documentElement).getPropertyValue('--fill-accent').trim() || '#6F8F63';

    // 2026-09-14ユーザー指摘「地図をもっと薄い色にして経路とMRTの表示を目立たせて」
    // 対応。地図タイル自体を大きく薄くした分、経路線が背景に溶け込まないよう
    // 白い縁取り（ケーシング）を経路線の下に一回り太く敷いてコントラストを出す。
    routeModalPolylineCasing = window.L.polyline(latLngs, {
      color: '#FAFAF8',
      weight: 9,
      opacity: 0.9,
    }).addTo(map);
    routeModalPolyline = window.L.polyline(latLngs, { color: routeLineColor, weight: 5, opacity: 0.95 }).addTo(map);

    // 2026-09-14ユーザー指摘: 出発点(緑)と終点(路線色と同じ濃色)が色だけでは
    // 見分けづらいとのことで、出発点=青い丸(現在地の定番配色)、終点=濃色のピン
    // アイコン(丸ではなく形自体を変える)にして、色と形の両方で区別できるようにした。
    // 当初は目的地パレットの--category-color-blueを流用していたが、
    // 2026-09-14の目的地パレット刷新(MRT路線色との衝突回避)でblueキー自体を
    // 廃止したため、現在地マーカー専用の--current-location-blueに切り替えた
    // （目的地カテゴリ色とは無関係の「現在地」という別概念のため独立させる）。
    const startColor = window.getComputedStyle(document.documentElement).getPropertyValue('--current-location-blue').trim() || '#5B84A8';
    const startMarker = window.L.circleMarker(latLngs[0], {
      radius: 8,
      color: '#FFFFFF',
      weight: 3,
      fillColor: startColor,
      fillOpacity: 1,
    }).addTo(map);
    routeModalMarkers.push(startMarker);

    // 2026-09-14ユーザー指摘「現在地点(最寄駅)と終点も黒い文字で表示して」対応。
    // 既存のマーカー(丸・ピン)自体の座標アンカーはそのままに、Leafletの
    // permanentツールチップで黒文字ラベルを添える(MRT駅マーカーのような
    // 独自divIconへの作り替えは不要で、既存マーカーの座標精度も保てる)。
    if (origin && origin.Description) {
      // 2026-09-14ユーザー指摘「ラベルの重なり」対応。direction:'right'だと、
      // MRT駅マーカーのラベルも同じくドットの右側に伸びる作りのため、現在地が
      // 近隣のMRT駅と地理的に近い場合に両者のラベルが重なって読めなくなって
      // いた(例:「The Nexus」と「Beauty World Stn Exit C」)。現在地ラベルだけ
      // 上方向に出すことで、右方向に伸びるMRT駅ラベルとの衝突を避ける。
      startMarker
        .bindTooltip(origin.Description, {
          permanent: true,
          direction: 'top',
          offset: [0, -10],
          className: 'route-modal-endpoint-tooltip',
        })
        .openTooltip();
    }

    if (latLngs.length > 1) {
      // 2026-09-14実機で発見・修正: 読み込んでいる@tabler/icons-webfontには
      // "-filled"系のアイコン(塗りつぶし版)が一切含まれておらず(アウトライン系
      // のみ収録)、ti-map-pin-filledは存在しないクラスのため終点ピンが
      // 何も描画されない(グリフなし)状態になっていた。実在するti-map-pin
      // (アウトライン)に修正。
      const endIcon = window.L.divIcon({
        className: 'route-modal-end-marker',
        html: '<i class="ti ti-map-pin" aria-hidden="true"></i>',
        iconSize: [26, 26],
        iconAnchor: [13, 24],
      });
      const endMarker = window.L.marker(latLngs[latLngs.length - 1], { icon: endIcon }).addTo(map);
      routeModalMarkers.push(endMarker);

      if (destination && destination.Description) {
        endMarker
          .bindTooltip(destination.Description, {
            permanent: true,
            direction: 'top',
            offset: [0, -24],
            className: 'route-modal-endpoint-tooltip',
          })
          .openTooltip();
      }
    }

    // 登録済み目的地に一致する経由地はMRT駅マーカーで強調表示する
    // （2026-09-14ユーザー指示「自分の目的地がある場合はそこもハイライトして
    // ほしい」）。
    const destinationByStopCode = new Map(
      loadDestinations()
        .filter((dest) => dest.busStopCode)
        .map((dest) => [dest.busStopCode, dest])
    );

    // 2026-09-14ユーザー指摘「ラベルの重なり・文字切れ」対応。従来のpadding
    // (24px一律)では、現在地マーカーの黒文字ラベル(right方向にはみ出す)が
    // ちょうど境界付近の停留所と重なって読めなくなる実害があった(例:
    // 「The Nexus」の現在地ラベルが「Beauty World Stn Exit C」に重なる)。
    // ラベル分の余白を確保するため上下左右のpaddingを拡大する。
    //
    // フェーズ8（.claude/plan-phase8-arrivals-grid-and-modal.md）で経路
    // モーダルをフルスクリーンから中央配置の小さいカード(max-height:78vh、
    // 地図は.route-modal-mapのflex:2分のみ)に変更したことに伴い、地図の
    // 実高さがフルスクリーン時よりかなり小さくなった。[50,60]のままだと
    // 縦方向の余白(合計120px)が地図の実高さに対して相対的に大きくなり、
    // 短い区間でも不必要に大きくズームアウトしてしまうため、値を控えめに
    // 調整した（ラベル文字切れ対策としての余白確保自体は維持しつつ縮小）。
    map.fitBounds(routeModalPolyline.getBounds(), { padding: [36, 44] });

    // addMrtWaypointMarkers()はマーカー同士の画面上のピクセル距離で近接判定を
    // 行うため、ズーム・中心が確定するfitBounds()の後に呼ぶ必要がある
    // （2026-09-14ユーザー指摘「見にくいところない？」で発見・修正。以前は
    // fitBounds()より前に呼んでいたため、緯度経度の実距離ベースで近接判定を
    // していたが、地図のズーム倍率によって同じ実距離でも画面上の重なり方が
    // 大きく変わるため誤判定していた。例: King Albert Pk StnとBeauty World
    // Stn Exit Cは実距離約930mも離れているが、この経路のズーム倍率では
    // 画面上わずか数十pxしか離れておらずラベルが重なっていた）。
    addMrtWaypointMarkers(map, waypoints, destinationByStopCode);
  }

  // 地図下部に、実際に停車する全てのバス停を停車順に縦積みリストで表示する
  // （2026-09-14ユーザー指示「地図のサイズを画面の2/3くらいにして、下の1/3は
  // バス停のリストを止まる順に表示してほしい」）。従来はMRT駅・登録済み目的地
  // のみに絞った代表ウェイポイント(2〜3件)のピルタグ表示だったが、地図を
  // 画面の2/3に固定した分できた下部の余白を使い、/api/bus-routes/pathが
  // 返す区間内の全停留所(stops、2026-09-14追加)をそのまま停車順に並べる。
  // MRT駅名の停留所は路線色、登録済み目的地に一致する停留所はそのアイコン色+
  // カテゴリアイコンで引き続き強調する。現在地・終点の行には専用タグを添える。
  function renderRouteModalStopList(stops, destinationByStopCode, currentStopCode, destinationStopCode) {
    const el = document.getElementById('route-modal-stop-list');
    if (!el) return;

    const list = Array.isArray(stops) ? stops : [];
    if (list.length === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    const rowsHtml = list
      .map((stop) => {
        const dest = destinationByStopCode ? destinationByStopCode.get(stop.BusStopCode) : null;
        const isCurrent = stop.BusStopCode === currentStopCode;
        const isDestination = stop.BusStopCode === destinationStopCode;

        const rowClasses = ['route-modal-stop-row'];
        if (dest) rowClasses.push('route-modal-stop-row--dest');

        let dotStyle = '';
        let nameHtml = escapeHtml(stop.Description || '');

        if (dest) {
          const colorKey = normalizeDestinationIconColor(dest.iconColor);
          const hex = getCategoryColorHex(colorKey) || 'var(--fill-accent)';
          const category = normalizeDestinationCategory(dest.category);
          const label = dest.title && dest.title.trim() ? escapeHtml(dest.title.trim()) : escapeHtml(stop.Description || '');
          dotStyle = ` style="background:${hex};"`;
          nameHtml = `${DESTINATION_CATEGORY_ICON_SVG[category]}<span style="color:${hex};">${label}</span>`;
        } else if (stop.mrtColor) {
          dotStyle = ` style="background:${stop.mrtColor};"`;
          nameHtml = `<span style="color:${stop.mrtColor};">${nameHtml}</span>`;
        }

        let tagHtml = '';
        if (isCurrent) tagHtml = '<span class="route-modal-stop-tag">You are here</span>';
        else if (isDestination) tagHtml = '<span class="route-modal-stop-tag">Destination</span>';

        return (
          `<div class="${rowClasses.join(' ')}">` +
          `<span class="route-modal-stop-connector"><span class="route-modal-stop-dot"${dotStyle}></span></span>` +
          `<span class="route-modal-stop-text">${nameHtml}${tagHtml}</span>` +
          `</div>`
        );
      })
      .join('');

    el.hidden = false;
    el.innerHTML = `
      <div class="route-modal-stop-list-caption">Stops in order</div>
      <div class="route-modal-stop-list-inner">${rowsHtml}</div>
    `;
  }

  // /api/bus-routes/summary?serviceNo=&direction= を取得する。
  // v3/BusArrivalにDirectionフィールドが存在しないため（plan.md 2-2節）、
  // direction=1を先に試し、originCode/destinationCodeと一致しなければ
  // direction=2を試す（circular routeはdestinationCodeのみで判定）。
  //
  // 経路モーダル（initRouteModal）・星アイコンハイライト（applyRouteEnrichment）の
  // 両方がdirection特定に同じロジックを必要とするため、モジュールスコープの
  // 共通関数として切り出している。
  //
  // fromStopCode（省略可、2026-09-14追加）: 現在地のバス停コード。渡すと
  // サーバー側がwaypoints選定を「現在地より後〜終点の手前まで」に絞り込む。
  // ユーザー指摘「経路モーダルにまだ通過していない手前のMRT駅が表示される」
  // で発見・修正（fromStopCodeなしだと経路全体からwaypointsが選ばれるため、
  // 現在地より手前のMRT駅も選定対象に含まれてしまっていた）。
  async function fetchRouteSummary(serviceNo, originCode, destinationCode, fromStopCode) {
    async function fetchDirection(direction) {
      const fromParam = fromStopCode ? `&fromStopCode=${encodeURIComponent(fromStopCode)}` : '';
      const response = await fetch(
        API_BASE + `/api/bus-routes/summary?serviceNo=${encodeURIComponent(serviceNo)}&direction=${direction}${fromParam}`
      );
      if (!response.ok) return null;
      return response.json();
    }

    const first = await fetchDirection(1);
    if (first && destinationCode && first.destination && first.destination.BusStopCode === destinationCode) {
      return first;
    }
    if (first && originCode && first.origin && first.origin.BusStopCode === originCode) {
      return first;
    }

    const second = await fetchDirection(2);
    if (second) return second;

    // どちらの方向でも取得できなかった場合、direction=1の結果があれば
    // （突き合わせに失敗しただけの可能性があるため）フォールバックとして使う。
    return first;
  }

  // 指定の系統・方向が、渡されたバス停コード群のいずれかを実際に経由するかを
  // /api/bus-routes/contains-stopで判定し、一致したもののみ返す。経路モーダルの
  // 地図・経由地リストに登録済み目的地を追加表示するために使う
  // （2026-09-14ユーザー指示、cardMatchesAnyDestination()と同じエンドポイントを
  // 利用するがカード側とは呼び出しタイミングが異なるため別関数として切り出す）。
  // fromStopCode（現在地）を渡すことで、地図に描画される区間（現在地→終点）の
  // 外側にある「すでに通過済みの目的地」を誤って一致扱いしないようにする
  // （2026-09-14ユーザー指摘「逆方向なのに光ってます」で発見・修正。fromStopCode
  // なしだと、地図の描画区間外の目的地マーカーが経路線から浮いて表示される
  // 実害があった）。
  //
  // 戻り値を{ matchedStopCodes, positions }に拡張(2026-09-14追加)。positionsは
  // /api/bus-routes/summaryのwaypoints（stopIndex付き）とマージした後、実際に
  // バスが経由する順に並べ替えるために使う（ユーザー指摘「経路って通っていく
  // 順番に並べて欲しい」対応）。
  async function fetchMatchedSavedDestinationStopCodes(serviceNo, direction, destinationStopCodes, fromStopCode) {
    if (!destinationStopCodes || destinationStopCodes.length === 0) return { matchedStopCodes: [], positions: {} };
    try {
      const stopCodesParam = destinationStopCodes.join(',');
      const response = await fetch(
        API_BASE + `/api/bus-routes/contains-stop?serviceNo=${encodeURIComponent(serviceNo)}` +
          `&direction=${direction}&stopCodes=${encodeURIComponent(stopCodesParam)}` +
          `&fromStopCode=${encodeURIComponent(fromStopCode || '')}`
      );
      if (!response.ok) return { matchedStopCodes: [], positions: {} };
      const data = await response.json();
      const results = data.results || {};
      const matchedStopCodes = Object.keys(results).filter((code) => results[code] === true);
      return { matchedStopCodes, positions: data.positions || {} };
    } catch (err) {
      return { matchedStopCodes: [], positions: {} };
    }
  }

  function initRouteModal() {
    const overlay = document.getElementById('route-modal-overlay');
    const closeBtn = document.getElementById('route-modal-close');
    const titleEl = document.getElementById('route-modal-title');
    const badgeEl = document.getElementById('route-modal-badge');
    const statusEl = document.getElementById('route-modal-status');
    const mapEl = document.getElementById('route-modal-map-el');

    if (!overlay) return;

    // openModal呼び出しのたびにインクリメントし、fetch完了時に自分が最新の
    // 呼び出しかどうかを確認する（連続タップ時に古いレスポンスで
    // 新しいモーダル内容を上書きしないようにするため）。
    let requestToken = 0;

    function showStatus(html) {
      if (statusEl) statusEl.innerHTML = html;
      if (mapEl) mapEl.hidden = true;
    }

    async function openModal(card) {
      const from = card.getAttribute('data-route-from') || '';
      const to = card.getAttribute('data-route-to') || '';
      const number = card.getAttribute('data-route-number') || '';
      const originCode = card.getAttribute('data-origin-code') || '';
      const destinationCode = card.getAttribute('data-destination-code') || '';
      // 2026-09-14ユーザー指示「出発から終点までじゃなくて現在地から終点までに
      // して欲しい」対応。originCode（LTAのNextBus.OriginCode、＝バスの発車地点＝
      // 路線全体の起点）は現在地とは限らないため、地図・タイトルには代わりに
      // 「今ユーザーが立っているバス停」(data-current-stop-code)を使う。
      const currentStopCode = card.getAttribute('data-current-stop-code') || originCode;

      if (titleEl) titleEl.textContent = from ? `${from} → ${to}` : to;
      if (badgeEl) {
        const badgeNumberEl = document.getElementById('route-modal-badge-number');
        if (badgeNumberEl) badgeNumberEl.textContent = number;
        // 2026-09-14ユーザー指摘「路線番号バッジは前の画面(Arrivals)とあわせて」
        // 対応。Home画面のバスカード(buildBusCard)と同じ配色(ニュートラル、
        // アクセント緑ではない)・4文字以上の系統番号での縮小ルールに揃える。
        badgeEl.className = number.length >= 4 ? 'bus-badge bus-badge--long' : 'bus-badge';

        // 2026-09-21ユーザー指摘「経路モーダルのバッジがHomeのハイライトと
        // 連動していない」対応。タップ元の行が選択中目的地でハイライトされて
        // いる(.tt-row--highlight)場合、モーダルのバッジにも同じ色を反映する。
        // 選択中の目的地は常に1件のみのため（2026-09-21目的地ハイライト
        // ピッカー刷新）、getCurrentHighlightColorHex()で全体共通の色を
        // 取得するだけでよく、旧仕様のようなカード側状態の複製は不要。
        const isHighlighted = card.classList.contains('tt-row--highlight');
        const highlightHex = isHighlighted ? getCurrentHighlightColorHex() : null;
        if (highlightHex) {
          const selectedDestination = loadDestinations().find((dest) => dest.id === highlightDestinationId);
          const label = selectedDestination
            ? (selectedDestination.title && selectedDestination.title.trim()
                ? selectedDestination.title.trim()
                : selectedDestination.description)
            : '';
          badgeEl.style.background = highlightHex;
          badgeEl.style.color = 'var(--on-accent)';
          if (label) {
            badgeEl.setAttribute('aria-label', `Passes ${label}`);
            badgeEl.setAttribute('title', label);
          }
        } else {
          badgeEl.style.background = '';
          badgeEl.style.color = '';
          badgeEl.removeAttribute('aria-label');
          badgeEl.removeAttribute('title');
        }
      }
      showStatus(buildRouteStatusLoadingHtml());

      overlay.classList.add('visible');

      requestToken += 1;
      const currentToken = requestToken;

      if (!number) {
        showStatus(buildRouteStatusFallbackHtml('Unable to load route information'));
        return;
      }

      try {
        const summary = await fetchRouteSummary(number, originCode, destinationCode, currentStopCode);

        // 連続タップ等でこの呼び出しが古くなっていた場合は描画しない
        if (currentToken !== requestToken) return;

        if (!summary) {
          showStatus(buildRouteStatusFallbackHtml('Route information is being prepared'));
          return;
        }

        // 現在地(currentStopCode)の表示名を解決する。currentDisplayedStop
        // （今画面に表示中のバス停）が一致すればそれを使い、念のためnearbyStops
        // （バス停切替ピル行の候補）もフォールバックとして確認する。
        const currentStopInfo =
          (currentDisplayedStop && currentDisplayedStop.BusStopCode === currentStopCode
            ? currentDisplayedStop
            : null) || nearbyStops.find((stop) => stop.BusStopCode === currentStopCode) || null;
        const currentStopName = (currentStopInfo && currentStopInfo.Description) || from;

        if (titleEl) {
          if (summary.isLoop) {
            titleEl.textContent = `${number} Loop via ${summary.loopDesc || ''}`;
          } else if (summary.destination) {
            titleEl.textContent = `${currentStopName} → ${summary.destination.Description || to}`;
          }
        }

        const destinationStopCode = summary.destination && summary.destination.BusStopCode;

        if (!currentStopCode || !destinationStopCode) {
          showStatus(buildRouteStatusFallbackHtml('Unable to load route information'));
          return;
        }

        const pathResponse = await fetch(
          API_BASE + `/api/bus-routes/path?serviceNo=${encodeURIComponent(number)}` +
            `&direction=${encodeURIComponent(summary.direction)}` +
            `&fromStopCode=${encodeURIComponent(currentStopCode)}` +
            `&toStopCode=${encodeURIComponent(destinationStopCode)}`
        );

        if (currentToken !== requestToken) return;

        if (!pathResponse.ok) {
          showStatus(buildRouteStatusFallbackHtml('Unable to load route information'));
          return;
        }

        const pathData = await pathResponse.json();
        const path = Array.isArray(pathData.path) ? pathData.path : [];
        const fullStops = Array.isArray(pathData.stops) ? pathData.stops : [];

        if (currentToken !== requestToken) return;

        if (path.length === 0) {
          showStatus(buildRouteStatusFallbackHtml('Unable to load route information'));
          return;
        }

        // 2026-09-14ユーザー指示「セーブしているバス停がある場合は経路図の
        // 地図についても必ず表示したい」対応。カード側(applyRouteEnrichment)と
        // 同じ仕組みで、サーバー選定のwaypoints(MRT駅・ランドマークのみ)に
        // 実際に一致した登録済み目的地を追加でマージしてから地図に渡す。
        const allDestinations = loadDestinations();
        const destinationByStopCode = new Map(
          allDestinations.filter((dest) => dest.busStopCode).map((dest) => [dest.busStopCode, dest])
        );
        const destinationStopCodes = allDestinations.map((dest) => dest.busStopCode).filter(Boolean);
        const { matchedStopCodes, positions: matchedPositions } = await fetchMatchedSavedDestinationStopCodes(
          number,
          summary.direction,
          destinationStopCodes,
          currentStopCode
        );

        if (currentToken !== requestToken) return;

        const mergedWaypoints = sortWaypointsByStopIndex(
          mergeSavedDestinationWaypoints(
            summary.waypoints,
            matchedStopCodes,
            destinationByStopCode,
            [currentStopCode, destinationStopCode],
            matchedPositions
          )
        );

        renderRouteModalMap(
          path,
          mergedWaypoints,
          { BusStopCode: currentStopCode, Description: currentStopName },
          summary.destination
        );

        // 2026-09-14ユーザー指示「下の1/3はバス停のリストを止まる順に表示
        // してほしい」対応。地図側は引き続きMRT駅・登録済み目的地のみの
        // 代表waypointsを表示するが、下部のリストは区間内の全停留所(fullStops)
        // を停車順のまま表示する。
        renderRouteModalStopList(fullStops, destinationByStopCode, currentStopCode, destinationStopCode);
      } catch (err) {
        if (currentToken !== requestToken) return;
        showStatus(buildRouteStatusFallbackHtml('Unable to load route information'));
      }
    }

    function closeModal() {
      overlay.classList.remove('visible');
    }

    // フェーズ6・2-12節: Timetableビューの各行は横幅が狭くカードのような
    // 専用ボタンを置く余地がないため、系統番号バッジ自体（.tt-badge）を
    // タップすると同じ経路モーダルを開く。
    const timetableList = document.getElementById('home-timetable-list');
    if (timetableList) {
      timetableList.addEventListener('click', (event) => {
        const row = event.target.closest('.tt-row');
        if (row) openModal(row);
      });
      timetableList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('.tt-row');
        if (!row) return;
        event.preventDefault();
        openModal(row);
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', closeModal);
    }

    // オーバーレイの背景クリックでも閉じる（モーダル本体クリックでは閉じない）
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeModal();
      }
    });
  }

  /* ══════════════════════════════════════════════
   * 目的地一致ハイライト（星アイコンバッジ・Approachingバーの強調表示）の
   * 対象要素収集。2026-09-20「関連のみ」フィルタートグル廃止・Arrivals廃止に
   * 伴い、対象は#home-timetable-list .tt-rowのみになった（旧仕様は当時の
   * フェーズ4カード由来のdata-route-number等の属性をtt-rowにも持たせて
   * 既存関数を使い回す設計だったが、その名残の属性名はそのまま踏襲している）。
   * ══════════════════════════════════════════════ */
  function collectEnrichableElements() {
    const timetableList = document.getElementById('home-timetable-list');
    return timetableList ? Array.from(timetableList.querySelectorAll('.tt-row')) : [];
  }

  // 指定カード1件について、登録済み目的地のいずれか1つでも経由するかを判定する。
  // 判定不能（方向特定失敗・API失敗等）の場合はnullを返し、呼び出し元が
  // 「安全側で表示する」フォールバックを選べるようにする。
  //
  // フェーズ4 タスク分解ステップ2改修: 戻り値をboolean/nullから
  // { matched, matchedStopCodes, summary } 形式のオブジェクトに拡張した。
  // - matched: true/false/null（従来と同じ意味）
  // - matchedStopCodes: 実際に一致した登録済み目的地のバス停コード配列
  //   （目的地一致タグ「Passes {バス停名}」の表示に使う。呼び出し元で
  //   loadDestinations()のエントリと突き合わせてdescriptionを解決する）
  // - summary: fetchRouteSummary()の結果をそのまま含める。ミニ経路図の
  //   中間点（waypoints）表示にも同じ結果を使い回し、系統単位で
  //   fetchRouteSummaryを2回呼ばないようにするため（N+1回避）。
  // - matchedPositions: 一致した目的地のstops配列内絶対位置（2026-09-14追加）。
  //   summary.waypointsのstopIndexと直接比較可能で、ミニ経路図タグを実際の
  //   経由順に並べ替えるために使う。
  async function cardMatchesAnyDestination(card, destinationStopCodes) {
    const serviceNo = card.getAttribute('data-route-number') || '';
    const originCode = card.getAttribute('data-origin-code') || '';
    const destinationCode = card.getAttribute('data-destination-code') || '';
    const currentStopCode = card.getAttribute('data-current-stop-code') || '';

    if (!serviceNo) return { matched: null, matchedStopCodes: [], matchedPositions: {}, summary: null };

    // 経路モーダルと同じ2回fetch方式でdirectionを特定する
    // （fetchRouteSummaryはsummary.directionにその結果を含めて返す）。
    const summary = await fetchRouteSummary(serviceNo, originCode, destinationCode, currentStopCode);
    if (!summary || summary.direction === undefined || summary.direction === null) {
      return { matched: null, matchedStopCodes: [], matchedPositions: {}, summary: summary || null };
    }

    try {
      const stopCodesParam = destinationStopCodes.join(',');
      // 2026-09-14ユーザー指摘「逆方向（すでに保存バス停は通り過ぎてる）のに
      // 光ってます。これからいくときだけハイライトさせたい」対応。
      // fromStopCode（現在地）を渡し、まだ通過していない（現在地以降にある）
      // 目的地のみを一致対象とする。
      const response = await fetch(
        API_BASE + `/api/bus-routes/contains-stop?serviceNo=${encodeURIComponent(serviceNo)}` +
          `&direction=${summary.direction}&stopCodes=${encodeURIComponent(stopCodesParam)}` +
          `&fromStopCode=${encodeURIComponent(currentStopCode)}`
      );
      if (!response.ok) return { matched: null, matchedStopCodes: [], matchedPositions: {}, summary };

      const data = await response.json();
      const results = data.results || {};
      const matchedStopCodes = Object.keys(results).filter((code) => results[code] === true);
      // OR判定: いずれか1つでもtrueなら関連あり
      return { matched: matchedStopCodes.length > 0, matchedStopCodes, matchedPositions: data.positions || {}, summary };
    } catch (err) {
      return { matched: null, matchedStopCodes: [], matchedPositions: {}, summary };
    }
  }

  /* ══════════════════════════════════════════════
   * フェーズ4 タスク分解ステップ1に伴う改修:
   * フィード転換により1系統1カードから複数枚（同一系統が複数到着インスタンス分
   * カードとして存在しうる）に変わったため、目的地一致判定（cardMatchesAnyDestination）
   * を系統ごとに1回だけ実行し、その結果を同一系統の全カードに一貫して適用する。
   *
   * groupCardsByServiceNo(): 表示中の全カードを系統番号（data-route-number）で
   * グルーピングする。判定自体は各グループの代表カード1枚に対してのみ行う
   * （同一系統内はOriginCode/DestinationCodeも同一のため、代表1枚の判定結果を
   * そのグループの全カードに適用してよい）。
   * ══════════════════════════════════════════════ */
  function groupCardsByServiceNo(cards) {
    const groups = new Map(); // serviceNo -> Array<HTMLElement>
    cards.forEach((card) => {
      const serviceNo = card.getAttribute('data-route-number') || '';
      if (!groups.has(serviceNo)) groups.set(serviceNo, []);
      groups.get(serviceNo).push(card);
    });
    return groups;
  }

  /* ══════════════════════════════════════════════
   * 系統単位のルート情報キャッシュ（フェーズ4 タスク分解ステップ2）
   *
   * cardMatchesAnyDestination()はfetchRouteSummary（direction特定）+
   * /api/bus-routes/contains-stopの2回のAPI呼び出しを伴う。
   * 目的地一致判定（星ハイライト・目的地一致タグ）と
   * ミニ経路図の中間点（waypoints）表示はいずれも「系統単位で1回だけ
   * fetchRouteSummaryすれば済む」情報を必要とするため、系統番号(ServiceNo)を
   * キーにPromiseをキャッシュし、同一系統の複数到着インスタンス・複数の
   * 呼び出し元（フィルター/ハイライト/ミニ経路図）の間で使い回す。
   *
   * バス停切替（loadBusArrivals）のたびにclearServiceRouteInfoCache()で
   * 破棄する（系統・方向の組み合わせがバス停ごとに変わりうるため、
   * 古いバス停の結果を次のバス停に誤って適用しないようにする）。
   * ══════════════════════════════════════════════ */
  let serviceRouteInfoCache = new Map(); // serviceNo -> Promise<{matched, matchedStopCodes, summary}>

  function clearServiceRouteInfoCache() {
    serviceRouteInfoCache = new Map();
  }

  // 指定系統番号のルート情報（目的地一致判定+summary）を取得する。
  // 同一系統に対して2回目以降の呼び出しはキャッシュ済みPromiseを返すため、
  // fetchRouteSummary/contains-stopは系統ごとに実質1回しか発生しない。
  function getOrFetchServiceRouteInfo(serviceNo, representativeCard, destinationStopCodes) {
    if (serviceRouteInfoCache.has(serviceNo)) {
      return serviceRouteInfoCache.get(serviceNo);
    }
    const promise = cardMatchesAnyDestination(representativeCard, destinationStopCodes || []);
    serviceRouteInfoCache.set(serviceNo, promise);
    return promise;
  }

  /* ══════════════════════════════════════════════
   * ミニ経路図（縦並びテキストリスト版、静的表示のみ）
   * （.claude/plan.md 第2-2節「5. ミニ経路図」・第2-3節・第2-5節・第3-1節・第8-1節）
   *
   * フェーズ5第8-1節（Home画面改善1）: 従来の水平線+ドットのSVG表示を廃止し、
   * origin・waypoints（最大3件）・destinationを縦に並んだ地名リストとして
   * 表示する（合計3〜5件想定）。
   * - 始点: 現在表示中のバス停（ヘッダーに表示中のcurrentStopName）
   * - 中間地点（最大3件）: fetchRouteSummaryの結果（summary.waypoints）。
   *   0件・取得失敗時は中間地点なしの始点→終点の2行のみにする。
   * - 終点: 到着インスタンスのDestinationName（card data-route-to属性から取得）
   *
   * 2026-09-13 不具合修正: 実機テストで「マップのトグルボタンは要らない。
   * ルートの表示方法はまた後で考える」というユーザー指示を受け、従来あった
   * 「Map ⌄」トグルリンク・タップでのLeaflet地図パネル展開機能を削除し、
   * 縦並びの地名リストのみのシンプルな静的表示に戻した。card自体（button要素、
   * 経路モーダル起動）へのクリック伝播を止めるevent.stopPropagation()は
   * トグル機能自体の削除に伴い不要になったため、リスナーごと削除済み。
   *
   * 地図初期化ロジック（ensureMiniRouteMap/initMiniRouteLeafletMap/
   * renderMiniRouteMapFallback/miniRouteMapState）は、将来的に経路表示方法を
   * 再検討する際に再利用する可能性があるため、呼び出し元（renderMiniRoute内の
   * トグルUI・クリックイベント）のみ削除し、関数定義自体はあえて残している
   * （現時点ではどこからも呼ばれない未使用コードになる）。
   * ══════════════════════════════════════════════ */

  // カードごとの地図パネル初期化状態を保持する（現在未使用、上記コメント参照）。
  // key: .bus-card-mini-route要素 -> { map: L.Map|null, requested: boolean }
  // requestedは「初期化処理を開始済みか」を示し、初回タップ後の連打で
  // 二重にfetch/L.map()が走らないようにするためのガード。
  const miniRouteMapState = new WeakMap();

  let miniRouteMapIdCounter = 0;

  // /api/bus-routes/path のレスポンス（{lat,lng}[]）からLeafletインスタンスを
  // 生成する（mockups/home-card-redesign-v4.html initMap()相当）。
  // 現在未使用（上記コメント参照、将来のミニ経路図の地図表示再検討用に残置）。
  function initMiniRouteLeafletMap(mapEl, path, colorVar) {
    const color = window.getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim() || '#6F8F63';
    const map = window.L.map(mapEl, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    const latLngs = path.map((point) => [point.lat, point.lng]);
    const line = window.L.polyline(latLngs, { color, weight: 4 }).addTo(map);
    window.L.circleMarker(latLngs[0], { radius: 6, color, fillColor: color, fillOpacity: 1 }).addTo(map);
    window.L.circleMarker(latLngs[latLngs.length - 1], {
      radius: 6,
      color: '#2B2B27',
      fillColor: '#2B2B27',
      fillOpacity: 1,
    }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [20, 20] });
    return map;
  }

  // 地図パネルに「読み込めませんでした」のフォールバック表示を出す
  // （.claude/plan.md 第4節失敗系: 地図用の座標取得APIが失敗・タイムアウトした
  // 場合でもカード全体の表示は妨げない）。現在未使用（上記コメント参照）。
  function renderMiniRouteMapFallback(mapEl, message) {
    mapEl.innerHTML = `
      <div class="bus-card-map-fallback">
        <i class="ti ti-map-off" aria-hidden="true"></i>
        <span>${message}</span>
      </div>
    `;
  }

  // ミニ経路図タップ時、初回のみ/api/bus-routes/pathを叩いてLeaflet地図を
  // 生成する。2回目以降のタップでは既存のmapインスタンスをそのまま使い回す
  // （invalidateSize()でパネル再表示時のサイズ崩れのみ補正する）。
  // 現在未使用（上記コメント参照、renderMiniRoute()からの呼び出しを削除済み）。
  async function ensureMiniRouteMap(routeEl, mapEl, serviceNo, currentStopCode, isMatch) {
    let state = miniRouteMapState.get(routeEl);
    if (!state) {
      state = { map: null, requested: false };
      miniRouteMapState.set(routeEl, state);
    }

    if (state.map) {
      // 既存インスタンスを使い回す。開閉のCSSトランジション分だけ
      // わずかに遅らせてからinvalidateSize()する（mockup v4と同様）。
      setTimeout(() => state.map.invalidateSize(), 300);
      return;
    }

    if (state.requested) return; // 初回リクエストが進行中（連打対策）
    state.requested = true;

    if (!serviceNo || !currentStopCode) {
      renderMiniRouteMapFallback(mapEl, 'Unable to load map');
      return;
    }

    const cachedPromise = serviceRouteInfoCache.get(serviceNo);
    if (!cachedPromise) {
      renderMiniRouteMapFallback(mapEl, 'Unable to load map');
      return;
    }

    try {
      const routeInfo = await cachedPromise;
      const summary = routeInfo && routeInfo.summary;
      const direction = summary ? summary.direction : null;
      const destinationStopCode = summary && summary.destination ? summary.destination.BusStopCode : null;

      if (direction === undefined || direction === null || !destinationStopCode) {
        renderMiniRouteMapFallback(mapEl, 'Unable to load map');
        return;
      }

      const response = await fetch(
        API_BASE + `/api/bus-routes/path?serviceNo=${encodeURIComponent(serviceNo)}` +
          `&direction=${encodeURIComponent(direction)}` +
          `&fromStopCode=${encodeURIComponent(currentStopCode)}` +
          `&toStopCode=${encodeURIComponent(destinationStopCode)}`
      );

      if (!response.ok) {
        renderMiniRouteMapFallback(mapEl, 'Unable to load map');
        return;
      }

      const data = await response.json();
      const path = Array.isArray(data.path) ? data.path : [];

      if (path.length === 0 || !window.L) {
        renderMiniRouteMapFallback(mapEl, 'Unable to load map');
        return;
      }

      const colorVar = isMatch ? '--caramel' : '--warm-gray';
      state.map = initMiniRouteLeafletMap(mapEl, path, colorVar);
    } catch (err) {
      renderMiniRouteMapFallback(mapEl, 'Unable to load map');
    }
  }

  // MRT駅1件分のピルタグHTMLを組み立てる（2026-09-13カードデザイン刷新:
  // 縦5行のドットリストは情報が縦に散らばり密度を下げていたため、
  // SG在住Naviのカテゴリタグを参考にした丸ピル型タグの横並び(折り返しあり)に変更。
  // 2026-09-14ユーザー指示で始点・終点タグを廃止し、MRT駅のタグのみに絞った）。
  // MRT駅タグの路線色連動は2026-09-14に廃止した: 目的地一致タグ(塗りつぶし色)と
  // 実際のMRT路線色(赤・青等)が同一カード内で同時に主張し「色が多すぎる」との
  // 指摘があったため、カード上ではMRT駅タグをニュートラルなテキスト表示に統一し、
  // 色は目的地一致タグだけに絞った。ユーザー指示「この画面でのMRTの駅名の色付けは
  // やめたいと思います」。**経路モーダル側(renderRouteModalWaypointsList・地図の
  // MRTマーカー)はこの対象外で、路線色付きのまま維持する**方針(「ルートを押した
  // 時の画面ではやっぱりMRTの色付きの情報は残してください」との明示指示)。
  //
  // 2026-09-14ユーザー指示「経由地はMRTの情報だけになっているが、セーブして
  // いるバス停がある場合はそれも必ず表示したい」により、登録済み目的地に
  // 一致する経由地（wp.reason === 'saved_destination'）も表示対象に含めた。
  // 目的地一致タグは経路モーダルの強調タグと同じ「アイコン色で塗りつぶし+
  // カテゴリアイコン」の実心バッジにして、MRT駅タグ（文字色のみ）と区別する。
  // 「目立ちすぎるので薄めのラベルに」との指摘で一時的に薄色化、さらに
  // 「系統の色付けをやめる、バッジだけでいい」でタグ自体の色連動を一旦廃止
  // したが、2026-09-14「ごめん逆です、経路のピルの色はそのままでいいです。
  // 経路の番号(バッジ)の方の色連動がグレーでいい」との訂正を受け、**タグの
  // 色連動は復活**し、系統番号バッジ側（renderMatchTag）だけをニュートラルに
  // する方針に確定した。
  function buildMiniRouteTagHtml(wp) {
    if (wp.reason === 'saved_destination' && wp.matchedDestination) {
      const dest = wp.matchedDestination;
      const colorKey = normalizeDestinationIconColor(dest.iconColor);
      const hex = getCategoryColorHex(colorKey) || 'var(--fill-accent)';
      const category = normalizeDestinationCategory(dest.category);
      const label = dest.title && dest.title.trim() ? escapeHtml(dest.title.trim()) : (wp.Description || '');
      const bg = lightenHexColor(hex, 0.82);
      return (
        `<span class="bus-card-mini-route-tag bus-card-mini-route-tag--dest" style="background:${bg}; color:${hex};">` +
        `${DESTINATION_CATEGORY_ICON_SVG[category]}${label}</span>`
      );
    }
    return `<span class="bus-card-mini-route-tag">${wp.Description || ''}</span>`;
  }

  // 登録済み目的地オブジェクトから、waypoints配列に混ぜ込める形式のエントリを
  // 組み立てる。サーバー側selectWaypoints()はMRT駅・ランドマークしか選ばない
  // ため、目的地が普通のバス停（MRT駅ではない）だった場合は経路上を実際に
  // 通っていても一切表示されない問題があった（2026-09-14ユーザー指摘）。
  // stopIndex（2026-09-14追加）: /api/bus-routes/contains-stopのpositionsから
  // 取得したstops配列内の絶対位置。summary.waypointsのstopIndexと直接比較可能
  // で、表示順を実際の経由順に揃えるために使う。
  function buildSavedDestinationWaypoint(dest, stopIndex) {
    return {
      BusStopCode: dest.busStopCode,
      Description: dest.description,
      reason: 'saved_destination',
      mrtLine: null,
      mrtColor: null,
      Latitude: dest.lat,
      Longitude: dest.lng,
      matchedDestination: dest,
      stopIndex: typeof stopIndex === 'number' ? stopIndex : null,
    };
  }

  // 経由地の表示順を実際にバスが経由する順（stopIndex昇順）に並べ替える。
  // stopIndexが不明（null）なものは末尾に回す（2026-09-14ユーザー指摘「経路って
  // 通っていく順番に並べて欲しい」対応。従来は目的地一致タグが常に先頭に固定
  // 表示され、MRT駅タグとの並び順が実際の経由順と無関係だった）。
  function sortWaypointsByStopIndex(waypoints) {
    return waypoints.slice().sort((a, b) => {
      const aIndex = typeof a.stopIndex === 'number' ? a.stopIndex : Infinity;
      const bIndex = typeof b.stopIndex === 'number' ? b.stopIndex : Infinity;
      return aIndex - bIndex;
    });
  }

  // サーバーが選定したwaypoints（MRT駅・ランドマークのみ）に、実際に一致した
  // 登録済み目的地を追加でマージする。既に同一BusStopCodeが含まれる場合、
  // および除外対象（経路の起点・終点など、別途エンドポイント表示があるため
  // 重複表示になるもの）は追加しない。positions（2026-09-14追加）は
  // /api/bus-routes/contains-stopが返すBusStopCode→stopIndexのマップ。
  function mergeSavedDestinationWaypoints(waypoints, matchedStopCodes, destinationByStopCode, excludeStopCodes, positions) {
    const base = Array.isArray(waypoints) ? waypoints : [];
    const existingCodes = new Set(base.map((wp) => wp.BusStopCode));
    const exclude = new Set(excludeStopCodes || []);
    const positionMap = positions || {};
    const extra = (matchedStopCodes || [])
      .filter((code) => code && !existingCodes.has(code) && !exclude.has(code))
      .map((code) => {
        const dest = destinationByStopCode.get(code);
        return dest ? buildSavedDestinationWaypoint(dest, positionMap[code]) : null;
      })
      .filter(Boolean);
    return base.concat(extra);
  }

  // 2026-09-14ユーザー指示: 始点・終点のタグは不要、「そのバスが寄っていく
  // MRT駅の情報だけでいい」とのことで、MRT路線色が解決できた経由地（mrtColor
  // ありのwaypoint）のみを表示していた。その後「セーブしているバス停がある
  // 場合はそれも必ず表示したい」との指示を受け、登録済み目的地に一致する
  // 経由地（reason: 'saved_destination'）も表示対象に加えた。表示件数の
  // 上限(3件)で登録済み目的地が埋もれないよう、目的地一致分を優先的に確保
  // した上で、最終的な表示順は実際にバスが経由する順（stopIndex昇順）に
  // 並べ替える（2026-09-14ユーザー指摘「経路って通っていく順番に並べて
  // 欲しい」で発見・修正。従来は選定後のslice(0,3)がそのまま表示順にもなって
  // いたため、目的地一致タグが常にMRT駅タグより手前に固定表示され、実際の
  // 通過順と無関係な並びになっていた）。該当が0件の場合はセクション自体を
  // 非表示にする。
  function renderMiniRoute(card, summary) {
    const el = card.querySelector('.bus-card-mini-route');
    if (!el) return;

    const waypoints = summary && Array.isArray(summary.waypoints) ? summary.waypoints : [];
    const destWaypoints = waypoints.filter((wp) => wp && wp.reason === 'saved_destination');
    const mrtWaypoints = waypoints.filter((wp) => wp && wp.mrtColor);
    const remainingSlots = Math.max(3 - destWaypoints.length, 0);
    const shownWaypoints = sortWaypointsByStopIndex(destWaypoints.concat(mrtWaypoints.slice(0, remainingSlots)));

    if (shownWaypoints.length === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    const caption = destWaypoints.length > 0 ? 'Passes along the way' : 'Passes these MRT stations';
    const waypointTagsHtml = shownWaypoints.map((wp) => buildMiniRouteTagHtml(wp)).join('');

    el.hidden = false;
    el.innerHTML = `
      <div class="bus-card-mini-route-caption">${caption}</div>
      <div class="bus-card-mini-route-tags">
        ${waypointTagsHtml}
      </div>
    `;
  }

  /* ══════════════════════════════════════════════
   * 目的地ハイライトの適用（2026-09-21全面刷新）
   *
   * 旧仕様は保存済み目的地「全件」を対象に一致判定し、いずれか1つでも
   * 経由すれば星バッジで強調していたが、目的地を複数保存しているほど
   * 多くの系統が同時にハイライトされ表示が崩れる問題があった
   * （mockups/home-destination-highlight-picker-v1.html検討時にユーザー指摘）。
   *
   * 新仕様: ヘッダーの目的地ハイライトピッカー(highlightDestinationId)で
   * 選択中の目的地「1件のみ」を対象に判定し、一致した行をその目的地の色
   * （iconColor）でハイライトする(バッジは使わず色のみ、ユーザー指示)。
   * 何も選択していなければ判定自体を行わない。
   * ══════════════════════════════════════════════ */
  async function applyRouteEnrichment() {
    const cards = collectEnrichableElements();

    // 選択変更・解除のたびに、まず全行から前回のハイライトを取り除く
    // （再判定を待たず即座に見た目へ反映するため、ポーリングによる
    // Timetable再描画を待たない）。
    clearHighlightIndicators(cards);

    if (cards.length === 0) {
      syncApproachingBarMatches(null);
      return;
    }

    const destinations = loadDestinations();

    // 選択中の目的地がSaved画面側で削除されていた場合は選択解除する
    // （2026-09-21確定仕様）。
    if (highlightDestinationId && !destinations.some((dest) => dest.id === highlightDestinationId)) {
      highlightDestinationId = null;
      updateHighlightButtonUI();
    }

    if (!highlightDestinationId) {
      syncApproachingBarMatches(null);
      return;
    }

    const selectedDestination = destinations.find((dest) => dest.id === highlightDestinationId);
    if (!selectedDestination || !selectedDestination.busStopCode) {
      syncApproachingBarMatches(null);
      return;
    }

    // 2026-09-14ユーザー指示で発見・修正した既存の考慮を踏襲: 現在表示中の
    // バス停自体が選択中の目的地の場合、どの系統の経路にも(出発点として)
    // 必ず含まれ「関連あり」判定が常にtrueになってしまうため、判定を行わない。
    const currentStopCode = currentDisplayedStop ? currentDisplayedStop.BusStopCode : null;
    if (selectedDestination.busStopCode === currentStopCode) {
      syncApproachingBarMatches(null);
      return;
    }

    // 系統番号ごとにグルーピングし、グループの代表カード1枚のみ判定する
    // （同一系統の複数到着インスタンスに対して重複してAPIを叩かないため）。
    const groups = groupCardsByServiceNo(cards);
    const serviceNos = Array.from(groups.keys());

    let routeInfos;
    try {
      routeInfos = await Promise.all(
        serviceNos.map((serviceNo) => {
          const representativeCard = groups.get(serviceNo)[0];
          return getOrFetchServiceRouteInfo(serviceNo, representativeCard, [selectedDestination.busStopCode]);
        })
      );
    } catch (err) {
      syncApproachingBarMatches(null);
      return;
    }

    const colorKey = normalizeDestinationIconColor(selectedDestination.iconColor);
    const hex = getCategoryColorHex(colorKey);
    if (!hex) {
      syncApproachingBarMatches(null);
      return;
    }

    serviceNos.forEach((serviceNo, index) => {
      const routeInfo = routeInfos[index] || {};
      if (routeInfo.matched !== true) return;
      groups.get(serviceNo).forEach((card) => applyHighlightIndicator(card, hex));
    });

    // Timetable側のハイライトが確定したので、Approachingバーの該当ドットにも
    // 同じ色を反映する（系統単位の判定を二重に行わない）。
    syncApproachingBarMatches(hex);
  }

  // 行(.tt-row)1件に選択中目的地の色でハイライトを適用する（背景の薄いトーン+
  // 左端カラーバー(box-shadow insetでpaddingを崩さない)+系統番号バッジの
  // 塗りつぶし）。Saved画面のアイコン色編集と同じlightenHexColor()を使う。
  function applyHighlightIndicator(card, hex) {
    card.classList.add('tt-row--highlight');
    card.style.backgroundColor = lightenHexColor(hex, 0.86);
    card.style.boxShadow = `inset 4px 0 0 0 ${hex}`;
    const badge = card.querySelector('.tt-badge');
    if (badge) badge.style.background = hex;
  }

  // 全カード/行からハイライトを取り除く（選択解除・選択変更・再判定の
  // たびに呼ぶ）。
  function clearHighlightIndicators(cards) {
    cards.forEach((card) => {
      card.classList.remove('tt-row--highlight');
      card.style.backgroundColor = '';
      card.style.boxShadow = '';
      const badge = card.querySelector('.tt-badge');
      if (badge) badge.style.background = '';
    });
  }

  /* ══════════════════════════════════════════════
   * 目的地ハイライトピッカー（Home画面ヘッダー、2026-09-21新規）
   * mockups/home-destination-highlight-picker-v1.html（ユーザー承認済み）
   * ══════════════════════════════════════════════ */

  function closeHighlightDropdown() {
    const dropdown = document.getElementById('home-highlight-dropdown');
    const btn = document.getElementById('home-highlight-btn');
    if (dropdown) dropdown.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // ドロップダウンの中身を開くたびに最新のloadDestinations()から再構築する
  // （Saved画面での追加・削除・タイトル変更を常に反映するため）。
  function renderHighlightDropdown() {
    const dropdown = document.getElementById('home-highlight-dropdown');
    if (!dropdown) return;

    const destinations = loadDestinations();
    const noneSelected = !highlightDestinationId;

    let html = `
      <div class="home-highlight-dropdown-item${noneSelected ? ' home-highlight-dropdown-item--selected' : ''}" data-highlight-id="">
        <span class="home-highlight-dropdown-item-icon home-highlight-dropdown-item-icon--none"><i class="ti ti-circle-off" aria-hidden="true"></i></span>
        <span class="home-highlight-dropdown-item-label">Don't highlight</span>
        ${noneSelected ? '<i class="ti ti-check home-highlight-dropdown-item-check" aria-hidden="true"></i>' : ''}
      </div>
    `;

    destinations.forEach((dest) => {
      const isSelected = dest.id === highlightDestinationId;
      const colorKey = normalizeDestinationIconColor(dest.iconColor);
      const hex = getCategoryColorHex(colorKey) || 'var(--fill-accent)';
      const category = normalizeDestinationCategory(dest.category);
      const label = dest.title && dest.title.trim() ? dest.title.trim() : dest.description;
      html += `
        <div class="home-highlight-dropdown-item${isSelected ? ' home-highlight-dropdown-item--selected' : ''}" data-highlight-id="${escapeHtml(dest.id)}">
          <span class="home-highlight-dropdown-item-icon" style="background:${hex};">${DESTINATION_CATEGORY_ICON_SVG[category]}</span>
          <span class="home-highlight-dropdown-item-label">${escapeHtml(label)}</span>
          ${isSelected ? '<i class="ti ti-check home-highlight-dropdown-item-check" aria-hidden="true"></i>' : ''}
        </div>
      `;
    });

    dropdown.innerHTML = html;
  }

  // ボタンの見た目（ラベル・配色・表示/非表示）を現在の選択状態に同期する。
  function updateHighlightButtonUI() {
    const btn = document.getElementById('home-highlight-btn');
    const labelEl = document.getElementById('home-highlight-btn-label');
    if (!btn || !labelEl) return;

    const destinations = loadDestinations();
    // 保存済み目的地が0件ならボタン自体を隠す（選びようがないため）。
    btn.hidden = destinations.length === 0;

    const selected = highlightDestinationId
      ? destinations.find((dest) => dest.id === highlightDestinationId)
      : null;

    if (selected) {
      const colorKey = normalizeDestinationIconColor(selected.iconColor);
      const hex = getCategoryColorHex(colorKey);
      labelEl.textContent = selected.title && selected.title.trim() ? selected.title.trim() : selected.description;
      btn.classList.add('home-highlight-btn--active');
      btn.style.background = hex || '';
      btn.style.color = hex ? 'var(--on-accent)' : '';
    } else {
      labelEl.textContent = 'Select stop';
      btn.classList.remove('home-highlight-btn--active');
      btn.style.background = '';
      btn.style.color = '';
    }
  }

  // 選択を確定する（idがnull/空文字なら「選択解除」）。系統単位のルート情報
  // キャッシュは対象の目的地が変わると判定結果も変わりうるため、
  // 選択変更のたびに破棄してから再判定する。
  function selectHighlightDestination(id) {
    highlightDestinationId = id || null;
    closeHighlightDropdown();
    updateHighlightButtonUI();
    clearServiceRouteInfoCache();
    applyRouteEnrichment();
  }

  function initHighlightPicker() {
    const btn = document.getElementById('home-highlight-btn');
    const dropdown = document.getElementById('home-highlight-dropdown');
    if (!btn || !dropdown) return;

    updateHighlightButtonUI();

    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!dropdown.hidden) {
        closeHighlightDropdown();
        return;
      }
      renderHighlightDropdown();
      dropdown.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    });

    dropdown.addEventListener('click', (event) => {
      const item = event.target.closest('.home-highlight-dropdown-item');
      if (!item) return;
      selectHighlightDestination(item.getAttribute('data-highlight-id'));
    });

    // ドロップダウン外タップで変更せず閉じる。
    document.addEventListener('click', (event) => {
      if (dropdown.hidden) return;
      if (dropdown.contains(event.target) || btn.contains(event.target)) return;
      closeHighlightDropdown();
    });
  }

  // Saved画面のアイコン色ピッカーで使う--category-color-*変数の実際の16進値を取得する。
  function getCategoryColorHex(colorKey) {
    return (
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue(`--category-color-${colorKey}`)
        .trim() || null
    );
  }

  // 目的地一致インジケーター(バッジ・経由地タグ等)の塗りつぶし色を薄める。
  // 2026-09-14ユーザー指摘「ちょっと目立ちすぎなので薄めのラベルにして。
  // 経路、宛先の両方です」対応。指定色に白を混ぜた淡い背景色を返す
  // （元の色はテキスト/アイコン色としてそのまま使うことで、薄い背景の上でも
  // 十分なコントラストを保つ）。
  function lightenHexColor(hex, whiteRatio) {
    if (!hex || hex.charAt(0) !== '#') return hex;
    const num = parseInt(hex.slice(1), 16);
    if (Number.isNaN(num)) return hex;
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    const mix = (channel) => Math.round(channel + (255 - channel) * whiteRatio);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  /* ══════════════════════════════════════════════
   * LTA DataMall連携: バス到着情報の取得・描画
   * ══════════════════════════════════════════════ */

  // NextBus/NextBus2/NextBus3のEstimatedArrival（ISO8601）から
  // 「あと何分」かを算出する。過去時刻・不正値は0分扱いにする。
  function estimateMinutesFromNow(isoString) {
    if (!isoString) return null;
    const arrival = new Date(isoString).getTime();
    if (Number.isNaN(arrival)) return null;
    const diffMs = arrival - Date.now();
    const minutes = Math.round(diffMs / 60000);
    return minutes < 0 ? 0 : minutes;
  }

  // LTAの車種コード（SD: シングルデッキ, DD: ダブルデッキ, BD: 連接バス等）から
  // 表示用ラベルを決める。
  // 注意（スキーマ前提）: 実キー取得後、実データでコード値・欠落パターンを確認し
  // 必要であれば調整すること。
  // フェーズ4 タスク分解ステップ2で再利用: メタ行（buildMetaRowHtml）の
  // 車種ラベル表示（アイコン+テキスト）に使用する（.claude/plan.md 第2-2節）。
  function getBusTypeLabel(typeCode) {
    if (typeCode === 'DD') return 'Double Deck';
    if (typeCode === 'BD') return 'Bendy';
    return 'Single Deck';
  }

  // 1本の到着時刻ブロック（分の数値+単位）を生成
  // 注意（フェーズ4カードデザイン刷新で未使用）: 1到着=1カード化に伴い、
  // ETA表示はbuildEtaHtml()（.eta-value/.eta-unit形式）に置き換わったため、
  // buildBusCard()からは呼び出されなくなった。
  function buildTimeBlock(minutes, isPrimary, isAccent) {
    const classes = ['bus-time'];
    if (isPrimary) classes.push('bus-time--primary');
    if (isAccent) classes.push('bus-time--accent');

    const displayValue = minutes === null ? '—' : String(minutes);

    return `
      <div class="${classes.join(' ')}">
        <span class="bus-time-value">${displayValue}</span>
        <span class="bus-time-unit">min</span>
      </div>
    `;
  }

  // LTA Loadコード（SEA/SDA/LSD）から混雑状況インジケーター用の
  // { colorClass, label } を決める。未知の値・欠落時はnullを返し、
  // 呼び出し元がインジケーター自体を非表示にできるようにする
  // （plan.md 2-4節「偽の色を出さない」要件）。Timetableビューの各時刻セル
  // （buildTimetableTimeCellHtml）が色分けに使う。
  function getLoadIndicatorInfo(loadCode) {
    if (loadCode === 'SEA') return { colorClass: 'green', label: 'Seats available' };
    if (loadCode === 'SDA') return { colorClass: 'amber', label: 'Standing room' };
    if (loadCode === 'LSD') return { colorClass: 'red', label: 'Crowded' };
    return null;
  }

  /* ══════════════════════════════════════════════
   * フェーズ4 タスク分解ステップ1（.claude/plan.md 第2-1節・第9節）:
   * 「1系統1カード×3時刻内包」→「1件=1到着」のフラット時系列フィードへの転換
   *
   * flattenServicesToArrivalInstances(): Services[]の各要素（系統）の
   * NextBus/NextBus2/NextBus3を、それぞれ独立した「1到着インスタンス」の
   * 配列に展開する。EstimatedArrivalが空文字列（運行なし）のものは含めない。
   * ══════════════════════════════════════════════ */

  // 1系統分のサービス情報から、有効な到着インスタンス（NextBus/NextBus2/NextBus3のうち
  // EstimatedArrivalが空でないもの）を配列として取り出す。
  //
  // Operator（バス会社、SBST/SMRT/TTS/GAS）はNextBus単位ではなくService単位の
  // フィールドのため（フェーズ8、.claude/plan-phase8-arrivals-grid-and-modal.md
  // 1-3節、server.js側が/api/bus-arrivalのServices[]にOperatorを付与する）、
  // 各到着インスタンスにそのままコピーして持たせる（buildBusCard()の
  // Operator表示用）。
  function extractArrivalInstancesFromService(service) {
    const serviceNo = service.ServiceNo || '?';
    const instances = [];

    ['NextBus', 'NextBus2', 'NextBus3'].forEach((key) => {
      const nextBus = service[key];
      if (!nextBus || typeof nextBus !== 'object') return;
      if (!nextBus.EstimatedArrival) return; // 空文字列（運行なし）は除外

      instances.push({
        ServiceNo: serviceNo,
        Operator: service.Operator,
        DestinationName: nextBus.DestinationName,
        DestinationCode: nextBus.DestinationCode,
        OriginCode: nextBus.OriginCode,
        EstimatedArrival: nextBus.EstimatedArrival,
        Type: nextBus.Type,
        Load: nextBus.Load,
        Monitored: nextBus.Monitored,
        Feature: nextBus.Feature,
      });
    });

    return instances;
  }

  // Services[]全体を「1到着=1件」のフラットな配列に変換し、EstimatedArrivalの
  // 昇順でソートする。同時刻（同分・同秒）の場合は系統番号順という決定的な
  // 順序にする（plan.md第4節「エッジケース」要実装判断分の対応）。
  // Approachingバーに表示する到着インスタンスの最大件数
  // （2026-09-20ユーザー指示「バスは10本だけでいい」。旧Arrivalsグリッド時代の
  // MAX_DISPLAYED_ARRIVALS=12はArrivals廃止に伴い置き換え）。
  const MAX_APPROACHING_BAR_BUSES = 10;

  function flattenServicesToArrivalInstances(services) {
    const instances = [];
    services.forEach((service) => {
      instances.push(...extractArrivalInstancesFromService(service));
    });

    instances.sort((a, b) => {
      const timeA = new Date(a.EstimatedArrival).getTime();
      const timeB = new Date(b.EstimatedArrival).getTime();
      if (timeA !== timeB) return timeA - timeB;
      return String(a.ServiceNo).localeCompare(String(b.ServiceNo));
    });

    return instances.slice(0, MAX_APPROACHING_BAR_BUSES);
  }

  /* ══════════════════════════════════════════════
   * Approachingバー（Home画面、2026-09-20新規、Arrivalsグリッド廃止に伴う置き換え）
   *
   * mockups/arrivals-bar-timetable-combined-v1.html（ユーザー承認済み）に基づく。
   * ETA（0〜15分でクランプ）に応じてバスをドットとして横帯上に配置する。
   * 左端=Now（バス停マーカー）、右端=15分以上（ユーザー指示「Nowが左のほうが
   * いい」）。出発演出・新規挿入アニメーションは持たず、ポーリングのたびに
   * 単純に全ドットを再生成する（Timetableビューと同じ方針、5節「Timetableは
   * 数値の更新のみで良い」を踏襲）。
   *
   * 選択中目的地行きの系統ハイライトはapplyRouteEnrichment()が確定した
   * Timetable側の.tt-row--highlightクラス（2026-09-21目的地ハイライト
   * ピッカー刷新、色は選択中目的地のiconColor）を流用する
   * （syncApproachingBarMatches()、系統単位の判定を二重に行わない）。
   * ══════════════════════════════════════════════ */
  // Save済み目的地行きの系統は後からドットが拡大される（.home-approaching-
  // bus--saved、syncApproachingBarMatches()が非同期に付与）ため、衝突回避の
  // 最小間隔はSave済みドットの幅を前提に計算し、後から拡大されても重ならない
  // ようにしておく。
  const APPROACHING_MIN_GAP_PX = 56;
  // 左端の停留所ピン（.home-approaching-stop-flag、4px〜30px幅26pxで表示）と
  // 最初のドットが重ならないだけの余白を確保する（右端の余白にも同じ値を使う）。
  const APPROACHING_START_PAD_PX = 54;
  // 分あたりのpx幅の下限。画面が極端に狭い場合でもドットが潰れて見えない
  // ようにするためのフォールバック（通常は画面幅から動的計算した値を使う）。
  const APPROACHING_MIN_PX_PER_MIN = 16;

  // 2026-09-21ユーザー指示「バスの本数が少ない時は一画面(15分まで)に収まる
  // ようにして、収まらない時だけ横スクロールしたい」対応。分あたりのpx幅を
  // 画面幅から逆算し、0〜15分の全域がちょうど収まるスケールを基準にする。
  // 衝突回避で押し出しが発生した時だけ、結果的にこのスケールを超えて
  // トラックが伸び、横スクロールが必要になる（＝バスが密集している時のみ）。
  function computeApproachingPxPerMin() {
    const scrollEl = document.getElementById('home-approaching-scroll');
    const visibleWidth = scrollEl ? scrollEl.clientWidth : 0;
    if (!visibleWidth) return APPROACHING_MIN_PX_PER_MIN;
    const usablePx = visibleWidth - APPROACHING_START_PAD_PX * 2;
    return Math.max(APPROACHING_MIN_PX_PER_MIN, usablePx / 15);
  }

  function renderApproachingBar(arrivalInstances) {
    const track = document.getElementById('home-approaching-track');
    const ticks = document.getElementById('home-approaching-ticks');
    if (!track) return;

    track.querySelectorAll('.home-approaching-bus').forEach((el) => el.remove());

    const pxPerMin = computeApproachingPxPerMin();

    // ETA（0〜15分でクランプ）に比例した位置を仮に割り当てた後、左から順に
    // 最小間隔（APPROACHING_MIN_GAP_PX）を確保するよう押し出す（2026-09-20
    // ユーザー指示「バス情報は重ならないように」対応）。arrivalInstancesは
    // 既にETA昇順のため、そのまま左から確定させていける。
    let prevX = -Infinity;
    const positions = arrivalInstances.map((instance) => {
      const minutes = estimateMinutesFromNow(instance.EstimatedArrival);
      const clampedMinutes = Math.min(minutes === null ? 15 : minutes, 15);
      let x = APPROACHING_START_PAD_PX + clampedMinutes * pxPerMin;
      if (x < prevX + APPROACHING_MIN_GAP_PX) x = prevX + APPROACHING_MIN_GAP_PX;
      prevX = x;
      return { instance, x };
    });

    // バスが少ない・密集していない時はpxPerMinが画面ぴったりに収まるスケール
    // のため、トラック幅も自然に画面幅と一致し横スクロールは発生しない。
    // 密集で衝突回避の押し出しが発生した時だけ、必要な分だけ幅が伸びて
    // 横スクロールが有効になる（.home-approaching-scroll、CSS側）。
    const trackWidth = Math.max(0, prevX + APPROACHING_START_PAD_PX);
    track.style.width = `${trackWidth}px`;
    if (ticks) ticks.style.width = `${trackWidth}px`;

    positions.forEach(({ instance, x }) => {
      const dot = document.createElement('div');
      dot.className = 'home-approaching-bus';
      dot.style.left = `${x}px`;
      dot.setAttribute('data-route-number', instance.ServiceNo || '?');

      const inner = document.createElement('div');
      inner.className = 'home-approaching-bus-dot';
      inner.textContent = instance.ServiceNo || '?';
      dot.appendChild(inner);

      track.appendChild(dot);
    });

    // Timetable側の直近の判定結果（前回のapplyRouteEnrichment()確定分）を
    // 再生成直後のドットにも反映しておく。実際の再判定はこの後
    // renderTimetableView()→applyRouteEnrichment()の順で走り、そこで
    // 改めてsyncApproachingBarMatches()が呼ばれる。
    syncApproachingBarMatches(getCurrentHighlightColorHex());

    // トラック幅が変わるたびに、横スクロールできるかどうかのヒント表示も
    // 再評価する（2026-09-21ユーザー指摘「横スクロールできることが
    // 分かりにくい」対応）。
    updateApproachingFadeVisibility();
  }

  // トラックが画面幅を超えている、かつ末尾までスクロールしきっていない時だけ
  // 右端のフェードグラデーション(.home-approaching-fade)を表示する。
  function updateApproachingFadeVisibility() {
    const scrollEl = document.getElementById('home-approaching-scroll');
    const fadeEl = document.getElementById('home-approaching-fade');
    if (!scrollEl || !fadeEl) return;

    const isScrollable = scrollEl.scrollWidth > scrollEl.clientWidth + 1;
    const isAtEnd = scrollEl.scrollLeft + scrollEl.clientWidth >= scrollEl.scrollWidth - 4;
    fadeEl.hidden = !isScrollable || isAtEnd;
  }

  // #home-approaching-scrollのscrollイベントで末尾到達を検知し、フェードを
  // 隠す（一度だけバインドすればよいのでDOMContentLoadedから呼ぶ）。
  function initApproachingScrollHint() {
    const scrollEl = document.getElementById('home-approaching-scroll');
    if (!scrollEl) return;
    scrollEl.addEventListener('scroll', updateApproachingFadeVisibility, { passive: true });
  }

  // 2026-09-21ユーザー指示「バス停を切り替えたときはApproachingバーの横
  // スクロールを常に最初に戻す」対応。表示中のバス停が変わると中身は
  // 総入れ替えになるため、古いバス停で見ていたスクロール位置を引き継ぐ
  // 意味がない（switchToStopIndex()・switchToScreen()のHomeタブ復帰の
  // 両方から呼ぶ）。
  function resetApproachingBarScroll() {
    const approachingScroll = document.getElementById('home-approaching-scroll');
    if (approachingScroll) approachingScroll.scrollTo({ left: 0, behavior: 'smooth' });
  }

  // 選択中の目的地のアイコン色（16進）を返す。未選択・削除済みならnull。
  function getCurrentHighlightColorHex() {
    if (!highlightDestinationId) return null;
    const dest = loadDestinations().find((d) => d.id === highlightDestinationId);
    if (!dest) return null;
    return getCategoryColorHex(normalizeDestinationIconColor(dest.iconColor)) || null;
  }

  // applyRouteEnrichment()が確定させたTimetable行のハイライト状態
  // （.tt-row--highlight）を読み取り、同じ系統番号のApproachingバードットにも
  // 同じ色で強調表示を反映する。colorHexがnullの場合は「ハイライトなし」。
  function syncApproachingBarMatches(colorHex) {
    const track = document.getElementById('home-approaching-track');
    if (!track) return;

    const matchedServiceNos = new Set(
      Array.from(document.querySelectorAll('#home-timetable-list .tt-row--highlight')).map((row) =>
        row.getAttribute('data-route-number')
      )
    );

    track.querySelectorAll('.home-approaching-bus').forEach((dot) => {
      const serviceNo = dot.getAttribute('data-route-number');
      const isMatched = colorHex && matchedServiceNos.has(serviceNo);
      dot.classList.toggle('home-approaching-bus--saved', Boolean(isMatched));
      const inner = dot.querySelector('.home-approaching-bus-dot');
      if (inner) {
        inner.style.background = isMatched ? colorHex : '';
        inner.style.borderColor = isMatched ? colorHex : '';
      }
    });
  }

  function clearApproachingBar() {
    const track = document.getElementById('home-approaching-track');
    const ticks = document.getElementById('home-approaching-ticks');
    if (!track) return;
    track.querySelectorAll('.home-approaching-bus').forEach((el) => el.remove());
    track.style.width = '';
    if (ticks) ticks.style.width = '';
  }

  /* ══════════════════════════════════════════════
   * フェーズ6: Timetableビュー（.claude/plan-phase6-map-timetable-toggle.md
   * 2-7節・4節・5節）
   *
   * flattenServicesToArrivalInstances()を経由するフラットフィードとは別に、
   * 生のServices[]（NextBus/NextBus2/NextBus3を内包したまま）を系統番号1行の
   * テーブルとして描画する。系統番号の自然順（数値部分＋アルファベット部分を
   * 考慮したlocaleCompare、flattenServicesToArrivalInstances内の同着時ソートと
   * 同じ比較関数）でソートする（到着時刻順だと行の位置が毎ポーリングで入れ替わり
   * 一覧性が損なわれるため）。
   * ══════════════════════════════════════════════ */
  function compareServiceNumbers(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // 1系統分のセル（N分の数値+混雑度色+車種/車椅子ミニアイコン）を組み立てる。
  // 到着予定なし（EstimatedArrival空文字列）の枠は「-」プレースホルダーにする
  // （4節エッジケース、参考画像の4N系統と同じ表現）。
  function buildTimetableTimeCellHtml(nextBus) {
    if (!nextBus || !nextBus.EstimatedArrival) {
      return `
        <div class="tt-time-cell">
          <div class="tt-time-value dash">–</div>
        </div>
      `;
    }

    const minutes = estimateMinutesFromNow(nextBus.EstimatedArrival);
    const loadInfo = getLoadIndicatorInfo(nextBus.Load);
    const colorClass = loadInfo ? ` load-${loadInfo.colorClass}` : '';
    const displayValue = minutes === null ? '–' : minutes === 0 ? 'Now' : String(minutes);

    // 4節正常系「各時刻の下に混雑状況の色・車種ラベルが小さく併記される」対応。
    // セル幅が狭い（min-width:28px）ため、getBusTypeLabel()のフルテキスト
    // （"Single Deck"等）ではなくLTAの車種コード（SD/DD/BD）をそのまま
    // 小さく表示する（車椅子アイコンと横並び）。
    const wabIconHtml =
      nextBus.Feature === 'WAB'
        ? '<i class="ti ti-wheelchair" aria-hidden="true" title="Wheelchair accessible"></i>'
        : '';
    const typeCode = nextBus.Type || 'SD';
    const typeLabelHtml = `<span class="tt-time-type" title="${escapeHtml(getBusTypeLabel(typeCode))}">${escapeHtml(typeCode)}</span>`;

    return `
      <div class="tt-time-cell">
        <div class="tt-time-value${colorClass}">${displayValue}</div>
        <div class="tt-time-icons">${wabIconHtml}${typeLabelHtml}</div>
      </div>
    `;
  }

  // 1系統分の行（.tt-row）を組み立てる。系統番号バッジ（.tt-badge）は
  // data-route-number/data-origin-code/data-destination-code/
  // data-current-stop-code属性を持ち、applyRouteEnrichment()が
  // 目的地一致判定に使う。バッジタップで経路モーダルを開く。
  function buildTimetableRow(service, currentStopCode) {
    const serviceNo = service.ServiceNo || '?';
    const nextBuses = [service.NextBus, service.NextBus2, service.NextBus3];
    // Direction特定・経路モーダル起動にはOriginCode/DestinationCodeが必要
    // （.bus-cardと同じ仕組み）。NextBusが空の系統でもorigin/destinationCode
    // だけは残っていることがあるため、最初に見つかった非空のNextBus*から取る。
    const representative = nextBuses.find((nb) => nb && nb.EstimatedArrival) || nextBuses[0] || {};

    const row = document.createElement('div');
    row.className = 'tt-row';
    row.setAttribute('data-route-number', serviceNo);
    row.setAttribute('data-route-from', '');
    row.setAttribute('data-route-to', representative.DestinationName || '');
    row.setAttribute('data-origin-code', representative.OriginCode || '');
    row.setAttribute('data-destination-code', representative.DestinationCode || '');
    row.setAttribute('data-current-stop-code', currentStopCode || '');
    // 2026-09-20ユーザー指示「Routeの表示は系統番号だけでなく、カードの
    // どこを叩いても表示するように」対応。従来は.tt-badge単体がタップ対象
    // だったが、行全体(.tt-row)をタップターゲットにする(Arrivalsカード側が
    // カード全体タップな点とも一貫性が取れる)。
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', `View route for service ${serviceNo}`);

    const badgeLengthClass = serviceNo.length >= 4 ? ' tt-badge--long' : '';
    const timesHtml = nextBuses.map((nb) => buildTimetableTimeCellHtml(nb)).join('');
    // 4節エッジケース「循環路線の場合、行き先表示は...統一する」対応の前提として、
    // まず行き先自体を表示する（当初の実装漏れ、buildBusCard/mockupのバッジ+時刻
    // のみのレイアウトに合わせていたため欠落していた）。Loop表現（"Loop via X"）は
    // /api/bus-routes/summaryの非同期解決が必要なためbuildBusCard()側も現状は
    // 行っておらず、ここでも同じ制約でDestinationNameをそのまま表示する
    // （Arrivals/Timetable両ビューで挙動を揃える）。
    // 常にtt-destを描画する（行き先が取れない場合でも要素自体は残し、
    // badge/times間のflexレイアウトが崩れないようにする）。
    const destText = representative.DestinationName || '';

    // 2026-09-21目的地ハイライトピッカー刷新により、目的地一致は行全体の
    // 色ハイライト(.tt-row--highlight、applyHighlightIndicator())で表現する
    // ようになり、バッジは使わなくなった（ユーザー指示「バッジはいらない、
    // 色のハイライトだけでいい」）。
    row.innerHTML = `
      <div class="tt-badge${badgeLengthClass}">
        <span class="tt-badge-number">${escapeHtml(serviceNo)}</span>
      </div>
      <div class="tt-dest">${escapeHtml(destText)}</div>
      <div class="tt-times">${timesHtml}</div>
    `;

    return row;
  }

  // Timetableビュー全体を再描画する。上限なし・全件表示（8節確定事項、
  // MAX_DISPLAYED_ARRIVALSとは別概念）。系統番号の自然順でソートする。
  function renderTimetableView(services) {
    const container = document.getElementById('home-timetable-list');
    if (!container) return;

    const list = Array.isArray(services) ? services : [];
    if (list.length === 0) {
      renderTimetableErrorState('No buses are currently running from this stop');
      return;
    }

    const sorted = list.slice().sort((a, b) => compareServiceNumbers(a.ServiceNo || '', b.ServiceNo || ''));
    const currentStopCode = currentDisplayedStop ? currentDisplayedStop.BusStopCode : '';

    container.innerHTML = '';
    sorted.forEach((service) => {
      container.appendChild(buildTimetableRow(service, currentStopCode));
    });
  }

  function renderTimetableLoadingState() {
    const container = document.getElementById('home-timetable-list');
    if (!container) return;
    container.innerHTML = `
      <div class="placeholder-screen">
        <i class="ti ti-loader-2" aria-hidden="true"></i>
        <p>Loading…</p>
      </div>
    `;
  }

  function renderTimetableErrorState(message) {
    const container = document.getElementById('home-timetable-list');
    if (!container) return;
    container.innerHTML = `
      <div class="placeholder-screen">
        <i class="ti ti-alert-triangle" aria-hidden="true"></i>
        <p>${message || 'Unable to load bus arrival information'}</p>
      </div>
    `;
  }

  async function loadBusArrivals(stopCode) {
    renderTimetableLoadingState();

    // バス停切替のたびに系統単位のルート情報キャッシュを破棄する。
    // 同じ系統番号でもバス停が変わればdirection/経由判定が変わりうるため、
    // 古いバス停の結果を次のバス停に誤って適用しないようにする。
    clearServiceRouteInfoCache();

    try {
      const response = await fetch(API_BASE + `/api/bus-arrival?stopCode=${encodeURIComponent(stopCode)}`);

      if (!response.ok) {
        // サーバー側は { error: '...' } 形式の汎用メッセージを返す想定。
        let message = 'Unable to load bus arrival information';
        try {
          const errBody = await response.json();
          if (errBody && errBody.error) message = errBody.error;
        } catch (parseErr) {
          // JSONパース失敗時はデフォルトメッセージのまま
        }
        renderTimetableErrorState(message);
        clearApproachingBar();
        return;
      }

      const data = await response.json();
      const services = Array.isArray(data.Services) ? data.Services : [];

      if (services.length === 0) {
        renderTimetableErrorState('No buses are currently running from this stop');
        clearApproachingBar();
        return;
      }

      const arrivalInstances = flattenServicesToArrivalInstances(services);

      if (arrivalInstances.length === 0) {
        renderTimetableErrorState('No buses are currently running from this stop');
        clearApproachingBar();
        return;
      }

      lastRawServices = services;

      renderApproachingBar(arrivalInstances);

      // フェーズ6: Timetableビューは上限なし・生のServices[]をそのまま行データに
      // する（8節確定「表示系統数は上限なし」、2-7節）。
      renderTimetableView(services);

      // 星アイコンハイライト・目的地一致タグを適用する。
      applyRouteEnrichment();

      // このバス停の自動ポーリングを（再）開始する。バス停切替のたびに
      // 古いポーリングを止めて新しいバス停用に張り直す。
      startArrivalPolling(stopCode);
    } catch (err) {
      // ネットワークエラー等（サーバー自体に到達できない場合を含む）
      renderTimetableErrorState('Unable to load bus arrival information');
      clearApproachingBar();
    }
  }

  /* ══════════════════════════════════════════════
   * 自動ポーリング（15秒間隔）。Approachingバー・Timetableとも、出発演出等の
   * 差分アニメーションは持たず、ポーリングのたびに単純に全体を再描画する
   * （旧Arrivalsグリッド時代のmatchArrivalAcrossPolls()による近似マッチング・
   * 出発検出は、グリッド廃止に伴い不要になった）。
   * ══════════════════════════════════════════════ */
  const ARRIVAL_POLL_INTERVAL_MS = 15000;

  // 現在ポーリング中のタイマーID。バス停切替・画面離脱時に確実に止められるよう
  // モジュールスコープに保持する。
  let arrivalPollTimerId = null;

  // 直近のポーリング対象バス停コード。ポーリング応答が返ってきた時点で
  // 「まだこのバス停を見ているか」を確認するために使う（stopArrivalPollingで
  // nullにし、応答時にコード不一致なら古い応答として破棄する）。
  let polledStopCode = null;

  // フェーズ6: 直近に取得した生のServices[]（NextBus/NextBus2/NextBus3を
  // 内包したまま、flattenServicesToArrivalInstances()を経由する前のデータ）。
  // Timetableビュー（renderTimetableView）は「系統ごとに1行、複数時刻を
  // 横並び」という表示要求のため、あえてフラット化前のこの構造をそのまま
  // 行データとして使う（2-7節、3-2節「時刻表ビューも既存APIで賄える」）。
  let lastRawServices = [];

  // Home画面が実際にユーザーに見えているかどうか。Search/Saved/Settings画面に
  // 切り替わっている間はポーリングを止め、無駄なAPI呼び出しを避ける
  // （switchToScreen()から都度更新する）。
  let isHomeScreenActive = true;

  function stopArrivalPolling() {
    if (arrivalPollTimerId !== null) {
      clearInterval(arrivalPollTimerId);
      arrivalPollTimerId = null;
    }
    polledStopCode = null;
  }

  // 指定バス停の自動ポーリングを開始する。既に別バス停向けのタイマーが
  // 動いていれば止めてから張り直す。
  function startArrivalPolling(stopCode) {
    stopArrivalPolling();

    polledStopCode = stopCode;

    arrivalPollTimerId = setInterval(() => {
      // Home画面が非アクティブな間は無駄なAPI呼び出しをしない
      // （Search/Saved/Settings表示中はポーリングを停止する要件）。
      if (!isHomeScreenActive) return;
      pollBusArrivals(stopCode);
    }, ARRIVAL_POLL_INTERVAL_MS);
  }

  // ポーリング1回分: 最新の到着情報を取得し、Approachingバー・Timetableとも
  // 単純に全体を再描画する。バス停切替・画面遷移との競合を避けるため、
  // レスポンスが返ってきた時点でまだ同じバス停をポーリング対象としているか
  // 確認してから描画する。
  async function pollBusArrivals(stopCode) {
    let response;
    try {
      response = await fetch(API_BASE + `/api/bus-arrival?stopCode=${encodeURIComponent(stopCode)}`);
    } catch (err) {
      return; // ネットワークエラー時は次回ポーリングに委ねる（画面は変更しない）
    }

    // ユーザーが既に別のバス停に切り替えている（横スワイプ/検索/GPS更新）場合、
    // このレスポンスは古い問い合わせに対するものなので描画に使わない。
    if (stopCode !== polledStopCode) return;
    if (!response.ok) return;

    let data;
    try {
      data = await response.json();
    } catch (err) {
      return;
    }

    const services = Array.isArray(data.Services) ? data.Services : [];
    const arrivalInstances = flattenServicesToArrivalInstances(services);

    lastRawServices = services;
    renderApproachingBar(arrivalInstances);
    renderTimetableView(services);
    applyRouteEnrichment();
  }

  /* ══════════════════════════════════════════════
   * フェーズ6: Home画面 地図パネル（.claude/plan-phase6-map-timetable-toggle.md
   * 2-1節〜2-5節、9節）
   *
   * 経路モーダルのensureRouteModalMap()と同じ「一度だけ生成し、以後は既存
   * インスタンスをクリアして再利用する」パターンを踏襲する。バス停切替の
   * たびにピンを再描画するが、地図インスタンス自体は使い回す。
   * ══════════════════════════════════════════════ */

  function ensureHomeMap() {
    if (homeMapInstance) return homeMapInstance;
    if (typeof window.L === 'undefined') return null; // Leaflet未読み込み（CDN障害等）

    const mapEl = document.getElementById('home-map-el');
    if (!mapEl) return null;

    const map = window.L.map(mapEl, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: false,
      dragging: true,
      doubleClickZoom: false,
      touchZoom: true,
    }).setView(MAP_INITIAL_CENTER, MAP_INITIAL_ZOOM);

    // 経路モーダルと同じ標準OSMタイル（CartoDB Positronは要APIキー化のため
    // 使用不可、2026-09-14実機で発見済み）。グレースケール処理は
    // .home-map-el .leaflet-tile-paneへのCSSフィルターで行う（2-2節）。
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    homeMapInstance = map;
    return map;
  }

  // 地図パネルをフォールバック表示に切り替える（4節失敗系: GPS未確定・
  // /api/bus-stops/nearby失敗・Leaflet未読み込みのいずれでも、下部のビュー
  // 切替・カード一覧・テーブルの動作は妨げない）。
  function showHomeMapFallback(message) {
    const fallbackEl = document.getElementById('home-map-fallback');
    const mapEl = document.getElementById('home-map-el');
    if (fallbackEl) {
      fallbackEl.hidden = false;
      const span = fallbackEl.querySelector('span');
      if (span && message) span.textContent = message;
      // 初期HTMLは「読み込み中」（ti-loader-2、回転アイコン）だが、実際の
      // 取得失敗時はローディングではなく明確なエラーとして伝わるよう
      // ti-map-offアイコンに切り替える。
      const icon = fallbackEl.querySelector('i');
      if (icon) {
        icon.classList.remove('ti-loader-2');
        icon.classList.add('ti-map-off');
      }
    }
    if (mapEl) mapEl.hidden = true;
  }

  function hideHomeMapFallback() {
    const fallbackEl = document.getElementById('home-map-fallback');
    const mapEl = document.getElementById('home-map-el');
    if (fallbackEl) fallbackEl.hidden = true;
    if (mapEl) mapEl.hidden = false;
  }

  // 現在地マーカー・周辺バス停ピンを最新のnearbyStops/currentStopIndexに
  // 合わせて再描画する。GPS取得・バス停切替（loadNearbyStopsAndArrivals）の
  // たびに呼ぶ（4節正常系「バス停切替のたびに地図の中心・ピンが再取得した
  // nearbyStopsに合わせて更新される」）。
  function renderHomeMapPins(lat, lng) {
    const map = ensureHomeMap();
    if (!map) {
      showHomeMapFallback('Map unavailable');
      return;
    }

    hideHomeMapFallback();
    map.invalidateSize();

    if (homeMapCurrentMarker) {
      map.removeLayer(homeMapCurrentMarker);
      homeMapCurrentMarker = null;
    }
    homeMapStopMarkers.forEach((entry) => map.removeLayer(entry.marker));
    homeMapStopMarkers = [];

    const currentIcon = window.L.divIcon({
      className: '',
      html: '<div class="home-map-current-dot"></div>',
      iconSize: [16, 16],
    });
    homeMapCurrentMarker = window.L.marker([lat, lng], { icon: currentIcon }).addTo(map);

    const bounds = [[lat, lng]];

    nearbyStops.forEach((stop, index) => {
      if (stop.Latitude == null || stop.Longitude == null) return;
      bounds.push([stop.Latitude, stop.Longitude]);

      const isActive = index === currentStopIndex;
      // ドット→ティアドロップ型ピン(ti-map-pin)への変更に伴い、マーカーの
      // 実位置はピンの「先端」に合わせる必要がある(円形ドットと違い
      // 左右非対称のため、中心アンカーのままだとピン全体が実座標より
      // 上にずれて見える)。経路モーダル終点マーカー(26px→anchor[13,24])と
      // 同じ比率で20pxにスケールし、anchor[10,18]を採用する。
      const icon = window.L.divIcon({
        className: '',
        html: `<i class="ti ti-map-pin home-map-stop-pin${isActive ? ' home-map-stop-pin--active' : ''}" aria-hidden="true"></i>`,
        iconSize: [20, 20],
        iconAnchor: [10, 18],
      });
      const marker = window.L.marker([stop.Latitude, stop.Longitude], { icon }).addTo(map);

      // 2-4節: 地図タップでのバス停切替。ピル行・カード一覧の横スワイプと同じ
      // switchToStopIndex()を呼ぶことで、3手段が同じ同期ロジックを共有する。
      marker.on('click', () => switchToStopIndex(index));

      if (isActive) {
        marker
          .bindTooltip(`<div class="home-map-stop-label">${escapeHtml(stop.Description || 'Bus stop')}</div>`, {
            permanent: true,
            direction: 'right',
            offset: [12, 0],
            className: 'home-map-stop-tooltip',
          })
          .openTooltip();
      }

      homeMapStopMarkers.push({ marker, index });
    });

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
    } else {
      map.setView([lat, lng], 16);
    }
  }

  // switchToStopIndex()経由でのバス停切替時、地図の中心・ズームは変えずに
  // 選択ピンの見た目（アクティブ状態・ラベル）だけを同期する
  // （4節正常系「地図の選択状態が正しく追従する」）。地図タップ自体は
  // renderHomeMapPins()の呼び出し元(loadNearbyStopsAndArrivals)を経由しない
  // 軽量な切替のため、ピンの再生成はせずスタイルの付け替えのみ行う。
  function updateHomeMapSelection() {
    if (!homeMapInstance) return;

    homeMapStopMarkers.forEach((entry) => {
      const stop = nearbyStops[entry.index];
      if (!stop) return;
      const isActive = entry.index === currentStopIndex;

      entry.marker.unbindTooltip();
      const iconEl = entry.marker.getElement();
      if (iconEl) {
        const pin = iconEl.querySelector('.home-map-stop-pin');
        if (pin) pin.classList.toggle('home-map-stop-pin--active', isActive);
      }

      if (isActive) {
        entry.marker
          .bindTooltip(`<div class="home-map-stop-label">${escapeHtml(stop.Description || 'Bus stop')}</div>`, {
            permanent: true,
            direction: 'right',
            offset: [12, 0],
            className: 'home-map-stop-tooltip',
          })
          .openTooltip();
      }
    });
  }

  /* ══════════════════════════════════════════════
   * フェーズ2 タスク5: 横スワイプ・ドットインジケーター連携
   * ══════════════════════════════════════════════ */

  // 横スワイプ判定の閾値（px）。この距離以上の水平移動があればスワイプとみなす。
  const SWIPE_THRESHOLD_PX = 50;

  // 縦スクロールとの誤認識を防ぐため、垂直方向の移動が水平方向の移動を
  // 上回っている場合はスワイプ操作として扱わない。
  function isHorizontalSwipe(deltaX, deltaY) {
    return Math.abs(deltaX) >= SWIPE_THRESHOLD_PX && Math.abs(deltaX) > Math.abs(deltaY);
  }

  // currentStopIndex を指定インデックスに切り替え、バスカード・ヘッダー・
  // ドットを再描画する。範囲外・変化なしの場合は何もしない。
  function switchToStopIndex(index) {
    if (!Array.isArray(nearbyStops) || nearbyStops.length === 0) return;

    const clamped = Math.min(Math.max(index, 0), nearbyStops.length - 1);
    if (clamped === currentStopIndex) return;

    currentStopIndex = clamped;
    const stop = nearbyStops[currentStopIndex];
    if (!stop) return;

    currentDisplayedStop = stop;
    updateHeaderStopName(stop.Description || 'Near your location');
    loadBusArrivals(stop.BusStopCode);
    updateStopPillActiveState();
    // 2-4節: 地図・ピル行・カード一覧の横スワイプの3手段が共通してこの関数を
    // 呼ぶため、ここで地図の選択ピン表示（アクティブ状態・ラベル）も同期する。
    updateHomeMapSelection();
    // バス停切り替え時はApproachingバーの中身が総入れ替えになるため、
    // 横スクロール位置も必ず最初に戻す（ピル/スワイプ/地図タップいずれも
    // ここを通る）。
    resetApproachingBarScroll();
  }

  // #stop-pill-row を nearbyStops に応じて動的に再構築する（2026-09-13、姉妹アプリ
  // SG在住Naviのカテゴリフィルターピル(.filter-chip)を参考にしたデザインに刷新。
  // 従来のドット+「Nearest bus stop」等のテキストラベルは、バス停名そのものが
  // 見えないため分かりにくいとの指摘があり、ピル自体にバス停名を表示する
  // タブ切り替えUIに置き換えた）。GPS取得完了後、nearbyStopsが確定した
  // タイミングで呼び出す。
  function buildStopPillRow() {
    const rowEl = document.getElementById('stop-pill-row');
    if (!rowEl) return;

    rowEl.innerHTML = '';

    nearbyStops.forEach((stop, index) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'stop-pill';
      pill.setAttribute('role', 'tab');
      pill.setAttribute('aria-selected', String(index === currentStopIndex));
      if (index === currentStopIndex) pill.classList.add('stop-pill--active');
      // 2026-09-14ユーザー指示「Arrivalの上部のバス停名の前にバス停の番号も
      // 表示して」対応。バス停コードをバス停名の前に付ける。
      const stopCode = stop.BusStopCode || '';
      pill.textContent = stopCode ? `${stopCode} ${stop.Description || 'Bus stop'}` : (stop.Description || 'Bus stop');

      pill.addEventListener('click', () => switchToStopIndex(index));

      rowEl.appendChild(pill);
    });
  }

  // currentStopIndex に対応するピルにのみactiveクラス・aria-selectedを付与する。
  function updateStopPillActiveState() {
    const rowEl = document.getElementById('stop-pill-row');
    if (!rowEl) return;

    const pills = rowEl.querySelectorAll('.stop-pill');
    pills.forEach((pill, index) => {
      const isActive = index === currentStopIndex;
      pill.classList.toggle('stop-pill--active', isActive);
      pill.setAttribute('aria-selected', String(isActive));
      // 2026-09-16ユーザー指摘「バス停名をスワイプで切り替えたときに上の
      // 横スクロールがずれます」対応。従来はactiveクラスの付け替えのみで、
      // ピル行自体のスクロール位置は動かしていなかった。ピルタップ時は
      // タップした本人が見えている範囲内なので気づかなかったが、カード一覧の
      // 横スワイプ(initSwipeGesture→switchToStopIndex)で見えている範囲外の
      // バス停に切り替わると、activeピルが画面外にスクロールしたままになり
      // 「どれがアクティブか分からない」状態になっていた。activeピルを
      // 常にスクロール範囲内に入れる。
      if (isActive) {
        pill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    });
  }

  // #home-timetable-list に対してタッチ（および開発確認用のマウスドラッグ）
  // による横スワイプを検出し、currentStopIndex を+1/-1する
  // （ユーザー指示「Timetableも横スワイプでバス停がかわるようにして」対応）。
  function initSwipeGesture() {
    const container = document.getElementById('home-timetable-list');
    if (container) bindSwipeGestureToContainer(container);
  }

  function bindSwipeGestureToContainer(container) {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    function onSwipeStart(x, y) {
      startX = x;
      startY = y;
      tracking = true;
    }

    function onSwipeEnd(x, y) {
      if (!tracking) return;
      tracking = false;

      const deltaX = x - startX;
      const deltaY = y - startY;

      if (!isHorizontalSwipe(deltaX, deltaY)) return;

      if (deltaX < 0) {
        // 左スワイプ（次へ）
        switchToStopIndex(currentStopIndex + 1);
      } else {
        // 右スワイプ（前へ）
        switchToStopIndex(currentStopIndex - 1);
      }
    }

    // タッチイベント（実機・モバイルブラウザ向け、必須要件）
    container.addEventListener(
      'touchstart',
      (event) => {
        const touch = event.touches[0];
        if (touch) onSwipeStart(touch.clientX, touch.clientY);
      },
      { passive: true }
    );

    container.addEventListener(
      'touchend',
      (event) => {
        const touch = event.changedTouches[0];
        if (touch) onSwipeEnd(touch.clientX, touch.clientY);
      },
      { passive: true }
    );

    // マウスドラッグ（PCブラウザでの開発確認用。必須ではないが実装容易なため追加）
    container.addEventListener('mousedown', (event) => {
      onSwipeStart(event.clientX, event.clientY);
    });

    container.addEventListener('mouseup', (event) => {
      onSwipeEnd(event.clientX, event.clientY);
    });

    // ドラッグ中にカードリスト外でボタンを離した場合はスワイプ扱いにしない
    container.addEventListener('mouseleave', () => {
      tracking = false;
    });
  }

  /* ══════════════════════════════════════════════
   * フェーズ2 タスク4: GPS取得〜最寄りバス停自動検出
   * ══════════════════════════════════════════════ */

  // 現在ヘッダーに表示中のバス停名。ミニ経路図（renderMiniRoute）の
  // 始点ラベルに使うため、updateHeaderStopName()の呼び出しに合わせて
  // モジュールスコープに保持しておく（フェーズ4 タスク分解ステップ2）。
  let currentStopName = '';

  // ヘッダーのバス停名表示を更新する
  function updateHeaderStopName(name) {
    currentStopName = name || '';
    const el = document.querySelector('.app-header-stop-name');
    if (el) el.textContent = name;
  }

  // GPS取得中〜nearby API呼び出し中のローディング表示。
  function renderGpsLoadingState() {
    const timetableContainer = document.getElementById('home-timetable-list');
    if (timetableContainer) {
      timetableContainer.innerHTML = `
        <div class="placeholder-screen">
          <i class="ti ti-loader-2" aria-hidden="true"></i>
          <p>Getting your location…</p>
        </div>
      `;
    }
    clearApproachingBar();
  }

  // GPS失敗時・マスタ未準備時のフォールバックUI表示切替。
  // 表示中はTimetable・バス停ピル行・Approachingバーを隠し、フォールバックUIの
  // みを見せる。地図パネルは4節失敗系「GPS取得前・取得失敗時は、地図パネルは
  // 空またはフォールバック表示にとどめ、下部のGPSフォールバックUIの表示を
  // 妨げない」方針のとおり、独立してフォールバック表示に切り替える。
  function showGpsFallback(message) {
    const fallback = document.getElementById('gps-fallback');
    const messageEl = document.getElementById('gps-fallback-message');
    const timetableList = document.getElementById('home-timetable-list');
    const pillRow = document.getElementById('stop-pill-row');
    const approachingPanel = document.getElementById('home-approaching-panel');

    if (messageEl && message) messageEl.textContent = message;
    if (fallback) fallback.hidden = false;
    if (timetableList) timetableList.hidden = true;
    if (pillRow) pillRow.hidden = true;
    if (approachingPanel) approachingPanel.hidden = true;
    showHomeMapFallback('Map unavailable');
  }

  // 通常コンテンツ（Timetable・バス停ピル行・Approachingバー）を再表示し、
  // フォールバックUIを隠す。GPS取得に成功した場合に呼ぶ。
  // 地図自体の表示切替はrenderHomeMapPins()呼び出し側で行う。
  function hideGpsFallback() {
    const fallback = document.getElementById('gps-fallback');
    const timetableList = document.getElementById('home-timetable-list');
    const pillRow = document.getElementById('stop-pill-row');
    const approachingPanel = document.getElementById('home-approaching-panel');

    if (fallback) fallback.hidden = true;
    if (timetableList) timetableList.hidden = false;
    if (pillRow) pillRow.hidden = false;
    if (approachingPanel) approachingPanel.hidden = false;
  }

  // /api/bus-stops/nearby を呼び出し、成功時は最寄りバス停の到着情報を表示する。
  async function loadNearbyStopsAndArrivals(lat, lng) {
    renderGpsLoadingState();
    saveLastLocation(lat, lng);

    let response;
    try {
      response = await fetch(
        API_BASE + `/api/bus-stops/nearby?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&limit=${NEARBY_LIMIT}`
      );
    } catch (err) {
      // ネットワークエラー等でサーバーに到達できない場合
      showGpsFallback('Unable to load bus stop information. Please check your connection and try again.');
      return;
    }

    if (response.status === 503) {
      // busStopsCacheが空（マスタ未準備）。権限拒否とは異なるメッセージにする。
      showGpsFallback('Bus stop information is being prepared. Please wait a moment.');
      return;
    }

    if (!response.ok) {
      showGpsFallback('Unable to load bus stop information. Please try again later.');
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      showGpsFallback('Unable to load bus stop information. Please try again later.');
      return;
    }

    const stops = Array.isArray(data.stops) ? data.stops : [];
    if (stops.length === 0) {
      showGpsFallback('No bus stops were found nearby.');
      return;
    }

    // 横スワイプ実装（タスク5）で使うため、近傍3件をモジュール変数に保持しておく。
    nearbyStops = stops;
    currentStopIndex = 0;

    hideGpsFallback();
    buildStopPillRow();
    // フェーズ6 4節正常系「バス停切替のたびに地図の中心・ピンが再取得した
    // nearbyStopsに合わせて更新される」。GPS更新・段階的取得の上書きの
    // いずれの経路でも、最新の現在地座標でピンを描画し直す。
    renderHomeMapPins(lat, lng);

    const nearestStop = nearbyStops[0];
    currentDisplayedStop = nearestStop;
    updateHeaderStopName(nearestStop.Description || 'Near your location');
    loadBusArrivals(nearestStop.BusStopCode);
  }

  // ネイティブアプリ(Capacitor)/Web両対応の位置情報取得ラッパー。
  //
  // 2026-09-16実機(TestFlight)で発見・修正: ネイティブアプリ(Capacitor)内で
  // 標準のnavigator.geolocationを使うと、WKWebView内蔵のWebKitレベルの権限
  // ダイアログ（"'localhost' would like to use your current location. This
  // website will use your precise location because 'SGBusNavi' currently has
  // access..."）が表示され、「localhost」「website」という開発者向けの表記が
  // そのままユーザーに見えてしまっていた(ユーザー指摘「App版これがでます」)。
  // ネイティブアプリ内では@capacitor/geolocationプラグイン(iOSのネイティブ
  // CLLocationManagerに直接橋渡しする)を使うことで、OS標準の自然な権限
  // ダイアログ（"SGBusNavi" Would Like to Use Your Location）になる。
  // Web版(PWA、bus.willoa.net)ではCapacitorのプラグインは存在しないため、
  // 従来通りnavigator.geolocationを使う（window.Capacitorの有無で分岐）。
  // どちらの経路でもエラーは{message: 'denied'|'disabled'|'unavailable'|'timeout'|...}
  // 形式に正規化し、呼び出し元でメッセージ分岐を1箇所に共通化できるようにする。
  function isNativeGeoAvailable() {
    return Boolean(
      window.Capacitor &&
        window.Capacitor.isNativePlatform &&
        window.Capacitor.isNativePlatform() &&
        window.Capacitor.Plugins &&
        window.Capacitor.Plugins.Geolocation
    );
  }

  function getCurrentCoords(options) {
    if (isNativeGeoAvailable()) {
      return window.Capacitor.Plugins.Geolocation.getCurrentPosition(options).then(
        (position) => position.coords
      );
    }

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(position.coords),
        (error) => {
          // error.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
          // POSITION_UNAVAILABLE は「このサイトへの許可」ではなく「端末の位置情報サービス自体がオフ」の
          // ケースで発生することが多い（iOS Safari等）。許可拒否と区別して設定変更を明示的に促す。
          let code = 'unavailable';
          if (error.code === error.PERMISSION_DENIED) code = 'denied';
          else if (error.code === error.TIMEOUT) code = 'timeout';
          reject(new Error(code));
        },
        { maximumAge: 0, ...options }
      );
    });
  }

  function buildGpsErrorMessage(error) {
    const msg = (error && error.message) || '';
    if (/denied/i.test(msg)) {
      return 'Location access was denied. Please allow location access in your device Settings.';
    } else if (/disabled|unavailable/i.test(msg)) {
      return 'Location Services appear to be turned off. Please turn on Location Services in your device Settings.';
    } else if (/timeout/i.test(msg)) {
      return 'Getting your location timed out. Please check your signal and try again.';
    }
    return 'Unable to get your location.';
  }

  // GPS取得のエントリーポイント。
  //
  // 2026-09-17ユーザー指示による3段階の段階的取得:
  // 1. 直近成功時の座標(localStorage、LAST_LOCATION_MAX_AGE_MS以内)があれば、
  //    GPS/位置情報の取得を一切待たずに即座にそれで暫定表示する（「アプリを
  //    立ち上げた瞬間に現在地が分かるようにしたい」対応、到着時刻自体は
  //    必ずサーバーから最新を取り直すため鮮度の問題はない）。
  // 2. Wi-Fi/セルタワーベースの粗い位置(速いが精度は低い)。
  // 3. 高精度GPS(enableHighAccuracy:true)。初回取得は数秒〜10秒かかることが
  //    ある（特に高層ビルの多いシンガポールの屋内）。このアプリの核心機能
  //    （最寄りバス停の自動検出）は精度が命のため、段階1・2で暫定表示済みでも
  //    高精度取得自体は必ず行う。
  // 2・3は並行してリクエストし、どちらか早く届いた方で(1がなければ)先に暫定
  // 表示する。より正確な結果が後から届いた時点で、ユーザーがまだ最寄りバス停
  // （0番目）を見ている場合のみ結果を差し替える（既に2番目以降のバス停に
  // 手動でスワイプ/タップ済みの場合は、表示を勝手に0番目へ戻して驚かせない
  // よう上書きしない）。
  async function initGpsLocation() {
    renderGpsLoadingState();

    if (!isNativeGeoAvailable() && !('geolocation' in navigator)) {
      showGpsFallback('Your browser does not support location services.');
      return;
    }

    let shownAnyLocation = false;

    // 1. 直近成功時の座標があれば、位置情報取得を待たずに即座に暫定表示する。
    const lastLocation = loadLastLocation();
    if (lastLocation) {
      shownAnyLocation = true;
      loadNearbyStopsAndArrivals(lastLocation.lat, lastLocation.lng);
    }

    // 2. 粗い位置（速いが精度は低い）。失敗しても高精度側の結果を待てばよいため、
    // ここでのエラーはフォールバック表示せず黙って無視する。
    getCurrentCoords({ enableHighAccuracy: false, timeout: GPS_FAST_TIMEOUT_MS, maximumAge: GPS_FAST_MAX_AGE_MS })
      .then((coords) => {
        if (shownAnyLocation) return; // キャッシュ済み座標or高精度側が先に届いていれば何もしない
        shownAnyLocation = true;
        loadNearbyStopsAndArrivals(coords.latitude, coords.longitude);
      })
      .catch(() => {
        // 粗い位置の取得失敗は無視（高精度側の結果を待つ）
      });

    // 高精度（GPS）。こちらが本命の正確な結果。
    try {
      const coords = await getCurrentCoords({
        enableHighAccuracy: true,
        timeout: GPS_TIMEOUT_MS,
        maximumAge: GPS_ACCURATE_MAX_AGE_MS,
      });
      if (shownAnyLocation && currentStopIndex !== 0) return; // ユーザーが既に他のバス停を見ている場合は上書きしない
      shownAnyLocation = true;
      loadNearbyStopsAndArrivals(coords.latitude, coords.longitude);
    } catch (error) {
      if (shownAnyLocation) return; // 粗い位置で既に何か表示できていれば高精度側の失敗は無視してよい
      showGpsFallback(buildGpsErrorMessage(error));
    }
  }

  /* ══════════════════════════════════════════════
   * バス停検索共通ユーティリティ
   * （旧ボトムナビ「Search」画面は2026-09-13に削除済み。ここに残る定数・関数は
   *   目的地登録の「By Route」「By Bus Stop」タブ（/api/bus-services/:serviceNo/stops、
   *   /api/bus-stops/search）から引き続き参照されているため残置している）
   * ══════════════════════════════════════════════ */

  // 検索欄のデバウンス間隔（ミリ秒）。By Route/By Bus Stopタブで使用。
  const SEARCH_DEBOUNCE_MS = 300;

  // これ未満の文字数ではAPIを呼ばない
  // （サーバー側の最小文字数制約 SEARCH_MIN_QUERY_LENGTH=2 と揃える）
  const SEARCH_MIN_QUERY_LENGTH = 2;

  // バス停コードの先頭2文字からバッジ用の文字列を作る（既存マークアップパターン踏襲: OT, EI 等）。
  // Descriptionの先頭2文字を使う。By Route/By Bus Stopタブの結果リストで使用。
  function buildStopBadgeText(description) {
    const trimmed = (description || '').trim();
    if (!trimmed) return '??';
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  }

  document.addEventListener('DOMContentLoaded', () => {
    initBottomNav();
    initRouteModal();
    initHighlightPicker();
    initApproachingScrollHint();
    initSwipeGesture();
    initGpsLocation();

    const gpsRetryBtn = document.getElementById('gps-fallback-retry-btn');
    if (gpsRetryBtn) {
      gpsRetryBtn.addEventListener('click', () => {
        initGpsLocation();
      });
    }

    initDestinations();
    initPullToRefresh();
    initSettingsScreen();
  });

  /* ══════════════════════════════════════════════
   * フェーズ6: Settings画面（Profile / Account / App Settings / Support & Info / Feedback）
   * sg-weekend-app（姉妹アプリ）のSettings画面のロジックを踏襲する
   * （2026-09-13ユーザー指示「基本同じロジックを使って」）。
   *
   * - Account節: SGBusNaviには認証機構が一切ないため、Google/Appleログイン等は
   *   移植せず空のプレースホルダー行のみとする（2026-09-13ユーザー確定指示）。
   * - Website/Contact/Privacy Policy: 実URLが未確定のため、行自体は表示しつつ
   *   .settings-item--disabledでタップ不可にする（2026-09-13ユーザー確定指示）。
   *   URL確定後はHTML側でhrefを設定しdisabledクラスを外すだけでよい。
   * - フィードバック送信: sg-weekend-appと同じくLINE Messaging APIへのPushで
   *   開発者に通知する（2026-09-13ユーザー確定指示「同じline通知でお願いします」）。
   * ══════════════════════════════════════════════ */

  const NICKNAME_STORAGE_KEY = 'sgbusnavi_nickname';
  const THEME_STORAGE_KEY = 'sgbusnavi_theme';

  function loadNickname() {
    try {
      return window.localStorage.getItem(NICKNAME_STORAGE_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  // 戻り値: 保存に成功したかどうか（persistDestinations()と同じ「サイレント失敗禁止」規約）。
  function persistNickname(value) {
    try {
      window.localStorage.setItem(NICKNAME_STORAGE_KEY, value);
      return true;
    } catch (err) {
      console.error('ニックネームの保存に失敗しました（localStorage書き込みエラー）:', err);
      return false;
    }
  }

  function getTheme() {
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) || 'light';
    } catch (err) {
      return 'light';
    }
  }

  // sg-weekend-appのapplyTheme()と同一方式: html[data-theme="dark"]の付け外しのみ行う。
  function applyTheme() {
    const mode = getTheme();
    const html = document.documentElement;
    if (mode === 'dark') {
      html.setAttribute('data-theme', 'dark');
    } else if (mode === 'light') {
      html.removeAttribute('data-theme');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) html.setAttribute('data-theme', 'dark');
      else html.removeAttribute('data-theme');
    }
    updateThemeUI();
  }

  function updateThemeUI() {
    const label = document.getElementById('settings-dark-mode-label');
    if (!label) return;
    const labels = { auto: 'Auto', light: 'Off', dark: 'On' };
    label.textContent = labels[getTheme()] || labels.light;
  }

  function cycleTheme() {
    const cycle = { auto: 'light', light: 'dark', dark: 'auto' };
    const next = cycle[getTheme()] || 'auto';
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (err) {
      console.error('テーマ設定の保存に失敗しました（localStorage書き込みエラー）:', err);
      window.alert('Could not save this setting. Please try again.');
      return;
    }
    applyTheme();
  }

  // 2026-09-17ユーザー指摘「アプリの方はビルド番号が表示されてないです」で追加:
  // /api/versionはpackage.jsonのマーケティングバージョン(例: 1.0.0)のみを返し、
  // ビルド番号(CI実行のたびにgithub.run_numberで自動採番、TestFlight上で
  // 「1.0.0 (11)」のように表示される値)はサーバー側にはそもそも存在しない
  // （ネイティブバンドルのInfo.plistにのみ焼き込まれるCI時点の値のため）。
  // ネイティブアプリ内では@capacitor/appの App.getInfo() でInfo.plistから
  // 直接読み取り、Web版は従来通りバージョンのみ表示する。
  async function loadAppVersion() {
    const versionLabel = document.getElementById('settings-version-label');
    if (!versionLabel) return;

    if (_isCapacitorApp && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      try {
        const info = await window.Capacitor.Plugins.App.getInfo();
        versionLabel.textContent = info.version ? `v${info.version} (${info.build})` : '—';
        return;
      } catch (err) {
        // ネイティブ側取得に失敗した場合はWeb版と同じ/api/versionのフォールバックに委ねる
      }
    }

    try {
      const res = await fetch(API_BASE + '/api/version');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      versionLabel.textContent = data.version ? `v${data.version}` : '—';
    } catch (err) {
      versionLabel.textContent = '—';
    }
  }

  async function sendFeedback() {
    const textarea = document.getElementById('settings-feedback-text');
    const sendBtn = document.getElementById('settings-feedback-send-btn');
    if (!textarea || !sendBtn) return;

    const message = textarea.value.trim();
    if (!message) {
      // ボタン押下時の前提条件チェックで早期returnする場合は必ずユーザーに理由を伝える
      // （CLAUDE.md「サイレント失敗の禁止」規約）。
      window.alert('Please enter a message before sending.');
      return;
    }

    sendBtn.disabled = true;
    const originalLabel = sendBtn.textContent;
    sendBtn.textContent = 'Sending…';

    try {
      const res = await fetch(API_BASE + '/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      textarea.value = '';
      window.alert('Thanks! Your feedback has been sent.');
    } catch (err) {
      // 送信失敗時は入力内容を消さない（ユーザーが打ち直す手間を防ぐ）。
      window.alert("Couldn't send feedback. Please try again.");
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = originalLabel;
    }
  }

  // シェアシート（Settings画面「Share」ボタン、2026-09-14追加、姉妹アプリ
  // sg-weekend-appのQR共有シートを参考に実装。ユーザー指示「SG在住Naviの設定を
  // 参考に、シェアをつけて」）。ネイティブアプリが未リリースのため、QRコード・
  // シェア本文のリンク先は当面Web版URL(bus.willoa.net)に固定する（ユーザー指示
  // 「QRコードのURLはまだWeb版のURLでいいです」）。ネイティブアプリが出た際は
  // ここを差し替える。
  const SHARE_URL = 'https://bus.willoa.net';

  function initShareSheet() {
    const openBtn = document.getElementById('settings-share-btn');
    const overlay = document.getElementById('share-sheet-overlay');
    const closeBtn = document.getElementById('share-sheet-close');
    const shareBtn = document.getElementById('share-sheet-share-btn');
    const qrEl = document.getElementById('share-sheet-qr');
    if (!openBtn || !overlay) return;

    function openShareSheet() {
      // QRコードは初回オープン時のみ生成しキャッシュする（毎回再生成は不要な処理）。
      if (qrEl && !qrEl.hasChildNodes() && typeof window.qrcode === 'function') {
        const qr = window.qrcode(0, 'M');
        qr.addData(SHARE_URL);
        qr.make();
        qrEl.innerHTML = qr.createSvgTag(6, 4);
      }
      overlay.classList.add('visible');
    }

    function closeShareSheet() {
      overlay.classList.remove('visible');
    }

    openBtn.addEventListener('click', openShareSheet);
    if (closeBtn) closeBtn.addEventListener('click', closeShareSheet);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeShareSheet();
    });

    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const text = `Real-time bus arrivals for Singapore 🚌\n\n${SHARE_URL}`;
        const data = { title: 'SGBusNavi', text, url: SHARE_URL };
        if (navigator.share) {
          try {
            await navigator.share(data);
          } catch (err) {
            // ユーザーによるキャンセル等はエラー扱いしない（sg-weekend-appと同じ方針）
          }
        } else if (navigator.clipboard) {
          // 「サイレント失敗の禁止」原則(CLAUDE.md)に従い、クリップボードへの
          // コピー成功・失敗のいずれもユーザーに通知する。
          try {
            await navigator.clipboard.writeText(SHARE_URL);
            window.alert('Link copied to clipboard!');
          } catch (err) {
            window.alert(`Could not copy the link. Please copy it manually: ${SHARE_URL}`);
          }
        } else {
          window.alert(SHARE_URL);
        }
      });
    }
  }

  function initSettingsScreen() {
    const nicknameInput = document.getElementById('settings-nickname-input');
    if (nicknameInput) {
      nicknameInput.value = loadNickname();
      nicknameInput.addEventListener('input', () => {
        persistNickname(nicknameInput.value.trim());
      });
    }

    applyTheme();

    const darkModeBtn = document.getElementById('settings-dark-mode-btn');
    if (darkModeBtn) {
      darkModeBtn.addEventListener('click', cycleTheme);
    }

    loadAppVersion();

    const feedbackSendBtn = document.getElementById('settings-feedback-send-btn');
    if (feedbackSendBtn) {
      feedbackSendBtn.addEventListener('click', sendFeedback);
    }

    initShareSheet();

    // OS側のダーク/ライト切替に追従するリスナー登録は付随機能のため、万一
    // 未対応環境でmatchMedia自体が例外を投げても上記の必須バインディング
    // （ダークモードボタン・バージョン表示・フィードバック送信）を巻き込んで
    // 失敗させないよう、最後にtry/catchで囲んで登録する。
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getTheme() === 'auto') applyTheme();
      });
    } catch (err) {
      // 付随機能のため握りつぶしてよい（Autoモードの手動切替は引き続き機能する）
    }
  }

  /* ══════════════════════════════════════════════
   * フェーズ3-B タスク分解ステップ8: 目的地登録機能
   * フェーズ5 タスク分解ステップ2: 目的地登録の入口3方式化
   * （plan.md 第1-1節・第3節・第6節ステップ2）
   *
   * 目的地登録モーダルに「By Route」「By Bus Stop」「By Map」の3タブを設け、
   * いずれの入口から選んでも共通のsaveDestination()を呼ぶ。
   *
   * - By Route: GET /api/bus-services/:serviceNo/stops で系統が通る
   *   全バス停一覧を取得し、一覧の各行から直接登録する。
   * - By Bus Stop: 既存の /api/bus-stops/search をそのまま流用する
   *   （Search画面と同じデバウンス・最小文字数挙動）。
   * - By Map: 既存の地図タップ→最寄りバス停確認フローをそのまま維持する
   *   （タップ地点の曖昧さがあるため確認ダイアログを残す）。
   *
   * By Route・By Bus Stopはユーザーが一覧から明示的に1件を選ぶ操作のため
   * 曖昧さがなく、地図タップ（同じ「確認」でも実際には最寄り店の推測が
   * 挟まる）とは性質が異なる。誤タップの心配がある地図フローとの一貫性より
   * 操作数の少なさを優先し、一覧からは確認ダイアログなしで直接登録し、
   * 登録直後は行内の＋ボタンを一時的にチェックマークに変えて完了を知らせる
   * （plan.md 第1-1節「確認画面いずれからも共通の登録処理を呼ぶ」を踏まえた実装判断）。
   * ══════════════════════════════════════════════ */

  const DESTINATIONS_STORAGE_KEY = 'sgbusnavi_destinations';

  /* ── フェーズ5第7節: 目的地カテゴリアイコン ──
   * 当初のWork(カバン)/Lessons(本棚、見た目が一時停止ボタンに見えて分かり
   * づらいとの指摘)は2026-09-14ユーザー指示「カバンとか一時停止とかはよく
   * 分からないので消して」により廃止し、より直感的に分かるMall(ショッピング
   * バッグ)/School(卒業帽)に差し替えた（モック比較mockups/category-icons-v1.html
   * のうえ、ユーザー例示「モールとか職場とか学校とか」から2件選定）。
   * その後、Mallのアイコンがショッピングバッグに見えず「鞄」に見えるとの
   * 指摘を受け、2026-09-14「鞄の代わりにオフィスビルで、あとショッピング
   * モール追加して」により、鞄アイコンはOffice(オフィスビル)として新設し、
   * Mallは分かりやすいショッピングカートのアイコンに差し替えた
   * （mallキー自体は既存データ互換のため維持、アイコンのみ変更）。
   * ボトムナビ（home/star）と共通のパスを再利用しているアイコンがある。 */
  const DESTINATION_CATEGORIES = ['home', 'office', 'mall', 'school', 'other'];
  const DESTINATION_CATEGORY_LABELS = {
    home: 'Home',
    office: 'Office',
    mall: 'Mall',
    school: 'School',
    other: 'Other',
  };
  const DESTINATION_CATEGORY_ICON_SVG = {
    home: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 L4 10 V20 H9 V14 H15 V20 H20 V10 Z"/></svg>',
    office: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20"/><path d="M9 6h1M14 6h1M9 10h1M14 10h1M9 14h1M14 14h1M10 22v-4h4v4"/></svg>',
    mall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="20" r="1.4" fill="currentColor" stroke="none"/><path d="M2.5 3h2.5l2.8 12.2a2 2 0 0 0 2 1.6h7.4a2 2 0 0 0 2-1.6L21 7H6"/></svg>',
    school: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 22 8 12 13 2 8Z"/><path d="M6 10.3V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.7l-6 3-6-3Z"/></svg>',
    other: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5 L14.9 8.6 L21.6 9.5 L16.8 14.1 L18 20.8 L12 17.6 L6 20.8 L7.2 14.1 L2.4 9.5 L9.1 8.6 Z"/></svg>',
  };

  // 未知・未設定のcategory値は後方互換のフォールバックとして'other'扱いにする
  // （過去登録データにcategoryフィールドが存在しないケースを含む）。
  function normalizeDestinationCategory(category) {
    return DESTINATION_CATEGORIES.includes(category) ? category : 'other';
  }

  /* ── アイコン色パレット（2026-09-13ユーザー指示: 保存済みバス停のアイコン色を
   * 編集可能にする機能で使用）。SGBusNavi全体のアクセントカラー(柳グリーン)は
   * 変更せず、カテゴリバッジ用に少数色の専用パレットを新規追加する
   * （AskUserQuestionで「新規に少数色のパレットを追加」を選択、既存の
   * caramel/sage/terracotta等はSGBusNaviでは全て同一の柳グリーンに
   * エイリアスされておりそのままでは使えないため）。
   *
   * 2026-09-14ユーザー指摘「MRTの色と保存したバッジの色がどうしても被る。
   * 青のバッジとブルーラインが紛らわしい」により、旧パレット(green/blue/
   * orange/purple/red/teal)はMRTの7路線色(赤/緑/紫/橙/青/茶/灰)とほぼ同系統
   * だったため、MRTが使っていない色相(黄/黄緑/青緑/藍/赤紫/淡いピンク)を
   * 中心にした新パレットに差し替えた（モック比較
   * mockups/destination-palette-mrt-safe-v1.html）。 ── */
  const DESTINATION_ICON_COLORS = ['gold', 'lime', 'turquoise', 'indigo', 'magenta', 'rose'];
  const DESTINATION_ICON_COLOR_LABELS = {
    gold: 'Gold',
    lime: 'Lime',
    turquoise: 'Turquoise',
    indigo: 'Indigo',
    magenta: 'Magenta',
    rose: 'Rose',
  };

  // 旧パレットのキーが既存データ（localStorage）に残っている場合の読み替え表。
  // ユーザーの「色を区別して使い分けていた」意図はできるだけ保ったまま、
  // MRTと被らない対応する新色に1:1でマッピングする。
  const LEGACY_DESTINATION_ICON_COLOR_MAP = {
    green: 'lime',
    blue: 'indigo',
    orange: 'gold',
    purple: 'magenta',
    red: 'rose',
    teal: 'turquoise',
  };

  // 未知・未設定のiconColor値は後方互換のフォールバックとして先頭色扱いにする。
  function normalizeDestinationIconColor(iconColor) {
    if (DESTINATION_ICON_COLORS.includes(iconColor)) return iconColor;
    if (LEGACY_DESTINATION_ICON_COLOR_MAP[iconColor]) return LEGACY_DESTINATION_ICON_COLOR_MAP[iconColor];
    return DESTINATION_ICON_COLORS[0];
  }

  // 色ピッカー（6つの丸スウォッチ横並び）のマークアップを生成する。
  function buildIconColorPickerHtml(selectedColor) {
    const swatches = DESTINATION_ICON_COLORS.map((color) => {
      const isActive = color === selectedColor;
      const activeClass = isActive ? ' destination-color-btn--active' : '';
      const label = DESTINATION_ICON_COLOR_LABELS[color];
      return `
        <button type="button" class="destination-color-btn destination-color-btn--${color}${activeClass}" data-color="${color}" aria-label="${label}" aria-pressed="${isActive}"></button>
      `;
    }).join('');
    return `<div class="destination-color-picker">${swatches}</div>`;
  }

  // カテゴリピッカー（4つの丸ボタン横並び）のマークアップを生成する。
  // By Route/By Bus Stopのインライン展開・By Mapの確認ダイアログの両方から共用する。
  function buildCategoryPickerHtml(selectedCategory) {
    const buttons = DESTINATION_CATEGORIES.map((category) => {
      const isActive = category === selectedCategory;
      const activeClass = isActive ? ' destination-category-btn--active' : '';
      const label = DESTINATION_CATEGORY_LABELS[category];
      return `
        <button type="button" class="destination-category-btn${activeClass}" data-category="${category}" aria-label="${label}" aria-pressed="${isActive}">
          ${DESTINATION_CATEGORY_ICON_SVG[category]}
        </button>
      `;
    }).join('');
    return `<div class="destination-category-picker">${buttons}</div>`;
  }

  // シンガポール中心付近の初期表示位置・ズームレベル（plan.md 12節ステップ8の指示に準拠）
  const MAP_INITIAL_CENTER = [1.3521, 103.8198];
  const MAP_INITIAL_ZOOM = 13;

  // 目的地のカスタムタイトル（ユーザー自由入力）をinnerHTMLに差し込む前に
  // エスケープする。バス停名（LTA由来）と異なりユーザーが任意の文字列を
  // 入力できるフィールドのため、HTML注入を防ぐ目的で導入（2026-09-14追加）。
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // 簡易ID生成（uuid未導入のため、タイムスタンプ+乱数で衝突をほぼ回避する）。
  function generateDestinationId() {
    return `dest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // localStorageから登録済み目的地一覧を読み込む。壊れたデータは空配列扱いにする。
  function loadDestinations() {
    try {
      const raw = window.localStorage.getItem(DESTINATIONS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      // 同一busStopCodeの重複除去（2026-09-14実機で発見・修正: 従来は
      // saveDestination()に重複チェックがなく、同じバス停を複数回登録できて
      // しまっていた。既存データに紛れ込んだ重複を読み込み時に自動で
      // クリーンアップし、そのまま書き戻す。先に登録された方（カスタム
      // タイトル等を設定済みの可能性が高い）を残す）。
      const seenStopCodes = new Set();
      let hasDuplicates = false;
      const deduped = parsed.filter((dest) => {
        if (!dest || !dest.busStopCode) return true;
        if (seenStopCodes.has(dest.busStopCode)) {
          hasDuplicates = true;
          return false;
        }
        seenStopCodes.add(dest.busStopCode);
        return true;
      });

      if (hasDuplicates) {
        persistDestinations(deduped);
      }

      return deduped;
    } catch (err) {
      return [];
    }
  }

  // 目的地一覧をそのままlocalStorageに書き戻す（内部ヘルパー）。
  // 不具合3調査（実機で断続的に「保存したのにSaved画面に出ない」報告）:
  // 従来はここでcatchした例外を握りつぶしていたため、QuotaExceededError
  // （容量超過）やSafariプライベートブラウジングでのlocalStorage書き込み
  // 拒否が発生した場合、saveDestination()自体は「成功したかのように」
  // 静かに終了し、renderDestinationList()が再描画しても実際にはデータが
  // 書き込まれていない（＝表示されない）という状態になり得た。
  // 呼び出し元が失敗を検知できるよう、真偽値を返すようにする。
  function persistDestinations(destinations) {
    try {
      window.localStorage.setItem(DESTINATIONS_STORAGE_KEY, JSON.stringify(destinations));
      return true;
    } catch (err) {
      // localStorageが使用不可（プライベートモード・容量超過等）の場合は
      // 保存できなかったことを呼び出し元に伝える。
      console.error('目的地の保存に失敗しました（localStorage書き込みエラー）:', err);
      return false;
    }
  }

  // 新しい目的地を1件追加する。plan.md 2-1節のデータ構造（id/busStopCode/
  // description/lat/lng/registeredAt）に従う。
  // 2026-09-14実機で発見・修正: 同じバス停を複数回登録できてしまう不具合が
  // 報告された（当初は「重複登録の排除は行わない」という未確定仕様だったが、
  // ユーザー指示によりここで排除するよう確定）。同一busStopCodeが既に
  // 登録済みの場合は追加せず'duplicate'を返す。
  // 戻り値: 'duplicate'（既に登録済み）/ true（保存成功）/ false（保存失敗、
  // 呼び出し元でUIフィードバックに使う）。
  function saveDestination(stop, lat, lng, category = 'other') {
    if (!stop || !stop.BusStopCode) {
      return false;
    }

    const before = loadDestinations();
    if (before.some((dest) => dest.busStopCode === stop.BusStopCode)) {
      return 'duplicate';
    }

    const entry = {
      id: generateDestinationId(),
      busStopCode: stop.BusStopCode,
      description: stop.Description || 'Bus stop',
      lat,
      lng,
      registeredAt: new Date().toISOString(),
      category: normalizeDestinationCategory(category),
      iconColor: 'green',
    };

    const updated = [...before, entry];
    const ok = persistDestinations(updated);
    return ok;
  }

  // 指定idの目的地を削除する。
  function deleteDestination(id) {
    const updated = loadDestinations().filter((d) => d.id !== id);
    persistDestinations(updated);
  }

  // 指定idの目的地のフィールド（category/iconColor等）を更新する
  // （2026-09-13ユーザー指示「保存、アイコン、アイコンの色、この3つの設定を
  // 保存し、編集ができる」。保存後もアイコン種類・色を変更できるようにする）。
  // 戻り値: 保存に成功したかどうか（persistDestinations()と同じ規約）。
  function updateDestination(id, updates) {
    const destinations = loadDestinations();
    const index = destinations.findIndex((d) => d.id === id);
    if (index === -1) return false;

    destinations[index] = { ...destinations[index], ...updates };
    return persistDestinations(destinations);
  }

  // 目的地一覧セクションを再描画する（0件時は空状態表示）。
  /* ══════════════════════════════════════════════
   * Bus Stops一覧のドラッグ&ドロップ並べ替え（2026-09-14ユーザー指示
   * 「順番をドラッグ&ドロップで変えれるようにしたい。3本線で動かすやつ」対応）
   *
   * 各行の左端に3本線ハンドル(.destination-item-drag-handle、ti-menu-2)を
   * 追加し、ドラッグ中はハンドルを掴んだ行をposition:fixedで画面上に浮かせて
   * 指の動きに追従させ、元の位置にはプレースホルダー(高さだけ持つ空div)を
   * 残して他の行が自然に詰める/開くようにする（SortableJS等でも使われる
   * 標準的な実装パターン）。並べ替え確定はpointerup時にDOM順から
   * destinations配列を再構築してpersistDestinations()で保存する。
   * 一覧はlistEl.innerHTML = ''で毎回作り直されるため、行ごとにリスナーを
   * 貼るのではなく#destination-listへの委譲(pointerdown)で1回だけ初期化する。
   * ══════════════════════════════════════════════ */
  let destinationDragState = null;

  function initDestinationListDragReorder() {
    const listEl = document.getElementById('destination-list');
    if (!listEl) return;

    listEl.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('.destination-item-drag-handle');
      if (!handle) return;
      const item = handle.closest('.destination-item');
      if (!item) return;

      event.preventDefault();

      const rect = item.getBoundingClientRect();
      const placeholder = document.createElement('div');
      placeholder.className = 'destination-item-placeholder';
      placeholder.style.height = `${rect.height}px`;
      item.before(placeholder);

      item.style.position = 'fixed';
      item.style.top = `${rect.top}px`;
      item.style.left = `${rect.left}px`;
      item.style.width = `${rect.width}px`;
      item.style.zIndex = '1000';
      item.classList.add('destination-item--dragging');

      destinationDragState = {
        item,
        placeholder,
        startClientY: event.clientY,
        initialTop: rect.top,
      };

      try {
        handle.setPointerCapture(event.pointerId);
      } catch (err) {
        // setPointerCaptureが使えない環境でもdocumentレベルのリスナーで継続動作する。
      }

      document.addEventListener('pointermove', onDestinationDragMove);
      document.addEventListener('pointerup', onDestinationDragEnd);
      document.addEventListener('pointercancel', onDestinationDragEnd);
    });
  }

  function onDestinationDragMove(event) {
    if (!destinationDragState) return;
    const { item, placeholder, startClientY, initialTop } = destinationDragState;

    const deltaY = event.clientY - startClientY;
    item.style.top = `${initialTop + deltaY}px`;

    const listEl = document.getElementById('destination-list');
    if (!listEl) return;

    const siblings = Array.from(listEl.querySelectorAll('.destination-item')).filter((el) => el !== item);
    const itemRect = item.getBoundingClientRect();
    const itemMidY = itemRect.top + itemRect.height / 2;

    for (const sib of siblings) {
      const sibRect = sib.getBoundingClientRect();
      const sibMidY = sibRect.top + sibRect.height / 2;
      const placeholderIsBeforeSib = Boolean(
        placeholder.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING
      );

      if (itemMidY > sibMidY && placeholderIsBeforeSib) {
        sib.after(placeholder);
        break;
      }
      if (itemMidY < sibMidY && !placeholderIsBeforeSib) {
        sib.before(placeholder);
        break;
      }
    }
  }

  function onDestinationDragEnd() {
    if (!destinationDragState) return;
    const { item, placeholder } = destinationDragState;

    placeholder.replaceWith(item);
    item.style.position = '';
    item.style.top = '';
    item.style.left = '';
    item.style.width = '';
    item.style.zIndex = '';
    item.classList.remove('destination-item--dragging');

    document.removeEventListener('pointermove', onDestinationDragMove);
    document.removeEventListener('pointerup', onDestinationDragEnd);
    document.removeEventListener('pointercancel', onDestinationDragEnd);

    // DOM上の最終的な並び順からdestinations配列を再構築して保存する。
    const listEl = document.getElementById('destination-list');
    if (listEl) {
      const newOrderIds = Array.from(listEl.querySelectorAll('.destination-item')).map((el) => el.dataset.id);
      const destinations = loadDestinations();
      const byId = new Map(destinations.map((dest) => [dest.id, dest]));
      const reordered = newOrderIds.map((id) => byId.get(id)).filter(Boolean);
      // 件数が一致する場合のみ保存する（想定外の状態で並び順が壊れるのを防ぐ安全策）。
      if (reordered.length === destinations.length) {
        const ok = persistDestinations(reordered);
        // サイレント失敗禁止の方針（CLAUDE.md）に従い、保存失敗時はユーザーに
        // 知らせる。並べ替え自体の見た目は既にDOM上で確定しているため、
        // 次回一覧を開き直すと元の順序に戻ってしまうことを伝える。
        if (!ok) {
          window.alert('Could not save the new order. Your device storage may be full or restricted.');
        }
      }
    }

    destinationDragState = null;
  }

  function renderDestinationList() {
    const listEl = document.getElementById('destination-list');
    if (!listEl) return;

    const destinations = loadDestinations();
    listEl.innerHTML = '';

    if (destinations.length === 0) {
      listEl.innerHTML = `
        <div class="destination-empty">
          <i class="ti ti-map-pin-off" aria-hidden="true"></i>
          <p>No bus stops saved yet</p>
        </div>
      `;
      return;
    }

    destinations.forEach((dest) => {
      // 過去登録データにcategory/iconColorフィールドが存在しない場合は
      // それぞれ'other'/'green'にフォールバックする（後方互換要件）。
      const category = normalizeDestinationCategory(dest.category);
      const iconColor = normalizeDestinationIconColor(dest.iconColor);

      // カスタムタイトル（例:「日本人会」）が設定されていればそれを表示名にし、
      // バス停の元の名称は補足情報として下に小さく残す。未設定時は従来通り
      // バス停名を表示名として使う（2026-09-14ユーザー指示）。
      const hasCustomTitle = Boolean(dest.title && dest.title.trim());
      const displayName = hasCustomTitle ? escapeHtml(dest.title.trim()) : escapeHtml(dest.description);
      const subMetaHtml = hasCustomTitle
        ? `<div class="destination-item-meta">${escapeHtml(dest.description)} · ${dest.busStopCode}</div>`
        : `<div class="destination-item-meta">${dest.busStopCode}</div>`;

      // タイトル未設定の場合、常時表示のプロンプトを出す（2026-09-14ユーザー
      // 指示「タイトルをつけられるようにして。どこか分かるようにです。
      // タイトルが重要です」対応）。従来はカテゴリバッジをタップしないと
      // タイトル入力欄の存在に気づけなかったため、目立つ入口を追加した。
      const addTitlePromptHtml = hasCustomTitle
        ? ''
        : `<button type="button" class="destination-item-add-title-btn">
             <i class="ti ti-pencil" aria-hidden="true"></i>
             <span>Add a title</span>
           </button>`;

      const item = document.createElement('div');
      item.className = 'destination-item';
      // 2026-09-14ユーザー指示「順番をドラッグ&ドロップで変えれるようにしたい」
      // 対応。並べ替え確定時（onDestinationDragEnd）にDOM順からdestinations
      // 配列を再構築するため、各行にidを持たせて対応付けられるようにする。
      item.dataset.id = dest.id;
      item.innerHTML = `
        <button type="button" class="destination-item-drag-handle" aria-label="Drag to reorder">
          <i class="ti ti-menu-2" aria-hidden="true"></i>
        </button>
        <button type="button" class="destination-item-category-badge destination-item-category-badge--${iconColor}" aria-label="Edit icon: ${DESTINATION_CATEGORY_LABELS[category]}">
          ${DESTINATION_CATEGORY_ICON_SVG[category]}
        </button>
        <div class="destination-item-info">
          <div class="destination-item-name">${displayName}</div>
          ${subMetaHtml}
          ${addTitlePromptHtml}
          <div class="destination-item-services" hidden></div>
        </div>
        <button type="button" class="destination-item-delete" aria-label="Delete">
          <i class="ti ti-trash" aria-hidden="true"></i>
        </button>
      `;

      const deleteBtn = item.querySelector('.destination-item-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          deleteDestination(dest.id);
          renderDestinationList();
        });
      }

      // アイコンバッジ、または「Add a title」プロンプトをタップすると、
      // タイトル入力・アイコン種類・アイコン色を変更できる編集パネルを
      // インライン展開する（2026-09-13ユーザー指示。By Route/By Bus Stopの
      // 既存カテゴリピッカー展開パターンを踏襲、タップ即反映で別途「保存」
      // ボタンは設けない）。2026-09-14: タイトル欄の入口をバッジタップだけに
      // 頼らず複数用意するため、トグル処理を関数化して両方から呼べるようにした。
      function toggleDestinationEditor() {
        const existingEditor = item.querySelector('.destination-item-editor');
        if (existingEditor) {
          existingEditor.remove();
          return;
        }

        const editor = document.createElement('div');
        editor.className = 'destination-item-editor';
        editor.innerHTML = `
          <div class="destination-item-title-row">
            <span class="destination-item-title-label">Title</span>
            <input type="text" class="destination-item-title-input" maxlength="30"
              placeholder="e.g. Japanese Association" aria-label="Custom title"
              value="${dest.title ? escapeHtml(dest.title) : ''}">
          </div>
          ${buildCategoryPickerHtml(category)}
          ${buildIconColorPickerHtml(iconColor)}
          <div class="destination-item-editor-footer">
            <button type="button" class="destination-item-editor-done">Done</button>
          </div>
        `;
        item.appendChild(editor);

        // 2026-09-14ユーザー指摘「この画面が閉じられません」対応。従来は
        // バッジ再タップのみが閉じる手段で、その挙動を示す視覚的なヒントが
        // 何もなかったため気づけなかった。明示的な閉じるボタンを追加する。
        const doneBtn = editor.querySelector('.destination-item-editor-done');
        if (doneBtn) {
          doneBtn.addEventListener('click', toggleDestinationEditor);
        }

        // タイトルはキー入力のたびに保存するが、renderDestinationList()を
        // 呼ぶと入力中のinput要素ごと再生成されフォーカスが失われるため、
        // 表示名だけをDOM上で直接更新する（次回リスト再描画時にも反映される
        // よう保存自体はupdateDestination()で行う）。
        const titleInput = editor.querySelector('.destination-item-title-input');
        if (titleInput) {
          titleInput.focus();
          titleInput.addEventListener('input', () => {
            const value = titleInput.value.trim();
            updateDestination(dest.id, { title: value });
            const nameEl = item.querySelector('.destination-item-name');
            if (nameEl) nameEl.textContent = value || dest.description;
            const metaEl = item.querySelector('.destination-item-meta');
            if (metaEl) {
              metaEl.textContent = value ? `${dest.description} · ${dest.busStopCode}` : dest.busStopCode;
            }
            // タイトルが入力されたら常時表示プロンプトは不要になるため隠し、
            // 逆に空に戻された場合は再表示する。
            const addTitlePromptEl = item.querySelector('.destination-item-add-title-btn');
            if (addTitlePromptEl) addTitlePromptEl.hidden = Boolean(value);
          });
        }

        editor.querySelectorAll('.destination-category-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            updateDestination(dest.id, { category: btn.dataset.category });
            renderDestinationList();
          });
        });

        editor.querySelectorAll('.destination-color-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            updateDestination(dest.id, { iconColor: btn.dataset.color });
            renderDestinationList();
          });
        });
      }

      const badgeBtn = item.querySelector('.destination-item-category-badge');
      if (badgeBtn) {
        badgeBtn.addEventListener('click', toggleDestinationEditor);
      }

      const addTitleBtn = item.querySelector('.destination-item-add-title-btn');
      if (addTitleBtn) {
        addTitleBtn.addEventListener('click', toggleDestinationEditor);
      }

      // 通過系統番号（2026-09-13ユーザー指示「バス停のところには何番のバスが
      // 通るかも表示するように」）。バス停一覧全体の初回描画をブロックしたく
      // ないため、行自体は即座に描画し、系統番号だけ非同期に差し込む。
      const servicesEl = item.querySelector('.destination-item-services');
      if (servicesEl && dest.busStopCode) {
        fetchStopServiceNumbers(dest.busStopCode).then((services) => {
          if (!services || services.length === 0) return;
          const shown = services.slice(0, 10).join(', ');
          const suffix = services.length > 10 ? '…' : '';
          servicesEl.textContent = `Bus: ${shown}${suffix}`;
          servicesEl.hidden = false;
        });
      }

      listEl.appendChild(item);
    });
  }

  // バス停コード -> 通過系統番号配列（解決結果をキャッシュし、Saved画面の
  // 再描画のたびに同じバス停へ重複リクエストしないようにする）。
  const stopServiceNumbersCache = new Map();

  function fetchStopServiceNumbers(stopCode) {
    if (!stopServiceNumbersCache.has(stopCode)) {
      stopServiceNumbersCache.set(
        stopCode,
        fetch(API_BASE + `/api/bus-stops/${encodeURIComponent(stopCode)}/services`)
          .then((res) => (res.ok ? res.json() : { services: [] }))
          .then((data) => (Array.isArray(data.services) ? data.services : []))
          .catch(() => [])
      );
    }
    return stopServiceNumbersCache.get(stopCode);
  }

  // 目的地登録モーダル（2タブ: By Route/By Bus Stop）を開く。
  // 2026-09-14ユーザー指示「By Mapはやっぱり要らない、分かりにくい」により
  // By Mapタブ（Leaflet地図タップ登録フロー）自体を廃止した。
  function openDestinationPickerModal() {
    const overlay = document.getElementById('destination-map-modal-overlay');
    if (!overlay) return;

    overlay.classList.add('visible');
    switchDestinationTab('route');
  }

  function closeDestinationPickerModal() {
    const overlay = document.getElementById('destination-map-modal-overlay');
    if (overlay) overlay.classList.remove('visible');
  }

  /* ── タブ切替（セグメントコントロール） ── */

  const DESTINATION_TAB_IDS = ['route', 'stop'];

  function switchDestinationTab(tabName) {
    if (!DESTINATION_TAB_IDS.includes(tabName)) return;

    DESTINATION_TAB_IDS.forEach((name) => {
      const tabBtn = document.getElementById(`destination-tab-${name}`);
      const panel = document.getElementById(`destination-panel-${name}`);
      const isActive = name === tabName;
      if (tabBtn) tabBtn.setAttribute('aria-selected', String(isActive));
      if (panel) panel.hidden = !isActive;
    });

    // By Route/By Bus Stopタブを開くたびに、下部の近隣バス停候補を再取得する
    // （ページ読み込み直後の初回呼び出し時はGPSが未解決だった可能性があるため）。
    if (tabName === 'route' || tabName === 'stop') {
      renderNearbyStopsSection(`destination-${tabName}-nearby-list`);
    }
  }

  function initDestinationTabs() {
    DESTINATION_TAB_IDS.forEach((name) => {
      const tabBtn = document.getElementById(`destination-tab-${name}`);
      if (tabBtn) {
        tabBtn.addEventListener('click', () => switchDestinationTab(name));
      }
    });
  }

  /* ── By Route タブ: 系統番号からバス停一覧 ── */

  // 検索欄デバウンス間隔はバス停検索と揃える（既存のSEARCH_DEBOUNCE_MS=300msを再利用）。
  let routeStopsDebounceTimer = null;
  let routeStopsRequestToken = 0;

  function renderRouteStopsMessage(message) {
    const listEl = document.getElementById('destination-route-list');
    if (!listEl) return;
    listEl.innerHTML = `<div class="search-history-message">${message}</div>`;
  }

  // By Route一覧の1行を生成する。既存buildStopListItem()と同じ
  // .search-history-itemマークアップパターンをベースにしつつ、右端に
  // 登録専用の＋ボタンを追加した.destination-result-itemを使う
  // （一覧タップ=詳細表示ではなく登録操作そのものであるSearch画面と役割が異なるため）。
  //
  // 2026-09-14ユーザー指示: By Route/By Bus Stop/By Mapいずれも登録時には
  // アイコン選択を挟まず直接登録するように変更（従来はここでカテゴリピッカーを
  // インライン展開していたが廃止）。アイコン・色はSaved画面で登録後にのみ
  // 変更できる（destination-item-category-badgeタップで編集、既存実装）。
  // 通過系統番号一覧（services: string[]）を「Bus: 67, 154, 961M」形式の
  // 小さな1行にする。8件を超える場合は省略記号を付ける（一覧の縦幅肥大化を防ぐ）。
  // servicesが空・未提供（古いAPIレスポンス等）の場合は何も表示しない。
  function buildServiceNumbersLineHtml(services, className) {
    if (!Array.isArray(services) || services.length === 0) return '';
    const shown = services.slice(0, 8).join(', ');
    const suffix = services.length > 8 ? '…' : '';
    return `<div class="${className}">Bus: ${shown}${suffix}</div>`;
  }

  function buildDestinationResultItem(stop, onAdd) {
    const item = document.createElement('div');
    item.className = 'destination-result-item';

    const description = stop.Description || 'Bus stop';
    const roadName = stop.RoadName || '';
    const busStopCode = stop.BusStopCode || '';
    const metaText = [busStopCode, roadName].filter(Boolean).join(' · ');
    const servicesHtml = buildServiceNumbersLineHtml(stop.services, 'destination-result-services');

    item.innerHTML = `
      <div class="destination-result-row">
        <div class="search-history-badge">${buildStopBadgeText(description)}</div>
        <div class="search-history-info">
          <div class="search-history-name">${description}</div>
          <div class="search-history-meta">${metaText}</div>
          ${servicesHtml}
        </div>
        <button type="button" class="destination-result-add-btn" aria-label="Save this bus stop">
          <i class="ti ti-plus" aria-hidden="true"></i>
        </button>
      </div>
    `;

    const addBtn = item.querySelector('.destination-result-add-btn');
    if (addBtn) {
      // 不具合3対応: タッチデバイスのゴーストクリック等でこのボタンが二重発火
      // した場合に登録処理（onAdd/saveDestination）が二重に走らないよう、
      // 1回処理したら即座に無効化する。
      let added = false;
      addBtn.addEventListener('click', () => {
        if (added) return;
        added = true;
        onAdd(stop, addBtn, 'other');
      });
    }

    return item;
  }

  // 登録処理の共通ラッパー。saveDestination()を呼び、Saved画面一覧を再描画した上で、
  // タップされた＋ボタンを一時的にチェックマークに変えて完了を知らせる
  // （地図タブの確認ダイアログとは異なり、一覧からの選択は曖昧さがないため
  // 確認ステップなしの直接登録とする。理由は本ブロック冒頭コメント参照）。
  function registerDestinationFromResult(stop, addBtn, category) {
    if (!stop || !stop.BusStopCode) {
      return;
    }

    const saved = saveDestination(stop, stop.Latitude, stop.Longitude, category);
    renderDestinationList();

    if (saved === 'duplicate') {
      // 2026-09-14実機で発見・修正: 同じバス停が複数回登録される不具合の対応。
      // 既に保存済みという意味では「望む状態は既に達成されている」ため、
      // エラー扱いにはせず、チェックマークに変えて分かりやすく知らせる。
      window.alert('This bus stop is already saved to your list.');
      if (addBtn) {
        addBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i>';
        addBtn.disabled = true;
      }
      return;
    }

    if (!saved) {
      // localStorage書き込み失敗時（容量超過・プライベートモード等）は
      // ＋ボタンをチェックマークに変えず、失敗をユーザーに知らせる
      // （不具合3対応: 従来は失敗時も成功したように見えてしまっていた）。
      window.alert('Could not save this destination. Your device storage may be full or restricted.');
      return;
    }

    if (addBtn) {
      addBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i>';
      addBtn.disabled = true;
    }
  }

  // /api/bus-services/:serviceNo/stops を呼び出し、結果を描画する。
  async function performRouteStopsSearch(serviceNo) {
    const token = ++routeStopsRequestToken;
    renderRouteStopsMessage('Searching…');

    let response;
    try {
      response = await fetch(API_BASE + `/api/bus-services/${encodeURIComponent(serviceNo)}/stops`);
    } catch (err) {
      if (token !== routeStopsRequestToken) return;
      renderRouteStopsMessage('Search failed. Please check your connection.');
      return;
    }

    if (token !== routeStopsRequestToken) return;

    if (response.status === 404) {
      renderRouteStopsMessage('No stops found for this route.');
      return;
    }

    if (response.status === 503) {
      renderRouteStopsMessage('Route information is being prepared. Please try again later.');
      return;
    }

    if (!response.ok) {
      renderRouteStopsMessage('Search failed.');
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (token !== routeStopsRequestToken) return;
      renderRouteStopsMessage('Search failed.');
      return;
    }

    if (token !== routeStopsRequestToken) return;

    const stops = Array.isArray(data.stops) ? data.stops : [];
    if (stops.length === 0) {
      renderRouteStopsMessage('No stops found for this route.');
      return;
    }

    const listEl = document.getElementById('destination-route-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    stops.forEach((stop) => {
      listEl.appendChild(buildDestinationResultItem(stop, registerDestinationFromResult));
    });
  }

  function initDestinationRouteInput() {
    const input = document.getElementById('destination-route-input');
    if (!input) return;
    const nearbySection = document.getElementById('destination-route-nearby-section');

    input.addEventListener('input', () => {
      const query = input.value.trim();

      // 2026-09-14ユーザー指示「Near byは検索ボックスに何も入力がないときだけ
      // でいい。何か入力されたらその検索結果を優先して表示して」により、
      // 近隣バス停候補は検索クエリが空の時だけ表示する。
      if (nearbySection) nearbySection.hidden = query.length > 0;

      if (routeStopsDebounceTimer) {
        clearTimeout(routeStopsDebounceTimer);
        routeStopsDebounceTimer = null;
      }

      if (query.length === 0) {
        routeStopsRequestToken += 1;
        renderRouteStopsMessage('Enter a service number to see its stops.');
        return;
      }

      routeStopsDebounceTimer = setTimeout(() => {
        performRouteStopsSearch(query);
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  /* ── By Bus Stop タブ: 既存/api/bus-stops/searchの流用 ── */

  let destinationStopDebounceTimer = null;
  let destinationStopRequestToken = 0;

  function renderDestinationStopMessage(message) {
    const listEl = document.getElementById('destination-stop-list');
    if (!listEl) return;
    listEl.innerHTML = `<div class="search-history-message">${message}</div>`;
  }

  const NEARBY_DESTINATION_SUGGESTION_LIMIT = 5;
  // コンテナIDごとに個別のトークンを持たせ、By Route/By Bus Stop両方の
  // セクションを同時に更新しても互いのfetch結果を誤ってキャンセルしないようにする。
  const nearbyStopsSuggestionTokens = new Map();

  // By Route/By Bus Stopいずれのタブでも、検索状態（クエリの有無・結果件数）に
  // 関わらず画面下部に常に近隣バス停候補を表示する（2026-09-14ユーザー指示
  // 「どの検索のケースでも下に現在位置から近いバス停を表示するように」）。
  // 現在地そのものの再取得はせず、Home画面で既に取得済みのcurrentDisplayedStopの
  // 座標をそのまま使う（GPS許可ダイアログの再表示を避けるため）。
  async function renderNearbyStopsSection(containerId) {
    const listEl = document.getElementById(containerId);
    if (!listEl) return;

    if (!currentDisplayedStop || currentDisplayedStop.Latitude == null || currentDisplayedStop.Longitude == null) {
      listEl.innerHTML = '';
      return;
    }

    const token = (nearbyStopsSuggestionTokens.get(containerId) || 0) + 1;
    nearbyStopsSuggestionTokens.set(containerId, token);
    listEl.innerHTML = '<div class="search-history-message">Loading nearby bus stops…</div>';

    let response;
    try {
      response = await fetch(
        API_BASE + `/api/bus-stops/nearby?lat=${currentDisplayedStop.Latitude}&lng=${currentDisplayedStop.Longitude}` +
          `&limit=${NEARBY_DESTINATION_SUGGESTION_LIMIT}`
      );
    } catch (err) {
      if (token !== nearbyStopsSuggestionTokens.get(containerId)) return;
      listEl.innerHTML = '';
      return;
    }

    if (token !== nearbyStopsSuggestionTokens.get(containerId)) return;
    if (!response.ok) {
      listEl.innerHTML = '';
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      listEl.innerHTML = '';
      return;
    }

    if (token !== nearbyStopsSuggestionTokens.get(containerId)) return;

    const stops = Array.isArray(data.stops) ? data.stops : [];
    listEl.innerHTML = '';
    stops.forEach((stop) => {
      listEl.appendChild(buildDestinationResultItem(stop, registerDestinationFromResult));
    });
  }

  function renderAllNearbyStopSections() {
    renderNearbyStopsSection('destination-route-nearby-list');
    renderNearbyStopsSection('destination-stop-nearby-list');
  }

  // Search画面のperformSearch()と同じ/api/bus-stops/searchを呼ぶが、結果の描画先・
  // 登録動線（タップ即遷移ではなく＋ボタンでの直接登録）が異なるため専用に実装する。
  async function performDestinationStopSearch(query) {
    const token = ++destinationStopRequestToken;
    renderDestinationStopMessage('Searching…');

    let response;
    try {
      response = await fetch(API_BASE + `/api/bus-stops/search?q=${encodeURIComponent(query)}`);
    } catch (err) {
      if (token !== destinationStopRequestToken) return;
      renderDestinationStopMessage('Search failed. Please check your connection.');
      return;
    }

    if (token !== destinationStopRequestToken) return;

    if (!response.ok) {
      let message = 'Search failed.';
      try {
        const errBody = await response.json();
        if (errBody && errBody.error) message = errBody.error;
      } catch (parseErr) {
        // JSONパース失敗時はデフォルトメッセージのまま
      }
      if (token !== destinationStopRequestToken) return;
      renderDestinationStopMessage(message);
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (token !== destinationStopRequestToken) return;
      renderDestinationStopMessage('Search failed.');
      return;
    }

    if (token !== destinationStopRequestToken) return;

    const stops = Array.isArray(data.stops) ? data.stops : [];
    if (stops.length === 0) {
      renderDestinationStopMessage('No results found');
      return;
    }

    const listEl = document.getElementById('destination-stop-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    stops.forEach((stop) => {
      listEl.appendChild(buildDestinationResultItem(stop, registerDestinationFromResult));
    });
  }

  function initDestinationStopInput() {
    const input = document.getElementById('destination-stop-input');
    if (!input) return;
    const nearbySection = document.getElementById('destination-stop-nearby-section');

    input.addEventListener('input', () => {
      const query = input.value.trim();

      // 2026-09-14ユーザー指示「Near byは検索ボックスに何も入力がないときだけ
      // でいい。何か入力されたらその検索結果を優先して表示して」により、
      // 近隣バス停候補は検索クエリが空の時だけ表示する。
      if (nearbySection) nearbySection.hidden = query.length > 0;

      if (destinationStopDebounceTimer) {
        clearTimeout(destinationStopDebounceTimer);
        destinationStopDebounceTimer = null;
      }

      if (query.length < SEARCH_MIN_QUERY_LENGTH) {
        destinationStopRequestToken += 1;
        renderDestinationStopMessage('Enter a bus stop name or number to search.');
        return;
      }

      destinationStopDebounceTimer = setTimeout(() => {
        performDestinationStopSearch(query);
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  /* ══════════════════════════════════════════════
   * PULL TO REFRESH（フェーズ5第8-2節、Home画面限定・PWAスタンドアロン時のみ）
   *
   * SG在住Navi（/home/masahiko/sg-weekend-app/public/app.js の _initPtr()、
   * 189行目付近）を参考に実装する。スクロールコンテナ内部の先頭に置いた
   * インジケーター要素のheight/opacityのみをJSで操作する点は同一。
   * ヘッダー・app-shell・html/bodyのposition/overflow/heightは一切変更しない。
   *
   * SG在住Naviとの相違点:
   * - SGBusNaviも2026-09-16以降Capacitorネイティブアプリに対応した(_isCapacitorApp
   *   は本ファイル冒頭で定義、API_BASEの判定に使用)。2026-09-17実機で発見・修正:
   *   当初PTRの起動判定はwindow.matchMedia('(display-mode: standalone)').matches ||
   *   window.navigator.standalone === trueのみだったため、ネイティブアプリ
   *   (Capacitor WKWebView)ではどちらも真にならず、下に引っ張って更新する
   *   操作自体が一切効かなかった(ユーザー指摘「アプリ側、更新のために下に
   *   Pullすることができないね」)。isStandalonePwa()に_isCapacitorAppも
   *   条件に加え、ネイティブアプリ内でもPTRを有効化した。
   * - 2026-09-13、Home画面のヘッダー（タイトル・バス停ピル行）を固定表示にする
   *   刷新に伴い、SGBusNaviもSG在住Naviと同じ専用overflow:autoスクロール
   *   コンテナ（#home-scroll-content）を持つ構造に変更した。これにより
   *   container.scrollTopで直接スクロール位置を判定できるようになり、
   *   以前使っていたwindow.scrollYベースの判定は不要になった。
   * ══════════════════════════════════════════════ */
  const PTR_THRESHOLD = 60; // これ以上引っ張って離したらリフレッシュ確定
  const PTR_MAX_PULL = 90; // インジケーターの最大高さ（クランプ）

  // ホーム画面限定のPWAスタンドアロン起動判定（ネイティブアプリも含む）。
  // iOS Safari: navigator.standalone、Android Chrome等: display-mode: standalone、
  // Capacitorネイティブアプリ: _isCapacitorApp のいずれかがtrueなら、
  // ブラウザのアドレスバー等が存在しない「アプリらしい」画面とみなす。
  function isStandalonePwa() {
    return (
      _isCapacitorApp ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true
    );
  }

  // container: タッチイベントを監視するDOM要素（#home-scroll-content）。
  // indicatorId: インジケーター要素のid。
  // onRefresh: async関数。データ再取得処理。
  // getScrollTop: 現在のスクロール位置を返す関数（最上部判定に使用）。
  function _initPtr(container, indicatorId, onRefresh, getScrollTop) {
    if (!isStandalonePwa()) return; // PWAスタンドアロン起動時のみ有効化
    if (!container || container._ptrInit) return;
    container._ptrInit = true;

    const indicator = document.getElementById(indicatorId);
    if (!indicator) return;

    let startY = 0;
    let pulling = false;
    let refreshing = false;

    container.addEventListener(
      'touchstart',
      (e) => {
        if (refreshing) return;
        startY = e.touches[0].clientY;
        pulling = false;
      },
      { passive: true }
    );

    container.addEventListener(
      'touchmove',
      (e) => {
        if (refreshing) return;

        const dy = e.touches[0].clientY - startY;
        if (dy <= 0) {
          // 上方向 or 動きなし → 通常のスクロールに委ねる
          if (pulling) {
            pulling = false;
            indicator.style.height = '0px';
            indicator.style.opacity = '0';
          }
          return;
        }
        if (getScrollTop() > 0) return; // 最上部でない → PTR対象外

        pulling = true;
        e.preventDefault(); // 引っ張り中はスクロールコンテナのバウンスを起こさない
        const pull = Math.min(dy, PTR_MAX_PULL);
        indicator.style.height = pull + 'px';
        indicator.style.opacity = String(Math.min(pull / PTR_THRESHOLD, 1));
      },
      { passive: false }
    );

    container.addEventListener(
      'touchend',
      async () => {
        if (refreshing || !pulling) {
          pulling = false;
          return;
        }
        pulling = false;
        const curHeight = parseFloat(indicator.style.height) || 0;
        if (curHeight >= PTR_THRESHOLD) {
          refreshing = true;
          indicator.classList.add('ptr-refreshing');
          indicator.style.height = PTR_THRESHOLD + 'px';
          indicator.style.opacity = '1';
          try {
            await onRefresh();
          } catch (_) {
            // 失敗してもインジケーターは必ず消す（無限ローディング防止）
          } finally {
            indicator.classList.remove('ptr-refreshing');
            indicator.style.height = '0px';
            indicator.style.opacity = '0';
            refreshing = false;
          }
        } else {
          indicator.style.height = '0px';
          indicator.style.opacity = '0';
        }
      },
      { passive: true }
    );
  }

  // Home画面のスクロール位置（bodyスクロール構造のためwindow.scrollYを使う。
  // 一部ブラウザ向けフォールバックとしてdocument.documentElement.scrollTopも見る）。
  function getHomeScrollTop() {
    const container = document.getElementById('home-scroll-content');
    return container ? container.scrollTop : 0;
  }

  // Home画面限定でプルリフレッシュを初期化する。リフレッシュ処理は
  // 既存の到着情報再取得ロジック（loadBusArrivals）を呼び出す。表示中のバス停は
  // currentDisplayedStopから取得する（GPS/スワイプ/検索いずれの経路でも対応）。
  function initPullToRefresh() {
    const container = document.getElementById('home-scroll-content');
    _initPtr(
      container,
      'ptr-indicator-home',
      async () => {
        if (currentDisplayedStop && currentDisplayedStop.BusStopCode) {
          await loadBusArrivals(currentDisplayedStop.BusStopCode);
        }
      },
      getHomeScrollTop
    );
  }

  // 目的地登録UI・モーダル（By Route/By Bus Stopの2タブ）一式の初期化。
  function initDestinations() {
    renderDestinationList();
    initDestinationTabs();
    initDestinationRouteInput();
    initDestinationStopInput();
    initDestinationListDragReorder();
    renderRouteStopsMessage('Enter a service number to see its stops.');
    renderDestinationStopMessage('Enter a bus stop name or number to search.');

    const addBtn = document.getElementById('destination-add-btn');
    const closeBtn = document.getElementById('destination-map-modal-close');
    const overlay = document.getElementById('destination-map-modal-overlay');

    if (addBtn) {
      addBtn.addEventListener('click', openDestinationPickerModal);
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', closeDestinationPickerModal);
    }

    if (overlay) {
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeDestinationPickerModal();
      });
    }
  }

  /* ══════════════════════════════════════════════
   * ステップ5: Service Worker登録（PWA化）
   *
   * 静的アセットのcache-first配信を有効化する。
   * /api/* はsw.js側で必ずnetwork-onlyにしているため、
   * バス到着時刻のリアルタイム性には影響しない。
   * ══════════════════════════════════════════════ */
  if ('serviceWorker' in navigator) {
    // 新しいService Workerが有効化され制御が切り替わったら自動でリロードする。
    // これがないと、CACHE_VERSIONを上げてデプロイしても既存タブ/PWAセッションでは
    // 手動でアプリを完全に閉じて2回開き直すまで新しいコンテンツが反映されない
    // （skipWaiting+clients.claimだけでは「今表示中のページ」への反映は保証されないため）。
    let swRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swRefreshing) return;
      swRefreshing = true;
      window.location.reload();
    });

    let swRegistration = null;

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((registration) => {
        swRegistration = registration;
        // ページを開いたまま長時間放置されているケースに備え、明示的に更新確認も行う。
        registration.update();
      }).catch((err) => {
        console.error('Service Workerの登録に失敗しました:', err);
      });
    });

    // 2026-09-17実機で発見: iOS(WebKit)のホーム画面追加PWA(standalone)は、
    // アプリを完全に閉じて再度開いた場合でも'load'イベント自体が発火しない
    // （前回セッションのページがバックグラウンドから復帰するだけの扱いになる）
    // ケースがあり、その場合sw.jsの更新確認自体が長期間まったく走らず、
    // CACHE_VERSIONを上げても実機に反映されない不具合があった(ユーザー指摘
    // 「Web版は直ってないね」)。visibilitychangeでアプリがフォアグラウンドに
    // 戻るたびにも明示的な更新確認を行うことで、この抜け穴を塞ぐ。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && swRegistration) {
        swRegistration.update();
      }
    });
  }
})();
