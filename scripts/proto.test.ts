import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

setDefaultTimeout(120_000)

const root = join(import.meta.dir, '..')
const proto = join(root, 'proto')
const pkg = join(proto, 'rchat/fed/v1')
const baselines = join(proto, 'baseline')

// The buf launcher is a script with a node shebang; bun runs it, so node isn't needed.
const buf = (args: string[], cwd = proto) => {
  const run = Bun.spawnSync(
    [process.execPath, join(root, 'node_modules/@bufbuild/buf/bin/buf'), ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' }
  )
  return { code: run.exitCode, out: `${run.stdout}${run.stderr}` }
}

const scratch = <T>(use: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'rchat-proto-'))
  try {
    return use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

// The first version of the schema: the reference models' files, byte for byte.
const FIRST_VERSION: Record<string, string> = {
  'call.proto': '62df988f655cb28aa04b42bb44e39488d83a643a8d167d59d9c4719aa16300c4',
  'directory.proto': '53909635828190d56d3bf0878a97b7fa9bc66d66465ac3e773bdb3e7b86dfadf',
  'instance.proto': 'b4f651db31969aa547373a2db2cccdae27dea565a825a3f96082c4a99d5a2ceb',
  'invites.proto': 'b30727bcce837aadf3a6df0255f65c4be96ce39a42603204ea92432a240182ac',
  'letters.proto': '3701ba56a346eed3af45149d21094fc07afbc16728d54691fd9b34d3958ef250',
  'profiles.proto': '7d3bfd81f413bd6c5dfe5c402075ff7817feab8c19f23f3883899ffa9a2e589c',
  'reports.proto': '74142ca39cee47088f0f216696a74bd29baa6b1b26f7ebdabc1768e1e08e0e74',
}

const SERVICES: Record<string, string[]> = {
  AppsService: [],
  DirectoryService: ['Search'],
  InstanceService: ['Hello'],
  InvitesService: ['Preview', 'Icon'],
  LettersService: ['Deliver', 'PutObjects', 'Pull', 'PullFile', 'GetKey'],
  ProfilesService: ['Get', 'Avatar'],
  ReportsService: ['Forward'],
}

type Image = {
  file: {
    name: string
    package: string
    syntax?: string
    service?: { name: string; method?: { name: string }[] }[]
  }[]
}

const image = (): Image =>
  scratch(dir => {
    const out = join(dir, 'image.json')
    const built = buf(['build', '-o', out])
    expect(built).toEqual({ code: 0, out: '' })
    return JSON.parse(readFileSync(out, 'utf8')) as Image
  })

describe('instance protocol schema', () => {
  test('the workspace holds the schema files and nothing else', () => {
    expect(readdirSync(proto).sort()).toEqual(
      [...(existsSync(baselines) ? ['baseline'] : []), 'buf.gen.yaml', 'buf.yaml', 'rchat'].sort()
    )
    expect(readdirSync(pkg).sort()).toEqual(['apps.proto', ...Object.keys(FIRST_VERSION)].sort())
  })

  test('buf lint passes with the STANDARD rules', () => {
    expect(readFileSync(join(proto, 'buf.yaml'), 'utf8')).toContain('STANDARD')
    expect(buf(['lint'])).toEqual({ code: 0, out: '' })
  })

  test('buf lint is on: a service not named *Service fails', () => {
    scratch(dir => {
      cpSync(proto, dir, { recursive: true })
      const file = join(dir, 'rchat/fed/v1/apps.proto')
      writeFileSync(file, readFileSync(file, 'utf8').replace('service AppsService', 'service Apps'))
      const run = buf(['lint'], dir)
      expect(run.code).not.toBe(0)
      expect(run.out).toContain('should be suffixed with "Service"')
    })
  })

  test('every file is proto3 in package rchat.fed.v1', () => {
    for (const file of image().file) {
      expect({ name: file.name, package: file.package, syntax: file.syntax }).toEqual({
        name: file.name,
        package: 'rchat.fed.v1',
        syntax: 'proto3',
      })
    }
  })

  test('the services and their methods, with the apps slot reserved and empty', () => {
    const services = Object.fromEntries(
      image()
        .file.flatMap(file => file.service ?? [])
        .map(service => [service.name, (service.method ?? []).map(method => method.name)])
    )
    expect(services).toEqual(SERVICES)
  })

  test('buf breaking follows the evolution rules: a field is added freely, removed only with its number and name reserved, and never renumbered or retyped', () => {
    scratch(dir => {
      const before = join(dir, 'before.binpb')
      expect(buf(['build', '-o', before])).toEqual({ code: 0, out: '' })
      const copy = join(dir, 'proto')
      cpSync(proto, copy, { recursive: true })
      const file = join(copy, 'rchat/fed/v1/call.proto')
      const text = readFileSync(file, 'utf8')
      const STAMP = '  bytes stamp = 12;\n'
      expect(text).toContain(STAMP)
      const change = (from: string, to: string) => {
        writeFileSync(file, text.replace(from, to))
        return buf(['breaking', '--against', before], copy)
      }
      const taken = { code: 0, out: '' }

      expect(change(STAMP, `${STAMP}  bytes added = 13;\n`)).toEqual(taken)
      expect(change(STAMP, '  reserved 12;\n  reserved "stamp";\n')).toEqual(taken)

      const refused: [string, string, string][] = [
        ['removed with nothing reserved', '', 'stamp'],
        ['removed with only the number reserved', '  reserved 12;\n', 'without reserving the name'],
        [
          'removed with only the name reserved',
          '  reserved "stamp";\n',
          'without reserving the number',
        ],
        ['renumbered', '  bytes stamp = 13;\n', 'stamp'],
        ['retyped', '  string stamp = 12;\n', 'stamp'],
        ['renamed', '  bytes stamps = 12;\n', 'stamp'],
        ['made repeated', '  repeated bytes stamp = 12;\n', 'stamp'],
      ]
      for (const [what, to, says] of refused) {
        const run = change(STAMP, to)
        expect({ what, refused: run.code !== 0, says: run.out.includes(says) }).toEqual({
          what,
          refused: true,
          says: true,
        })
      }
    })
    const rules = readFileSync(join(proto, 'buf.yaml'), 'utf8')
    expect(rules.slice(rules.indexOf('breaking:'))).toBe(
      [
        'breaking:',
        '  use:',
        '    - FILE',
        '    - FIELD_NO_DELETE_UNLESS_NUMBER_RESERVED',
        '    - FIELD_NO_DELETE_UNLESS_NAME_RESERVED',
        '  except:',
        '    - FIELD_NO_DELETE',
        '',
      ].join('\n')
    )
  })
})

// Until a release commits its image, the schema is held to its first version by hash. From then
// on, `buf breaking` against every committed image governs it.
if (existsSync(baselines)) {
  describe('against the release baselines', () => {
    const images = readdirSync(baselines).filter(name => name.endsWith('.binpb'))
    test('the baseline folder holds at least one image', () => {
      expect(images.length).toBeGreaterThan(0)
    })
    for (const name of images) {
      test(`nothing breaks ${name}`, () => {
        expect(buf(['breaking', '--against', join(baselines, name)])).toEqual({ code: 0, out: '' })
      })
    }
  })
} else {
  describe('before the first release baseline', () => {
    for (const [name, hash] of Object.entries(FIRST_VERSION)) {
      test(`${name} is the reference model's file`, () => {
        expect(sha256(join(pkg, name))).toBe(hash)
      })
    }
  })
}
