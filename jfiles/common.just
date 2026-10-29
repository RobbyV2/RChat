ROOT := `git rev-parse --show-toplevel`
WEB := ROOT / "apps/web"
DOTENVX := "bunx dotenvx run --convention=nextjs --quiet --"
