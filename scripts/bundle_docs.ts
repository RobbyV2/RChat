// Puts the docs site into the web app's static build (apps/web/out/docs), which the client-only
// web build and the desktop and mobile apps serve. Builds the site first unless DOCS_BUILD is off
// or `--built` reuses docs/dist. Compressed copies stay out: the apps carry the plain files.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

export const skipped = (env: Record<string, string | undefined>) =>
  env.DOCS_BUILD?.trim().toLowerCase() === 'off'

// Whether a file of the built site goes into the app.
export const bundled = (path: string) => !/\.(gz|br)$/.test(path)

export function bundleDocs(
  args = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env
) {
  const out = join(root, 'apps/web/out')
  const site = join(root, 'docs/dist')
  if (skipped(env)) return 'skipped'
  if (!existsSync(out)) throw new Error('apps/web/out is missing: build the static app first')
  if (!args.includes('--built')) {
    const built = spawnSync('bun', ['run', 'build:docs'], { cwd: root, stdio: 'inherit' })
    if (built.status !== 0) throw new Error('bun run build:docs failed')
  }
  if (!existsSync(join(site, 'index.html'))) throw new Error('docs/dist holds no built site')
  const target = join(out, 'docs')
  rmSync(target, { recursive: true, force: true })
  cpSync(site, target, { recursive: true, filter: bundled })
  return 'bundled'
}

if (import.meta.main) console.log(`Docs ${bundleDocs()}.`)
