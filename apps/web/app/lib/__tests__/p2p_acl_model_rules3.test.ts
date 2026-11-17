import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importsOf } from './import_graph'

// The rules-3 model (acl_model_rules3/) is a test reference: only tests load it.

const WEB = fileURLToPath(new URL('../../../', import.meta.url))
const TESTS = 'app/lib/__tests__/'
const MODEL = `${TESTS}acl_model_rules3/`

const sources = (dir: string): string[] =>
  readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap(e => {
    const p = `${dir}/${e.name}`
    if (e.isDirectory())
      return e.name === 'node_modules' || e.name.startsWith('.') ? [] : sources(p)
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : []
  })

const all = [...sources('app'), ...sources('scripts')]

test('the model copy is all there', () => {
  const files = readdirSync(join(WEB, MODEL))
  expect(files.filter(f => f.endsWith('.ts')).length).toBe(23)
  expect(readdirSync(join(WEB, MODEL, 'fixtures')).length).toBe(22)
  for (const f of files.filter(f => f.endsWith('.ts')))
    expect(readFileSync(join(WEB, MODEL, f), 'utf8').startsWith('/* eslint-disable */\n')).toBe(
      true
    )
}, 120_000)

test('no file of the app or its scripts loads the rules-3 model', () => {
  const app = all.filter(f => !f.startsWith(TESTS))
  expect(app.length).toBeGreaterThan(300)
  const loads = app.filter(f =>
    [...importsOf(`apps/web/${f}`)].some(p => relative('apps/web', p).startsWith(MODEL))
  )
  expect(loads).toEqual([])
}, 120_000)

test('outside the copy, only test files name it', () => {
  const naming = all.filter(
    f => !f.startsWith(MODEL) && readFileSync(join(WEB, f), 'utf8').includes('acl_model_rules3')
  )
  expect(naming.filter(f => !f.startsWith(TESTS))).toEqual([])
}, 120_000)
