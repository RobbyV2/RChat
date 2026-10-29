// Creates the Android or iOS project in `src-tauri/gen` and applies our changes to it.
//
//   bun apps/desktop/scripts/mobile.ts init android|ios   runs `cargo tauri <platform> init`, then patch
//   bun apps/desktop/scripts/mobile.ts patch android|ios  icons, splash, permissions and insets only
//
// The generated projects are never committed; everything that differs from Tauri's template lives
// in `apps/desktop/mobile` and is applied here, so a fresh `init` always gives the same app.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauri = join(desktop, 'src-tauri')
const overlay = join(desktop, 'mobile')
const gen = join(tauri, 'gen')
const background = '#141218'
const logo = resolve(desktop, '../../assets/rchat_r.png')

const run = (args: string[]) => {
  const done = spawnSync('cargo', args, { cwd: tauri, stdio: 'inherit' })
  if (done.status !== 0) throw new Error(`cargo ${args.join(' ')} failed`)
}

const read = (path: string) => readFileSync(path, 'utf8')

// Puts `lines` right before `before` (first match) between marker comments; a second run
// replaces the block instead of adding another one.
export const insertBlock = (xml: string, id: string, before: string, lines: string[]) => {
  const mark = `<!-- rchat: ${id} -->`
  const kept = xml.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of kept) {
    if (line.trim() === mark) {
      skipping = !skipping
      continue
    }
    if (!skipping) out.push(line)
  }
  const at = out.findIndex(line => line.includes(before))
  if (at < 0) throw new Error(`${before} not found`)
  const indent = out[at].match(/^\s*/)?.[0] ?? ''
  const pad = before.startsWith('</') ? `${indent}    ` : indent
  out.splice(at, 0, ...[mark, ...lines, mark].map(line => `${pad}${line}`))
  return out.join('\n')
}

const findFile = (dir: string, name: string): string | null => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    } else if (entry === name) return path
  }
  return null
}

// `cargo tauri icon` writes straight into the generated projects that exist; the desktop set it
// also makes goes to a scratch folder next to `icons` and is thrown away.
const icons = () => {
  const scratch = join(tauri, '.mobile-icons')
  try {
    run(['tauri', 'icon', join(overlay, 'icon.json'), '-o', scratch])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const android = () => {
  const app = join(gen, 'android', 'app', 'src', 'main')
  if (!existsSync(app)) throw new Error('Run init first: no Android project in src-tauri/gen')

  const activity = findFile(join(app, 'java'), 'MainActivity.kt')
  if (!activity) throw new Error('MainActivity.kt not found')
  const pkg = read(activity)
    .split('\n')
    .find(line => line.startsWith('package '))
  if (!pkg) throw new Error('MainActivity.kt has no package line')
  writeFileSync(activity, `${pkg}\n\n${read(join(overlay, 'android', 'MainActivity.kt'))}`)

  const manifest = join(app, 'AndroidManifest.xml')
  writeFileSync(
    manifest,
    insertBlock(read(manifest), 'permissions', '<application', [
      '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
      '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
      '<uses-permission android:name="android.permission.CAMERA" />',
      '<uses-feature android:name="android.hardware.camera" android:required="false" />',
      '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
    ])
  )

  const values = join(app, 'res', 'values')
  writeFileSync(
    join(values, 'rchat_colors.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="rchat_background">${background}</color>\n</resources>\n`
  )
  for (const folder of ['values', 'values-night']) {
    const themes = join(app, 'res', folder, 'themes.xml')
    if (!existsSync(themes)) continue
    writeFileSync(
      themes,
      insertBlock(read(themes), 'splash', '</style>', [
        '<item name="android:windowBackground">@color/rchat_background</item>',
      ])
    )
  }
}

const ios = () => {
  const apple = join(gen, 'apple')
  if (!existsSync(apple)) throw new Error('Run init first: no iOS project in src-tauri/gen')
  copyFileSync(
    join(overlay, 'ios', 'LaunchScreen.storyboard'),
    join(apple, 'LaunchScreen.storyboard')
  )
  const set = join(apple, 'Assets.xcassets', 'LaunchLogo.imageset')
  mkdirSync(set, { recursive: true })
  copyFileSync(join(overlay, 'ios', 'LaunchLogo.json'), join(set, 'Contents.json'))
  copyFileSync(logo, join(set, 'launch_logo.png'))
}

const main = (argv: string[]) => {
  const [step, platform] = argv
  if (!['init', 'patch'].includes(step) || !['android', 'ios'].includes(platform)) {
    console.error('Usage: bun apps/desktop/scripts/mobile.ts init|patch android|ios')
    process.exit(2)
  }
  if (step === 'init') run(['tauri', platform, 'init', '--ci'])
  icons()
  if (platform === 'android') android()
  else ios()
  console.log(
    `${platform} project ready in ${join(gen, platform === 'android' ? 'android' : 'apple')}`
  )
}

if (import.meta.main) main(process.argv.slice(2))
