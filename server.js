require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3010;
const LTA_API_KEY = process.env.LTA_DATAMALL_API_KEY || '';
// 注意: 旧 BusArrivalv2 エンドポイントは404を返すため廃止済み。v3/BusArrivalが現行仕様（2026-09-12確認）。
const LTA_BUS_ARRIVAL_URL = 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival';
// 注意: BusStopsはv3系が存在せず無印パスが正（2026-09-12実キーで疎通確認済み。CLAUDE.md参照）。
const LTA_BUS_STOPS_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusStops';
// 注意: BusRoutes/BusServicesもv3系が存在せず無印パスが正（.claude/plan.md フェーズ3設計書参照）。
const LTA_BUS_ROUTES_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusRoutes';
const LTA_BUS_SERVICES_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusServices';

// ステップ4: 起動時にLTA DataMall APIキーの有無を確認する。
// キーが未設定でもアプリ全体は落とさず、警告ログのみ出して起動を継続する。
// （実際のAPI呼び出し時に汎用エラーを返す形でユーザー影響を最小化する）
if (!LTA_API_KEY) {
  console.warn(
    '[警告] LTA_DATAMALL_API_KEY が .env に設定されていません。' +
      ' /api/bus-arrival は実データを取得できず、汎用エラーを返します。' +
      ' LTA DataMallサイトでAPIキーを取得後、.env に設定してください。'
  );
}

/* ══════════════════════════════════════════════
 * 一時デバッグ用: Web版PWAがキャッシュクリア・プライベートブラウズでも
 * 古いCSS/JSのまま反映されない不具合の原因調査用ログ（2026-09-17）。
 * サーバー自体は最新版を正しく返せているか、途中に何らかの中間キャッシュ
 * （キャリアの透過プロキシ等）が介在していないかを、実際にリクエストが
 * origin(このサーバー)まで届いているかどうかで切り分ける目的。
 * 原因特定後は削除してよい一時的な仕組み。
 * ══════════════════════════════════════════════ */
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/css/style.css' || req.path === '/js/app.js' || req.path === '/sw.js') {
    console.log(
      `[debug-static-request] ${new Date().toISOString()} ${req.method} ${req.path} ` +
        `ua="${req.get('User-Agent') || ''}" xff="${req.get('X-Forwarded-For') || ''}" ` +
        `ifNoneMatch="${req.get('If-None-Match') || ''}"`
    );
  }
  next();
});

// sw.js自体はブラウザ側のService Worker更新検知を妨げないよう、
// 明示的にキャッシュ無効化ヘッダーを付与する（sg-weekend-appの前例を踏襲）。
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

// アプリ紹介ページ（2026-09-15追加、sg-weekend-appのabout.dosuru.appを参考に実装）。
// bus.willoa.netはサブドメイン分割ではなく単一ドメイン構成のため、
// express.staticの拡張子なしルーティングには頼らず、/aboutへの明示的な
// ルートでpublic/about.htmlを返す。
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

/* ══════════════════════════════════════════════
 * 一時デバッグ用: クライアント側エラー受信エンドポイント
 * （2026-09-13、目的地保存が実機でのみ再現する不具合の原因究明用。
 *   原因特定後は削除してよい一時的な仕組み）
 * ══════════════════════════════════════════════ */
app.use(express.json({ limit: '20kb' }));

const CLIENT_ERROR_LOG_PATH = path.join(__dirname, 'data', 'client-errors.log');
app.post('/api/client-error', (req, res) => {
  try {
    const entry = {
      receivedAt: new Date().toISOString(),
      userAgent: req.get('User-Agent') || '',
      body: req.body,
    };
    fs.appendFileSync(CLIENT_ERROR_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[client-error] ログ書き込み失敗:', err);
  }
  res.status(204).end();
});

/* ══════════════════════════════════════════════
 * CORS（iOSネイティブアプリ/Capacitorからのクロスオリジンfetch許可）
 *
 * 2026-09-16実機(TestFlight)で発見・修正: ネイティブアプリはCapacitorの
 * webDir設定により静的アセットをアプリバンドル内にローカル同梱しており、
 * WebViewのoriginはbus.willoa.netではなくcapacitor://localhost（iOS）になる。
 * public/js/app.jsのfetch呼び出しをAPI_BASE（絶対URL）に修正しても、
 * サーバー側でこのオリジンをCORS許可していなければブラウザ側でレスポンスが
 * ブロックされる（「Getting your location…」から進まずGPS取得自体は成功して
 * いるのに後続の/api/bus-stops/nearby呼び出しが全滅する不具合の原因）。
 * sg-weekend-app（server.js）と同じ許可オリジンリストを踏襲する。
 * ══════════════════════════════════════════════ */
const ALLOWED_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'http://localhost'];
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ══════════════════════════════════════════════
 * レート制限
 *
 * 2026-09-14実機テストで発見: 従来は/api/*全体に一律30リクエスト/分を適用して
 * いたが、実際にLTA DataMallへ問い合わせるのは/api/bus-arrivalのみで、
 * 他のエンドポイント（bus-routes/summary、bus-routes/contains-stop、
 * bus-stops/nearby等）は全てサーバー起動時にロード済みのインメモリキャッシュを
 * 参照するだけで外部通信を伴わない。ところがHome画面表示時の経路情報エンリッチ
 * メント（星ハイライト・ミニ経路図判定）だけで1つのバス停につき系統数×方向数分の
 * summary/contains-stop呼び出しが発生し、バス停によっては1回の表示だけで
 * 30リクエストの大半〜全てを消費してしまい、直後に「Add Bus Stop」を開く等の
 * 操作が「Too many requests」で失敗する実害を確認した。
 *
 * 対策として、実際にLTA DataMallへ問い合わせる/api/bus-arrivalにのみ厳しめの
 * 制限（1分間30リクエスト、値は初期案のまま）を適用し、それ以外のインメモリ
 * 完結のエンドポイントには緩い制限（1分間300リクエスト、悪意あるアクセス対策
 * のみが目的）を適用する2段構成にした。
 * ══════════════════════════════════════════════ */
const busArrivalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

app.use('/api/bus-arrival', busArrivalLimiter);
app.use('/api', generalApiLimiter);

/* ══════════════════════════════════════════════
 * Settings画面: バージョン表示・フィードバック送信
 * ══════════════════════════════════════════════ */
const APP_VERSION = require('./package.json').version;

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// フィードバック受信 → LINE Push送信（sg-weekend-appと同一方式、2026-09-13ユーザー指示）。
// サーバー側にはデータを保存せず、開発者個人のLINEへの通知リレーに徹する。
app.post('/api/feedback', async (req, res) => {
  const { message } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if (!token || !userId) {
    console.error('[feedback] LINE credentials not set');
    return res.status(500).json({ error: 'LINE not configured' });
  }

  const now = new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const lineMessage = `📨 SGBusNaviにフィードバックが届きました\n\n${String(message).trim()}\n\n🕐 ${now} (SGT)`;

  try {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: lineMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[feedback] LINE push error:', err);
      return res.status(500).json({ error: 'LINE push failed' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback] LINE push failed:', err);
    res.status(500).json({ error: 'LINE push failed' });
  }
});

/* ══════════════════════════════════════════════
 * 簡易インメモリキャッシュ（Map + TTL）
 * 同一stopCodeへの短時間の連続リクエストをLTA DataMallまで
 * 飛ばさず、キャッシュされたレスポンスを返す。
 * サーバー再起動でリセットされる揮発性キャッシュで十分。
 * ══════════════════════════════════════════════ */
const CACHE_TTL_MS = 12 * 1000; // 12秒（10〜15秒レンジの中間値）
const busArrivalCache = new Map(); // key: stopCode -> { data, expiresAt }

function getCached(stopCode) {
  const entry = busArrivalCache.get(stopCode);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    busArrivalCache.delete(stopCode);
    return null;
  }
  return entry.data;
}

function setCached(stopCode, data) {
  busArrivalCache.set(stopCode, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/* ══════════════════════════════════════════════
 * GET /api/bus-arrival?stopCode=xxxxx
 *
 * LTA DataMall v3/BusArrival のサーバーサイドプロキシ。
 * AccountKeyヘッダーはサーバー側でのみ付与し、フロントには一切露出しない。
 *
 * レスポンス方針:
 * LTA側のレスポンス構造（BusStopCode, Services[]）をほぼそのまま返す。
 * 理由: 現段階ではフロント側のバスカード描画ロジック（車種判定・
 * 到着時刻の分単位変換など）がまだ実データに対して検証されておらず、
 * サーバー側で早期に独自スキーマへ整形してしまうと、LTA側の実データの
 * クセ（フィールド欠落・NextBus無し等）を把握しにくくなる。
 * 実キー取得後にレスポンス実物を確認しながら、必要であれば
 * 整形ロジックをサーバー側に足す方が手戻りが少ないと判断した。
 *
 * 例外（追加のみ・非破壊）: 2026-09-12実データ確認の結果、
 * Services[].NextBus/NextBus2/NextBus3.DestinationCodeは
 * BusStopsマスタのBusStopCodeと同一形式で、そのまま地名解決可能と判明した。
 * BusServices/BusRoutesマスタの追加取得は不要と判断し、
 * 既存のDestinationCodeフィールドは変更せず、解決済み地名を
 * DestinationName（新規フィールド）として追加するのみに留める。
 * 詳細は enrichBusArrivalWithDestinationNames() 参照。
 *
 * 注意（スキーマ前提）: LTA公式ドキュメントの一般的な記載に基づく想定。
 * Services[].NextBus / NextBus2 / NextBus3 各々に
 * EstimatedArrival（ISO8601）, Type（車種: SD/DD/BD等）,
 * Load, Feature 等が入る想定だが、実キー取得後に実データで
 * フィールド名・欠落パターンを必ず検証すること。
 * ══════════════════════════════════════════════ */
app.get('/api/bus-arrival', async (req, res) => {
  const { stopCode } = req.query;

  // バリデーション: 5桁の数字のみ許可。LTA APIへの無駄なリクエストを防ぐ。
  if (!stopCode || !/^\d{5}$/.test(stopCode)) {
    return res.status(400).json({
      error: 'stopCode must be a 5-digit number.',
    });
  }

  const cached = getCached(stopCode);
  if (cached) {
    return res.json(cached);
  }

  if (!LTA_API_KEY) {
    // フロントにはキー未設定である旨を具体的に伝えず、汎用メッセージのみ返す。
    console.error(
      `[エラー] /api/bus-arrival stopCode=${stopCode} 呼び出し失敗: LTA_DATAMALL_API_KEY が未設定です。`
    );
    return res.status(500).json({
      error: 'Server configuration is incomplete. Please try again later.',
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒でタイムアウト

  try {
    const url = `${LTA_BUS_ARRIVAL_URL}?BusStopCode=${encodeURIComponent(stopCode)}`;
    const ltaResponse = await fetch(url, {
      method: 'GET',
      headers: {
        AccountKey: LTA_API_KEY,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!ltaResponse.ok) {
      const bodyText = await ltaResponse.text().catch(() => '');
      console.error(
        `[エラー] LTA DataMall BusArrivalv2 呼び出し失敗: status=${ltaResponse.status} stopCode=${stopCode} body=${bodyText}`
      );
      return res.status(502).json({
        error: 'Failed to load bus arrival information. Please try again later.',
      });
    }

    const data = await ltaResponse.json();
    enrichBusArrivalWithDestinationNames(data);
    setCached(stopCode, data);
    return res.json(data);
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      console.error(`[エラー] LTA DataMall BusArrivalv2 タイムアウト: stopCode=${stopCode}`);
      return res.status(504).json({
        error: 'Loading bus arrival information timed out. Please try again later.',
      });
    }

    console.error(`[エラー] LTA DataMall BusArrivalv2 呼び出し中に例外発生: stopCode=${stopCode}`, err);
    return res.status(500).json({
      error: 'An error occurred while loading bus arrival information. Please try again later.',
    });
  }
});

/* ══════════════════════════════════════════════
 * BusStopsマスタ・サーバー側キャッシュ基盤
 *（フェーズ2 タスク分解ステップ2、設計書 .claude/plan.md 第8節・第9節）
 *
 * 全ユーザー共通のバス停マスタ（約5,207件）をLTA DataMallから
 * ページング取得し、data/bus-stops.json にファイルキャッシュする。
 * 起動時はファイルキャッシュを優先して読み込み、起動を高速化する。
 * ファイルが無い・一定期間より古い場合のみ、起動時に非同期で
 * LTAへ全件再取得を行い、完了後にメモリ上のデータを差し替える。
 * ══════════════════════════════════════════════ */
const BUS_STOPS_CACHE_PATH = path.join(__dirname, 'data', 'bus-stops.json');
const BUS_STOPS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24時間
const BUS_STOPS_PAGE_SIZE = 500;
const BUS_STOPS_PAGE_INTERVAL_MS = 250; // LTAへの負荷配慮のためページ取得間に待機

// メモリ上のバス停マスタ本体。次ステップの/api/bus-stops/nearby、
// /api/bus-stops/search はこの配列を参照する想定。
let busStopsCache = [];
let busStopsUpdatedAt = null; // 最終更新時刻（Date）。ログ・古さ判定に使う。
let busStopsFetchInProgress = false;

// BusStopCode -> Description（地名）への高速引き当て用Map。
// busStopsCacheが更新される（初期読み込み・LTA再取得完了）たびに再構築する。
// 用途: /api/bus-arrival の各Services[].NextBus/NextBus2/NextBus3.DestinationCode
// をバス停の地名（Description）に解決し、DestinationNameとして付与する
// （フェーズ2 タスク分解ステップ7、設計書 .claude/plan.md 第13節）。
let busStopCodeToDescriptionMap = new Map();

// BusStopCode -> { Description, RoadName } への引き当て用Map。
// 用途: 経路モーダル用の経由地点選定ロジック（フェーズ3 タスク分解ステップ5、
// .claude/plan.md 第3-2節）で、主要地名リストによる補完判定にRoadNameも
// 必要なため、Descriptionのみのbusキャッシュ済みMapとは別に保持する。
let busStopCodeToStopInfoMap = new Map();

// BusStopCode -> { Latitude, Longitude } への引き当て用Map。
// 用途: GET /api/bus-routes/path（フェーズ4 タスク分解ステップ4、
// .claude/plan.md 第3-1節）が、区間内の各停留所座標をO(1)で解決するために使用する。
let busStopCodeToLatLngMap = new Map();

function rebuildBusStopCodeToDescriptionMap() {
  busStopCodeToDescriptionMap = new Map(
    busStopsCache.map((stop) => [stop.BusStopCode, stop.Description])
  );
  busStopCodeToStopInfoMap = new Map(
    busStopsCache.map((stop) => [
      stop.BusStopCode,
      { Description: stop.Description, RoadName: stop.RoadName },
    ])
  );
  busStopCodeToLatLngMap = new Map(
    busStopsCache.map((stop) => [
      stop.BusStopCode,
      { Latitude: stop.Latitude, Longitude: stop.Longitude },
    ])
  );
}

/**
 * バス停コードから地名（Description）を引く。
 * busStopsCacheに存在しない場合（マスタ未取得・データ不整合等）はnullを返す。
 */
function resolveDestinationName(destinationCode) {
  if (!destinationCode) return null;
  return busStopCodeToDescriptionMap.get(destinationCode) || null;
}

/**
 * /api/bus-arrival のLTA生レスポンスに対し、各Services[].NextBus/NextBus2/NextBus3の
 * DestinationCodeを地名に解決し、DestinationNameフィールドを追加する。
 * 元のDestinationCode等の既存フィールドは変更しない（後方互換性維持）。
 * busStopsCacheが未準備（0件）の場合は全てnullになるが、レスポンス自体は返す
 * （フロント側がフォールバック表示するため、ここではエラーにしない）。
 */
function enrichBusArrivalWithDestinationNames(data) {
  if (!data || !Array.isArray(data.Services)) {
    return data;
  }

  for (const service of data.Services) {
    for (const key of ['NextBus', 'NextBus2', 'NextBus3']) {
      const nextBus = service[key];
      if (nextBus && typeof nextBus === 'object') {
        nextBus.DestinationName = resolveDestinationName(nextBus.DestinationCode);
      }
    }
  }

  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * LTA DataMall BusStopsエンドポイントから全件をページング取得する。
 * $skipを0,500,1000...と増やし、valueが空配列を返した時点で終了する
 * （総件数をハードコードしない）。各ページ取得の間に約250ms待機する。
 *
 * @returns {Promise<Array<{BusStopCode, RoadName, Description, Latitude, Longitude}>>}
 */
async function fetchAllBusStopsFromLta() {
  if (!LTA_API_KEY) {
    throw new Error('LTA_DATAMALL_API_KEY が .env に設定されていません。');
  }

  const results = [];
  let skip = 0;

  while (true) {
    const url = `${LTA_BUS_STOPS_URL}?$skip=${skip}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒でタイムアウト

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          AccountKey: LTA_API_KEY,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `LTA DataMall BusStops 呼び出し失敗: status=${response.status} skip=${skip} body=${bodyText}`
      );
    }

    const json = await response.json();
    const page = Array.isArray(json.value) ? json.value : [];

    if (page.length === 0) {
      break;
    }

    // 必要フィールドのみに絞って保持（軽量化。理由は完了報告参照）。
    for (const stop of page) {
      results.push({
        BusStopCode: stop.BusStopCode,
        RoadName: stop.RoadName,
        Description: stop.Description,
        Latitude: stop.Latitude,
        Longitude: stop.Longitude,
      });
    }

    console.log(`[BusStops] 取得中... ${results.length}件`);

    skip += BUS_STOPS_PAGE_SIZE;

    if (page.length < BUS_STOPS_PAGE_SIZE) {
      // 最終ページ（フルページ未満）を受け取った時点で終了。
      // 次ループでも空配列が返るはずだが、1往復節約するための早期終了。
      break;
    }

    await sleep(BUS_STOPS_PAGE_INTERVAL_MS);
  }

  return results;
}

/**
 * data/bus-stops.json を読み込み、{ updatedAt, stops } 形式で返す。
 * ファイルが存在しない・JSONとして壊れている場合はnullを返す。
 */
function loadBusStopsCacheFromDisk() {
  try {
    if (!fs.existsSync(BUS_STOPS_CACHE_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(BUS_STOPS_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.stops)) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[エラー] data/bus-stops.json の読み込みに失敗しました。', err);
    return null;
  }
}

/**
 * 取得したバス停配列をupdatedAt付きでdata/bus-stops.jsonに保存する。
 */
function saveBusStopsCacheToDisk(stops, updatedAt) {
  const payload = { updatedAt: updatedAt.toISOString(), stops };
  fs.writeFileSync(BUS_STOPS_CACHE_PATH, JSON.stringify(payload), 'utf-8');
}

/**
 * LTAから全件を取得し、メモリとファイルキャッシュの両方を更新する。
 * 失敗時は例外を投げるのみで、呼び出し側で既存キャッシュを維持する。
 */
async function refreshBusStopsCache() {
  if (busStopsFetchInProgress) {
    console.log('[BusStops] 既に取得処理が進行中のためスキップします。');
    return;
  }
  busStopsFetchInProgress = true;
  console.log('[BusStops] LTA DataMallからの全件取得を開始します...');

  try {
    const stops = await fetchAllBusStopsFromLta();
    const updatedAt = new Date();
    busStopsCache = stops;
    busStopsUpdatedAt = updatedAt;
    rebuildBusStopCodeToDescriptionMap();
    saveBusStopsCacheToDisk(stops, updatedAt);
    console.log(
      `[BusStops] 取得完了: ${stops.length}件、data/bus-stops.jsonに保存しました。`
    );
  } catch (err) {
    // 既存キャッシュ（メモリ・ファイル）はそのまま維持し、アプリは落とさない。
    console.error(
      '[エラー] BusStopsマスタの取得に失敗しました。既存キャッシュがあればそれを使用し続けます。',
      err
    );
  } finally {
    busStopsFetchInProgress = false;
  }
}

/**
 * サーバー起動時に呼び出す初期化処理。
 * - ファイルキャッシュがあれば即座にメモリへ読み込み、起動を高速化する。
 * - キャッシュが無い、または24時間以上古い場合は非同期でLTA再取得を走らせる
 *   （取得完了を待たずに起動を継続する）。
 */
function initBusStopsCache() {
  const cached = loadBusStopsCacheFromDisk();

  if (cached) {
    busStopsCache = cached.stops;
    busStopsUpdatedAt = cached.updatedAt ? new Date(cached.updatedAt) : null;
    rebuildBusStopCodeToDescriptionMap();
    console.log(
      `[BusStops] data/bus-stops.json からキャッシュを読み込みました（${busStopsCache.length}件、` +
        `更新日時: ${busStopsUpdatedAt ? busStopsUpdatedAt.toISOString() : '不明'}）。`
    );
  } else {
    console.log('[BusStops] data/bus-stops.json が存在しません。初回取得を行います。');
  }

  const isStale =
    !busStopsUpdatedAt || Date.now() - busStopsUpdatedAt.getTime() > BUS_STOPS_MAX_AGE_MS;

  if (isStale) {
    if (cached) {
      console.log('[BusStops] キャッシュが24時間以上古いため、バックグラウンドで再取得します。');
    }
    // 起動をブロックしないよう、完了を待たずに非同期実行する。
    refreshBusStopsCache();
  } else {
    console.log('[BusStops] キャッシュは最新のため、起動時のLTA再取得はスキップします。');
  }
}

/* ══════════════════════════════════════════════
 * BusRoutes・BusServicesマスタ・サーバー側キャッシュ基盤
 *（フェーズ3 タスク分解ステップ3、設計書 .claude/plan.md 第3節・第8節）
 *
 * BusStopsキャッシュ基盤（上記）と対称的なパターンで、
 * 系統の経由停留所情報（BusRoutes、全26,808件）と系統マスタ
 * （BusServices、全800件）をLTA DataMallからページング取得し、
 * それぞれ data/bus-routes.json / data/bus-services.json に
 * ファイルキャッシュする。起動時はファイルキャッシュを優先して
 * 読み込み、古い・存在しない場合のみ非同期でLTA再取得を行う。
 *
 * このブロックはBusRoutes・BusServicesの取得・キャッシュ基盤のみを扱う。
 * 経由地点選定ロジック・本番用エンドポイント（GET /api/bus-routes/summary）は
 * このファイル下部で実装済み（フェーズ3 タスク分解ステップ5、
 * .claude/plan.md 第3-2節・第3-2-補節・第9節）。
 * 経路モーダルのSVG動的生成（フロント側）は次ステップで別途実装する
 * （.claude/plan.md 第12節タスク分解ステップ6）。
 * ══════════════════════════════════════════════ */
const BUS_ROUTES_CACHE_PATH = path.join(__dirname, 'data', 'bus-routes.json');
const BUS_SERVICES_CACHE_PATH = path.join(__dirname, 'data', 'bus-services.json');
const BUS_ROUTES_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24時間
const BUS_SERVICES_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24時間
const BUS_ROUTES_PAGE_SIZE = 500;
const BUS_SERVICES_PAGE_SIZE = 500;
const BUS_ROUTES_PAGE_INTERVAL_MS = 250; // LTAへの負荷配慮のためページ取得間に待機
const BUS_SERVICES_PAGE_INTERVAL_MS = 250;
const BUS_ROUTES_PROGRESS_LOG_INTERVAL = 5000; // 進捗ログの間引き間隔（件数）

// メモリ上のBusRoutes・BusServicesマスタ本体。
let busRoutesCache = [];
let busRoutesUpdatedAt = null;
let busRoutesFetchInProgress = false;

let busServicesCache = [];
let busServicesUpdatedAt = null;
let busServicesFetchInProgress = false;

// "ServiceNo|Direction" -> Array<{StopSequence, BusStopCode, Distance}>（StopSequence昇順ソート済み）。
// 次ステップ（経路モーダル実データ化）の経由地点選定ロジックが、
// 系統・方向を指定して経由停留所列を高速に引けるようにするための事前グルーピング。
// busRoutesCacheが更新される（初期読み込み・LTA再取得完了）たびに再構築する。
// 注意: StopSequenceには欠番があるため、配列インデックス=StopSequenceという
// 前提を置いてはならない（.claude/plan.md 第3節参照）。あくまで昇順ソート済み配列として扱うこと。
let busRoutesByServiceDirection = new Map();

// "ServiceNo|Direction" -> { Category, OriginCode, DestinationCode, LoopDesc }
// 1系統1方向につき1レコードのはずだが、念のため重複があれば最初の1件を採用しログに警告を出す。
let busServiceByServiceDirection = new Map();

// BusStopCode -> ServiceNo[]（そのバス停を通る系統番号の一覧、重複排除・昇順ソート済み）。
// Saved画面で各バス停が「何番のバスが通るか」を表示するための逆引きMap
// （2026-09-13ユーザー指示）。busRoutesCacheが更新されるたびに再構築する。
let busStopCodeToServiceNumbersMap = new Map();

function rebuildBusStopCodeToServiceNumbersMap() {
  const map = new Map();
  for (const route of busRoutesCache) {
    if (!map.has(route.BusStopCode)) {
      map.set(route.BusStopCode, new Set());
    }
    map.get(route.BusStopCode).add(route.ServiceNo);
  }
  const sortedMap = new Map();
  for (const [stopCode, serviceNoSet] of map.entries()) {
    sortedMap.set(
      stopCode,
      Array.from(serviceNoSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    );
  }
  busStopCodeToServiceNumbersMap = sortedMap;
  console.log(`[BusRoutes] バス停→系統番号の逆引きMap再構築完了: ${sortedMap.size}バス停`);
}

function makeServiceDirectionKey(serviceNo, direction) {
  return `${serviceNo}|${direction}`;
}

function rebuildBusRoutesByServiceDirection() {
  const map = new Map();
  for (const route of busRoutesCache) {
    const key = makeServiceDirectionKey(route.ServiceNo, route.Direction);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push({
      StopSequence: route.StopSequence,
      BusStopCode: route.BusStopCode,
      Distance: route.Distance,
    });
  }
  // 各配列をStopSequence昇順にソート（欠番があり得るため、あくまでソートキーとして扱う）。
  for (const stops of map.values()) {
    stops.sort((a, b) => a.StopSequence - b.StopSequence);
  }
  busRoutesByServiceDirection = map;
  console.log(
    `[BusRoutes] グルーピングMap再構築完了: ${map.size}系統・方向の組み合わせ`
  );
}

function rebuildBusServiceByServiceDirection() {
  const map = new Map();
  let duplicateCount = 0;
  for (const service of busServicesCache) {
    const key = makeServiceDirectionKey(service.ServiceNo, service.Direction);
    if (map.has(key)) {
      duplicateCount += 1;
      continue; // 最初の1件を採用（重複は無視）
    }
    map.set(key, {
      Category: service.Category,
      OriginCode: service.OriginCode,
      DestinationCode: service.DestinationCode,
      LoopDesc: service.LoopDesc,
    });
  }
  if (duplicateCount > 0) {
    console.warn(
      `[警告][BusServices] ServiceNo+Directionの重複レコードを${duplicateCount}件検出しました。各組み合わせにつき最初の1件のみ採用しています。`
    );
  }
  busServiceByServiceDirection = map;
  console.log(
    `[BusServices] グルーピングMap再構築完了: ${map.size}系統・方向の組み合わせ`
  );
}

/**
 * LTA DataMall BusRoutesエンドポイントから全件をページング取得する。
 * $skipを0,500,1000...と増やし、valueが空配列またはフルページ未満を
 * 返した時点で終了する（総件数をハードコードしない）。
 * 全26,808件・54ページと件数が大きいため、進捗ログは間引いて出力する。
 *
 * @returns {Promise<Array<{ServiceNo, Direction, StopSequence, BusStopCode, Distance}>>}
 */
async function fetchAllBusRoutesFromLta() {
  if (!LTA_API_KEY) {
    throw new Error('LTA_DATAMALL_API_KEY が .env に設定されていません。');
  }

  const results = [];
  let skip = 0;
  let lastLoggedAt = 0;

  while (true) {
    const url = `${LTA_BUS_ROUTES_URL}?$skip=${skip}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          AccountKey: LTA_API_KEY,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `LTA DataMall BusRoutes 呼び出し失敗: status=${response.status} skip=${skip} body=${bodyText}`
      );
    }

    const json = await response.json();
    const page = Array.isArray(json.value) ? json.value : [];

    if (page.length === 0) {
      break;
    }

    // 必要フィールドのみに絞って保持（曜日別初発・終発は不要のため除外）。
    for (const route of page) {
      results.push({
        ServiceNo: route.ServiceNo,
        Direction: route.Direction,
        StopSequence: route.StopSequence,
        BusStopCode: route.BusStopCode,
        Distance: route.Distance,
      });
    }

    if (results.length - lastLoggedAt >= BUS_ROUTES_PROGRESS_LOG_INTERVAL) {
      console.log(`[BusRoutes] 取得中... ${results.length}件`);
      lastLoggedAt = results.length;
    }

    skip += BUS_ROUTES_PAGE_SIZE;

    if (page.length < BUS_ROUTES_PAGE_SIZE) {
      break;
    }

    await sleep(BUS_ROUTES_PAGE_INTERVAL_MS);
  }

  return results;
}

/**
 * LTA DataMall BusServicesエンドポイントから全件をページング取得する。
 * 全800件・2ページのみで負荷は軽微。
 *
 * @returns {Promise<Array<{ServiceNo, Direction, Category, OriginCode, DestinationCode, LoopDesc}>>}
 */
async function fetchAllBusServicesFromLta() {
  if (!LTA_API_KEY) {
    throw new Error('LTA_DATAMALL_API_KEY が .env に設定されていません。');
  }

  const results = [];
  let skip = 0;

  while (true) {
    const url = `${LTA_BUS_SERVICES_URL}?$skip=${skip}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          AccountKey: LTA_API_KEY,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `LTA DataMall BusServices 呼び出し失敗: status=${response.status} skip=${skip} body=${bodyText}`
      );
    }

    const json = await response.json();
    const page = Array.isArray(json.value) ? json.value : [];

    if (page.length === 0) {
      break;
    }

    for (const service of page) {
      results.push({
        ServiceNo: service.ServiceNo,
        Direction: service.Direction,
        Category: service.Category,
        OriginCode: service.OriginCode,
        DestinationCode: service.DestinationCode,
        LoopDesc: service.LoopDesc,
      });
    }

    console.log(`[BusServices] 取得中... ${results.length}件`);

    skip += BUS_SERVICES_PAGE_SIZE;

    if (page.length < BUS_SERVICES_PAGE_SIZE) {
      break;
    }

    await sleep(BUS_SERVICES_PAGE_INTERVAL_MS);
  }

  return results;
}

/**
 * data/bus-routes.json を読み込み、{ updatedAt, routes } 形式で返す。
 * ファイルが存在しない・JSONとして壊れている場合はnullを返す。
 */
function loadBusRoutesCacheFromDisk() {
  try {
    if (!fs.existsSync(BUS_ROUTES_CACHE_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(BUS_ROUTES_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.routes)) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[エラー] data/bus-routes.json の読み込みに失敗しました。', err);
    return null;
  }
}

/**
 * data/bus-services.json を読み込み、{ updatedAt, services } 形式で返す。
 * ファイルが存在しない・JSONとして壊れている場合はnullを返す。
 */
function loadBusServicesCacheFromDisk() {
  try {
    if (!fs.existsSync(BUS_SERVICES_CACHE_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(BUS_SERVICES_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.services)) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[エラー] data/bus-services.json の読み込みに失敗しました。', err);
    return null;
  }
}

/**
 * 取得したBusRoutes配列をupdatedAt付きでdata/bus-routes.jsonに保存する。
 */
function saveBusRoutesCacheToDisk(routes, updatedAt) {
  const payload = { updatedAt: updatedAt.toISOString(), routes };
  fs.writeFileSync(BUS_ROUTES_CACHE_PATH, JSON.stringify(payload), 'utf-8');
}

/**
 * 取得したBusServices配列をupdatedAt付きでdata/bus-services.jsonに保存する。
 */
function saveBusServicesCacheToDisk(services, updatedAt) {
  const payload = { updatedAt: updatedAt.toISOString(), services };
  fs.writeFileSync(BUS_SERVICES_CACHE_PATH, JSON.stringify(payload), 'utf-8');
}

/**
 * LTAから全件を取得し、メモリとファイルキャッシュの両方を更新する。
 * 失敗時は例外を投げるのみで、呼び出し側で既存キャッシュを維持する。
 */
async function refreshBusRoutesCache() {
  if (busRoutesFetchInProgress) {
    console.log('[BusRoutes] 既に取得処理が進行中のためスキップします。');
    return;
  }
  busRoutesFetchInProgress = true;
  console.log('[BusRoutes] LTA DataMallからの全件取得を開始します...');

  try {
    const routes = await fetchAllBusRoutesFromLta();
    const updatedAt = new Date();
    busRoutesCache = routes;
    busRoutesUpdatedAt = updatedAt;
    rebuildBusRoutesByServiceDirection();
    rebuildBusStopCodeToServiceNumbersMap();
    saveBusRoutesCacheToDisk(routes, updatedAt);
    console.log(
      `[BusRoutes] 取得完了: ${routes.length}件、data/bus-routes.jsonに保存しました。`
    );
  } catch (err) {
    console.error(
      '[エラー] BusRoutesマスタの取得に失敗しました。既存キャッシュがあればそれを使用し続けます。',
      err
    );
  } finally {
    busRoutesFetchInProgress = false;
  }
}

/**
 * LTAから全件を取得し、メモリとファイルキャッシュの両方を更新する。
 * 失敗時は例外を投げるのみで、呼び出し側で既存キャッシュを維持する。
 */
async function refreshBusServicesCache() {
  if (busServicesFetchInProgress) {
    console.log('[BusServices] 既に取得処理が進行中のためスキップします。');
    return;
  }
  busServicesFetchInProgress = true;
  console.log('[BusServices] LTA DataMallからの全件取得を開始します...');

  try {
    const services = await fetchAllBusServicesFromLta();
    const updatedAt = new Date();
    busServicesCache = services;
    busServicesUpdatedAt = updatedAt;
    rebuildBusServiceByServiceDirection();
    saveBusServicesCacheToDisk(services, updatedAt);
    console.log(
      `[BusServices] 取得完了: ${services.length}件、data/bus-services.jsonに保存しました。`
    );
  } catch (err) {
    console.error(
      '[エラー] BusServicesマスタの取得に失敗しました。既存キャッシュがあればそれを使用し続けます。',
      err
    );
  } finally {
    busServicesFetchInProgress = false;
  }
}

/**
 * サーバー起動時に呼び出す初期化処理（BusRoutes）。
 * BusStopsと同一パターン: ファイルキャッシュがあれば即座にメモリへ読み込み、
 * 古い・存在しない場合のみ非同期でLTA再取得を走らせる（起動をブロックしない）。
 */
function initBusRoutesCache() {
  const cached = loadBusRoutesCacheFromDisk();

  if (cached) {
    busRoutesCache = cached.routes;
    busRoutesUpdatedAt = cached.updatedAt ? new Date(cached.updatedAt) : null;
    rebuildBusRoutesByServiceDirection();
    rebuildBusStopCodeToServiceNumbersMap();
    console.log(
      `[BusRoutes] data/bus-routes.json からキャッシュを読み込みました（${busRoutesCache.length}件、` +
        `更新日時: ${busRoutesUpdatedAt ? busRoutesUpdatedAt.toISOString() : '不明'}）。`
    );
  } else {
    console.log('[BusRoutes] data/bus-routes.json が存在しません。初回取得を行います。');
  }

  const isStale =
    !busRoutesUpdatedAt || Date.now() - busRoutesUpdatedAt.getTime() > BUS_ROUTES_MAX_AGE_MS;

  if (isStale) {
    if (cached) {
      console.log('[BusRoutes] キャッシュが24時間以上古いため、バックグラウンドで再取得します。');
    }
    refreshBusRoutesCache();
  } else {
    console.log('[BusRoutes] キャッシュは最新のため、起動時のLTA再取得はスキップします。');
  }
}

/**
 * サーバー起動時に呼び出す初期化処理（BusServices）。
 */
function initBusServicesCache() {
  const cached = loadBusServicesCacheFromDisk();

  if (cached) {
    busServicesCache = cached.services;
    busServicesUpdatedAt = cached.updatedAt ? new Date(cached.updatedAt) : null;
    rebuildBusServiceByServiceDirection();
    console.log(
      `[BusServices] data/bus-services.json からキャッシュを読み込みました（${busServicesCache.length}件、` +
        `更新日時: ${busServicesUpdatedAt ? busServicesUpdatedAt.toISOString() : '不明'}）。`
    );
  } else {
    console.log('[BusServices] data/bus-services.json が存在しません。初回取得を行います。');
  }

  const isStale =
    !busServicesUpdatedAt ||
    Date.now() - busServicesUpdatedAt.getTime() > BUS_SERVICES_MAX_AGE_MS;

  if (isStale) {
    if (cached) {
      console.log('[BusServices] キャッシュが24時間以上古いため、バックグラウンドで再取得します。');
    }
    refreshBusServicesCache();
  } else {
    console.log('[BusServices] キャッシュは最新のため、起動時のLTA再取得はスキップします。');
  }
}

/* ══════════════════════════════════════════════
 * 経路モーダル用の経由地点選定ロジック
 *（フェーズ3 タスク分解ステップ5、設計書 .claude/plan.md 第3-2節・第3-2-補節）
 * ══════════════════════════════════════════════ */

// MRT駅・インターチェンジ判定の正規表現（Descriptionに対して判定）。
// 実データ確認済み（.claude/plan.md 第3-2節）: インターチェンジは末尾"Int"表記、
// MRT駅は"Stn"表記（大文字"STN"は0件）。全件網羅性は未検証のヒューリスティック。
const INTERCHANGE_PATTERN = /\bInt$/;
const MRT_STATION_PATTERN = /\bstn\b/i;

/* ══════════════════════════════════════════════
 * MRT路線色マッピング（2026-09-14ユーザー指示: バスカード・経路モーダルの
 * MRT駅表示をその路線の公式色で色付けしたい）。
 *
 * LTA DataMallにはMRT路線・色の情報が含まれないため、公開情報（シンガポール
 * MRT/LRT路線図の公式配色）を元にした静的マッピングをここで独自に用意する。
 * 停留所のDescription（"Bef "/"Aft "/"Opp "接頭辞・" Stn"以降の接尾辞を除去し
 * 小文字化したもの）をキーに引く。複数路線が乗り入れる乗換駅は配列の先頭を
 * 代表路線・代表色として扱う（タグ1つに複数色を出す複雑さを避けるための簡略化）。
 *
 * 注意: 全駅を網羅した完全な公式データではなく、実際にBusStops.Descriptionに
 * 現れる表記（Bt Batok、C'wealth、S'goon、W'lands等の略称含む）に合わせて
 * ベストエフォートで作成したもの。「Fire Stn」「Police Stn」等MRT駅ではない
 * 誤マッチ（既存のMRT_STATION_PATTERNヒューリスティックの限界）はこの
 * マッピングに存在しないため、自然に無色（通常のグレーのタグ）にフォールバックする。
 * ══════════════════════════════════════════════ */
const MRT_LINE_COLORS = {
  NSL: '#D42E12', // North South Line（赤）
  EWL: '#009645', // East West Line（緑）
  NEL: '#9900AA', // North East Line（紫）
  CCL: '#FA9E0D', // Circle Line（オレンジ）
  DTL: '#005EC4', // Downtown Line（青）
  TEL: '#9D5B25', // Thomson-East Coast Line（茶）
  LRT: '#748477', // 各LRT線（グレー、共通色扱い）
};

const MRT_STATION_LINES = {
  // North South Line
  'jurong east': ['NSL', 'EWL'],
  'bt batok': ['NSL'],
  'bt gombak': ['NSL'],
  'choa chu kang': ['NSL'],
  'yew tee': ['NSL'],
  'kranji': ['NSL'],
  'marsiling': ['NSL'],
  'w\'lands': ['NSL', 'TEL'],
  'w\'lands nth': ['TEL'],
  'w\'lands sth': ['TEL'],
  'admiralty': ['NSL'],
  'sembawang': ['NSL'],
  'canberra': ['NSL'],
  'yishun': ['NSL'],
  'khatib': ['NSL'],
  'yio chu kang': ['NSL'],
  'ang mo kio': ['NSL'],
  'bishan': ['NSL', 'CCL'],
  'braddell': ['NSL'],
  'toa payoh': ['NSL'],
  'novena': ['NSL'],
  'newton': ['NSL', 'DTL'],
  'orchard': ['NSL', 'TEL'],
  'somerset': ['NSL'],
  'dhoby ghaut': ['NSL', 'NEL', 'CCL'],
  'city hall': ['NSL', 'EWL'],
  'raffles pl': ['NSL', 'EWL'],
  'marina bay': ['NSL', 'CCL', 'TEL'],
  'marina sth pier': ['NSL'],
  // East West Line
  'pasir ris': ['EWL'],
  'tampines': ['EWL', 'DTL'],
  'tampines east': ['DTL'],
  'tampines west': ['DTL'],
  'simei': ['EWL'],
  'tanah merah': ['EWL'],
  'bedok': ['EWL'],
  'bedok nth': ['DTL'],
  'bedok resvr': ['DTL'],
  'kembangan': ['EWL'],
  'eunos': ['EWL'],
  'paya lebar': ['EWL', 'CCL'],
  'aljunied': ['EWL'],
  'kallang': ['EWL'],
  'lavender': ['EWL'],
  'bugis': ['EWL', 'DTL'],
  'tanjong pagar': ['EWL'],
  'outram pk': ['EWL', 'NEL', 'TEL'],
  'tiong bahru': ['EWL'],
  'redhill': ['EWL'],
  'queenstown': ['EWL'],
  'c\'wealth': ['EWL'],
  'buona vista': ['EWL', 'CCL'],
  'dover': ['EWL'],
  'clementi': ['EWL'],
  'chinese gdn': ['EWL'],
  'lakeside': ['EWL'],
  'boon lay': ['EWL'],
  'pioneer': ['EWL'],
  'joo koon': ['EWL'],
  'gul circle': ['EWL'],
  'tuas cres': ['EWL'],
  'tuas west rd': ['EWL'],
  'tuas lk': ['EWL'],
  'expo': ['EWL', 'DTL'],
  // North East Line
  'harbourfront': ['NEL', 'CCL'],
  'chinatown': ['NEL', 'DTL'],
  'clarke quay': ['NEL'],
  'little india': ['NEL', 'DTL'],
  'farrer pk': ['NEL'],
  'boon keng': ['NEL'],
  'potong pasir': ['NEL'],
  'woodleigh': ['NEL'],
  's\'goon': ['NEL', 'CCL'],
  'kovan': ['NEL'],
  'hougang': ['NEL'],
  'buangkok': ['NEL'],
  'sengkang': ['NEL'],
  'punggol': ['NEL'],
  'punggol coast': ['NEL'],
  // Circle Line
  'bras basah': ['CCL'],
  'esplanade': ['CCL'],
  'promenade': ['CCL', 'DTL'],
  'nicoll highway': ['CCL'],
  'stadium': ['CCL'],
  'mountbatten': ['CCL'],
  'dakota': ['CCL'],
  'macpherson': ['CCL', 'DTL'],
  'tai seng': ['CCL'],
  'bartley': ['CCL'],
  'lor chuan': ['CCL'],
  'marymount': ['CCL'],
  'caldecott': ['CCL', 'TEL'],
  'botanic gdns': ['CCL', 'DTL'],
  'farrer rd': ['CCL'],
  'holland v': ['CCL'],
  'one-north': ['CCL'],
  'kent ridge': ['CCL'],
  'haw par villa': ['CCL'],
  'pasir panjang': ['CCL'],
  'labrador pk': ['CCL'],
  'telok blangah': ['CCL'],
  // Downtown Line
  'bt panjang': ['DTL'],
  'cashew': ['DTL'],
  'hillview': ['DTL'],
  'beauty world': ['DTL'],
  'king albert pk': ['DTL'],
  'sixth ave': ['DTL'],
  'tan kah kee': ['DTL'],
  'stevens': ['DTL', 'TEL'],
  'rochor': ['DTL'],
  'downtown': ['DTL'],
  'telok ayer': ['DTL'],
  'fort canning': ['DTL'],
  'bencoolen': ['DTL'],
  'jln besar': ['DTL'],
  'bendemeer': ['DTL'],
  'geylang bahru': ['DTL'],
  'mattar': ['DTL'],
  'ubi': ['DTL'],
  'kaki bt': ['DTL'],
  'bayfront': ['DTL', 'CCL'],
  // Thomson-East Coast Line
  'springleaf': ['TEL'],
  'lentor': ['TEL'],
  'mayflower': ['TEL'],
  'bright hill': ['TEL'],
  'upp thomson': ['TEL'],
  'napier': ['TEL'],
  'orchard blvd': ['TEL'],
  'great world': ['TEL'],
  'havelock': ['TEL'],
  'maxwell': ['TEL'],
  'shenton way': ['TEL'],
  'gardens by the bay': ['TEL'],
  'tanjong rhu': ['TEL'],
  'katong pk': ['TEL'],
  'tg katong': ['TEL'],
  'marine pde': ['TEL'],
  'marine terr': ['TEL'],
  'siglap': ['TEL'],
  'bayshore': ['TEL'],
  'upp changi': ['DTL'],
  // LRT（Bukit Panjang/Sengkang/Punggol、共通グレー扱い）
  'petir': ['LRT'],
  'phoenix': ['LRT'],
  'bangkit': ['LRT'],
  'fajar': ['LRT'],
  'jelapang': ['LRT'],
  'south view': ['LRT'],
  'pending': ['LRT'],
  'cheng lim': ['LRT'],
  'farmway': ['LRT'],
  'thanggam': ['LRT'],
  'fernvale': ['LRT'],
  'layar': ['LRT'],
  'renjong': ['LRT'],
  'cove': ['LRT'],
  'meridian': ['LRT'],
  'coral edge': ['LRT'],
  'riviera': ['LRT'],
  'kadaloor': ['LRT'],
  'punggol pt': ['LRT'],
  'samudera': ['LRT'],
  'nibong': ['LRT'],
  'sumang': ['LRT'],
  'soo teck': ['LRT'],
  'damai': ['LRT'],
  'oasis': ['LRT'],
  'kangkar': ['LRT'],
  'ranggung': ['LRT'],
  'teck lee': ['LRT'],
  'bakau': ['LRT'],
};

// バス停のDescriptionからMRT駅名らしき部分を取り出し、路線色を解決する。
// マッチしない場合（MRT駅ではない"Fire Stn"等の誤検出含む）はnullを返す。
function resolveMrtLineColor(description) {
  if (!description) return null;
  let normalized = description
    .replace(/^(Bef|Aft|Opp)\s+/i, '')
    .replace(/\s+Stn\b.*$/i, '')
    .trim()
    .toLowerCase();

  const lines = MRT_STATION_LINES[normalized];
  if (!lines || lines.length === 0) return null;

  const primaryLine = lines[0];
  return { line: primaryLine, color: MRT_LINE_COLORS[primaryLine] || null };
}

// 主要地名リスト（優先順位2の補完候補）。
// 要企画判断・暫定リスト: CLAUDE.md「Orchard、Chinatown等」の例示を起点に、
// シンガポールの主要地区名を暫定的に列挙したもの。今後の実データ検証・
// 企画判断により追加・削除される前提（.claude/plan.md 第3-2節、第11節5項）。
const LANDMARK_NAMES = [
  'Orchard',
  'Chinatown',
  'Bugis',
  'Jurong East',
  'Tampines',
  'Woodlands',
  'Raffles Place',
  'City Hall',
  'Marina Bay',
  'Novena',
  'Toa Payoh',
  'Ang Mo Kio',
  'Bishan',
  'Clementi',
  'Bedok',
];

/**
 * BusStopCodeから{Description, RoadName}を引く。未登録の場合はnullを返す。
 */
function resolveStopInfo(busStopCode) {
  return busStopCodeToStopInfoMap.get(busStopCode) || null;
}

/**
 * マッチした停留所配列（StopSequence順）が2〜3件を超える場合、
 * 等間隔ステップで間引いて最大3件に絞る。シンプルな均等抽出方式
 * （凝ったアルゴリズムは採用しない、.claude/plan.md 第3-2節参照）。
 */
function thinOutToMax(items, maxCount) {
  if (items.length <= maxCount) {
    return items;
  }
  const result = [];
  const step = (items.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i += 1) {
    const index = Math.round(i * step);
    result.push(items[index]);
  }
  // Math.roundの丸め次第で同一インデックスが重複する可能性があるため重複除去。
  const seen = new Set();
  return result.filter((item) => {
    if (seen.has(item.BusStopCode)) return false;
    seen.add(item.BusStopCode);
    return true;
  });
}

const WAYPOINT_MIN_COUNT = 2;
const WAYPOINT_MAX_COUNT = 3;

/**
 * 指定系統・方向の停留所リスト（始点・終点を除く中間停留所、StopSequence昇順）から
 * 経由地点（2〜3箇所）を選定する。
 *
 * 優先順位:
 *   1. MRT駅・インターチェンジ判定にマッチする停留所（reason: "mrt_or_interchange"）
 *   2. 1で不足する場合、主要地名リストにマッチする停留所で補完（reason: "landmark"）
 *
 * @param {Array<{StopSequence, BusStopCode}>} middleStops 始点・終点を除いた中間停留所
 * @returns {Array<{BusStopCode, Description, reason}>}
 */
function selectWaypoints(middleStops) {
  const middleWithInfo = middleStops
    .map((stop) => {
      const info = resolveStopInfo(stop.BusStopCode);
      return info ? { BusStopCode: stop.BusStopCode, Description: info.Description, RoadName: info.RoadName } : null;
    })
    .filter(Boolean);

  const mrtOrInterchangeMatches = middleWithInfo.filter(
    (stop) => INTERCHANGE_PATTERN.test(stop.Description) || MRT_STATION_PATTERN.test(stop.Description)
  );

  let selected = thinOutToMax(mrtOrInterchangeMatches, WAYPOINT_MAX_COUNT).map((stop) => {
    const mrtInfo = resolveMrtLineColor(stop.Description);
    const latLng = busStopCodeToLatLngMap.get(stop.BusStopCode);
    return {
      BusStopCode: stop.BusStopCode,
      Description: stop.Description,
      reason: 'mrt_or_interchange',
      mrtLine: mrtInfo ? mrtInfo.line : null,
      mrtColor: mrtInfo ? mrtInfo.color : null,
      Latitude: latLng ? latLng.Latitude : null,
      Longitude: latLng ? latLng.Longitude : null,
    };
  });

  if (selected.length < WAYPOINT_MIN_COUNT) {
    const alreadySelectedCodes = new Set(selected.map((stop) => stop.BusStopCode));
    const landmarkMatches = middleWithInfo.filter((stop) => {
      if (alreadySelectedCodes.has(stop.BusStopCode)) return false;
      const description = stop.Description || '';
      const roadName = stop.RoadName || '';
      return LANDMARK_NAMES.some(
        (landmark) => description.includes(landmark) || roadName.includes(landmark)
      );
    });

    const needed = WAYPOINT_MAX_COUNT - selected.length;
    const supplement = thinOutToMax(landmarkMatches, needed).map((stop) => ({
      BusStopCode: stop.BusStopCode,
      Description: stop.Description,
      reason: 'landmark',
    }));

    selected = selected.concat(supplement);
  }

  return selected;
}

/* ══════════════════════════════════════════════
 * GET /api/bus-routes/summary?serviceNo=&direction=&fromStopCode=
 *
 * 指定系統・方向の経路情報（始点・終点、選定済み経由地点2〜3箇所）を返す。
 * 循環路線（LoopDesc非空）の場合は始点=終点になるため、isLoop/loopDescで
 * フロント側が「Loop via {LoopDesc}」等の専用表示に切り替えられるようにする
 * （.claude/plan.md 第3-2-補節）。
 *
 * fromStopCode（省略可、2026-09-14追加）: 現在地のバス停コード。指定すると
 * waypoints選定の対象を「現在地より後（現在地自体は除く）〜終点の手前まで」
 * に絞り込む。省略時・route上に見つからない場合は従来通り経路全体（起点〜終点）
 * から選定する（後方互換）。ユーザー指摘「経路モーダルの地図・経由地リストに、
 * まだ乗車していない現在地より手前のMRT駅が表示される」で発見・修正
 * （/api/bus-routes/contains-stopのfromStopCode/isAheadMatchと同じ「現在地より
 * 前は対象外」という考え方を、waypoints選定そのものにも適用したもの）。
 * ══════════════════════════════════════════════ */
app.get('/api/bus-routes/summary', (req, res) => {
  if (busRoutesCache.length === 0 || busServicesCache.length === 0) {
    return res.status(503).json({
      error: 'Route information is being prepared. Please try again later.',
    });
  }

  const { serviceNo, direction, fromStopCode } = req.query;

  if (!serviceNo || !direction) {
    return res.status(400).json({
      error: 'serviceNo and direction are required (e.g. ?serviceNo=101&direction=1).',
    });
  }

  const key = makeServiceDirectionKey(serviceNo, Number(direction));
  const stops = busRoutesByServiceDirection.get(key) || [];

  if (stops.length === 0) {
    return res.status(404).json({
      error: `No route information found for the specified service and direction (serviceNo=${serviceNo}, direction=${direction}).`,
    });
  }

  const service = busServiceByServiceDirection.get(key) || null;
  const loopDesc = service && service.LoopDesc ? service.LoopDesc : '';
  const isLoop = Boolean(loopDesc);

  const originStop = stops[0];
  const destinationStop = stops[stops.length - 1];
  let middleStops = stops.slice(1, -1);

  if (fromStopCode) {
    const fromIndex = stops.findIndex((stop) => stop.BusStopCode === String(fromStopCode));
    if (fromIndex !== -1) {
      middleStops = stops.slice(fromIndex + 1, -1);
    }
  }

  const originInfo = resolveStopInfo(originStop.BusStopCode);
  const destinationInfo = resolveStopInfo(destinationStop.BusStopCode);

  // stopIndex（stops配列内の絶対位置、2026-09-14追加）: フロント側で
  // waypoints（MRT駅等）と別途取得した登録済み目的地(saved_destination、
  // /api/bus-routes/contains-stopのpositionsで取得)をマージした後、実際に
  // バスが経由する順（StopSequence順）に並べ替えるためのキー。同じstops配列
  // から算出しているため両者は直接比較可能（ユーザー指摘「経路って通って
  // いく順番に並べて欲しい」で発見・修正。従来は目的地一致タグが常に先頭に
  // 固定表示され、実際の経由順と無関係な並びになっていた）。
  const stopIndexMap = new Map(stops.map((stop, index) => [stop.BusStopCode, index]));
  const waypoints = selectWaypoints(middleStops).map((wp) => ({
    ...wp,
    stopIndex: stopIndexMap.has(wp.BusStopCode) ? stopIndexMap.get(wp.BusStopCode) : null,
  }));

  res.json({
    serviceNo,
    direction: Number(direction),
    isLoop,
    loopDesc: loopDesc || null,
    origin: {
      BusStopCode: originStop.BusStopCode,
      Description: originInfo ? originInfo.Description : null,
    },
    destination: {
      BusStopCode: destinationStop.BusStopCode,
      Description: destinationInfo ? destinationInfo.Description : null,
    },
    waypoints,
  });
});

/* ══════════════════════════════════════════════
 * GET /api/bus-routes/contains-stop?serviceNo=&direction=&stopCode=（または stopCodes=カンマ区切り）&fromStopCode=
 *
 * 指定系統・方向が、指定バス停（複数可）のいずれかを経由するかを判定する。
 * 「関連のみ」フィルター・目的地一致ハイライトの実絞り込みロジックが使用する
 * （.claude/plan.md 第2節・第10節・第12節タスク分解ステップ9）。
 *
 * /api/bus-routes/summaryのwaypointsはMRT駅・インターチェンジ等の
 * 代表点に絞った経由地点であり、全停留所を含まないため、
 * 「目的地バス停を経由するか」の判定にはbusRoutesByServiceDirectionの
 * 全停留所リスト（StopSequence昇順）をそのまま参照する必要がある。
 *
 * stopCode（単一）とstopCodes（カンマ区切り複数）のどちらか一方を指定する。
 * 複数目的地を一括判定できるようにし、フロント側のAPI呼び出し回数を
 * 削減する（目的地登録数が多い場合のパフォーマンス配慮）。
 *
 * fromStopCode（省略可、2026-09-14追加）: 現在地のバス停コード。指定すると
 * そのStopSequence以降にある停留所のみを一致対象とする（すでに通過済みの
 * 目的地を誤って一致扱いしない、実機で発見された不具合の修正）。
 *
 * レスポンス:
 *   単一判定時: { contains: true/false }
 *   複数判定時: { results: { "82009": true, "12009": false }, positions: { "82009": 12 } }
 *   （positionsは一致有無に関わらず、stops配列上に存在する停留所のみ含む）
 * ══════════════════════════════════════════════ */
app.get('/api/bus-routes/contains-stop', (req, res) => {
  if (busRoutesCache.length === 0) {
    return res.status(503).json({
      error: 'Route information is being prepared. Please try again later.',
    });
  }

  const { serviceNo, direction, stopCode, stopCodes, fromStopCode } = req.query;

  if (!serviceNo || !direction) {
    return res.status(400).json({
      error: 'serviceNo and direction are required (e.g. ?serviceNo=10&direction=1&stopCode=75009).',
    });
  }

  if (!stopCode && !stopCodes) {
    return res.status(400).json({
      error: 'Please specify either stopCode or stopCodes.',
    });
  }

  const key = makeServiceDirectionKey(serviceNo, Number(direction));
  const stops = busRoutesByServiceDirection.get(key);

  if (!stops || stops.length === 0) {
    return res.status(404).json({
      error: `No route information found for the specified service and direction (serviceNo=${serviceNo}, direction=${direction}).`,
    });
  }

  // 2026-09-14実機で発見・修正: 単純な経路上の存在判定だけでは、その系統が
  // 「往路の途中ですでに通過済み」の目的地まで一致とみなしてしまい、逆方向
  // （すでに保存バス停を通り過ぎている）のバスまでハイライトされる不具合が
  // あった（ユーザー指摘「逆方向なのに光ってます。これからいくときだけ
  // ハイライトさせたい」）。fromStopCode（現在地のバス停コード、＝ユーザーが
  // これから乗る区間の起点）が指定された場合、そのStopSequence(配列内の
  // 出現順)以降にある停留所のみを一致対象とする。fromStopCodeが未指定、
  // またはこの経路上に見つからない場合は従来通り単純な存在判定にフォール
  // バックする（安全側）。
  const stopIndexMap = new Map(stops.map((stop, index) => [stop.BusStopCode, index]));
  const fromIndex = fromStopCode ? (stopIndexMap.has(String(fromStopCode)) ? stopIndexMap.get(String(fromStopCode)) : -1) : -1;

  function isAheadMatch(code) {
    if (!stopIndexMap.has(code)) return false;
    if (fromIndex === -1) return true;
    return stopIndexMap.get(code) >= fromIndex;
  }

  if (stopCodes) {
    const codes = String(stopCodes)
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0);

    // positions（2026-09-14追加）: 一致した停留所のstops配列内の絶対位置。
    // フロント側が/api/bus-routes/summaryのwaypoints(stopIndex付き)と
    // マージした後、実際の経由順に並べ替えるために使う
    // （ユーザー指摘「経路って通っていく順番に並べて欲しい」対応）。
    const results = {};
    const positions = {};
    codes.forEach((code) => {
      results[code] = isAheadMatch(code);
      if (stopIndexMap.has(code)) positions[code] = stopIndexMap.get(code);
    });

    return res.json({ results, positions });
  }

  return res.json({ contains: isAheadMatch(String(stopCode)) });
});

/* ══════════════════════════════════════════════
 * GET /api/bus-routes/path?serviceNo=&direction=&fromStopCode=&toStopCode=
 *
 * 指定系統・方向の乗車区間（fromStopCode〜toStopCode、両端含む）に含まれる
 * 全停留所を StopSequence 昇順で抽出し、緯度経度配列として返す
 * （ホーム画面バスカードのミニ経路図タップ時の実地図表示用、
 * フェーズ4 タスク分解ステップ4、.claude/plan.md 第2-5節・第3-1節）。
 *
 * /api/bus-routes/summary の waypoints は代表2〜3点のみで
 * ポリライン描画には使えないため、全停留所座標を返す専用エンドポイントとして
 * 新規追加する（案A、既存APIは変更しない）。
 *
 * stops（2026-09-14追加）: pathと同じ区間の全停留所を、座標だけでなく
 * BusStopCode/Description/mrtLine/mrtColorも含めて返す。経路モーダル下部の
 * 「実際に停車する全てのバス停を停車順に表示する」リスト（ユーザー指示
 * 「バス停のリストを止まる順に表示してほしい」）用。resolveMrtLineColor()は
 * 元々/api/bus-routes/summaryの代表waypoints選定にのみ使っていたが、ここでは
 * 区間内の全停留所に対して個別に適用し、MRT駅名の停留所だけ路線色を持たせる。
 * ══════════════════════════════════════════════ */
app.get('/api/bus-routes/path', (req, res) => {
  if (busRoutesCache.length === 0) {
    return res.status(503).json({
      error: 'Route information is being prepared. Please try again later.',
    });
  }

  const { serviceNo, direction, fromStopCode, toStopCode } = req.query;

  if (!serviceNo || !direction || !fromStopCode || !toStopCode) {
    return res.status(400).json({
      error:
        'serviceNo, direction, fromStopCode and toStopCode are required ' +
        '(e.g. ?serviceNo=67&direction=1&fromStopCode=42039&toStopCode=75009).',
    });
  }

  const key = makeServiceDirectionKey(serviceNo, Number(direction));
  const stops = busRoutesByServiceDirection.get(key);

  if (!stops || stops.length === 0) {
    return res.status(404).json({
      error: `No route information found for the specified service and direction (serviceNo=${serviceNo}, direction=${direction}).`,
    });
  }

  const fromIndex = stops.findIndex((stop) => stop.BusStopCode === String(fromStopCode));
  const toIndex = stops.findIndex((stop) => stop.BusStopCode === String(toStopCode));

  if (fromIndex === -1 || toIndex === -1) {
    return res.status(404).json({
      error:
        `fromStopCode/toStopCode not found on the specified route ` +
        `(serviceNo=${serviceNo}, direction=${direction}, fromStopCode=${fromStopCode}, toStopCode=${toStopCode}).`,
    });
  }

  let segment;
  if (fromStopCode === toStopCode) {
    // 循環路線（LoopDesc非空）は起点=終点のBusStopCodeが同一になるため、
    // 「区間指定」ではなく「全停留所（ループ全体）を返す」の意味とみなす
    // （経路モーダルの実地図表示で循環路線全体をプロットする用途、2026-09-13追加）。
    segment = stops;
  } else if (stops[fromIndex].StopSequence > stops[toIndex].StopSequence) {
    // 2026-09-14実機で発見・修正: 経路モーダルの表示区間を「現在地→終点」に
    // 変更したことに伴い、循環路線を起点以外の停留所から乗車するケースで
    // 発生するようになった。循環路線のstops配列は起点(stops[0])から1周分
    // しか保持しておらず「起点への帰還」を終端として含まないため、
    // toStopCodeが起点(stops[0])自身の場合は「ループの残り区間」（現在地から
    // 配列末尾まで、＝再び起点に戻るまでの区間）とみなす。それ以外の
    // 順序逆転（非循環路線での逆行指定等）は引き続きエラーとする。
    if (toIndex === 0) {
      segment = stops.slice(fromIndex);
    } else {
      return res.status(400).json({
        error:
          'fromStopCode must come before toStopCode on the route (StopSequence order). ' +
          'Check the direction/parameters.',
      });
    }
  } else {
    segment = stops.slice(fromIndex, toIndex + 1);
  }

  const path = segment
    .map((stop) => busStopCodeToLatLngMap.get(stop.BusStopCode))
    .filter((latLng) => latLng && latLng.Latitude != null && latLng.Longitude != null)
    .map((latLng) => ({ lat: latLng.Latitude, lng: latLng.Longitude }));

  if (path.length === 0) {
    return res.status(404).json({
      error: 'No coordinate data available for the stops on the specified segment.',
    });
  }

  const stopDetails = segment
    .map((stop) => {
      const info = resolveStopInfo(stop.BusStopCode);
      const latLng = busStopCodeToLatLngMap.get(stop.BusStopCode);
      if (!info || !latLng || latLng.Latitude == null || latLng.Longitude == null) return null;
      const mrtInfo = resolveMrtLineColor(info.Description);
      return {
        BusStopCode: stop.BusStopCode,
        Description: info.Description,
        Latitude: latLng.Latitude,
        Longitude: latLng.Longitude,
        mrtLine: mrtInfo ? mrtInfo.line : null,
        mrtColor: mrtInfo ? mrtInfo.color : null,
      };
    })
    .filter(Boolean);

  res.json({ path, stops: stopDetails });
});

/* ══════════════════════════════════════════════
 * GET /api/bus-services/:serviceNo/stops
 *
 * 指定された系統番号（バス番号）が通る全バス停を一覧で返す
 * （フェーズ5 タスク分解ステップ1、.claude/plan.md 第2-1節）。
 *
 * busRoutesByServiceDirectionからdirection=1・2両方の停留所リストを取得し、
 * BusStopCodeでマージ・重複除去する（StopSequence情報は不要、
 * 「その系統が通る停留所の集合」を返すのみ）。
 * どちらのdirectionにも存在しない場合は該当系統番号が存在しないとみなし404。
 * ══════════════════════════════════════════════ */
app.get('/api/bus-services/:serviceNo/stops', (req, res) => {
  if (busRoutesCache.length === 0) {
    return res.status(503).json({
      error: 'Route information is being prepared. Please try again later.',
    });
  }

  const { serviceNo } = req.params;

  const stopsDirection1 = busRoutesByServiceDirection.get(makeServiceDirectionKey(serviceNo, 1));
  const stopsDirection2 = busRoutesByServiceDirection.get(makeServiceDirectionKey(serviceNo, 2));

  if (!stopsDirection1 && !stopsDirection2) {
    return res.status(404).json({ error: 'Service number not found.' });
  }

  const mergedBusStopCodes = new Set();
  for (const stops of [stopsDirection1, stopsDirection2]) {
    if (!stops) continue;
    for (const stop of stops) {
      mergedBusStopCodes.add(stop.BusStopCode);
    }
  }

  const stops = [];
  for (const busStopCode of mergedBusStopCodes) {
    const info = busStopCodeToStopInfoMap.get(busStopCode);
    const latLng = busStopCodeToLatLngMap.get(busStopCode);
    stops.push({
      BusStopCode: busStopCode,
      Description: info ? info.Description : null,
      RoadName: info ? info.RoadName : null,
      Latitude: latLng ? latLng.Latitude : null,
      Longitude: latLng ? latLng.Longitude : null,
    });
  }

  res.json({ serviceNo, stops });
});

/* ══════════════════════════════════════════════
 * 近傍検索・名称検索の共通処理
 *（フェーズ2 タスク分解ステップ3、設計書 .claude/plan.md 第10節）
 * ══════════════════════════════════════════════ */
const EARTH_RADIUS_METERS = 6371000;
const NEARBY_DEFAULT_LIMIT = 3;
const NEARBY_MAX_LIMIT = 10;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_MAX_RESULTS = 20;

/**
 * Haversine公式による2点間の距離（メートル）を計算する。
 */
function calculateDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRadians = (deg) => (deg * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/* ══════════════════════════════════════════════
 * GET /api/bus-stops/nearby?lat=&lng=&limit=3
 *
 * 現在地（lat, lng）から近い順にバス停を返す。距離はHaversine公式で
 * メートル単位に計算し、distanceMetersとして各バス停に付与する。
 * ══════════════════════════════════════════════ */
app.get('/api/bus-stops/nearby', (req, res) => {
  if (busStopsCache.length === 0) {
    return res.status(503).json({
      error: 'Bus stop information is being prepared. Please try again later.',
    });
  }

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (req.query.lat === undefined || req.query.lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({
      error: 'lat and lng must be numbers.',
    });
  }

  let limit = NEARBY_DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    const parsedLimit = Number(req.query.limit);
    if (Number.isNaN(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({
        error: 'limit must be an integer of 1 or greater.',
      });
    }
    limit = Math.min(parsedLimit, NEARBY_MAX_LIMIT);
  }

  const stops = busStopsCache
    .map((stop) => ({
      ...stop,
      distanceMeters: calculateDistanceMeters(lat, lng, stop.Latitude, stop.Longitude),
      services: busStopCodeToServiceNumbersMap.get(stop.BusStopCode) || [],
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);

  res.json({ stops });
});

/* ══════════════════════════════════════════════
 * GET /api/bus-stops/:stopCode/services
 *
 * 指定バス停を通る系統番号の一覧を返す（Saved画面で保存済みバス停に
 * 「何番のバスが通るか」を表示するための逆引き、2026-09-13ユーザー指示）。
 * ══════════════════════════════════════════════ */
app.get('/api/bus-stops/:stopCode/services', (req, res) => {
  if (busRoutesCache.length === 0) {
    return res.status(503).json({
      error: 'Route information is being prepared. Please try again later.',
    });
  }

  const { stopCode } = req.params;
  const services = busStopCodeToServiceNumbersMap.get(stopCode) || [];
  res.json({ services });
});

/* ══════════════════════════════════════════════
 * GET /api/bus-stops/search?q=
 *
 * Description・RoadName・BusStopCodeのいずれかにqが部分一致（大文字小文字無視）
 * するバス停を返す。最大SEARCH_MAX_RESULTS件まで。
 * ══════════════════════════════════════════════ */
app.get('/api/bus-stops/search', (req, res) => {
  if (busStopsCache.length === 0) {
    return res.status(503).json({
      error: 'Bus stop information is being prepared. Please try again later.',
    });
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (q.length < SEARCH_MIN_QUERY_LENGTH) {
    return res.status(400).json({
      error: `Search keyword must be at least ${SEARCH_MIN_QUERY_LENGTH} characters.`,
    });
  }

  const needle = q.toLowerCase();

  const stops = [];
  for (const stop of busStopsCache) {
    const description = (stop.Description || '').toLowerCase();
    const roadName = (stop.RoadName || '').toLowerCase();
    const busStopCode = (stop.BusStopCode || '').toLowerCase();

    if (
      description.includes(needle) ||
      roadName.includes(needle) ||
      busStopCode.includes(needle)
    ) {
      stops.push({
        ...stop,
        services: busStopCodeToServiceNumbersMap.get(stop.BusStopCode) || [],
      });
      if (stops.length >= SEARCH_MAX_RESULTS) {
        break;
      }
    }
  }

  res.json({ stops });
});

initBusStopsCache();
initBusRoutesCache();
initBusServicesCache();

app.listen(PORT, () => {
  console.log(`SGBusNavi サーバー起動`);
  console.log(`   → http://localhost:${PORT}`);
});
