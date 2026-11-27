---
title: The apps
description: The web app, the installable app and the desktop and mobile apps on Linux, Windows, macOS, iOS and Android.
sidebar:
  order: 9
---

Every instance serves the web app at its address. The desktop and mobile apps carry the same app without a server of their own: on first launch, they ask for the address of an RChat instance. All of them hold several accounts on several instances.

## In the browser

The web app runs in current Chrome, Edge and Firefox, and in Safari from version 16.4, on iOS too. Browsers that support it can install it as an app from the browser's menu. On iPhone and iPad, an app added to the home screen keeps its data longer than a Safari tab, [P2P identities](/docs/use/p2p/) included.

The client-only web build lets people choose the instances they use when they open it (see [Deploy from source](/docs/run/from-source/)).

## Desktop and mobile

| Platform | Release files                                                   | Minimum     |
| -------- | --------------------------------------------------------------- | ----------- |
| Windows  | `.msi` and `-setup.exe` installers                              |             |
| macOS    | `RChat_<version>_universal.dmg`                                 | macOS 11    |
| Linux    | `.deb` and `.AppImage`, plus `.rpm` in stable releases          | glibc 2.35  |
| Android  | `RChat_<version>_android.apk`                                   | Android 7.0 |
| iOS      | `RChat_<version>_ios_sideload.ipa`, an unsigned developer build | iOS 16.4    |

Stable releases and weekly pre-releases (`weekly-YYYY-MM-DD`, every Monday) are on GitHub Releases. `packaging/` holds manifests for AUR, Homebrew, Scoop and winget.

Settings → General → Desktop app offers Close to tray, Start on login, and Check for updates on start, with weekly builds as an option.

## Building them

The apps are built with Tauri, which has its own prerequisites per platform.

| Command                                                             | Result                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `just src desktop-build`                                            | Installers for this platform in `target/release/bundle/`.                  |
| `just src mobile-init android`, then `just src android-build`       | A debug APK in `apps/desktop/src-tauri/gen/android/app/build/outputs/apk`. |
| `just src mobile-init ios`, then `just src ios-sideload` (on a Mac) | `apps/desktop/src-tauri/gen/apple/build/RChat_sideload.ipa`.               |
| `just src desktop`                                                  | The desktop app against the web dev server, with hot reload.               |
