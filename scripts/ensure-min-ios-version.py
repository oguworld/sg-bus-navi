#!/usr/bin/env python3
"""App Store審査対応: ITMS-90068 (MinimumOSVersion too low) 対策。

sg-weekend-app(SG在住Navi)と同じスクリプトをそのまま流用(汎用処理でapp固有の
内容を含まないため)。Appleは2027年春以降、iOSアプリのMinimumOSVersionを
15.0以上にすることを必須化すると予告しており、Capacitor 6が生成するPodfile /
Xcodeプロジェクトのデフォルト値（13.0）を15.0へ引き上げる。

- ios/App/Podfile の `platform :ios, 'X.X'` 行を `platform :ios, '15.0'` に置換
- ios/App/App.xcodeproj/project.pbxproj の全 `IPHONEOS_DEPLOYMENT_TARGET = X.X;` を
  `IPHONEOS_DEPLOYMENT_TARGET = 15.0;` に置換（App/Pods両ターゲット・Debug/Release両構成対応）
- どちらのファイルも該当パターンが1件も見つからない場合はテンプレート構造の変化を疑い、
  SystemExit(1) で明示的にビルドを失敗させる（サイレント素通り禁止）

使い方: python3 scripts/ensure-min-ios-version.py <path-to-ios-app-dir>
  例: python3 scripts/ensure-min-ios-version.py ios-app/ios
"""
import re
import sys
import os

TARGET_VERSION = "15.0"

if len(sys.argv) < 2:
    print("Usage: ensure-min-ios-version.py <path-to-ios-dir (contains App/Podfile)>")
    raise SystemExit(1)

ios_dir = sys.argv[1]
podfile_path = os.path.join(ios_dir, "App", "Podfile")
pbxproj_path = os.path.join(ios_dir, "App", "App.xcodeproj", "project.pbxproj")

# ── Podfile: platform :ios, 'X.X' ──────────────────────────────
with open(podfile_path, "r", encoding="utf-8") as f:
    podfile_src = f.read()

new_podfile_src, podfile_count = re.subn(
    r"platform\s+:ios,\s*['\"][\d.]+['\"]",
    f"platform :ios, '{TARGET_VERSION}'",
    podfile_src,
)

if podfile_count == 0:
    print(f"!!! Podfile内に 'platform :ios, ...' 行が見つかりませんでした（{podfile_path}）。テンプレート構造の変化の可能性があります。")
    raise SystemExit(1)

with open(podfile_path, "w", encoding="utf-8") as f:
    f.write(new_podfile_src)
print(f"Podfile: platform :ios を {TARGET_VERSION} に置換しました（{podfile_count}箇所）。")

# ── project.pbxproj: IPHONEOS_DEPLOYMENT_TARGET = X.X; ─────────
with open(pbxproj_path, "r", encoding="utf-8") as f:
    pbxproj_src = f.read()

new_pbxproj_src, pbxproj_count = re.subn(
    r"IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;",
    f"IPHONEOS_DEPLOYMENT_TARGET = {TARGET_VERSION};",
    pbxproj_src,
)

if pbxproj_count == 0:
    print(f"!!! project.pbxproj内に 'IPHONEOS_DEPLOYMENT_TARGET = ...;' が見つかりませんでした（{pbxproj_path}）。テンプレート構造の変化の可能性があります。")
    raise SystemExit(1)

with open(pbxproj_path, "w", encoding="utf-8") as f:
    f.write(new_pbxproj_src)
print(f"project.pbxproj: IPHONEOS_DEPLOYMENT_TARGET を {TARGET_VERSION} に置換しました（{pbxproj_count}箇所）。")
