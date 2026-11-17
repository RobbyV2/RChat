import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('../../', import.meta.url))

type Sources = Record<string, string>

const read = (f: string) => readFileSync(`${APP}${f}`, 'utf8')

let tree: Sources | null = null
const app = (): Sources =>
  (tree ??= Object.fromEntries(
    readdirSync(APP, { recursive: true, encoding: 'utf8' })
      .filter(f => /\.tsx?$/.test(f) && !f.includes('__tests__'))
      .sort()
      .map(f => [f, read(f)])
  ))

// Menus come from the registry (app/lib/actions/): a component opens one with openActionMenu or
// openChoiceMenu. Outside the menu's own files nothing names the opener or puts a menu into the
// store, and nothing outside the registry names the row type.
const MENU = [
  'components/context_menu.tsx',
  'lib/actions/menu.ts',
  'lib/slices/ui.ts',
  'lib/store_types.ts',
]

const count = (src: string, re: RegExp) => src.match(re)?.length ?? 0

const drift = (sources: Sources): string[] =>
  Object.entries(sources).flatMap(([f, src]) => {
    if (MENU.includes(f)) return []
    const opens = count(src, /\bopenContextMenu\b/g)
    const calls = count(src, /\bopenContextMenu\(/g)
    const rows = f.startsWith('lib/actions/') ? 0 : count(src, /\bContextMenuItem\b/g)
    const sets = count(src, /(?<![.\w])contextMenu\b(?!\s*:\s*null\b)/g)
    return opens === 0 && rows === 0 && sets === 0
      ? []
      : [
          `${f}: openContextMenu ${opens} (called ${calls}), ContextMenuItem ${rows}, contextMenu set ${sets}`,
        ]
  })

const HEADER = 'components/message_pane.tsx'
const GUEST = 'components/guest_voice_menu.tsx'
const OPEN = 'st.openContextMenu(0, 0, [{ label: "A" }])'

test('no file builds or opens a menu by hand', () => {
  const src = app()
  expect(Object.keys(src).filter(f => f.startsWith('components/')).length).toBeGreaterThan(50)
  expect(Object.keys(src).filter(f => f.startsWith('lib/')).length).toBeGreaterThan(200)
  expect(drift(src)).toEqual([])
}, 60_000)

test('every P2P component is free of hand-built menus', () => {
  const files = Object.entries(app()).filter(([f]) => f.startsWith('components/p2p/'))
  expect(files.length).toBeGreaterThan(15)
  for (const [f, src] of files)
    expect([f, /openContextMenu|ContextMenuItem|(?<![.\w])contextMenu\b/.test(src)]).toEqual([
      f,
      false,
    ])
}, 60_000)

test('a hand-built menu in a component is drift', () => {
  expect(drift({ 'components/p2p/x.tsx': OPEN })).toEqual([
    'components/p2p/x.tsx: openContextMenu 1 (called 1), ContextMenuItem 0, contextMenu set 0',
  ])
  expect(drift({ 'components/x.tsx': 'const items: ContextMenuItem[] = []' })).toHaveLength(1)
  expect(
    drift({ 'components/x.tsx': 'const open = useStore(s => s.openContextMenu)' })
  ).toHaveLength(1)
  expect(drift({ 'components/x.tsx': 'openActionMenu(0, 0, { kind: "home" })' })).toEqual([])
})

test('a menu put into the store without the opener is drift', () => {
  const set = 'set({ contextMenu: { x: 0, y: 0, items } })'
  expect(drift({ 'components/p2p/x.tsx': set })).toHaveLength(1)
  expect(drift({ 'components/x.tsx': 'set({ contextMenu })' })).toHaveLength(1)
  expect(drift({ 'components/x.tsx': 'set({ contextMenu: null })' })).toEqual([])
  expect(drift({ 'components/x.tsx': 'const menu = useStore(s => s.contextMenu)' })).toEqual([])
})

test('the channel header and the guest voice menu open theirs from the registry', () => {
  for (const f of [HEADER, GUEST]) {
    const src = read(f)
    expect([f, src.includes('openActionMenu(')]).toEqual([f, true])
    expect(drift({ [f]: src })).toEqual([])
    expect(drift({ [f]: `${src}\n${OPEN}` })).toHaveLength(1)
    expect(drift({ [f]: `${src}\nconst open = useStore(s => s.openContextMenu)` })).toHaveLength(1)
    expect(drift({ [f]: `${src}\nconst more: ContextMenuItem[] = []` })).toHaveLength(1)
  }
})

test('a menu opened from app/lib outside the registry is drift', () => {
  expect(drift({ 'lib/p2p/x.ts': OPEN })).toHaveLength(1)
  expect(drift({ 'lib/actions/p2p_chat.ts': OPEN })).toHaveLength(1)
  expect(drift({ 'lib/p2p/x.ts': 'set({ contextMenu: menu })' })).toHaveLength(1)
  expect(drift({ 'lib/p2p/x.ts': 'const items: ContextMenuItem[] = []' })).toHaveLength(1)
  expect(drift({ 'lib/actions/x.ts': 'const items: ContextMenuItem[] = []' })).toEqual([])
  expect(drift({ 'lib/slices/x.ts': 'set({ contextMenu: null })' })).toEqual([])
})
