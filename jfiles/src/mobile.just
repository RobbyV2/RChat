import "../common.just"

# Mobile apps (Tauri): need the Android SDK + NDK (ANDROID_HOME, NDK_HOME) or macOS with Xcode

# Usage: just src mobile-init android, or just src mobile-init ios
# Generate the native project in src-tauri/gen and apply our icons, splash and permissions
mobile-init platform: deps
  cd {{ROOT}} && bun apps/desktop/scripts/mobile.ts init {{platform}}

# Debug APK for phones and emulators (in src-tauri/gen/android/app/build/outputs/apk)
android-build *args: deps
  cd {{DESKTOP}} && cargo tauri android build --debug --apk {{args}}

# Unsigned iOS build (macOS only, in src-tauri/gen/apple/build)
ios-build *args: deps
  cd {{DESKTOP}} && cargo tauri ios build --no-sign {{args}}

# Output: src-tauri/gen/apple/build/RChat_sideload.ipa
# iOS build for AltStore, SideStore, Sideloadly, TrollStore or LiveContainer (macOS only)
ios-sideload *args: deps
  cd {{DESKTOP}} && cargo tauri ios build --no-sign --target aarch64 {{args}}
  {{ROOT}}/apps/desktop/scripts/sideload-ipa.sh "$(ls -t {{DESKTOP}}/gen/apple/build/*/*.ipa | head -n 1)" {{DESKTOP}}/gen/apple/build/RChat_sideload.ipa
