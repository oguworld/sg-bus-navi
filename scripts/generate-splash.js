// generate-splash.js
// ネイティブ起動画面(splash.png / splash-dark.png)を、アプリアイコン + 「SGBusNavi」ロゴテキストで生成する
// 使い方: node scripts/generate-splash.js
//
// sg-weekend-app（姉妹アプリ）のscripts/generate-splash.jsと同じ構図
// （アイコンが中央よりやや上、その下にタイトル）・同じcanvas/アイコンサイズ・
// 同じフォントサイズを踏襲する（2026-09-17ユーザー指示「SG在住Naviと統一したい」）。
// splash-dark.pngが無いとcapacitor-assetsがライト版を自動で暗く変換するだけになり、
// ロゴ文字が黒背景に沈んでほぼ見えなくなる（sg-weekend-appで判明済みの罠）ため、
// style.cssのhtml[data-theme="dark"]配色に合わせた専用のダーク版を明示的に生成する。

const sharp = require('sharp');
const path = require('path');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icons', 'app-icon-light.png');
const OUT_DIR = path.join(__dirname, '..', 'ios-app', 'resources');

const CANVAS_SIZE = 2732;
const ICON_SIZE = 560;

const THEMES = [
  {
    name: 'light',
    outPath: path.join(OUT_DIR, 'splash.png'),
    bg: '#FAFAF8', // --cream
    textDark: '#2B2B27', // --midnight
    textAccent: '#6F8F63', // --caramel（柳グリーン、ライト/ダーク共通）
  },
  {
    name: 'dark',
    outPath: path.join(OUT_DIR, 'splash-dark.png'),
    bg: '#1B1E19', // html[data-theme="dark"] --cream
    textDark: '#EDEAE3', // html[data-theme="dark"] --midnight
    textAccent: '#6F8F63', // --caramel（ダークモードでも上書きされないため同色）
  },
];

async function generate(theme) {
  const iconBuffer = await sharp(ICON_PATH).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();

  const iconY = Math.round(CANVAS_SIZE / 2 - ICON_SIZE / 2 - 100);
  const textY = iconY + ICON_SIZE + 160;

  const svgText = `
    <svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}">
      <text x="50%" y="${textY}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="130">
        <tspan fill="${theme.textDark}">SGBus</tspan><tspan fill="${theme.textAccent}">Navi</tspan>
      </text>
    </svg>
  `;
  const textBuffer = Buffer.from(svgText);

  await sharp({
    create: {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      channels: 4,
      background: theme.bg,
    },
  })
    .composite([
      { input: iconBuffer, top: iconY, left: Math.round(CANVAS_SIZE / 2 - ICON_SIZE / 2) },
      { input: textBuffer, top: 0, left: 0 },
    ])
    .png()
    .toFile(theme.outPath);

  console.log(`✅ ${theme.name} 生成完了: ${theme.outPath}`);
}

async function main() {
  for (const theme of THEMES) {
    await generate(theme);
  }
}

main().catch(console.error);
