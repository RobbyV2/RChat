import { describe, expect, test } from 'bun:test'
import { CATALOG, VIEW_LIMITS } from '../apps/ui/catalog'
import type { CatalogRow, Node, On } from '../apps/ui/types'
import { validatePages, type ViewContext } from '../apps/ui/validate'
import apps from './apps_vectors/view_pages.json'

type Row = [string, CatalogRow['group'], CatalogRow['release'], CatalogRow['binds'], string, string]

// The catalog table: component, group, release, binds, the phone
// rule, the accessibility rule.
const TABLE: Row[] = [
  ['stack', 'layout', 'first', 'none', 'unchanged', 'no role; children in reading order'],
  [
    'row',
    'layout',
    'first',
    'none',
    'wraps; below 600 px becomes a stack unless wrap is false',
    'reading order = source order',
  ],
  [
    'section',
    'layout',
    'first',
    'none',
    'unchanged; collapsible ones start closed past the first two',
    'heading level from depth; collapsible uses a disclosure button with aria-expanded',
  ],
  [
    'tabs',
    'layout',
    'first',
    'none',
    'scrollable tab strip; more than 5 tabs become a select',
    'tablist, arrow keys, Home and End',
  ],
  [
    'card',
    'layout',
    'first',
    'none',
    'full width',
    'a link or button when on is set; title is its name',
  ],
  [
    'split',
    'layout',
    'first',
    'none',
    'below 900 px shows one pane with a back button',
    'separator with arrow-key resize',
  ],
  ['toolbar', 'layout', 'first', 'none', 'overflow into a More menu', 'toolbar role, roving focus'],
  [
    'dialog',
    'layout',
    'first',
    'none',
    'a sheet inside the app area, under the app header, when sheet_on_phone (default true)',
    'modal within the app area, focus trap, Escape closes, title labels it',
  ],
  [
    'banner',
    'layout',
    'first',
    'none',
    'full width, text wraps',
    'status role; error tone uses alert',
  ],
  ['empty', 'layout', 'first', 'none', 'centered', 'icon decorative, title as heading'],
  ['scope', 'layout', 'first', 'record', 'unchanged', 'none (data only)'],
  ['text', 'display', 'first', 'none', 'wraps', 'title style is a heading'],
  [
    'markdown',
    'display',
    'first',
    'field',
    'wraps; wide tables scroll inside',
    "RChat's message renderer; link rule applies",
  ],
  [
    'value',
    'display',
    'first',
    'field',
    'unchanged',
    'times have a full date in the accessible name',
  ],
  ['image', 'display', 'first', 'field', 'max width 100%', 'alt required'],
  ['icon', 'display', 'first', 'none', 'unchanged', 'label required'],
  ['badge', 'display', 'first', 'none', 'unchanged', 'text is the name; tone not by color alone'],
  ['stat', 'display', 'first', 'query', 'two per row', 'label then value'],
  ['progress', 'display', 'first', 'field', 'full width', 'progressbar with value'],
  ['avatars', 'display', 'first', 'field', 'max 3 then +n', 'list of names; +n has the full list'],
  ['member', 'display', 'first', 'field', 'unchanged', "RChat's member chip and menu"],
  ['code', 'display', 'first', 'field', 'scrolls sideways inside', 'pre with language label'],
  [
    'diff',
    'display',
    'later',
    'field',
    'unified view',
    'added and removed are words, not only color',
  ],
  ['media', 'display', 'first', 'field', 'full width', 'native controls, captions when present'],
  ['files', 'display', 'first', 'field', 'list', 'list of links with size and type'],
  [
    'timer',
    'display',
    'first',
    'none',
    'unchanged',
    'timer role, announces at 1 minute and at 0 only',
  ],
  ['list', 'data', 'first', 'query', 'unchanged; virtual past 200 rows', 'list role, item count'],
  [
    'table',
    'data',
    'first',
    'query',
    'below 600 px rows become cards (column phone roles)',
    'grid role, sortable headers announce order, inline edit by Enter',
  ],
  [
    'tree',
    'data',
    'first',
    'query',
    'one level at a time with a path bar',
    'tree role, arrow keys, drag has a Move to... menu twin',
  ],
  [
    'board',
    'data',
    'first',
    'query',
    'one column at a time, swipe or a column picker',
    'each card has Move to column... ; drag optional',
  ],
  [
    'calendar',
    'data',
    'first',
    'query',
    'agenda view by default',
    'grid with dates in names; agenda as a list',
  ],
  ['timeline', 'data', 'later', 'query', 'vertical', 'list in time order'],
  ['gallery', 'data', 'first', 'query', 'two columns', 'list of images with titles'],
  [
    'chart',
    'data',
    'first',
    'query',
    'full width, legend below',
    'a data table twin one click away',
  ],
  [
    'sheet',
    'data',
    'first',
    'doc',
    'read and edit one cell at a time with a formula bar; frozen first row and column',
    'grid role, cell address in names, formula bar labelled',
  ],
  [
    'form',
    'input',
    'first',
    'record',
    'one column; steps as pages',
    'labels from the schema, errors linked by aria-describedby',
  ],
  [
    'input',
    'input',
    'first',
    'field',
    'full width; native pickers for date and time',
    'label required; color is chosen from theme swatches with names',
  ],
  ['button', 'input', 'first', 'none', 'at least 44 px', 'label required; danger asks to confirm'],
  [
    'search',
    'input',
    'first',
    'none',
    'full width, filters in a sheet',
    'search role, result count announced',
  ],
  ['pad', 'input', 'later', 'field', 'full width', 'a typed-name alternative for signatures'],
  [
    'doc',
    'live',
    'first',
    'doc',
    'toolbar collapses into a format sheet',
    'textbox multiline with rich text; other cursors announced by name on request only',
  ],
  [
    'slides',
    'live',
    'first',
    'doc',
    'view and present; editing one slide at a time, objects through a list',
    'each slide a region; objects listed in order with their text',
  ],
  [
    'scene',
    'live',
    'later',
    'doc',
    'pan and pinch zoom',
    'object list twin with text of each shape',
  ],
  ['thread', 'live', 'first', 'record', 'opens as a sheet', "RChat's thread view"],
  ['reactions', 'live', 'first', 'record', 'unchanged', "RChat's reaction bar"],
  ['vote', 'live', 'first', 'record', 'unchanged', 'buttons with pressed state and the count'],
  ['poll', 'live', 'first', 'record', 'unchanged', "RChat's poll"],
  ['presence', 'live', 'first', 'record', 'avatars max 3', 'list of names'],
  ['call', 'live', 'later', 'record', "RChat's call sheet", "RChat's call controls"],
  ['letter', 'live', 'later', 'record', "RChat's letter view", "RChat's letter view"],
  [
    'frame',
    'integration',
    'first',
    'none',
    'full width, height capped at the viewport',
    "the app's own markup; the host labels the region with the app's name",
  ],
  [
    'plugin',
    'integration',
    'first',
    'none',
    "the plugin's own",
    "the plugin's own; labelled region",
  ],
]

const ctx: ViewContext = {
  queries: ['q'],
  actions: ['act'],
  capabilities: ['app_frame'],
  plugin: true,
  rule: () => null,
}

const text: Node = { c: 'text', text: 'x' }
const act: On = { action: 'act' }

type Named<N, K> = N extends { c: infer C } ? (K extends C ? N : never) : never

// One node of every component, typed: a component without a sample does not compile.
const SAMPLE: { [K in Node['c']]: Named<Node, K> } = {
  stack: { c: 'stack', gap: 2, align: 'center', wrap: true, children: [text] },
  row: { c: 'row', children: [text], key: 'k', when: 'me.member', menu: ['act'] },
  section: { c: 'section', title: 'Work', collapsible: true, children: [text] },
  tabs: { c: 'tabs', tabs: [{ label: 'One', icon: 'home', view: text }] },
  card: { c: 'card', title: 'A', subtitle: 'B', on: act, children: [text] },
  split: { c: 'split', ratio: 0.3, min_px: 240, a: text, b: text },
  toolbar: { c: 'toolbar', children: [text] },
  dialog: { c: 'dialog', name: 'new_item', title: 'New', children: [text], sheet_on_phone: true },
  banner: { c: 'banner', text: 'Saved', tone: 'success', on: { op: 'close' }, action_label: 'OK' },
  empty: { c: 'empty', icon: 'inbox', title: 'Nothing yet', text: 'Add one', on: act },
  scope: { c: 'scope', bind: { record: 'route.id' }, children: [text] },
  text: { c: 'text', text: 'Hello {name}', style: 'title', tone: 'primary' },
  markdown: { c: 'markdown', bind: { field: 'body' } },
  value: { c: 'value', bind: { field: 'due' }, format: 'relative' },
  image: { c: 'image', src: 'assets/logo.png', alt: 'Logo', fit: 'contain' },
  icon: { c: 'icon', name: 'star', label: 'Starred' },
  badge: { c: 'badge', text: 'Late', tone: 'error' },
  stat: { c: 'stat', label: 'Answers', bind: { query: 'q' }, agg: 'count' },
  progress: { c: 'progress', value: 'record.done / record.total', label: 'Done' },
  avatars: { c: 'avatars', bind: { field: 'editors' }, field: 'editors', max: 3 },
  member: { c: 'member', bind: { field: 'author' } },
  code: { c: 'code', text: 'let x = 1', lang: 'rust' },
  diff: { c: 'diff', a: { field: 'before' }, b: { field: 'after' } },
  media: { c: 'media', bind: { field: 'clip' }, label: 'Clip' },
  files: { c: 'files', bind: { field: 'files' }, field: 'files', upload: true, label: 'Files' },
  timer: { c: 'timer', until: 'record.due', label: 'Due in', done_text: 'Closed' },
  list: { c: 'list', bind: { query: 'q' }, item: text, empty: text, virtual: true, label: 'Items' },
  table: {
    c: 'table',
    bind: { query: 'q', params: { course: 'route.course' } },
    columns: [{ field: 'title', label: 'Title', sort: true, phone: 'title' }],
    label: 'Work',
    on_row: { op: 'navigate', route: '/item/:id', params: { id: 'record.id' } },
    inline_edit: true,
    group_by: 'status',
  },
  tree: {
    c: 'tree',
    bind: { query: 'q' },
    parent: 'parent',
    item: text,
    label: 'Files',
    drag: true,
  },
  board: { c: 'board', bind: { query: 'q' }, column_field: 'status', item: text, label: 'Board' },
  calendar: {
    c: 'calendar',
    bind: { query: 'q' },
    start: 'due',
    title: 'title',
    views: ['month', 'agenda'],
    label: 'Due dates',
  },
  timeline: { c: 'timeline', bind: { query: 'q' }, at: 'created', item: text, label: 'Activity' },
  gallery: { c: 'gallery', bind: { query: 'q' }, image: 'cover', title: 'name', label: 'Books' },
  chart: {
    c: 'chart',
    bind: { query: 'q' },
    kind: 'bar',
    x: 'choice',
    y: ['count'],
    label: 'Results',
  },
  sheet: { c: 'sheet', bind: { field: 'cells' }, label: 'Sheet' },
  form: {
    c: 'form',
    collection: 'items',
    sections: [{ title: 'More', fields: ['note'], when: 'args.kind == "long"' }],
    submit: 'Save',
    on_done: { op: 'close' },
  },
  input: { c: 'input', field: 'title', label: 'Title', kind: 'text', placeholder: 'Name it' },
  button: { c: 'button', label: 'Share', icon: 'share', variant: 'tonal', on: { op: 'share' } },
  search: { c: 'search', target: 'items', label: 'Search', filters: ['status'] },
  pad: { c: 'pad', field: 'signature', label: 'Sign here', mode: 'signature' },
  doc: { c: 'doc', bind: { field: 'doc' }, label: 'Document', comments: true, presence: true },
  slides: { c: 'slides', bind: { field: 'deck' }, label: 'Deck' },
  scene: { c: 'scene', bind: { field: 'board' }, label: 'Whiteboard', presence: true },
  thread: { c: 'thread', bind: { record: 'record.id' }, label: 'Comments' },
  reactions: { c: 'reactions', bind: { record: 'record.id' } },
  vote: {
    c: 'vote',
    bind: { record: 'record.id' },
    collection: 'votes',
    field: 'value',
    mode: 'updown',
  },
  poll: { c: 'poll', bind: { record: 'record.id' }, label: 'Poll' },
  presence: { c: 'presence', label: 'Here now' },
  call: { c: 'call', bind: { record: 'record.id' }, label: 'Call' },
  letter: { c: 'letter', bind: { record: 'record.id' }, label: 'Letter' },
  frame: { c: 'frame', label: 'Game', height: 480 },
  plugin: { c: 'plugin', surface: 'board', label: 'Board' },
}

const page = (view: unknown, route = '/') => [{ route, view: view as Node }]
const check = (view: unknown, over: Partial<ViewContext> = {}) =>
  validatePages(page(view), { ...ctx, ...over })
const whats = (view: unknown, over: Partial<ViewContext> = {}) => check(view, over).map(p => p.what)

describe('the catalog', () => {
  test('is the table, row for row', () => {
    expect(CATALOG.length).toBe(52)
    expect(CATALOG.map(r => [r.c, r.group, r.release, r.binds, r.phone, r.a11y])).toEqual(TABLE)
  })

  test('has every component once, with a release, a phone rule and an accessibility rule', () => {
    const names = CATALOG.map(r => r.c)
    expect(new Set(names).size).toBe(names.length)
    for (const r of CATALOG) expect(r.phone.length > 0 && r.a11y.length > 0).toBe(true)
  })

  test('ships 46 components first and names the six that come later', () => {
    expect(CATALOG.filter(r => r.release === 'first').length).toBe(46)
    expect(CATALOG.filter(r => r.release === 'later').map(r => r.c)).toEqual([
      'diff',
      'timeline',
      'pad',
      'scene',
      'call',
      'letter',
    ])
  })

  test('has charts and calendars in the first release', () => {
    for (const c of ['chart', 'calendar'])
      expect(CATALOG.find(r => r.c === c)?.release).toBe('first')
  })

  test('keeps a dialog inside the app area on phones', () => {
    expect(CATALOG.find(r => r.c === 'dialog')?.phone).toBe(
      'a sheet inside the app area, under the app header, when sheet_on_phone (default true)'
    )
  })

  test('has a row for every component of the types, and a type for every row', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(CATALOG.map(r => r.c).sort())
    for (const [c, node] of Object.entries(SAMPLE)) expect(node.c).toBe(c as Node['c'])
  })

  test('caps a page at 32 levels, 2,000 parts and 100,000 characters', () => {
    expect(VIEW_LIMITS).toEqual({ depth: 32, nodes: 2000, chars: 100_000 })
  })
})

describe('a valid view', () => {
  test('every component validates with its props', () => {
    const views = Object.values(SAMPLE).filter(n => n.c !== 'dialog')
    expect(validatePages([{ route: '/', view: { c: 'stack', children: views } }], ctx)).toEqual([])
    expect(check(SAMPLE.dialog)).toEqual([])
  })

  test('the pages of the five example apps validate with no problems', () => {
    expect(apps.map(a => a.id)).toEqual(['classroom', 'forms', 'forum', 'office', 'sheet'])
    for (const a of apps) {
      const problems = validatePages(a.pages as unknown as { route: string; view: Node }[], {
        queries: a.queries,
        actions: a.actions,
        capabilities: a.capabilities,
        plugin: a.plugin,
        rule: () => null,
      })
      expect({ id: a.id, problems }).toEqual({ id: a.id, problems: [] })
    }
  })

  test('share and mark are operations', () => {
    const share: On = { op: 'share' }
    const mark: On = { op: 'mark', kind: 'star', value: 'true' }
    expect(check({ c: 'button', label: 'Share', on: share })).toEqual([])
    expect(check({ c: 'button', label: 'Star', on: mark })).toEqual([])
  })
})

describe('problems', () => {
  test('name where they are', () => {
    const view = { c: 'stack', children: [text, { c: 'row', children: [text, { c: 'nope' }] }] }
    expect(validatePages(page(view, '/course/:course'), ctx)).toEqual([
      { where: 'pages[/course/:course]/1/1', what: 'nope is not a component' },
    ])
  })

  test('number the parts of tabs, splits and lists', () => {
    const bad = { c: 'frame', label: 'x' }
    const where = (view: unknown) => check(view, { capabilities: [] }).map(p => p.where)
    expect(
      where({
        c: 'tabs',
        tabs: [
          { label: 'a', view: text },
          { label: 'b', view: bad },
        ],
      })
    ).toEqual(['pages[/]/1'])
    expect(where({ c: 'split', a: text, b: bad })).toEqual(['pages[/]/1'])
    expect(where({ c: 'list', bind: { query: 'q' }, item: text, empty: bad, label: 'l' })).toEqual([
      'pages[/]/1',
    ])
    expect(where({ c: 'tree', bind: { query: 'q' }, parent: 'p', item: bad, label: 'l' })).toEqual([
      'pages[/]/0',
    ])
  })

  test('a frame needs the app_frame capability', () => {
    expect(check({ c: 'frame', label: 'x' }, { capabilities: ['files'] })).toEqual([
      { where: 'pages[/]', what: 'The frame needs the app_frame capability' },
    ])
    expect(check({ c: 'frame', label: 'x' }, { capabilities: ['files', 'app_frame'] })).toEqual([])
  })

  test('a plugin surface needs a required plugin', () => {
    expect(whats({ c: 'plugin', surface: 's', label: 'x' }, { plugin: false })).toEqual([
      'A plugin surface needs requires.plugin',
    ])
  })

  test('an image is a file of the package or a file field, never a link', () => {
    const src = (s: unknown) => whats({ c: 'image', src: s, alt: 'logo' })
    const refused = [
      'An image src is a file of the package (assets/...), not a link; use bind for a file field',
    ]
    expect(src('assets/logo.png')).toEqual([])
    expect(src('assets/icons/dark/logo-2.v1_final.png')).toEqual([])
    for (const s of [
      'https://tracker.example/p.gif?u={me}',
      '//tracker.example/p.gif',
      'data:image/png;base64,AAAA',
      '../other/app.png',
      'javascript:alert(1)',
      'assets/',
      'Assets/logo.png',
      'assets/logo.png?x=1',
      'assets/logo.png#x',
      'assets/a b.png',
      'assets/' + 'a'.repeat(201),
      '',
      5,
      null,
    ])
      expect({ s, problems: src(s) }).toEqual({ s, problems: refused })
  })

  test('an image src never leaves the assets of the package', () => {
    const refused = [
      'An image src is a file of the package (assets/...), not a link; use bind for a file field',
    ]
    for (const s of [
      'assets/../app.json',
      'assets/a/../../x.png',
      'assets/./a.png',
      'assets//a.png',
      'assets/a/',
      'assets/..',
    ])
      expect({ s, problems: whats({ c: 'image', src: s, alt: 'x' }) }).toEqual({
        s,
        problems: refused,
      })
    expect(whats({ c: 'image', src: 'assets/a..b/c.png', alt: 'x' })).toEqual([])
  })

  test('an image needs a src or a bind', () => {
    expect(whats({ c: 'image', alt: 'x' })).toEqual(['An image needs src or bind'])
    expect(whats({ c: 'image', bind: { field: 'cover' }, alt: 'x' })).toEqual([])
  })

  test('a query a component binds must be declared', () => {
    expect(whats({ c: 'list', bind: { query: 'missing' }, item: text, label: 'l' })).toEqual([
      'No query missing',
    ])
    expect(whats({ c: 'diff', a: { query: 'gone' }, b: { field: 'x' } })).toEqual(['No query gone'])
    expect(whats({ c: 'diff', a: { field: 'x' }, b: { query: 'lost' } })).toEqual(['No query lost'])
    expect(whats({ c: 'scope', bind: { record: 'route.id' }, children: [] })).toEqual([])
  })

  test('an action a control runs must be declared, wherever the control is', () => {
    expect(whats({ c: 'button', label: 'Go', on: { action: 'nope' } })).toEqual(['No action nope'])
    expect(whats({ c: 'card', on: { action: 'nope' }, children: [] })).toEqual(['No action nope'])
    expect(
      whats({
        c: 'table',
        bind: { query: 'q' },
        columns: [],
        label: 'l',
        on_row: { action: 'nope' },
      })
    ).toEqual(['No action nope'])
    expect(
      whats({ c: 'form', collection: 'items', submit: 'Save', on_done: { action: 'nope' } })
    ).toEqual(['No action nope'])
    expect(whats({ c: 'text', text: 'x', menu: ['act', 'nope'] })).toEqual([
      'No action nope for the menu',
    ])
  })

  test('a when that is not a rule is reported with what the rule checker said', () => {
    const rule = (src: string) => (src === 'me.member' ? null : 'Expected a value at 1')
    expect(check({ c: 'text', text: 'x', when: 'me.member' }, { rule })).toEqual([])
    expect(check({ c: 'text', text: 'x', when: '&&' }, { rule })).toEqual([
      { where: 'pages[/]', what: 'when: Expected a value at 1' },
    ])
  })

  test('a view nests at most 32 levels below its root', () => {
    const nest = (levels: number) => {
      let n: Node = text
      for (let i = 0; i < levels; i++) n = { c: 'stack', children: [n] }
      return n
    }
    expect(check(nest(32))).toEqual([])
    expect(whats(nest(33))).toEqual(['Nested too deeply'])
    expect(whats(nest(2000))).toEqual(['Nested too deeply'])
    expect(whats(nest(50_000))).toContain('Nested too deeply')
  }, 60_000)

  test('a page has at most 2,000 parts', () => {
    const wide = (n: number) => ({
      c: 'stack',
      children: Array.from({ length: n - 1 }, () => text),
    })
    expect(check(wide(2000))).toEqual([])
    expect(check(wide(2001))).toEqual([{ where: 'pages[/]', what: 'More than 2000 parts' }])
  }, 60_000)

  test('a page has at most 100,000 characters', () => {
    const big = (chars: number) => ({ c: 'text', text: 'x'.repeat(chars) })
    const frame = JSON.stringify(big(0)).length
    expect(check(big(100_000 - frame))).toEqual([])
    expect(check(big(100_001 - frame))).toEqual([
      { where: 'pages[/]', what: 'More than 100000 characters' },
    ])
  })

  test('routes look like /course/:course', () => {
    for (const route of ['/', '/course', '/course/:course', '/a-b/c_d/9', '/:id'])
      expect(validatePages(page(text, route), ctx)).toEqual([])
    for (const route of ['', 'course', '/Course', '/a//b', '/a/', '/:Id', '/a b', '/a?x=1'])
      expect(validatePages(page(text, route), ctx)).toEqual([
        { where: `pages[${route}]`, what: 'Routes look like /course/:course' },
      ])
  })

  test('a control opens only a dialog some page has', () => {
    const open = (dialog: string) => ({ c: 'button', label: 'New', on: { op: 'open', dialog } })
    const dialog = { c: 'dialog', name: 'new_item', title: 'New', children: [] }
    expect(check({ c: 'stack', children: [open('new_item'), dialog] })).toEqual([])
    expect(check({ c: 'stack', children: [open('other'), dialog] })).toEqual([
      { where: 'pages', what: 'Opens a dialog other that no page has' },
    ])
    expect(
      validatePages(
        [
          { route: '/', view: open('new_item') as Node },
          { route: '/b', view: dialog as Node },
        ],
        ctx
      )
    ).toEqual([])
    expect(
      whats({ c: 'table', bind: { query: 'q' }, columns: [], label: 'l', on_row: open('gone').on })
    ).toEqual(['Opens a dialog gone that no page has'])
  })

  test('each control that opens a missing dialog is a problem', () => {
    const open = { c: 'button', label: 'New', on: { op: 'open', dialog: 'gone' } }
    expect(whats({ c: 'stack', children: [open, open] })).toEqual([
      'Opens a dialog gone that no page has',
      'Opens a dialog gone that no page has',
    ])
  })
})

describe('what is not a view at all', () => {
  test('is a problem, never a crash', () => {
    for (const view of [null, undefined, 5, 'text', [], {}, { c: 5 }, { c: null }])
      expect({ view, problems: whats(view) }).toEqual({ view, problems: ['Not a component'] })
  })

  test('a container without its parts says what it needs', () => {
    expect(whats({ c: 'stack' })).toEqual(['stack needs children'])
    expect(whats({ c: 'card', children: 'x' })).toEqual(['card needs children'])
    expect(whats({ c: 'tabs' })).toEqual(['tabs needs tabs'])
    expect(check({ c: 'tabs', tabs: [null, { label: 'a' }] })).toEqual([
      { where: 'pages[/]/0', what: 'Not a component' },
      { where: 'pages[/]/1', what: 'Not a component' },
    ])
    expect(check({ c: 'split', a: text })).toEqual([
      { where: 'pages[/]/1', what: 'Not a component' },
    ])
    expect(check({ c: 'list', bind: { query: 'q' }, label: 'l' })).toEqual([
      { where: 'pages[/]/0', what: 'Not a component' },
    ])
  })

  test('parts under a component that takes none are checked', () => {
    expect(check({ c: 'text', text: 'x', children: [text, { c: 'nope' }] })).toEqual([
      { where: 'pages[/]/1', what: 'nope is not a component' },
    ])
  })

  test('a view that holds itself is too deep and too large, not a crash', () => {
    const loop: { c: string; children: unknown[] } = { c: 'stack', children: [] }
    loop.children.push(loop)
    expect(whats(loop)).toEqual(['Nested too deeply', 'More than 100000 characters'])
  })

  test('odd props are checked as far as they go, without a crash', () => {
    expect(whats({ c: 'text', text: 'x', menu: 'act' })).toEqual([])
    expect(whats({ c: 'text', text: 'x', when: 5 })).toEqual([])
    expect(whats({ c: 'list', bind: 'q', item: text, label: 'l' })).toEqual([])
    expect(whats({ c: 'button', label: 'x', on: 'act' })).toEqual([])
    expect(whats({ c: 'button', label: 'x', on: { action: 5 } })).toEqual(['No action 5'])
    expect(whats({ c: 'dialog', name: 5, title: 'x', children: [] })).toEqual([])
  })

  test('pages that are not pages are problems', () => {
    expect(validatePages([null as unknown as { route: string; view: Node }], ctx)).toEqual([
      { where: 'pages[0]', what: 'Not a page' },
    ])
    expect(
      validatePages([{ route: 5, view: text } as unknown as { route: string; view: Node }], ctx)
    ).toEqual([{ where: 'pages[0]', what: 'Not a page' }])
  })
})
