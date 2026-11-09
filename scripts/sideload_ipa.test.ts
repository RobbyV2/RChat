import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const script = join(root, 'apps/desktop/scripts/sideload-ipa.sh')
const work = mkdtempSync(join(tmpdir(), 'rchat-sideload-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
// Every test starts a few processes, which is slow on a busy machine.
setDefaultTimeout(60_000)

// Stands in for macOS codesign: logs its arguments and leaves a mark where a signature would go.
const bin = join(work, 'bin')
const log = join(work, 'codesign.log')
mkdirSync(bin)
writeFileSync(
  join(bin, 'codesign'),
  `#!/usr/bin/env bash
echo "$*" >> "$CODESIGN_LOG"
echo "codesign: replacing existing signature"
if [ -n "\${CODESIGN_FAILS:-}" ]; then exit 1; fi
target="\${!#}"
if [ -d "$target" ]; then
  mkdir -p "$target/_CodeSignature"
  echo sealed > "$target/_CodeSignature/CodeResources"
else
  printf signed >> "$target"
fi
`
)
chmodSync(join(bin, 'codesign'), 0o755)

type Entry = { name: string; mode?: number; data?: string; link?: string }
type Listed = { name: string; mode: number; link: boolean; data: string }

const python = (code: string, args: string[], input = '') => {
  const out = spawnSync('python3', ['-I', '-c', code, ...args], { input, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(out.stderr)
  return out.stdout
}

const zip = (path: string, entries: Entry[]) =>
  python(
    `
import json, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:
    for entry in json.load(sys.stdin):
        info = zipfile.ZipInfo(entry['name'])
        info.create_system = 3
        if 'link' in entry:
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, entry['link'])
        elif entry['name'].endswith('/'):
            info.external_attr = (stat.S_IFDIR | 0o755) << 16 | 0x10
            archive.writestr(info, '')
        else:
            info.external_attr = (stat.S_IFREG | entry.get('mode', 0o644)) << 16
            archive.writestr(info, entry.get('data', ''))
`,
    [path],
    JSON.stringify(entries)
  )

const unzip = (path: string): Listed[] =>
  JSON.parse(
    python(
      `
import json, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps([{
        'name': info.filename,
        'mode': stat.S_IMODE(info.external_attr >> 16),
        'link': stat.S_ISLNK(info.external_attr >> 16),
        'data': archive.read(info).decode(),
    } for info in archive.infolist()]))
`,
      [path]
    )
  )

const plist = ({ minimum = '16.4', schemes = ['rchat'] as string[] | null } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleShortVersionString</key>
	<string>0.4.0</string>
	<key>CFBundleVersion</key>
	<string>0.4.0.7</string>
	<key>MinimumOSVersion</key>
	<string>${minimum}</string>${
    schemes
      ? `
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>io.github.robbyv2.rchat</string>
			<key>CFBundleURLSchemes</key>
			<array>${schemes.map(scheme => `<string>${scheme}</string>`).join('')}</array>
		</dict>
	</array>`
      : ''
  }
</dict>
</plist>
`

const app = (info = plist(), name = 'RChat'): Entry[] => [
  { name: 'Payload/' },
  { name: `Payload/${name}.app/` },
  { name: `Payload/${name}.app/Info.plist`, data: info },
  { name: `Payload/${name}.app/${name}`, mode: 0o755, data: 'binary' },
  { name: `Payload/${name}.app/Assets.car`, data: 'assets' },
]

const nested: Entry[] = [
  { name: 'Payload/RChat.app/PlugIns/Share.appex/Share', mode: 0o755, data: 'share' },
  { name: 'Payload/RChat.app/PlugIns/notes.txt', data: 'not code' },
  { name: 'Payload/RChat.app/Frameworks/Foo.framework/Foo', mode: 0o755, data: 'foo' },
  { name: 'Payload/RChat.app/Frameworks/Foo.framework/Latest', link: 'Foo' },
  { name: 'Payload/RChat.app/Frameworks/libbar.dylib', mode: 0o755, data: 'bar' },
]

let count = 0
const run = (entries: Entry[], env: Record<string, string> = {}) => {
  const id = ++count
  const input = join(work, `in-${id}.ipa`)
  const output = join(work, `out-${id}.ipa`)
  zip(input, entries)
  rmSync(log, { force: true })
  const done = spawnSync('bash', [script, input, output], {
    env: { PATH: `${bin}:${process.env.PATH}`, CODESIGN_LOG: log, ...env },
    encoding: 'utf8',
  })
  const signed = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(line => line.replace(/ \S*\/Payload\//, ' '))
    : []
  return { status: done.status, stdout: done.stdout, stderr: done.stderr, output, signed }
}

const refused = (entries: Entry[], message: string) => {
  const { status, stderr, output, signed } = run(entries)
  expect(status).not.toBe(0)
  expect(stderr).toContain(message)
  expect(signed).toEqual([])
  expect(existsSync(output)).toBe(false)
}

describe('sideload IPA', () => {
  test('nested code is signed ad hoc before the app', () => {
    const { status, signed } = run([...app(), ...nested])
    expect(status).toBe(0)
    expect(signed).toEqual([
      '--force --sign - --timestamp=none RChat.app/Frameworks/Foo.framework',
      '--force --sign - --timestamp=none RChat.app/Frameworks/libbar.dylib',
      '--force --sign - --timestamp=none RChat.app/PlugIns/Share.appex',
      '--force --sign - --timestamp=none RChat.app',
    ])
  })

  test('the output keeps Payload at the root, the file modes and the signatures', () => {
    const { status, output } = run([...app(), ...nested])
    expect(status).toBe(0)
    const files = unzip(output)
    expect(files[0].name).toBe('Payload/')
    expect(files.every(file => file.name.startsWith('Payload/'))).toBe(true)
    const at = (name: string) => files.find(file => file.name === `Payload/RChat.app/${name}`)
    expect(at('RChat')).toMatchObject({ mode: 0o755, data: 'binary' })
    expect(at('Info.plist')).toMatchObject({ mode: 0o644, data: plist() })
    expect(at('Assets.car')).toMatchObject({ mode: 0o644, data: 'assets' })
    expect(at('_CodeSignature/CodeResources')?.data).toBe('sealed\n')
    expect(at('Frameworks/Foo.framework/_CodeSignature/CodeResources')?.data).toBe('sealed\n')
    expect(at('PlugIns/Share.appex/_CodeSignature/CodeResources')?.data).toBe('sealed\n')
    expect(at('Frameworks/libbar.dylib')).toMatchObject({ mode: 0o755, data: 'barsigned' })
    expect(at('PlugIns/notes.txt')?.data).toBe('not code')
  })

  test('symbolic links stay links', () => {
    const { output } = run([...app(), ...nested])
    const link = unzip(output).find(file => file.name.endsWith('Foo.framework/Latest'))
    expect(link).toMatchObject({ link: true, data: 'Foo' })
  })

  test('an app with nothing nested is signed once', () => {
    const { status, signed, stdout } = run(app())
    expect(status).toBe(0)
    expect(signed).toEqual(['--force --sign - --timestamp=none RChat.app'])
    expect(stdout).toContain('0.4.0 (0.4.0.7)')
  })

  test('exactly one app is required', () => {
    refused([{ name: 'Payload/' }], 'found 0')
    refused([...app(), ...app(plist(), 'Other').slice(1)], 'found 2')
  })

  test('the rchat link scheme is required', () => {
    refused(app(plist({ schemes: null })), 'rchat')
    refused(app(plist({ schemes: ['other'] })), 'rchat')
  })

  test('the minimum iOS version must be 16.4', () => {
    refused(app(plist({ minimum: '15.0' })), '15.0')
  })

  test('a signing failure fails the script and leaves no output', () => {
    const { status, output } = run(app(), { CODESIGN_FAILS: '1' })
    expect(status).not.toBe(0)
    expect(existsSync(output)).toBe(false)
  })

  test('two arguments are required', () => {
    const done = spawnSync('bash', [script, 'only.ipa'], { encoding: 'utf8' })
    expect(done.status).toBe(2)
    expect(done.stderr).toContain('usage')
  })

  test('an archive that is not an app fails in one line', () => {
    const noInfo = run([{ name: 'Payload/RChat.app/RChat', mode: 0o755, data: 'binary' }])
    expect(noInfo.status).not.toBe(0)
    expect(noInfo.stderr).toContain('Info.plist')
    expect(noInfo.stderr).not.toContain('Traceback')
    expect(noInfo.stderr.trim().split('\n')).toHaveLength(1)
    expect(existsSync(noInfo.output)).toBe(false)
  })

  // A crafted IPA must not make the script write or sign anything outside its work folder.
  describe('symbolic links that leave the app', () => {
    const outside = () => {
      const folder = join(work, `outside-${++count}`)
      mkdirSync(folder)
      return folder
    }

    test('a file under a link to another folder is not written there', () => {
      const folder = outside()
      const { status, output } = run([
        ...app(),
        { name: 'Payload/RChat.app/escape', link: folder },
        { name: 'Payload/RChat.app/escape/planted.txt', data: 'planted' },
      ])
      expect(status).not.toBe(0)
      expect(existsSync(join(folder, 'planted.txt'))).toBe(false)
      expect(existsSync(output)).toBe(false)
    })

    test('a file named like a link does not overwrite what the link points at', () => {
      const victim = join(outside(), 'victim.txt')
      writeFileSync(victim, 'kept')
      const { status, signed, output } = run([
        ...app(),
        { name: 'Payload/RChat.app/note', link: victim },
        { name: 'Payload/RChat.app/note', data: 'overwritten' },
      ])
      expect(readFileSync(victim, 'utf8')).toBe('kept')
      expect(status).not.toBe(0)
      expect(signed).toEqual([])
      expect(existsSync(output)).toBe(false)
    })

    test('nested code that links to a file elsewhere is not signed', () => {
      const library = join(outside(), 'lib.dylib')
      writeFileSync(library, 'theirs')
      const { status, stderr, signed, output } = run([
        ...app(),
        { name: 'Payload/RChat.app/Frameworks/lib.dylib', link: library },
      ])
      expect(readFileSync(library, 'utf8')).toBe('theirs')
      expect(status).not.toBe(0)
      expect(stderr).toContain('Frameworks/lib.dylib points outside its app')
      expect(signed).toEqual([])
      expect(existsSync(output)).toBe(false)
    })

    test('an app that is itself a link is not signed', () => {
      const folder = outside()
      writeFileSync(join(folder, 'Info.plist'), plist())
      const { status, stderr, signed } = run([
        { name: 'Payload/' },
        { name: 'Payload/RChat.app', link: folder },
      ])
      expect(existsSync(join(folder, '_CodeSignature'))).toBe(false)
      expect(status).not.toBe(0)
      expect(stderr).toContain('points outside its app')
      expect(signed).toEqual([])
    })

    test('relative links out of the app are refused, also through another link', () => {
      refused([...app(), { name: 'Payload/RChat.app/up', link: '../..' }], 'points outside its app')
      refused(
        [
          ...app(),
          { name: 'Payload/RChat.app/a/b/top', link: '..' },
          { name: 'Payload/RChat.app/far', link: 'a/b/top/../..' },
        ],
        'far points outside its app'
      )
    })

    test('links inside the app pass, also through another link', () => {
      const { status, output } = run([
        ...app(),
        { name: 'Payload/RChat.app/a/b/top', link: '..' },
        { name: 'Payload/RChat.app/again', link: 'a/b/top/../Assets.car' },
      ])
      expect(status).toBe(0)
      const files = unzip(output)
      const at = (name: string) => files.find(file => file.name === `Payload/RChat.app/${name}`)
      expect(at('a/b/top')).toMatchObject({ link: true, data: '..' })
      expect(at('again')).toMatchObject({ link: true, data: 'a/b/top/../Assets.car' })
    })
  })

  // The generated Info.plist is the app's Info.ios.plist plus what Xcode adds from the config.
  test("the app's own plist and config pass the check", () => {
    const read = (path: string) => readFileSync(join(root, 'apps/desktop/src-tauri', path), 'utf8')
    const minimum = JSON.parse(read('tauri.conf.json')).bundle.iOS.minimumSystemVersion
    const info = read('Info.ios.plist').replace(
      /<\/dict>\s*<\/plist>\s*$/,
      `<key>CFBundleShortVersionString</key><string>0.4.0</string>
<key>CFBundleVersion</key><string>0.4.0</string>
<key>MinimumOSVersion</key><string>${minimum}</string></dict></plist>`
    )
    const { status, stderr } = run(app(info))
    expect(stderr).toBe('')
    expect(status).toBe(0)
  })
})
