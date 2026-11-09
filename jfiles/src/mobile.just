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
