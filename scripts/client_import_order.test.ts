import { expect, test } from 'bun:test'
import { join } from 'node:path'

const web = join(import.meta.dir, '..', 'apps', 'web')

// A test file that loads the instance registry before anything else loads the client runs on its
// own without a temporal dead zone: the client's module code builds a registry while it loads.
test('the instance registry loads first in a fresh process', () => {
  const run = Bun.spawnSync(['bun', 'test', 'app/lib/__tests__/api_version.test.ts'], {
    cwd: web,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = run.stdout.toString() + run.stderr.toString()
  expect(out).not.toContain('before initialization')
  expect(run.exitCode).toBe(0)
}, 120000)
