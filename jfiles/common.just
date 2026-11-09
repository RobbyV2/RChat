ROOT := `git rev-parse --show-toplevel`
WEB := ROOT / "apps/web"
DESKTOP := ROOT / "apps/desktop/src-tauri"
DOTENVX := "bunx dotenvx run --convention=nextjs --quiet --"
CARGO_TARGET := env_var_or_default("CARGO_TARGET_DIR", ROOT / "target")
PRETTIER_IGNORES := "--ignore-path .gitignore --ignore-path .prettierignore --ignore-path \"$(git rev-parse --git-common-dir)/info/exclude\""
DESKTOP_CRATES := "--exclude rchat-desktop --exclude tauri-plugin-rchat-share"

# Install the JS dependencies (fast when nothing changed)
[private]
deps:
  cd {{ROOT}} && bun install
