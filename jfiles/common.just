ROOT := `git rev-parse --show-toplevel`
WEB := ROOT / "apps/web"
DESKTOP := ROOT / "apps/desktop/src-tauri"
DOTENVX := "bunx dotenvx run --convention=nextjs --quiet --"
