import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TEMPLATES,
  appVersion,
  fill,
  packagingValues,
  releaseMeta,
  tauriConfig,
  templatesFor,
  updaterManifest,
} from './release'

const base = { base: '0.2.2', date: '2026-11-02', runNumber: 70001 }

describe('release meta', () => {
  test('a version tag is a stable release', () => {
    expect(releaseMeta({ ...base, refType: 'tag', refName: '0.3.0' })).toEqual({
      channel: 'stable',
      version: '0.3.0',
      tag: '0.3.0',
      title: 'RChat 0.3.0',
      prerelease: false,
      wixVersion: '',
      dockerTags: ['latest', '0.3.0'],
      linuxBundles: 'deb,rpm',
      versionCode: 70001,
    })
  })

  test('a pre-release tag is not latest and has no rpm', () => {
    const meta = releaseMeta({ ...base, refType: 'tag', refName: '0.3.0-rc.1' })
    expect(meta.version).toBe('0.3.0-rc.1')
    expect(meta.tag).toBe('0.3.0-rc.1')
    expect(meta.prerelease).toBe(true)
    expect(meta.wixVersion).toBe('0.3.0.4466')
    expect(meta.dockerTags).toEqual(['0.3.0-rc.1'])
    expect(meta.linuxBundles).toBe('deb')
  })

  test('other tags are refused, v tags too', () => {
    expect(() => releaseMeta({ ...base, refType: 'tag', refName: 'weekly' })).toThrow()
    expect(() => releaseMeta({ ...base, refType: 'tag', refName: 'v0.3.0' })).toThrow()
  })

  test('the schedule makes a weekly build of the next patch', () => {
    expect(releaseMeta({ ...base, refType: 'branch', refName: 'main' })).toEqual({
      channel: 'weekly',
      version: '0.2.3-weekly.20261102',
      tag: 'weekly-2026-11-02',
      title: 'Weekly 2026-11-02',
      prerelease: true,
      wixVersion: '0.2.3.4466',
      dockerTags: ['weekly', 'nightly', 'weekly-2026-11-02'],
      linuxBundles: 'deb',
      versionCode: 70001,
    })
  })

  test('the app version is the one Tauri reads, and the root package.json agrees', () => {
    const rootVersion = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
    ).version
    const tauri = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
    )
    expect(tauri.version).toBe('../../web/package.json')
    expect(appVersion()).toBe(rootVersion)
  })
})

// The profanity filter's wasm is git-ignored, so every app build makes it before the web build.
describe('app builds', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

  test('the Tauri build command builds the wasm before the static export', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    const tauri = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'))
    const run = (tauri.build.beforeBuildCommand.script as string).match(/^bun run ([\w:]+)$/)?.[1]
    const steps = (scripts[run ?? ''] ?? '').split(' && ')
    expect(steps).toEqual(['bun run build:wasm', 'bun run build:desktop'])
    expect(scripts['build:wasm']).toContain(
      'wasm-pack build crates/wasm --mode no-install --target web --out-dir ../../apps/web/public/wasm --release'
    )
  })

  test('every desktop and mobile job has wasm-pack and the wasm target', () => {
    for (const file of ['desktop.yml', 'mobile.yml']) {
      const jobs = read(`.github/workflows/${file}`)
        .split(/\n {2}(?=[\w-]+:\n)/)
        .slice(1)
      expect(jobs.length).toBeGreaterThan(0)
      for (const job of jobs.filter(j => j.includes('cargo tauri'))) {
        expect(job).toContain('cargo install wasm-pack')
        expect(job).toContain('wasm32-unknown-unknown')
      }
    }
  })
})

describe('tauri config', () => {
  test('no secrets: no updater files, no signing', () => {
    expect(tauriConfig({})).toEqual({ bundle: { createUpdaterArtifacts: false, windows: {} } })
  })

  test('a key without the public key does not sign', () => {
    expect(tauriConfig({ hasKey: true }).bundle.createUpdaterArtifacts).toBe(false)
  })

  test('a stable release without the updater key is refused, a weekly one is not', () => {
    expect(() => tauriConfig({ channel: 'stable', hasKey: true })).toThrow('stable release')
    expect(() => tauriConfig({ channel: 'stable', pubkey: 'PUB' })).toThrow('stable release')
    expect(tauriConfig({ channel: 'stable', pubkey: 'PUB', hasKey: true }).bundle).toMatchObject({
      createUpdaterArtifacts: true,
    })
    expect(tauriConfig({ channel: 'weekly' }).bundle.createUpdaterArtifacts).toBe(false)
  })

  test('the desktop builds pass their channel, and a stable re-run keeps the release', () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')
    const desktop = read('.github/workflows/desktop.yml')
    expect(desktop).toContain('CHANNEL: ${{ inputs.channel }}')
    const stable = read('.github/workflows/release.yml').split('- name: Stable release')[1]
    const step = stable.split('- name:')[0]
    expect(step).toContain('gh release upload "$TAG" dist/* --clobber')
    expect(step).not.toContain('gh release delete')
  })

  test('everything set', () => {
    expect(
      tauriConfig({
        version: '0.2.3-weekly.20261102',
        wixVersion: '0.2.3.5',
        versionCode: 81,
        pubkey: 'PUB',
        hasKey: true,
        thumbprint: 'AB12',
      })
    ).toEqual({
      version: '0.2.3-weekly.20261102',
      bundle: {
        createUpdaterArtifacts: true,
        windows: {
          wix: { version: '0.2.3.5' },
          certificateThumbprint: 'AB12',
          digestAlgorithm: 'sha256',
          timestampUrl: 'http://timestamp.digicert.com',
        },
        android: { versionCode: 81 },
      },
      plugins: { updater: { pubkey: 'PUB' } },
    })
  })
})

describe('updater manifest', () => {
  const files = [
    'RChat_0.3.0_universal.app.tar.gz',
    'RChat_0.3.0_x64-setup.exe',
    'RChat_0.3.0_x64_en-US.msi',
    'rchat_0.3.0_amd64.deb',
    'rchat-0.3.0-1.x86_64.rpm',
    'rchat_0.3.0_amd64.AppImage',
  ].map(name => ({ name, signature: `sig-${name}\n` }))
  const opts = { version: '0.3.0', base: 'https://x/d/0.3.0/', notes: 'n', date: 'd' }

  test('every installer gets a key, and each OS a default', () => {
    const { platforms, version, notes, pub_date } = updaterManifest(files, opts)
    expect({ version, notes, pub_date }).toEqual({ version: '0.3.0', notes: 'n', pub_date: 'd' })
    expect(Object.keys(platforms)).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'linux-x86_64',
      'linux-x86_64-appimage',
      'linux-x86_64-deb',
      'linux-x86_64-rpm',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ])
    expect(platforms['windows-x86_64'].url).toBe('https://x/d/0.3.0/RChat_0.3.0_x64-setup.exe')
    expect(platforms['linux-x86_64'].signature).toBe('sig-rchat_0.3.0_amd64.AppImage')
    expect(platforms['darwin-x86_64']).toEqual(platforms['darwin-aarch64'])
  })

  test('without an AppImage, Linux has no default', () => {
    const { platforms } = updaterManifest(
      files.filter(f => !f.name.endsWith('.AppImage')),
      opts
    )
    expect(platforms['linux-x86_64']).toBeUndefined()
    expect(platforms['linux-x86_64-appimage']).toBeUndefined()
    expect(platforms['linux-x86_64-deb'].url).toContain('.deb')
  })

  test('names are URL encoded', () => {
    const { platforms } = updaterManifest(
      [{ name: 'RChat_0.3.0-weekly.1_x64-setup.exe', signature: 's' }],
      opts
    )
    expect(platforms['windows-x86_64'].url).toBe(
      'https://x/d/0.3.0/RChat_0.3.0-weekly.1_x64-setup.exe'
    )
  })
})

describe('packaging', () => {
  const names = [
    'RChat_0.3.0_x64-setup.exe',
    'RChat_0.3.0_x64_en-US.msi',
    'RChat_0.3.0_universal.dmg',
    'rchat_0.3.0_amd64.deb',
  ]
  const values = packagingValues(names, name => `hash-${name}`, {
    version: '0.3.0',
    tag: '0.3.0',
    repo: 'RobbyV2/RChat',
  })

  test('values point at the release assets', () => {
    expect(values.DEB_URL).toBe(
      'https://github.com/RobbyV2/RChat/releases/download/0.3.0/rchat_0.3.0_amd64.deb'
    )
    expect(values.DMG_SHA256).toBe('hash-RChat_0.3.0_universal.dmg')
    expect(values.PKGVER).toBe('0.3.0')
    expect(values.LICENSE_URL).toBe('https://raw.githubusercontent.com/RobbyV2/RChat/0.3.0/LICENSE')
  })

  test('weekly versions are valid pkgver values', () => {
    const weekly = packagingValues([], () => '', {
      version: '0.2.3-weekly.20261102',
      tag: 'weekly-2026-11-02',
      repo: 'RobbyV2/RChat',
    })
    expect(weekly.PKGVER).toBe('0.2.3_weekly.20261102')
  })

  test('stable pre-releases get no package manager files', () => {
    expect(templatesFor('stable', true)).toEqual([])
    expect(templatesFor('stable', false).map(t => t.path)).toContain('scoop/rchat.json')
    expect(templatesFor('weekly', true).map(t => t.path)).toEqual(['aur/rchat-weekly-bin/PKGBUILD'])
  })

  test('scoop autoupdate uses the bare tag style', () => {
    const scoop = JSON.parse(
      fill(readFileSync(join(import.meta.dir, '..', 'packaging/scoop/rchat.json'), 'utf8'), values)
    )
    expect(scoop.autoupdate.architecture['64bit'].url).toBe(
      'https://github.com/RobbyV2/RChat/releases/download/$version/RChat_$version_x64-setup.exe#/dl.7z'
    )
    expect(values.NSIS_URL).toBe(
      'https://github.com/RobbyV2/RChat/releases/download/0.3.0/RChat_0.3.0_x64-setup.exe'
    )
  })

  test('a missing value is an error', () => {
    expect(() => fill('{{NOPE}}', {})).toThrow()
  })

  test('every template fills without leftovers', () => {
    for (const { path } of TEMPLATES) {
      const out = fill(readFileSync(join(import.meta.dir, '..', 'packaging', path), 'utf8'), values)
      expect(out).not.toMatch(/\{\{[A-Z0-9_]+\}\}/)
      if (path.endsWith('.json')) expect(JSON.parse(out).version).toBe('0.3.0')
    }
  })
})
