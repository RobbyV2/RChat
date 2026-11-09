import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEMPLATES,
  altstoreSource,
  appVersion,
  fill,
  iosApp,
  ipaPrivacy,
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

  test('the iOS job always makes the sideload IPA, and the signed one only with the secrets', () => {
    const job = read('.github/workflows/mobile.yml').split('\n  mobile-ios:\n')[1]
    const step = (name: string) => job.split(`- name: ${name}\n`)[1].split(/\n {6}(?:- |# )/)[0]
    const sideload = step('Build sideload IPA')
    expect(sideload).not.toContain('if:')
    expect(sideload).toContain('PLATFORM=ios bun ../../../scripts/release.ts tauri-config')
    expect(sideload).toContain('cargo tauri ios build --ci --no-sign --target aarch64')
    expect(sideload).toContain('--build-number "$BUILD_NUMBER"')
    expect(sideload).toContain('../scripts/sideload-ipa.sh "$ipa" "$GITHUB_WORKSPACE/dist/$NAME"')
    expect(sideload).toContain(
      "format('RChat_{0}_ios_sideload.ipa', inputs.version) || 'RChat_sideload.ipa'"
    )
    expect(step('Check the sideload IPA')).toContain('codesign --verify')
    const signed = step('Build signed IPA')
    expect(signed).toContain("if: steps.signing.outputs.present == 'true'")
    expect(signed).not.toContain('--no-sign')
    expect(signed).toContain('dist/RChat_${VERSION}_ios.ipa')
    expect(job).not.toContain('steps.run.outputs.build')
    expect(job).not.toMatch(/-----BEGIN|\.p12|\.mobileprovision/)
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

  test('iOS gets the numeric version, which CFBundleShortVersionString needs', () => {
    expect(tauriConfig({ version: '0.4.1-weekly.20261116', platform: 'ios' }).version).toBe('0.4.1')
    expect(tauriConfig({ version: '0.4.0-rc.1', platform: 'ios' }).version).toBe('0.4.0')
    expect(tauriConfig({ version: '0.4.0', platform: 'ios' }).version).toBe('0.4.0')
    expect(tauriConfig({ version: '0.4.1-weekly.20261116' }).version).toBe('0.4.1-weekly.20261116')
    expect(tauriConfig({ platform: 'ios' })).toEqual(tauriConfig({}))
    expect(() => tauriConfig({ version: 'next', platform: 'ios' })).toThrow('next')
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

// AltStore and SideStore refuse the install unless the version, the build, the size and the
// permissions in the source equal the IPA's.
describe('altstore source', () => {
  const app = {
    name: 'RChat',
    bundle: 'io.github.robbyv2.rchat',
    description: 'Anonymous Material chat',
    minimum: '16.4',
  }
  const privacy = { NSCameraUsageDescription: 'Turn on your camera in video calls.' }
  const sha256 = 'ab'.repeat(32)
  const input = { app, privacy, repo: 'RobbyV2/RChat', build: 812, size: 5356927, sha256 }
  const date = '2026-11-16T05:20:31Z'

  test('a stable release', () => {
    const source = altstoreSource({
      ...input,
      channel: 'stable',
      tag: '0.4.0',
      version: '0.4.0',
      file: 'RChat_0.4.0_ios_sideload.ipa',
      date,
    })
    expect(source).toEqual({
      name: 'RChat',
      identifier: 'io.github.robbyv2.rchat.source',
      apps: [
        {
          name: 'RChat',
          bundleIdentifier: 'io.github.robbyv2.rchat',
          developerName: 'RChat',
          localizedDescription: 'Anonymous Material chat',
          iconURL:
            'https://raw.githubusercontent.com/RobbyV2/RChat/0.4.0/apps/desktop/src-tauri/icons/128x128@2x.png',
          versions: [
            {
              version: '0.4.0',
              buildVersion: '0.4.0.812',
              date,
              downloadURL:
                'https://github.com/RobbyV2/RChat/releases/download/0.4.0/RChat_0.4.0_ios_sideload.ipa',
              size: 5356927,
              sha256,
              minOSVersion: '16.4',
            },
          ],
          appPermissions: {
            entitlements: [],
            privacy: { NSCameraUsageDescription: 'Turn on your camera in video calls.' },
          },
        },
      ],
    })
  })

  test('a weekly build has the numeric version, its dated download and its own identifier', () => {
    const source = altstoreSource({
      ...input,
      channel: 'weekly',
      tag: 'weekly-2026-11-16',
      version: '0.4.1-weekly.20261116',
      file: 'RChat_0.4.1-weekly.20261116_ios_sideload.ipa',
      date,
    })
    expect(source.name).toBe('RChat weekly')
    expect(source.identifier).toBe('io.github.robbyv2.rchat.source.weekly')
    expect(source.apps[0].iconURL).toContain('/RobbyV2/RChat/weekly-2026-11-16/')
    expect(source.apps[0].versions).toEqual([
      {
        version: '0.4.1',
        buildVersion: '0.4.1.812',
        date,
        downloadURL:
          'https://github.com/RobbyV2/RChat/releases/download/weekly-2026-11-16/RChat_0.4.1-weekly.20261116_ios_sideload.ipa',
        size: 5356927,
        sha256,
        minOSVersion: '16.4',
      },
    ])
  })

  test('the app facts come from the Tauri config', () => {
    expect(iosApp()).toEqual({
      name: 'RChat',
      bundle: 'io.github.robbyv2.rchat',
      description: 'Anonymous Material chat',
      minimum: '16.4',
    })
  })

  // A binary Info.plist like Xcode's, with one usage string the app's Info.ios.plist does not have
  // and the nested Info.plist every built app carries.
  const usage = {
    NSCameraUsageDescription: 'Turn on your camera in video calls.',
    NSBluetoothAlwaysUsageDescription: 'Added by a plugin at build time.',
  }
  const ipa = (
    path: string,
    info: Record<string, unknown> = { CFBundleName: 'RChat', ...usage }
  ) => {
    const code = `
import json, plistlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    archive.writestr('Payload/RChat.app/LaunchScreen.storyboardc/Info.plist',
        plistlib.dumps({'NSMotionUsageDescription': 'Not the app plist.'}))
    archive.writestr('Payload/RChat.app/Info.plist',
        plistlib.dumps(json.load(sys.stdin), fmt=plistlib.FMT_BINARY))
    archive.writestr('Payload/RChat.app/RChat', 'binary')
`
    const out = spawnSync('python3', ['-I', '-c', code, path], {
      input: JSON.stringify(info),
      encoding: 'utf8',
    })
    if (out.status !== 0) throw new Error(out.stderr)
  }
  const inDist = (check: (dist: string) => void) => {
    const dist = mkdtempSync(join(tmpdir(), 'rchat-altstore-'))
    try {
      check(dist)
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  }
  const stable = { CHANNEL: 'stable', TAG: '0.4.0', VERSION: '0.4.0', BUILD_NUMBER: '7' }
  const run = (dist: string, env: Record<string, string> = stable) =>
    spawnSync(process.execPath, [join(import.meta.dir, 'release.ts'), 'altstore', dist], {
      env: { PATH: process.env.PATH ?? '', GITHUB_REPOSITORY: 'RobbyV2/RChat', ...env },
      encoding: 'utf8',
    })

  test("the usage strings are the IPA's own, in a fixed order", () =>
    inDist(dist => {
      const path = join(dist, 'RChat_0.4.0_ios_sideload.ipa')
      ipa(path)
      expect(Object.entries(ipaPrivacy(path))).toEqual([
        ['NSBluetoothAlwaysUsageDescription', 'Added by a plugin at build time.'],
        ['NSCameraUsageDescription', 'Turn on your camera in video calls.'],
      ])
      ipa(path, { CFBundleName: 'RChat' })
      expect(ipaPrivacy(path)).toEqual({})
    }))

  test('the command reads the file: its size, its hash and its usage strings', () =>
    inDist(dist => {
      const path = join(dist, 'RChat_0.4.0_ios_sideload.ipa')
      ipa(path)
      writeFileSync(join(dist, 'RChat_0.4.0_ios.ipa'), 'signed')
      const done = run(dist)
      expect(done.stderr).toBe('')
      const source = JSON.parse(readFileSync(join(dist, 'altstore.json'), 'utf8'))
      const [version] = source.apps[0].versions
      expect(version.size).toBe(statSync(path).size)
      expect(version.sha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'))
      expect(version.buildVersion).toBe('0.4.0.7')
      expect(version.downloadURL).toEndWith('/0.4.0/RChat_0.4.0_ios_sideload.ipa')
      expect(version.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(source.apps[0].appPermissions).toEqual({
        entitlements: [],
        privacy: {
          NSBluetoothAlwaysUsageDescription: 'Added by a plugin at build time.',
          NSCameraUsageDescription: 'Turn on your camera in video calls.',
        },
      })
    }))

  test('an IPA that cannot be read fails and writes no source file', () =>
    inDist(dist => {
      writeFileSync(join(dist, 'RChat_0.4.0_ios_sideload.ipa'), 'not a zip')
      const done = run(dist)
      expect(done.status).not.toBe(0)
      expect(done.stderr).toContain('RChat_0.4.0_ios_sideload.ipa')
      expect(existsSync(join(dist, 'altstore.json'))).toBe(false)
    }))

  test('without the sideload IPA there is no source file', () =>
    inDist(dist => {
      const done = run(dist)
      expect(done.status).toBe(0)
      expect(existsSync(join(dist, 'altstore.json'))).toBe(false)
    }))

  test('the release writes it before the checksums, with the build number the iOS build got', () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')
    const release = read('.github/workflows/release.yml')
    expect(release).toContain('build-number: ${{ needs.meta.outputs.version_code }}')
    const step = release.split('- name: AltStore source\n')[1].split('- name:')[0]
    expect(step).toContain('BUILD_NUMBER: ${{ needs.meta.outputs.version_code }}')
    expect(step).toContain('bun scripts/release.ts altstore dist')
    expect(release.indexOf('- name: AltStore source')).toBeLessThan(
      release.indexOf('- name: Checksums')
    )
    const weekly = release.split('- name: Weekly release')[1].split('- name:')[0]
    expect(weekly).toContain('pointer+=(dist/altstore.json)')
    expect(weekly).toContain('gh release upload weekly "${pointer[@]}" --clobber')
    expect(read('.github/workflows/mobile.yml')).toContain(
      '[ "$build" != "$version.$BUILD_NUMBER" ]'
    )
  })

  test('the README names both source addresses', () => {
    const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8')
    expect(readme).toContain(
      'https://github.com/RobbyV2/RChat/releases/latest/download/altstore.json'
    )
    expect(readme).toContain(
      'https://github.com/RobbyV2/RChat/releases/download/weekly/altstore.json'
    )
  })
})
