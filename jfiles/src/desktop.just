import "../common.just"

# Desktop app (Tauri): needs `cargo install tauri-cli --version "^2" --locked`

# Run the desktop app against the Next dev server on 127.0.0.1:1430, with hot reload
desktop: build-wasm-dev
  cd {{DESKTOP}} && cargo tauri dev

# Usage: just src desktop-build, or just src desktop-build --bundles deb
# Build the desktop app bundles for this OS (release, in target/release/bundle; the Tauri
# beforeBuildCommand builds the wasm and the static export)
desktop-build *args:
  #!/usr/bin/env bash
  set -euo pipefail
  if [ "$(uname -s)" = Linux ] && ! pkg-config --exists webkit2gtk-4.1 libsoup-3.0; then
    echo "Missing webkit2gtk-4.1 or libsoup-3.0 development files."
    echo "  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev"
    echo "  Arch: sudo pacman -S webkit2gtk-4.1 libsoup3 libayatana-appindicator librsvg"
    exit 1
  fi
  cd "{{DESKTOP}}" && cargo tauri build {{args}}

# Debug build of the desktop app without bundles, for quick checks
desktop-debug:
  cd {{DESKTOP}} && cargo tauri build --debug --no-bundle
