import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const flags = (env: Record<string, string>) => {
  const out = spawnSync('bash', [join(import.meta.dir, 'ci-flags.sh')], {
    env: { PATH: process.env.PATH ?? '', EVENT: 'push', REF: 'refs/heads/main', ...env },
    encoding: 'utf8',
  })
  expect(out.status).toBe(0)
  return Object.fromEntries(
    out.stdout
      .trim()
      .split('\n')
      .map(line => line.split('='))
  )
}

const all = { desktop: 'true', mobile: 'true', docker: 'true', e2e: 'true' }

describe('ci flags', () => {
  test('no tags: everything runs', () => {
    expect(flags({ MESSAGE: 'Fix the composer' })).toEqual(all)
  })

  test('each tag skips its part', () => {
    expect(flags({ MESSAGE: 'Docs [skip mobile]' })).toEqual({ ...all, mobile: 'false' })
    expect(flags({ MESSAGE: 'x [skip docker]' })).toEqual({ ...all, docker: 'false' })
    expect(flags({ MESSAGE: 'x [skip e2e]' })).toEqual({ ...all, e2e: 'false' })
  })

  test('skip desktop also skips the smoke run', () => {
    expect(flags({ MESSAGE: 'x [Skip Desktop]' })).toEqual({
      ...all,
      desktop: 'false',
      e2e: 'false',
    })
  })

  test('skip native is desktop and mobile', () => {
    expect(flags({ MESSAGE: 'Title\n\nBody [skip native]' })).toEqual({
      ...all,
      desktop: 'false',
      mobile: 'false',
      e2e: 'false',
    })
  })

  test('ci light keeps only the fast checks', () => {
    expect(flags({ MESSAGE: '[ci light] typo' })).toEqual({
      desktop: 'false',
      mobile: 'false',
      docker: 'false',
      e2e: 'false',
    })
  })

  test('tags without brackets are not flags', () => {
    expect(flags({ MESSAGE: 'Explain skip docker in the README' })).toEqual(all)
  })

  test('labels work like tags, whole names only', () => {
    expect(flags({ LABELS: 'bug, skip docker' })).toEqual({ ...all, docker: 'false' })
    expect(flags({ LABELS: 'ci light' })).toEqual({
      desktop: 'false',
      mobile: 'false',
      docker: 'false',
      e2e: 'false',
    })
    expect(flags({ LABELS: 'do not skip docker' })).toEqual(all)
  })

  test('a push that does not touch the mobile sources skips mobile', () => {
    expect(flags({ MESSAGE: 'x', CHANGED: 'src/db.rs\ndeploy/k8s/relay.yaml' })).toEqual({
      ...all,
      mobile: 'false',
    })
    expect(flags({ MESSAGE: 'x', CHANGED: 'src/db.rs\napps/web/app/page.tsx' })).toEqual(all)
    expect(flags({ MESSAGE: 'x', CHANGED: 'Cargo.lock' })).toEqual(all)
    expect(flags({ MESSAGE: 'x', CHANGED: 'crates/profanity/src/lib.rs' })).toEqual(all)
    expect(flags({ MESSAGE: 'x' })).toEqual(all)
    expect(flags({ EVENT: 'workflow_dispatch', CHANGED: 'src/db.rs' })).toEqual(all)
    expect(flags({ EVENT: 'pull_request', CHANGED: 'src/db.rs' })).toEqual(all)
  })

  test('ignored for version tags, the schedule and manual runs', () => {
    expect(flags({ REF: 'refs/tags/0.3.0', MESSAGE: '[ci light]' })).toEqual(all)
    expect(flags({ EVENT: 'schedule', MESSAGE: '[skip native]' })).toEqual(all)
    expect(flags({ EVENT: 'workflow_dispatch', LABELS: 'skip docker' })).toEqual(all)
  })
})
