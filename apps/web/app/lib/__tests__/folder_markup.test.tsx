import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextMenu } from '../../components/context_menu'
import { FolderDialog } from '../../components/folder_dialog'
import { P2pFolderDialog } from '../../components/p2p/p2p_invite_dialog'
import { P2pFolderEntry } from '../../components/p2p/p2p_server_view'
import { FolderEntry } from '../../components/server_rail'
import { FOLDER_PRESETS } from '../folder_colors'
import { emptyLayout, type Folder } from '../nav_layout'
import { useP2p } from '../p2p/app'
import type { ServerView } from '../p2p/server/types'
import { resetSessionCaches, useStore } from '../store'
import { me } from './fixtures'

// Server rendering reads the stores' initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setState = (patch: Partial<typeof initial>) => {
  useStore.setState(patch)
  Object.assign(initial, useStore.getState())
}
const p2pInitial = useP2p.getInitialState()
const p2pSaved = { ...p2pInitial }
const setP2p = (patch: Partial<typeof p2pInitial>) => {
  useP2p.setState(patch)
  Object.assign(p2pInitial, useP2p.getState())
}

afterEach(() => {
  setState({ theme: saved.theme, contextMenu: null, activeDialog: null, layout: emptyLayout })
  setP2p({ layout: emptyLayout, dialog: null })
})

afterAll(() => {
  Object.assign(initial, saved)
  Object.assign(p2pInitial, p2pSaved)
  resetSessionCaches()
})

const F = (over: Partial<Folder> = {}): Folder => ({
  id: 'f1',
  name: 'Games',
  servers: ['a', 'b'],
  open: false,
  ...over,
})
const servers = ['a', 'b'].map(name => ({ name, display_name: name, creator: null }))
const rooms = ['A'.repeat(43), 'B'.repeat(43)].map(
  (id, i) => ({ id, name: `room${i}`, channels: [], chans: {} }) as unknown as ServerView
)
const DARK_RED =
  '--folder-icon:#ffb1b1;--folder-on-icon:#670000;--folder-group:#443136;--folder-tile:#4d383c;--folder-hover:#65484c;--folder-drop:#614549'
const LIGHT_RED =
  '--folder-icon:#b30000;--folder-on-icon:#ffefef;--folder-group:#eec7c7;--folder-tile:#ebbdbd;--folder-hover:#e4a3a3;--folder-drop:#e5a8a8'
const tagWith = (html: string, cls: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`))?.[0] ?? ''

describe('rail folder markup', () => {
  test('a closed folder without a color has no inline folder colors', () => {
    setState({ me: me('alice'), theme: 'dark' })
    const html = renderToStaticMarkup(<FolderEntry folder={F()} servers={servers} at={0} />)
    expect(html).not.toContain('--folder-')
    expect(tagWith(html, 'folder-tile')).toContain('<button')
    expect(tagWith(html, 'folder-badge')).toContain('<span')
    expect(html).not.toContain('bg-primary text-on-primary')
  })

  test('a closed colored folder carries the dark colors of its pick on the tile', () => {
    setState({ me: me('alice'), theme: 'dark' })
    const html = renderToStaticMarkup(
      <FolderEntry folder={F({ color: '#ff0000' })} servers={servers} at={0} />
    )
    expect(tagWith(html, 'folder-tile')).toContain(`style="${DARK_RED}"`)
    expect(tagWith(html, 'folder-badge')).not.toContain('style=')
  })

  test('an open colored folder carries the light colors on the group and its icon follows', () => {
    setState({ me: me('alice'), theme: 'light' })
    const html = renderToStaticMarkup(
      <FolderEntry folder={F({ color: '#ff0000', open: true })} servers={servers} at={0} />
    )
    expect(tagWith(html, 'folder-group')).toContain(`style="${LIGHT_RED}"`)
    const header = tagWith(html, 'folder-icon')
    expect(header).toContain('aria-expanded="true"')
    expect(header).not.toContain('text-primary')
  })

  test('an open folder without a color keeps the stylesheet defaults', () => {
    setState({ me: me('alice'), theme: 'light' })
    const html = renderToStaticMarkup(
      <FolderEntry folder={F({ open: true })} servers={servers} at={0} />
    )
    expect(html).not.toContain('--folder-')
    expect(tagWith(html, 'folder-icon')).toContain('<button')
  })

  test('a P2P folder takes the color and keeps its dashed P2P border', () => {
    setState({ me: me('alice'), theme: 'dark' })
    const closed = renderToStaticMarkup(
      <P2pFolderEntry folder={F({ color: '#ff0000' })} list={rooms} at={0} />
    )
    const tile = tagWith(closed, 'folder-tile')
    expect(tile).toContain(`style="${DARK_RED}"`)
    expect(tile).toContain('border-dashed border-tertiary')
    expect(closed).toContain('bg-(--folder-icon,var(--color-tertiary))')
    expect(closed).toContain('text-(--folder-on-icon,var(--color-on-tertiary))')
    const open = renderToStaticMarkup(
      <P2pFolderEntry folder={F({ color: '#ff0000', open: true })} list={rooms} at={0} />
    )
    expect(tagWith(open, 'folder-group')).toContain(`style="${DARK_RED}"`)
    expect(open).toContain('text-(--folder-icon,var(--color-tertiary))')
    const plain = renderToStaticMarkup(<P2pFolderEntry folder={F()} list={rooms} at={0} />)
    expect(plain).not.toContain('--folder-icon:')
  })
})

describe('menu swatches', () => {
  test('a row with a swatch shows a dot of that color before its label', () => {
    setState({
      contextMenu: {
        x: 10,
        y: 10,
        items: [
          { label: 'Blue', swatch: '#3b82d9', radio: true, checked: true, action: () => {} },
          { label: 'Default', radio: true, checked: false, action: () => {} },
        ],
      },
    })
    const html = renderToStaticMarkup(<ContextMenu />)
    const [blue = '', plain = ''] = html.match(/<button[^>]*data-menu-item.*?<\/button>/g) ?? []
    expect(blue).toContain('data-swatch="#3b82d9"')
    expect(blue).toContain('background:#3b82d9')
    expect(blue.indexOf('data-swatch')).toBeLessThan(blue.indexOf('Blue'))
    expect(blue).toContain('aria-checked="true"')
    expect(plain).toContain('Default')
    expect(plain).not.toContain('data-swatch')
    expect(plain).toContain('<span aria-hidden="true" class="shrink-0" style="width:16px"></span>')
  })
})

describe('folder dialog markup', () => {
  const layout = (folder: Folder) => ({ ...emptyLayout, servers: ['x', folder] })

  test('the folder dialog has the name, the swatches, a custom color and the default', () => {
    setState({
      me: me('alice'),
      theme: 'dark',
      layout: layout(F()),
      activeDialog: { kind: 'rename_folder', id: 'f1' },
    })
    const html = renderToStaticMarkup(<FolderDialog />)
    expect(html).toContain('aria-label="Folder name"')
    expect(html).toContain('role="group" aria-label="Folder color"')
    for (const p of FOLDER_PRESETS) expect(html).toContain(`aria-label="Folder color: ${p.label}"`)
    expect(html).toContain('aria-label="Folder color: custom color"')
    expect(html).toContain('>Default<')
    expect(html).not.toContain('aria-pressed="true"')
    expect(html).not.toContain('style="--folder-')
    expect(/<input[^>]*autofocus[^>]*aria-label="Folder name"/.test(html)).toBe(true)
  })

  test('opened for its color, the dialog does not put the caret in the name', () => {
    setState({
      me: me('alice'),
      theme: 'dark',
      layout: layout(F()),
      activeDialog: { kind: 'rename_folder', id: 'f1', focus: 'color' },
    })
    const html = renderToStaticMarkup(<FolderDialog />)
    expect(html).toContain('aria-label="Folder name"')
    expect(html).not.toContain('autofocus')
  })

  test('a colored folder opens with its swatch pressed, a reset and a preview in its colors', () => {
    setState({
      me: me('alice'),
      theme: 'dark',
      layout: layout(F({ color: '#d9483b' })),
      activeDialog: { kind: 'rename_folder', id: 'f1' },
    })
    const html = renderToStaticMarkup(<FolderDialog />)
    const pressed = html.match(/<button[^>]*aria-pressed="true"[^>]*>/g) ?? []
    expect(pressed).toHaveLength(1)
    expect(pressed[0]).toContain('aria-label="Folder color: Red"')
    expect(html).toContain('Use default')
    expect(tagWith(html, 'folder-group')).toContain('--folder-icon:#ffb2ab')
  })

  test('a folder that is gone renders no dialog', () => {
    setState({ layout: emptyLayout, activeDialog: { kind: 'rename_folder', id: 'f1' } })
    expect(renderToStaticMarkup(<FolderDialog />)).toBe('')
  })

  test('the P2P folder dialog has the same color field', () => {
    setState({ me: me('alice'), theme: 'light' })
    setP2p({ layout: layout(F({ id: 'p1', color: '#3b82d9' })) })
    const html = renderToStaticMarkup(<P2pFolderDialog id="p1" />)
    expect(html).toContain('aria-label="Folder name"')
    expect(html).toContain('role="group" aria-label="Folder color"')
    const pressed = html.match(/<button[^>]*aria-pressed="true"[^>]*>/g) ?? []
    expect(pressed.map(b => /aria-label="([^"]*)"/.exec(b)?.[1])).toEqual(['Folder color: Blue'])
  })
})
