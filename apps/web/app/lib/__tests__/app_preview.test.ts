import { flush } from './helpers/test_clock'
import { afterEach, expect, test } from 'bun:test'
import example from '../../../public/app-examples/field-notes.json'
import { serverActions } from '../actions/server'
import { actionById } from '../actions/registry'
import {
  closePreview,
  dispatchPreviewText,
  forgetPreview,
  fileSource,
  forgetSavedPreview,
  savedSource,
  launchPreview,
  previewStep,
  usePreview,
  type PreviewSource,
} from '../apps/preview'
import { savedPreviews } from '../apps/preview_files'
import { paletteCtx } from '../actions/ctx'
import { paletteCommands } from '../actions/palette'
import { readPreview } from '../apps/preview_definition'
import { resetSessionCaches, useStore } from '../store'
import { useViewing } from '../viewing'
import { me, serverDetail, textChannel, memoryStorage, until } from './fixtures'
import { answerPrompt } from './helpers/viewing'
import { defaultViewing } from '../viewing'

afterEach(() => {
  resetSessionCaches()
  memoryStorage.clear()
})

const openLauncher = () => {
  const server = serverDetail('garden', { channels: [textChannel(1)] })
  useStore.setState({
    me: me('reader', {
      servers: [
        {
          name: 'garden',
          display_name: 'Garden',
          creator: null,
          is_admin: false,
          banner_color: null,
          icon_image: null,
          icon_kind: 'identicon' as const,
          name_color: null,
          profiles_mode: 'all' as const,
          timed_out_remaining: null,
          timed_out_until: null,
        },
      ],
    }),
    guest: false,
    servers: { garden: server },
    view: { kind: 'channel', server: 'garden', channelId: 1 },
    activeDialog: { kind: 'app_preview', server: 'garden' },
  })
}
const answer = (open: boolean, remember = false) => {
  const warn = useViewing.getState().prompt
  expect(warn?.target.kind).toBe('app')
  answerPrompt(defaultViewing, open, remember)
}

test('the server menu exposes a local author preview', () => {
  expect(serverActions.some(a => a.id === 'apps.preview' && a.targets?.includes('server'))).toBe(
    true
  )
})

test('two definitions select their own aliases, dialogs, arguments and named actions after launch', async () => {
  openLauncher()
  let reads = 0
  for (const [id, alias, title] of [
    ['one', 'sample', 'Missing leaves'],
    ['two', 'measure', 'Soil depth'],
  ]) {
    const doc = structuredClone(example)
    doc.id = id
    doc.actions[0].slash = alias
    const raw = JSON.stringify(doc).replace('Field observation', title)
    const src: PreviewSource = {
      installation: id,
      publisher: 'gardener',
      revision: 'a',
      name: 'Notebook',
      read: async () => {
        reads++
        return raw
      },
    }
    const before = reads
    const cancel = launchPreview('garden', src)
    expect(actionById('app.' + id + '.observe')).toBeUndefined()
    expect(dispatchPreviewText('/' + alias + ' hidden')).toBe(false)
    answer(false)
    await cancel
    expect(reads).toBe(before)
    const opened = launchPreview('garden', src)
    answer(true, true)
    await opened
    expect(reads).toBe(before + 1)
    const app = usePreview.getState().loaded!
    expect(app.definition.dialogs.get('observation')?.title).toBe(title)
    closePreview()
    expect(dispatchPreviewText('ordinary draft')).toBe(false)
    expect(dispatchPreviewText('/unknown')).toBe(false)
    expect(dispatchPreviewText('/' + alias + ' moss')).toBe(true)
    expect(usePreview.getState().dialog).toBe('observation')
    expect(usePreview.getState().values).toEqual({ subject: 'moss' })
    previewStep(app, { action: 'review' })
    expect(usePreview.getState().dialog).toBe('summary')
    previewStep(app, { op: 'close' })
    expect(usePreview.getState().dialog).toBeNull()
    forgetPreview()
    expect(dispatchPreviewText('/' + alias)).toBe(true)
    answer(false)
    expect(usePreview.getState().dialog).toBeNull()
    openLauncher()
  }
  expect(actionById('app.one.observe')).toBeUndefined()
})

test('a replaced package asks again and a late definition cannot mount in a closed launcher', async () => {
  openLauncher()
  const base = {
    installation: 'same',
    publisher: 'writer',
    name: 'Notebook',
    read: async () => JSON.stringify(example),
  }
  const opened = launchPreview('garden', { ...base, revision: '1' })
  answer(true, true)
  await opened
  let done!: (s: string) => void
  const next = launchPreview('garden', {
    ...base,
    revision: '2',
    read: () =>
      new Promise(resolve => {
        done = resolve
      }),
  })
  answer(true)
  await Promise.resolve()
  closePreview()
  done(JSON.stringify({ ...example, id: 'replacement' }))
  await next
  expect(actionById('app.replacement.observe')).toBeUndefined()
})

test('an app can open only its own dialogs and named actions', () => {
  for (const [find, replace] of [
    ['"dialog":"observation"', '"dialog":"host_confirm"'],
    ['"action":"observe"', '"action":"app.other.observe"'],
    ['"op":"open"', '"op":"confirm"'],
    ['"capabilities":[]', '"capabilities":["chat.send"]'],
  ]) {
    expect(() => readPreview(JSON.stringify(example).replace(find, replace))).toThrow()
  }
})

test('palette exposure requires both the authored opt-in and the current approval', async () => {
  openLauncher()
  const doc = structuredClone(example)
  doc.actions[0].palette = false
  Object.assign(doc.actions[1], { palette: true, args: [{ name: 'comment', type: 'text' }] })
  const opened = launchPreview('garden', {
    installation: 'palette',
    publisher: 'local',
    revision: '1',
    name: 'Palette example',
    read: async () => JSON.stringify(doc),
  })
  answer(true, true)
  await opened
  const rows = () => paletteCommands(paletteCtx(useStore.getState()))
  expect(rows().some(r => r.id.endsWith('.observe'))).toBe(false)
  const row = rows().find(r => r.id === 'app.field-notes.review')!
  expect(row.arg).not.toBeUndefined()
  expect(row.available?.()).toBe(true)
  forgetPreview()
  expect(row.available?.()).toBe(false)
  expect(rows().some(r => r.id === row.id)).toBe(false)
  expect(dispatchPreviewText('/fieldnote private')).toBe(true)
  answer(false)
})

test('named buttons and form actions bind declared string values before opening their destination', async () => {
  openLauncher()
  const doc = JSON.parse(JSON.stringify(example))
  doc.actions[1].args = [{ name: 'stamp', type: 'text' }]
  const review = doc.pages[0].view.children[2].children[2]
  const source = {
    installation: 'form',
    publisher: 'local',
    revision: '1',
    name: 'Form',
    read: async () => JSON.stringify(doc),
  }
  review.on.args = { stamp: 'form.note' }
  const opened = launchPreview('garden', source)
  answer(true)
  await opened
  const app = usePreview.getState().loaded!
  usePreview.setState({ values: { note: 'navy thread' } })
  previewStep(app, review.on)
  expect(usePreview.getState().values).toEqual({ note: 'navy thread', stamp: 'navy thread' })
  previewStep(app, { action: 'review', args: { stamp: '"signed"' } })
  expect(usePreview.getState().values.stamp).toBe('signed')
  expect(usePreview.getState().dialog).toBe('summary')
  for (const args of [{ missing: '"x"' }, { stamp: '1 + 1' }, { stamp: 34 }, []]) {
    review.on.args = args
    expect(() => readPreview(JSON.stringify(doc))).toThrow()
  }
})

test('remembered file installs are accessible by revision after a session reset and can be forgotten', async () => {
  openLauncher()
  const raw = JSON.stringify(example)
  const file = new File([raw], 'notes.json')
  const first = launchPreview('garden', fileSource(file))
  answer(true, true)
  await first
  const [saved] = savedPreviews('reader', 'garden')
  expect(saved?.name).toBe('notes.json')
  expect(savedPreviews('elsewhere', 'garden')).toEqual([])
  expect(savedPreviews('reader', 'other')).toEqual([])
  resetSessionCaches()
  openLauncher()
  await launchPreview('garden', savedSource('reader', 'garden', saved))
  expect(useViewing.getState().prompt).toBeNull()
  await launchPreview('garden', fileSource(new File([raw], file.name)))
  expect(usePreview.getState().loaded?.source.revision).toBe(saved.revision)
  const changed = launchPreview(
    'garden',
    fileSource(new File([raw.replace('Field club', 'Hill  club')], file.name))
  )
  await flush()
  answer(false)
  await changed
  resetSessionCaches()
  openLauncher()
  forgetSavedPreview('reader', 'garden', saved)
  expect(savedPreviews('reader', 'garden')).toEqual([])
  const next = launchPreview('garden', fileSource(file))
  answer(false)
  await next
})

const inChannel = () => {
  openLauncher()
  useStore.setState({ activeDialog: null })
}

const remember = async (raw: string, name: string) => {
  openLauncher()
  const opened = launchPreview('garden', fileSource(new File([raw], name)))
  answer(true, true)
  await opened
}

test('a remembered alias runs in its app after a reload and unknown text sends', async () => {
  const doc = structuredClone(example)
  doc.actions[1].slash = 'reviewnote'
  await remember(JSON.stringify(doc), 'notes.json')
  resetSessionCaches()
  inChannel()
  expect(dispatchPreviewText('/unknown moss')).toBe(false)
  expect(dispatchPreviewText('/reviewnote extra words')).toBe(false)
  expect(dispatchPreviewText('/fieldnote moss')).toBe(true)
  expect(useStore.getState().activeDialog).toEqual({ kind: 'app_preview', server: 'garden' })
  await until(() => usePreview.getState().dialog === 'observation')
  expect(useViewing.getState().prompt).toBeNull()
  expect(usePreview.getState().values).toEqual({ subject: 'moss' })
  resetSessionCaches()
  inChannel()
  useStore.setState({ me: me('writer', { servers: useStore.getState().me!.servers }) })
  expect(dispatchPreviewText('/fieldnote moss')).toBe(false)
})

test('two remembered apps with one alias leave the choice to the viewer', async () => {
  await remember(JSON.stringify(example), 'one.json')
  await remember(JSON.stringify({ ...example, id: 'second-notes' }), 'two.json')
  resetSessionCaches()
  inChannel()
  expect(dispatchPreviewText('/fieldnote moss')).toBe(true)
  expect(useStore.getState().activeDialog).toEqual({ kind: 'app_preview', server: 'garden' })
  expect(usePreview.getState().loaded).toBeNull()
  expect(usePreview.getState().error).toBe('Choose the app for /fieldnote.')
})
