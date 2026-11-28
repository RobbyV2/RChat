import { expect, test } from 'bun:test'
import example from '../../../public/app-examples/field-notes.json'
import { previewFor, fileSource } from '../apps/preview'
import { savedPreviews } from '../apps/preview_files'
import { testAccount } from './test_account'
import type { AccountSession } from '../client/session'
import { client } from '../client/client'
import { registerAppActions } from '../actions'
import { openActionMenu } from '../actions/menu'
import { defineAction } from '../actions/registry'
import { me } from './fixtures'
import { answerPrompt } from './helpers/viewing'

function open(owner: AccountSession) {
  owner.store.setState({
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
    view: { kind: 'channel', server: 'garden', channelId: 1 },
    activeDialog: { kind: 'app_preview', server: 'garden' },
  })
}

test('file approvals and preview actions belong to the account where the definition was opened', async () => {
  const first = testAccount('reader', 'https://first.test')
  const second = testAccount('reader', 'https://second.test')
  const file = new File([JSON.stringify(example)], 'field.json')
  try {
    for (const owner of [first, second]) {
      open(owner)
      const preview = previewFor(owner)
      const pending = preview.launchPreview('garden', fileSource(file))
      const prompt = owner.viewing.useViewing.getState().prompt
      expect(prompt?.target.kind).toBe('app')
      answerPrompt(owner.viewing, true, true, prompt)
      await pending
      expect(preview.usePreview.getState().loaded?.definition.id).toBe(example.id)
      preview.closePreview()
      expect(owner.store.getState().activeDialog).toBeNull()
      expect(savedPreviews('reader', 'garden', owner.conn)).toHaveLength(1)
      if (owner === first) expect(savedPreviews('reader', 'garden', second.conn)).toHaveLength(0)
    }

    const secondPreview = previewFor(second)
    expect(secondPreview.dispatchPreviewText('/fieldnote moss')).toBe(true)
    expect(secondPreview.usePreview.getState().values).toEqual({ subject: 'moss' })
    expect(first.store.getState().activeDialog).toBeNull()
    secondPreview.forgetPreview()
    expect(savedPreviews('reader', 'garden', second.conn)).toHaveLength(0)
    expect(savedPreviews('reader', 'garden', first.conn)).toHaveLength(1)
  } finally {
    for (const owner of [first, second]) {
      previewFor(owner).forgetPreview()
      owner.store.dispose()
    }
  }
})

test('losing the owner’s preview while a definition is loading discards the late result', async () => {
  const owner = testAccount('reader')
  open(owner)
  const preview = previewFor(owner)
  const reading = Promise.withResolvers<void>()
  const body = Promise.withResolvers<string>()
  const pending = preview.launchPreview('garden', {
    installation: 'notes',
    name: 'Notes',
    revision: '1',
    publisher: 'local',
    read() {
      reading.resolve()
      return body.promise
    },
  })
  answerPrompt(owner.viewing, true, false)
  await reading.promise
  owner.store.setState({ view: null })
  open(owner)
  body.resolve(JSON.stringify(example))
  await pending
  expect(preview.usePreview.getState().loaded).toBeNull()
})

test('the registered server menu opens the preview in its owner while another account is shown', () => {
  const shown = client.shown
  const a = testAccount('reader', 'https://shown.test')
  const b = testAccount('reader', 'https://menu.test')
  try {
    client.shown = () => a
    for (const owner of [a, b]) {
      open(owner)
      owner.store.getState().closeDialog()
    }
    registerAppActions()
    const target = { kind: 'server', server: 'garden', folder: null, at: 0 } as const
    openActionMenu(0, 0, target, {}, b)
    expect(a.store.getState().contextMenu).toBeNull()
    const remove = defineAction({
      id: 'garden.visit',
      title: 'Visit garden',
      scope: 'server',
      targets: ['server'],
      available: ctx => ctx.s === b.store.getState(),
      run: () => {},
    })
    try {
      expect(b.store.getState().contextMenu?.items.map(item => item.label)).toContain(
        'Visit garden'
      )
      expect(a.store.getState().contextMenu).toBeNull()
    } finally {
      remove()
    }
    const row = b.store.getState().contextMenu?.items.find(item => item.label === 'App previews')
    expect(row?.label).toBe('App previews')
    row?.action?.()
    expect(a.store.getState().activeDialog).toBeNull()
    expect(b.store.getState().activeDialog).toEqual({ kind: 'app_preview', server: 'garden' })
  } finally {
    client.shown = shown
  }
})

test('leaving a preview server dismisses its slash consent and preserves a replacement prompt', async () => {
  const owner = testAccount('reader', 'https://slash.test')
  const preview = previewFor(owner)
  for (const replace of [false, true]) {
    open(owner)
    const pending = preview.launchPreview(
      'garden',
      fileSource(new File([JSON.stringify(example)], 'field.json'))
    )
    answerPrompt(owner.viewing, true, false)
    await pending
    preview.closePreview()
    expect(preview.dispatchPreviewText('/fieldnote moss')).toBe(true)
    const consent = owner.viewing.useViewing.getState().prompt
    expect(consent?.target.kind).toBe('app')
    const other = replace
      ? owner.viewing.requestViewing({
          kind: 'app',
          key: 'unrelated',
          name: 'Another app',
          sensitive: false,
        })
      : null
    const replacement = replace ? owner.viewing.useViewing.getState().prompt : null
    owner.store.setState({ view: { kind: 'dm', dmId: 4 } })
    expect(preview.usePreview.getState().loaded).toBeNull()
    expect(owner.viewing.useViewing.getState().prompt).toBe(replacement)
    answerPrompt(owner.viewing, true, true, consent)
    expect(!!owner.viewing.canView(consent!.target)).toBe(false)
    answerPrompt(owner.viewing, false, false, replacement)
    if (other) expect(!!(await other)).toBe(false)
    expect(owner.store.getState().activeDialog).toBeNull()
  }
})
