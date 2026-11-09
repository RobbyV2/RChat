// Release helpers for .github/workflows/release.yml and desktop.yml.
//
//   bun scripts/release.ts meta                 release channel, version and tags (key=value lines)
//   bun scripts/release.ts tauri-config <out>   per-build Tauri config overrides (JSON file)
//   bun scripts/release.ts updater <dist>       Tauri updater manifest dist/latest.json
//   bun scripts/release.ts packaging <dist> <out>  winget, scoop, Homebrew and AUR files
//
// Inputs come from the environment, so the workflows only pass what they know.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export type Meta = {
  channel: 'stable' | 'weekly'
  version: string
  tag: string
  title: string
  prerelease: boolean
  wixVersion: string
  dockerTags: string[]
  linuxBundles: string
  versionCode: number
}

type MetaInput = {
  refType: string
  refName: string
  base: string
  date: string
  runNumber: number
}

// RPM refuses a hyphen in Version, so versions with a pre-release part only get a .deb.
// versionCode is the Android build number; the run number keeps it increasing across channels.
export const releaseMeta = ({ refType, refName, base, date, runNumber }: MetaInput): Meta => {
  const build = runNumber % 65535
  if (refType === 'tag') {
    const m = SEMVER.exec(refName)
    if (!m) throw new Error(`Not a release tag (want 1.2.3 or 1.2.3-rc.1): ${refName}`)
    const prerelease = m[4] !== undefined
    return {
      channel: 'stable',
      version: refName,
      tag: refName,
      title: `RChat ${refName}`,
      prerelease,
      wixVersion: prerelease ? `${m[1]}.${m[2]}.${m[3]}.${build}` : '',
      dockerTags: prerelease ? [refName] : ['latest', refName],
      linuxBundles: prerelease ? 'deb' : 'deb,rpm',
      versionCode: runNumber,
    }
  }
  const m = SEMVER.exec(base)
  if (!m) throw new Error(`Bad base version: ${base}`)
  const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
  return {
    channel: 'weekly',
    version: `${next}-weekly.${date.replaceAll('-', '')}`,
    tag: `weekly-${date}`,
    title: `Weekly ${date}`,
    prerelease: true,
    wixVersion: `${next}.${build}`,
    dockerTags: ['weekly', 'nightly', `weekly-${date}`],
    linuxBundles: 'deb',
    versionCode: runNumber,
  }
}

// CFBundleShortVersionString takes three integers, so iOS builds drop the pre-release part.
export const numericVersion = (version: string) => {
  const m = SEMVER.exec(version)
  if (!m) throw new Error(`Bad version: ${version}`)
  return `${m[1]}.${m[2]}.${m[3]}`
}

type ConfigInput = {
  version?: string
  wixVersion?: string
  versionCode?: number
  pubkey?: string
  hasKey?: boolean
  thumbprint?: string
  channel?: string
  platform?: string
}

// Merged over tauri.conf.json with `--config`. Updater files are only made when both halves of
// the signing key are present, so test and weekly builds without secrets still pass. A stable
// release without them is refused: installed apps update from its latest.json.
export const tauriConfig = ({
  version,
  wixVersion,
  versionCode,
  pubkey,
  hasKey,
  thumbprint,
  channel,
  platform,
}: ConfigInput) => {
  const sign = Boolean(pubkey && hasKey)
  if (channel === 'stable' && !sign)
    throw new Error('a stable release needs TAURI_SIGNING_PRIVATE_KEY and TAURI_UPDATER_PUBKEY')
  const windows: Record<string, unknown> = {}
  if (wixVersion) windows.wix = { version: wixVersion }
  if (thumbprint) {
    windows.certificateThumbprint = thumbprint
    windows.digestAlgorithm = 'sha256'
    windows.timestampUrl = 'http://timestamp.digicert.com'
  }
  return {
    ...(version ? { version: platform === 'ios' ? numericVersion(version) : version } : {}),
    bundle: {
      createUpdaterArtifacts: sign,
      windows,
      ...(versionCode ? { android: { versionCode } } : {}),
    },
    ...(sign ? { plugins: { updater: { pubkey } } } : {}),
  }
}

type Platform = { signature: string; url: string }

const archOf = (name: string): string[] => {
  if (/universal/i.test(name)) return ['aarch64', 'x86_64']
  if (/aarch64|arm64/i.test(name)) return ['aarch64']
  return ['x86_64']
}

const kindOf = (name: string): [string, string] | null => {
  if (name.endsWith('.app.tar.gz')) return ['darwin', 'app']
  if (name.endsWith('-setup.exe')) return ['windows', 'nsis']
  if (name.endsWith('.msi')) return ['windows', 'msi']
  if (name.endsWith('.AppImage')) return ['linux', 'appimage']
  if (name.endsWith('.deb')) return ['linux', 'deb']
  if (name.endsWith('.rpm')) return ['linux', 'rpm']
  return null
}

// The default per OS is what `{os}-{arch}` points at when the installer type is unknown. Linux
// only defaults to the AppImage: the updater can't replace a package-managed .deb or .rpm.
const DEFAULTS: Record<string, string[]> = {
  darwin: ['app'],
  windows: ['nsis', 'msi'],
  linux: ['appimage'],
}

export const updaterManifest = (
  files: { name: string; signature: string }[],
  { version, base, notes, date }: { version: string; base: string; notes: string; date: string }
) => {
  const platforms: Record<string, Platform> = {}
  const found: Record<string, Record<string, Platform>> = {}
  for (const { name, signature } of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = kindOf(name)
    if (!kind) continue
    const [os, installer] = kind
    const entry = { signature: signature.trim(), url: `${base}${encodeURIComponent(name)}` }
    for (const arch of archOf(name)) {
      platforms[`${os}-${arch}-${installer}`] = entry
      found[`${os}-${arch}`] = { ...found[`${os}-${arch}`], [installer]: entry }
    }
  }
  for (const [key, kinds] of Object.entries(found)) {
    const os = key.split('-')[0]
    const pick = DEFAULTS[os].find(kind => kinds[kind])
    if (pick) platforms[key] = kinds[pick]
  }
  const sorted = Object.fromEntries(
    Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b))
  )
  return { version, notes, pub_date: date, platforms: sorted }
}

export const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`No value for {{${key}}}`)
    return values[key]
  })

// Which release asset each template needs, by channel. Paths are under packaging/. Stable
// pre-releases (1.2.3-rc.1) get none: package managers only carry real releases.
export const TEMPLATES: { path: string; channel: Meta['channel']; needs: string[] }[] = [
  { path: 'winget/RobbyV2.RChat.yaml', channel: 'stable', needs: [] },
  { path: 'winget/RobbyV2.RChat.installer.yaml', channel: 'stable', needs: ['NSIS', 'MSI'] },
  { path: 'winget/RobbyV2.RChat.locale.en-US.yaml', channel: 'stable', needs: [] },
  { path: 'scoop/rchat.json', channel: 'stable', needs: ['NSIS'] },
  { path: 'homebrew/rchat.rb', channel: 'stable', needs: ['DMG'] },
  { path: 'aur/rchat-bin/PKGBUILD', channel: 'stable', needs: ['DEB'] },
  { path: 'aur/rchat-weekly-bin/PKGBUILD', channel: 'weekly', needs: ['DEB'] },
]

export const templatesFor = (channel: string, prerelease: boolean) =>
  channel === 'stable' && prerelease ? [] : TEMPLATES.filter(t => t.channel === channel)

const ASSETS: Record<string, (name: string) => boolean> = {
  NSIS: name => name.endsWith('-setup.exe'),
  MSI: name => name.endsWith('.msi'),
  DMG: name => name.endsWith('.dmg'),
  DEB: name => name.endsWith('.deb'),
}

export const packagingValues = (
  names: string[],
  hash: (name: string) => string,
  { version, tag, repo }: { version: string; tag: string; repo: string }
) => {
  const values: Record<string, string> = {
    VERSION: version,
    PKGVER: version.replaceAll('-', '_'),
    TAG: tag,
    REPO: repo,
    LICENSE_SHA256: createHash('sha256')
      .update(readFileSync(join(root, 'LICENSE')))
      .digest('hex'),
    LICENSE_URL: `https://raw.githubusercontent.com/${repo}/${tag}/LICENSE`,
  }
  for (const [key, match] of Object.entries(ASSETS)) {
    const name = names.find(match)
    if (!name) continue
    values[`${key}_FILE`] = name
    values[`${key}_URL`] = `https://github.com/${repo}/releases/download/${tag}/${name}`
    values[`${key}_SHA256`] = hash(name)
  }
  return values
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

const env = (key: string, fallback?: string) => {
  const value = process.env[key] || fallback
  if (value === undefined) throw new Error(`${key} is not set`)
  return value
}

// The app version lives where Tauri reads it (tauri.conf.json points at this file).
export const appVersion = () =>
  JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')).version as string

const main = (args: string[]) => {
  const [command, ...rest] = args
  if (command === 'meta') {
    const base = appVersion()
    const meta = releaseMeta({
      refType: env('GITHUB_REF_TYPE'),
      refName: env('GITHUB_REF_NAME'),
      base,
      date: env('RELEASE_DATE', new Date().toISOString().slice(0, 10)),
      runNumber: Number(env('GITHUB_RUN_NUMBER', '1')),
    })
    if (meta.channel === 'stable' && meta.version.split('-')[0] !== base) {
      console.error(`warning: tag ${meta.tag} differs from apps/web/package.json ${base}`)
    }
    const lines = {
      channel: meta.channel,
      version: meta.version,
      tag: meta.tag,
      title: meta.title,
      prerelease: String(meta.prerelease),
      wix_version: meta.wixVersion,
      docker_tags: meta.dockerTags.join(' '),
      linux_bundles: meta.linuxBundles,
      version_code: String(meta.versionCode),
    }
    console.log(
      Object.entries(lines)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    )
  } else if (command === 'tauri-config') {
    const config = tauriConfig({
      version: process.env.VERSION,
      wixVersion: process.env.WIX_VERSION,
      versionCode: Number(process.env.VERSION_CODE) || undefined,
      pubkey: process.env.UPDATER_PUBKEY,
      hasKey: Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY),
      thumbprint: process.env.WINDOWS_THUMBPRINT,
      channel: process.env.CHANNEL,
      platform: process.env.PLATFORM,
    })
    console.log(
      config.bundle.createUpdaterArtifacts
        ? 'Updater files: signed'
        : 'Updater files: off (needs TAURI_SIGNING_PRIVATE_KEY and the TAURI_UPDATER_PUBKEY variable)'
    )
    writeFileSync(rest[0], JSON.stringify(config, null, 2))
  } else if (command === 'updater') {
    const dist = rest[0]
    const files = readdirSync(dist)
      .filter(name => existsSync(join(dist, `${name}.sig`)))
      .map(name => ({ name, signature: readFileSync(join(dist, `${name}.sig`), 'utf8') }))
    if (!files.length) {
      console.log('No .sig files, so no latest.json (updater signing is off).')
      return
    }
    const repo = env('GITHUB_REPOSITORY', 'RobbyV2/RChat')
    const tag = env('TAG')
    const manifest = updaterManifest(files, {
      version: env('VERSION'),
      base: `https://github.com/${repo}/releases/download/${tag}/`,
      notes: env('NOTES', `https://github.com/${repo}/releases/tag/${tag}`),
      date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    })
    writeFileSync(join(dist, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`latest.json: ${Object.keys(manifest.platforms).join(', ')}`)
  } else if (command === 'packaging') {
    const [dist, out] = rest
    const templates = templatesFor(env('CHANNEL'), process.env.PRERELEASE === 'true')
    if (!templates.length) {
      console.log('Pre-release: no package manager files.')
      return
    }
    const names = readdirSync(dist)
    const values = packagingValues(names, name => sha256(join(dist, name)), {
      version: env('VERSION'),
      tag: env('TAG'),
      repo: env('GITHUB_REPOSITORY', 'RobbyV2/RChat'),
    })
    for (const { path, needs } of templates) {
      const missing = needs.filter(key => !values[`${key}_FILE`])
      if (missing.length) {
        console.log(`skip ${path}: no ${missing.join(', ')} asset`)
        continue
      }
      const target = join(out, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, fill(readFileSync(join(root, 'packaging', path), 'utf8'), values))
      console.log(`wrote ${relative(out, target)}`)
    }
  } else {
    throw new Error(
      'usage: release.ts meta | tauri-config <out> | updater <dist> | packaging <dist> <out>'
    )
  }
}

if (import.meta.main) main(process.argv.slice(2))
