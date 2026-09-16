/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'net.willoa.bus',
  appName: 'SGBusNavi',
  webDir: '../public',
  ios: {
    // sg-weekend-app(app.dosuru)と同じ設定。'always'だとキーボード表示時に
    // window.innerHeightがsafe-area-inset-top分縮んで固着し、ボトムナビ
    // (position:fixed;bottom:0)が真の画面下端から浮くビューポート固着バグの
    // 原因になることが判明済みのため'never'にする。
    contentInset: 'never',
    backgroundColor: '#FAFAF8',
  },
  plugins: {
    Keyboard: {
      resize: 'none', // sg-weekend-appで'native'が実機テキスト入力不可の重大回帰を起こした実績があるため'none'固定
    },
    SplashScreen: {
      launchShowDuration: 1000,
      launchFadeOutDuration: 300,
      backgroundColor: '#FAFAF8',
      showSpinner: false,
      launchAutoHide: true,
    },
  },
};

module.exports = config;
