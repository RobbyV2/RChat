import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { Copy, Download, FileCode, Image, Link, Play, X } from 'lucide-react'
import { ctxFor, paletteCtx, refreshCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems, openActionMenu } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { allActions } from '../actions/registry'
import type { Target } from '../actions/types'
import { fileTarget, type FileMenu } from '../file_card'
import { setSharing, sharing } from '../platform'
import { resetSessionCaches, useStore } from '../store'
import { drain } from './fixtures'

const realSharing = sharing()

beforeAll(registerAppActions)
afterEach(() => {
  setSharing(realSharing)
  useStore.setState({ contextMenu: null, toast: null })
})
afterAll(resetSessionCaches)

const items = (t: Target) => menuItems(ctxFor(useStore.getState(), t, 'menu'))
const labels = (t: Target) => items(t).map(i => i.label)
const row = (t: Target, label: string) => items(t).find(i => i.label === label)

const copied = () => {
  const out: string[] = []
  setSharing({ ...realSharing, copyText: async t => (out.push(t), true) })
  return out
}

const LINK = 'https://chat.example/api/media/f1'

const card = (over: Partial<FileMenu> = {}): FileMenu => ({
  name: 'a.zip',
  verb: 'Download',
  download: () => {},
  cancel: null,
  extra: [],
  link: null,
  ...over,
})

const fixed = (menu: FileMenu) => fileTarget(() => menu)

test('a hosted file offers Download, Copy link and Copy file name', () => {
  let runs = 0
  const t = fixed(card({ name: 'report.pdf', download: () => runs++, link: LINK }))
  expect(labels(t)).toEqual(['Download', 'Copy link', 'Copy file name'])
  expect(items(t).map(i => i.icon)).toEqual([Download, Link, Copy])
  items(t)[0].action?.()
  expect(runs).toBe(1)
})

test('a P2P file has no link; one on the device is saved', () => {
  let saves = 0
  const t = fixed(card({ name: 'clip.mp4', verb: 'Save', download: () => saves++ }))
  expect(labels(t)).toEqual(['Save', 'Copy file name'])
  items(t)[0].action?.()
  expect(saves).toBe(1)
})

test('without a download to start, only the name is offered', () => {
  expect(labels(fixed(card({ download: null })))).toEqual(['Copy file name'])
  expect(labels(fixed(card({ download: null, link: LINK })))).toEqual([
    'Copy link',
    'Copy file name',
  ])
})

test('while a download runs, Cancel download is in the place of Download', () => {
  let stops = 0
  const t = fixed(card({ download: null, cancel: () => stops++ }))
  expect(labels(t)).toEqual(['Cancel download', 'Copy file name'])
  expect(items(t)[0].icon).toBe(X)
  items(t)[0].action?.()
  expect(stops).toBe(1)
})

test("the card's own buttons follow its main one, in the card's order", () => {
  const ran: string[] = []
  const extra = (kind: 'image' | 'preview' | 'audio' | 'video') => ({
    kind,
    run: () => void ran.push(kind),
  })
  const t = fixed(card({ extra: [extra('image'), extra('preview'), extra('audio')] }))
  expect(labels(t)).toEqual([
    'Download',
    'Show image',
    'Show preview',
    'Play audio',
    'Copy file name',
  ])
  expect(items(t).map(i => i.icon)).toEqual([Download, Image, FileCode, Play, Copy])
  for (const label of ['Show image', 'Show preview', 'Play audio']) row(t, label)?.action?.()
  expect(ran).toEqual(['image', 'preview', 'audio'])
  expect(labels(fixed(card({ extra: [extra('video')] })))).toEqual([
    'Download',
    'Play video',
    'Copy file name',
  ])
})

test('the copies go through the platform clipboard, the name as shown', async () => {
  const out = copied()
  const t = fixed(card({ name: '****.zip', link: LINK }))
  for (const label of ['Copy link', 'Copy file name']) row(t, label)?.action?.()
  await drain()
  expect(out).toEqual([LINK, '****.zip'])
})

test("a card's menu opens at the pointer and keeps its target while the card is there", () => {
  let now: FileMenu | null = card()
  const t = fileTarget(() => now)
  openActionMenu(7, 8, t)
  const menu = useStore.getState().contextMenu
  expect([menu?.x, menu?.y, menu?.items.map(i => i.label)]).toEqual([
    7,
    8,
    ['Download', 'Copy file name'],
  ])
  const ctx = ctxFor(useStore.getState(), t, 'menu')
  expect(refreshCtx(ctx)?.target).toBe(t)
  expect([ctx.member, ctx.message]).toEqual([null, null])
  now = null
  expect(refreshCtx(ctx)).toBeNull()
})

test('a row runs on the card as it is when it runs', () => {
  const ran: string[] = []
  let now: FileMenu | null = card({ download: () => void ran.push('get') })
  const t = fileTarget(() => now)
  const download = items(t)[0]
  now = card({ verb: 'Save', download: () => void ran.push('save') })
  download.action?.()
  expect(ran).toEqual(['save'])
})

test('a row left open across a finished download or a removed file does nothing', () => {
  const ran: string[] = []
  let now: FileMenu | null = card({ download: null, cancel: () => void ran.push('cancel') })
  const t = fileTarget(() => now)
  const cancel = items(t)[0]
  now = card({ verb: 'Save', download: () => void ran.push('save') })
  cancel.action?.()
  expect(ran).toEqual([])
  expect(useStore.getState().toast?.text).toBe("That's no longer available")
  useStore.setState({ toast: null })
  const name = row(t, 'Copy file name')!
  now = null
  name.action?.()
  expect(ran).toEqual([])
  expect(useStore.getState().toast?.text).toBe("That's no longer available")
})

test('file actions are message scope, join only file cards and stay out of the palette', () => {
  const file = allActions().filter(a => a.id.startsWith('file_'))
  expect(file.map(a => a.id)).toEqual([
    'file_download',
    'file_cancel',
    'file_show_image',
    'file_show_preview',
    'file_play_audio',
    'file_play_video',
    'file_copy_link',
    'file_copy_name',
  ])
  for (const a of file) expect([a.id, a.scope, a.targets]).toEqual([a.id, 'message', ['file']])
  const ids = new Set(paletteCommands(paletteCtx(useStore.getState())).map(r => r.id))
  expect(file.filter(a => ids.has(a.id))).toEqual([])
})
