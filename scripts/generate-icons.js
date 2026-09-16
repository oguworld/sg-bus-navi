/*
 * SGBusNavi — アイコン生成スクリプト（使い捨て）
 *
 * assets/icons/app-icon-light.png（マスター画像・白背景版、2000x2000）から
 * public/icons/ 配下に各サイズのPNGを生成する。
 *
 * 実行方法:
 *   node scripts/generate-icons.js
 *
 * 生成物:
 *   - icon-72.png / icon-96.png / icon-128.png / icon-144.png / icon-152.png /
 *     icon-192.png / icon-384.png / icon-512.png（通常アイコン、単純リサイズ）
 *   - icon-192-maskable.png / icon-512-maskable.png
 *     （Android等のmaskableセーフゾーン対応。中央の直径80%円内にコンテンツが
 *       収まるよう、マスター画像の周囲に透明ではなく背景色(#FAFAF8 = --cream)の
 *       パディングを追加してからリサイズする。マスター画像はピンのシルエットが
 *       画像いっぱいに配置されており余白が乏しいため、そのまま使うとmaskableの
 *       丸型/角丸トリミングで先端が欠ける懸念があるため。）
 *   - apple-touch-icon.png（180x180、iOS用。角丸はOS側が自動適用するため
 *     四角のまま出力）
 *   - favicon.png（32x32）
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '..', 'assets', 'icons', 'app-icon-light.png');
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// デザイントークンの --cream（画面背景色）。maskableアイコンの背景パディングに使用。
const CREAM_BG = { r: 0xfa, g: 0xfa, b: 0xf8, alpha: 1 };

const STANDARD_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const MASKABLE_SIZES = [192, 512];

async function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function generateStandard(size) {
  const outPath = path.join(OUT_DIR, `icon-${size}.png`);
  await sharp(SRC).resize(size, size).png().toFile(outPath);
  console.log(`generated: ${outPath}`);
}

async function generateMaskable(size) {
  // セーフゾーン確保のため、マスター画像を80%サイズに縮小してから
  // 背景色(--cream)でsize x sizeにパディングする（中央配置）。
  const contentSize = Math.round(size * 0.8);
  const outPath = path.join(OUT_DIR, `icon-${size}-maskable.png`);

  const resizedContent = await sharp(SRC)
    .resize(contentSize, contentSize)
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: CREAM_BG,
    },
  })
    .composite([{ input: resizedContent, gravity: 'center' }])
    .png()
    .toFile(outPath);

  console.log(`generated: ${outPath}`);
}

async function generateAppleTouchIcon() {
  const outPath = path.join(OUT_DIR, 'apple-touch-icon.png');
  // iOSはアイコンに透過があると黒背景で塗りつぶされることがあるため、
  // --cream背景を敷いた上で合成する。
  const resizedContent = await sharp(SRC).resize(180, 180).png().toBuffer();
  await sharp({
    create: {
      width: 180,
      height: 180,
      channels: 4,
      background: CREAM_BG,
    },
  })
    .composite([{ input: resizedContent, gravity: 'center' }])
    .png()
    .toFile(outPath);
  console.log(`generated: ${outPath}`);
}

async function generateFavicon() {
  const outPath = path.join(OUT_DIR, 'favicon.png');
  await sharp(SRC).resize(32, 32).png().toFile(outPath);
  console.log(`generated: ${outPath}`);
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`マスター画像が見つかりません: ${SRC}`);
    process.exit(1);
  }

  await ensureOutDir();

  for (const size of STANDARD_SIZES) {
    await generateStandard(size);
  }

  for (const size of MASKABLE_SIZES) {
    await generateMaskable(size);
  }

  await generateAppleTouchIcon();
  await generateFavicon();

  console.log('全アイコンの生成が完了しました。');
}

main().catch((err) => {
  console.error('アイコン生成中にエラーが発生しました:', err);
  process.exit(1);
});
