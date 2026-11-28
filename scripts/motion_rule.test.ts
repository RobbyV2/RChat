import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

const found = async (file: string, code: string, rule: string) => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, {
    filePath: join(root, file),
  })
  return result.messages.filter(m => m.ruleId === rule).length
}
const syntax = (code: string, file = 'apps/web/app/components/x.tsx') =>
  found(file, code, 'no-restricted-syntax')

test('only the motion engine starts an animation', async () => {
  const raw = 'export const x = (el: HTMLElement) => el.animate([], 100)\n'
  const read = 'export const x = (el: HTMLElement) => el.getAnimations()\n'
  const slot =
    "import { plays } from '../lib/motion/play'\nexport const X = () => <div ref={plays('dialog')} />\n"
  expect(await syntax(raw)).toBe(1)
  expect(await syntax(read)).toBe(1)
  expect(await syntax(raw, 'apps/web/app/lib/x.ts')).toBe(1)
  expect(await syntax(raw, 'apps/web/app/components/p2p/x.tsx')).toBe(1)
  expect(await syntax(raw, 'apps/web/app/lib/motion/engine.ts')).toBe(0)
  expect(await syntax(slot)).toBe(0)
}, 60_000)

test('a keyframe class is written only in the motion folder', async () => {
  const plain = 'export const X = () => <i className="size-4 animate-spin" />\n'
  const variant = 'export const X = () => <i className="motion-safe:animate-pulse" />\n'
  const template = 'export const x = (on: boolean) => `size-4 ${on ? "" : "x"} animate-ring`\n'
  const named =
    "import { FUNCTIONAL } from '../lib/motion/functional'\nexport const X = () => <i className={FUNCTIONAL.spin} />\n"
  const token = "export const x = ['--animate-', 'animated']\n"
  expect(await syntax(plain)).toBe(1)
  expect(await syntax(variant)).toBe(1)
  expect(await syntax(template)).toBe(1)
  expect(await syntax("export const x = 'size-4 animate-spin'\n", 'apps/web/app/lib/x.ts')).toBe(1)
  expect(await syntax(named)).toBe(0)
  expect(await syntax(token, 'apps/web/app/lib/x.ts')).toBe(0)
  expect(await syntax("export const x = 'animate-spin'\n", 'apps/web/app/lib/motion/x.ts')).toBe(0)
}, 60_000)

test('the mark of a slot the style sheet moves comes from the slot helper', async () => {
  const attr = 'export const X = () => <div data-motion="press" />\n'
  const spread = "export const X = () => <div {...{ 'data-motion': 'press' }} />\n"
  const none = 'export const X = () => <div data-motion-none="" />\n'
  const helper =
    "import { look } from '../lib/motion/play'\nexport const X = () => <div {...look('press')} />\n"
  expect(await syntax(attr)).toBe(1)
  expect(await syntax(spread)).toBe(1)
  expect(await syntax(none)).toBe(1)
  expect(await syntax(helper)).toBe(0)
}, 60_000)

test('only the motion folder reaches the engine', async () => {
  const imports = (code: string, file: string) => found(file, code, 'no-restricted-imports')
  const wire = "import { setLive } from '../lib/motion/wire'\nexport const x = setLive\n"
  const engine = "import { Engine } from './motion/engine'\nexport const x = Engine\n"
  const inside = "import { setLive } from './wire'\nexport const x = setLive\n"
  const play = "import { plays } from '../lib/motion/play'\nexport const x = plays\n"
  expect(await imports(wire, 'apps/web/app/components/x.tsx')).toBe(1)
  expect(await imports(wire, 'apps/web/app/components/p2p/x.tsx')).toBe(1)
  expect(await imports(engine, 'apps/web/app/lib/x.ts')).toBe(1)
  expect(await imports(inside, 'apps/web/app/lib/motion/x.ts')).toBe(0)
  expect(await imports(play, 'apps/web/app/components/x.tsx')).toBe(0)
}, 60_000)
