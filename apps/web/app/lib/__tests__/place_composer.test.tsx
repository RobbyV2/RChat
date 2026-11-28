import { nameText, unnamed } from '../names'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerField, fits } from '../../components/composer_field'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import { composer, type ComposerList } from '../place/composer'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import type { RChatState } from '../store_types'
import type { View } from '../view'
import { msg, user } from './fixtures'
import { NO_THREADS_TEXT } from '../channel_perms'
import { ChannelPermBit } from '../types'
import { ReplyBar } from '../../components/replies'
import { useFileDrop } from '../../components/file_drop'
import { ComposerGate } from '../../components/composer_gate'
import { Composer } from '../../components/composer'
import { TypingLine } from '../../components/typing_indicator'
import { AttachButton, ComposerFiles } from '../../components/composer_files'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with the conversation on screen and a thread open beside it, a draft in each, and
// what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], list: ComposerList = 'main') => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const view: View =
      place.kind === 'hostedServer'
        ? { kind: 'channel', server: world.server, channelId: 1 }
        : { kind: 'dm', dmId: world.dmId }
    const key = place.kind === 'hostedServer' ? 'c1' : `d${world.dmId}`
    const state = {
      view,
      panel: { kind: 'thread', root: msg(5) },
      drafts: { [key]: 'see you at noon', t5: 'in the thread' },
      me: { ...user('ann'), servers: [] },
      replying: { t5: { message: msg(6, { author: user('bob') }), mention: true } },
      setDraft: (...a: unknown[]) => void calls.push(['draft', ...a]),
      noteTyping: (...a: unknown[]) => void calls.push(['typing', ...a]),
      editLast: (k: string) => {
        calls.push(['edit', k])
        return true
      },
      cancelReply: (k: string) => void calls.push(['cancel', k]),
      toggleReplyMention: (k: string) => void calls.push(['ping', k]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const ch = place.kind === 'p2pRoom' ? 'c1' : null
    const main = ch ? `${world.room}/${ch}` : world.room
    const thread = `${main}#e5`
    const state = {
      chat: { room: world.room, ch },
      thread: {
        room: world.room,
        ch,
        root: 'e5',
        head: null,
        messages: [
          { id: 'e6', sender: 'B', ts: 6_000, body: 'six', att: [], reactions: [], edited: null },
        ],
        more: false,
        loading: false,
      },
      drafts: { [main]: 'see you at noon', [thread]: 'in the thread' },
      replying: { room: thread, id: 'e6' },
    }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pDm, {
      setDraft: (...a: unknown[]) => void calls.push(['draft', ...a]),
      typing: (...a: unknown[]) => void calls.push(['typing', ...a]),
      typingEvery: () => 4_000,
      editLast: (k: string) => {
        calls.push(['edit', k])
        return true
      },
      cancelReply: () => void calls.push(['cancel']),
    })
  }
  const here = featureAt(composer, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here.at(list)
}

placeContract(composer, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const mainKey = () =>
    hosted
      ? kind === 'hostedServer'
        ? 'c1'
        : `d${world().dmId}`
      : kind === 'p2pRoom'
        ? `${world().room}/c1`
        : world().room
  const threadKey = () => (hosted ? 't5' : `${mainKey()}#e5`)

  test('each list of the place has its own draft', () => {
    const main = seat(world(), [])
    const state = main.state.get()
    expect(main.state.get()).toBe(state)
    expect([state.key, state.text, state.replying]).toEqual([mainKey(), 'see you at noon', null])
    expect(state.max).toBeGreaterThan(0)
    const thread = seat(world(), [], 'thread').state.get()
    expect([thread.key, thread.text]).toEqual([threadKey(), 'in the thread'])
  })

  test('a draft that answers a message says whom, and whether they are pinged', () => {
    const calls: unknown[][] = []
    const thread = seat(world(), calls, 'thread')
    const { replying } = thread.state.get()
    expect(thread.state.get().replying).toBe(replying)
    expect(replying?.to.kind).toBe(hosted ? 'account' : 'named')
    expect(replying?.mention).toBe(hosted ? true : null)
    thread.toggleReplyMention()
    expect(calls).toEqual(hosted ? [['ping', threadKey()]] : [])
    const html = renderToStaticMarkup(
      <AccountProvider session={world().ann.account}>
        <P2pProvider identity={world().ann.app}>
          <PlaceProvider place={world().ann.place}>
            <ReplyBar list="thread" />
            <ReplyBar list="main" />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html.match(/Replying to/g)?.length).toBe(1)
    expect(html).toContain('aria-label="Cancel reply"')
    expect(html.includes('aria-pressed="true"')).toBe(hosted)
  })

  test('the draft, the last edit and the reply change on the side of the place', () => {
    const calls: unknown[][] = []
    const thread = seat(world(), calls, 'thread')
    thread.setText('later')
    expect(thread.editLast()).toBe(true)
    thread.cancelReply()
    expect(calls).toEqual([
      ['draft', threadKey(), 'later'],
      ['edit', threadKey()],
      hosted ? ['cancel', threadKey()] : ['cancel'],
    ])
  })

  test('a list asked to take the focus says so, and only that list', () => {
    const { ann } = world()
    const main = seat(world(), [])
    const thread = seat(world(), [], 'thread')
    expect(main.state.get().focus).toBe(0)
    const key = main.state.get().key as string
    if (hosted) ann.account.store.setState({ composerFocus: { key, n: 3 } })
    else ann.app?.useP2p.setState({ composerFocus: { key, n: 3 } })
    expect(main.state.get().focus).toBe(3)
    expect(thread.state.get().focus).toBe(0)
    if (hosted) return
    ann.app?.p2pDm.startReply(key, 'e6')
    expect(main.state.get().focus).toBe(4)
  })

  test('leaving an edit asks its list to take the focus', () => {
    const { ann } = world()
    const main = seat(world(), [])
    const key = main.state.get().key as string
    const before = main.state.get().focus
    if (hosted) {
      ann.account.store.setState({ editing: { key, id: 1, text: 'x', focus: 1 } })
      ann.account.store.getState().cancelEdit(true)
    } else {
      ann.app?.useP2p.setState({ editing: { room: key, id: 'e6', text: 'x', focus: 1 } })
      ann.app?.p2pDm.cancelEdit(true)
    }
    expect(main.state.get().focus).toBe(before + 1)
    if (hosted) return
    ann.app?.useP2p.setState({ editing: { room: key, id: 'e6', text: 'x', focus: 1 } })
    ann.app?.p2pDm.cancelEdit()
    expect(main.state.get().focus).toBe(before + 1)
  })

  test('a forward sent from a list goes to that list of the place', () => {
    const main = seat(world(), []).forwardTo.get()
    const thread = seat(world(), [], 'thread').forwardTo.get()
    expect(main?.destination.kind).toBe(hosted ? 'instance' : 'p2p')
    expect(main?.textOnly).toBe(false)
    expect(thread?.key).not.toBe(main?.key)
    if (hosted) expect([main?.key, thread?.key]).toEqual([mainKey(), threadKey()])
    else expect(main?.destination).toMatchObject({ room: world().room })
  })

  test('typing is said as often as the place wants it', () => {
    const calls: unknown[][] = []
    const main = seat(world(), calls)
    const key = mainKey()
    main.typing(key, true)
    main.typing(key, true)
    main.typing(key, false)
    expect(calls).toEqual(
      hosted
        ? [
            ['typing', key, true],
            ['typing', key, true],
            ['typing', key, false],
          ]
        : [
            ['typing', key, true],
            ['typing', key, false],
          ]
    )
  })

  test('who types in a list is named above its composer, and only there', () => {
    const main = seat(world(), [])
    const thread = seat(world(), [], 'thread')
    const { ann } = world()
    const key = mainKey()
    expect(main.typers.get().names).toEqual([])
    if (hosted)
      ann.account.store.setState({
        typingOn: true,
        typing: { [key]: { bob: { name: 'Bob', until: Number.MAX_SAFE_INTEGER } } },
      })
    else if (kind === 'p2pRoom') ann.app?.useP2p.setState({ serverTyping: { [key]: ['B'] } })
    else
      ann.app?.useP2p.setState({
        contacts: [{ ik: 'B', name: 'Bob', state: 'mutual' }] as never,
        chat: { room: world().room, ch: null, peer: 'B' } as never,
        typing: { [key]: ['B', 'C'] },
      })
    const typers = main.typers.get()
    expect(main.typers.get()).toBe(typers)
    expect(typers.names).toHaveLength(1)
    if (kind !== 'p2pRoom') expect(typers.names).toEqual(['Bob'])
    expect(typers.server).toBe(kind === 'hostedServer' ? world().server : null)
    expect(thread.typers.get().names).toEqual([])
    Object.assign(ann.account.store.getInitialState(), ann.account.store.getState())
    if (ann.app) Object.assign(ann.app.useP2p.getInitialState(), ann.app.useP2p.getState())
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <TypingLine bg="bg-surface" />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('data-typing')
    expect(html).toContain('is typing')
  })

  test('a text fits by its count and, between identities, by its size', () => {
    const main = seat(world(), [])
    const { max } = main.state.get()
    expect(fits(main, 'a'.repeat(max), max)).toBe(true)
    expect(fits(main, 'a'.repeat(max + 1), max)).toBe(false)
  })

  test('one field draws either side', () => {
    const main = seat(world(), [])
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <ComposerField
              compose={main}
              listKey={null}
              placeholder={unnamed('Message')}
              slowLeft={0}
              bar={null}
              later={() => null}
              onSend={() => {}}
            />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('see you at noon')
    expect(html).toContain('aria-label="Emoji"')
    expect(html).toContain('aria-label="Send"')
  })

  test('a draft is sent on the side of the place, and held back while slow mode runs', async () => {
    for (const list of ['main', 'thread'] as const) {
      const calls: unknown[][] = []
      const here = seat(world(), calls, list)
      const { ann } = world()
      const key = list === 'main' ? mainKey() : threadKey()
      const text = list === 'main' ? 'see you at noon' : 'in the thread'
      if (hosted)
        ann.account.store.setState({
          sendMessage: (...a: unknown[]) => void calls.push(['send', ...a]),
          sendThreadMessage: (...a: unknown[]) => void calls.push(['reply', ...a]),
        } as never)
      else if (ann.app)
        Object.assign(ann.app.p2pDm, {
          send: async (...a: unknown[]) => {
            calls.push(['send', ...a])
            return true
          },
        })
      here.send(() => calls.push(['keep']))
      await Promise.resolve()
      expect(calls).toEqual([
        hosted
          ? [list === 'main' ? 'send' : 'reply', text, undefined, undefined, []]
          : ['send', key, text, []],
        ['draft', key, ''],
      ])
      calls.length = 0
      const card = { title: 'Card' }
      expect(here.embeds.get().can).toBe(true)
      here.setEmbeds([card])
      expect(here.embeds.get().held).toEqual([card])
      calls.length = 0
      here.send(() => calls.push(['keep']))
      await Promise.resolve()
      expect(calls[0]).toEqual(
        hosted
          ? [list === 'main' ? 'send' : 'reply', text, undefined, undefined, [card]]
          : ['send', key, text, [card]]
      )
      await Promise.resolve()
      expect(here.embeds.get().held).toEqual([])
      if (kind === 'hostedDm') continue
      calls.length = 0
      const until = Number.MAX_SAFE_INTEGER
      if (hosted) ann.account.store.setState({ slowUntil: { 1: until } })
      else ann.app?.useP2p.setState({ slowUntil: { [mainKey()]: until } })
      expect(here.state.get().slowUntil).toBe(until)
      here.send(() => {})
      await Promise.resolve()
      expect(calls).toEqual([])
      if (hosted) ann.account.store.setState({ slowUntil: {} })
      else ann.app?.useP2p.setState({ slowUntil: {} })
    }
  })

  test('a draft holds files where the place takes them, and one card draws either', () => {
    const calls: unknown[][] = []
    const main = seat(world(), calls)
    const { ann } = world()
    const key = mainKey()
    const file = new File(['x'], 'cat.png', { type: 'image/png' })
    const settings = { ...ann.account.store.getState().settings }
    ann.account.store.setState({
      settings: { ...settings, asset_uploads: true, p2p_attachments: true },
    })
    if (hosted)
      ann.account.store.setState({
        pending: { [key]: { file, spoiler: false, mode: 'server', scope: key } },
        toggleSpoiler: (k: string) => void calls.push(['spoiler', k]),
        setUploadAlt: (k: string, alt: string) => void calls.push(['alt', k, alt]),
      } as never)
    else if (ann.app) {
      ann.app.useP2p.setState({
        attaching: {
          [key]: [
            {
              id: 4,
              file,
              spoiler: false,
              progress: 0.5,
              hashed: null,
              preview: null,
              error: null,
            },
          ],
        },
      })
      Object.assign(ann.app.p2pFiles, {
        toggleSpoiler: (k: string, id: number) => void calls.push(['spoiler', k, id]),
        setAlt: (k: string, id: number, alt: string) => void calls.push(['alt', k, id, alt]),
      })
    }
    const files = main.files.get()
    expect(main.files.get()).toBe(files)
    expect(files.add).toBe(hosted ? 'one' : 'many')
    expect(files.peer).toBe(!hosted)
    expect(files.stuck).toBe(false)
    expect(files.held.map(f => f.file.name)).toEqual(['cat.png'])
    expect(files.held[0].mode).toEqual(hosted ? { now: 'server', switchable: true } : null)
    expect(files.held[0].status).toEqual(hosted ? null : { kind: 'preparing', done: 0.5 })
    const { id } = files.held[0]
    main.toggleSpoiler(id)
    main.describe(id, 'a cat')
    expect(calls).toEqual(
      hosted
        ? [
            ['spoiler', key],
            ['alt', key, 'a cat'],
          ]
        : [
            ['spoiler', key, 4],
            ['alt', key, 4, 'a cat'],
          ]
    )
    expect(seat(world(), [], 'thread').files.get().held).toEqual([])
    Object.assign(ann.account.store.getInitialState(), ann.account.store.getState())
    if (ann.app) Object.assign(ann.app.useP2p.getInitialState(), ann.app.useP2p.getState())
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <ComposerFiles compose={main} />
            <AttachButton compose={main} />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html.match(/data-pending-file/g)?.length).toBe(1)
    expect(html).toContain('cat.png')
    expect(html).toContain('aria-label="Remove file"')
    expect(html).toContain('aria-label="Describe this image"')
    expect(html).toContain(hosted ? 'aria-label="Attach a file"' : 'aria-label="Attach files"')
    ann.account.store.setState({
      settings: { ...settings, asset_uploads: false, p2p_attachments: false },
    })
    expect(main.files.get().add).toBeNull()
    expect(main.paste([file])).toBe(false)
  })

  // Ann as a member who may write here, then with `change` on her side of the place.
  const gated = (change: (hostedState: () => Partial<RChatState>) => void, peer: object = {}) => {
    const main = seat(world(), [])
    const { ann, server } = world()
    if (hosted) {
      const mine = { name: server, timed_out_until: undefined as number | undefined }
      const me = { ...user('ann'), servers: [mine] }
      ann.account.store.setState({ me } as never)
      change(() => ({ me: { ...me, servers: [{ ...mine }] } }) as never)
    } else if (ann.app) {
      const state = {
        reader: false,
        elsewhere: false,
        status: 'ready',
        movedAt: null,
        movingAt: null,
        contacts: [{ ik: 'B', name: 'Bob', state: 'mutual' }],
        rooms: { [world().room]: { peer: 'B', full: false } },
        ...(kind === 'p2pDm' ? { chat: { room: world().room, ch: null, peer: 'B' } } : {}),
        ...peer,
      }
      ann.app.useP2p.setState(state as never)
    }
    return main
  }
  const drawn = (main: ReturnType<typeof seat>) => {
    const { account, app } = world().ann
    Object.assign(account.store.getInitialState(), account.store.getState())
    if (app) Object.assign(app.useP2p.getInitialState(), app.useP2p.getState())
    return renderToStaticMarkup(
      <AccountProvider session={world().ann.account}>
        <P2pProvider identity={world().ann.app}>
          <ComposerGate compose={main} list="main" />
        </P2pProvider>
      </AccountProvider>
    )
  }

  test('files dropped on a conversation go to its draft, and nowhere while its composer is shut', () => {
    gated(() => {})
    const { ann } = world()
    const { account, app, place } = ann
    const settings = { ...account.store.getState().settings }
    const dropped: string[] = []
    account.store.setState({
      settings: { ...settings, asset_uploads: true, p2p_attachments: true },
      uploadFile: (_key: string, file: File) => void dropped.push(file.name),
    } as never)
    if (app)
      Object.assign(app.p2pFiles, {
        add: (_key: string, files: File[]) => void dropped.push(...files.map(f => f.name)),
      })
    const drop = () => {
      let handlers: ReturnType<typeof useFileDrop>['handlers'] | null = null
      function Probe() {
        handlers = useFileDrop({ place }).handlers
        return null
      }
      Object.assign(account.store.getInitialState(), account.store.getState())
      if (app) Object.assign(app.useP2p.getInitialState(), app.useP2p.getState())
      renderToStaticMarkup(
        <AccountProvider session={account}>
          <P2pProvider identity={app}>
            <Probe />
          </P2pProvider>
        </AccountProvider>
      )
      const files = [new File(['x'], 'cat.png', { type: 'image/png' })]
      handlers!.onDrop({
        preventDefault: () => {},
        dataTransfer: { files, types: ['Files'] },
      } as never)
    }
    drop()
    expect(dropped).toEqual(['cat.png'])
    if (hosted) account.store.setState({ guest: true } as never)
    else app?.useP2p.setState({ elsewhere: true })
    drop()
    expect(dropped).toEqual(['cat.png'])
  })

  test('the field says what it writes to, and one composer draws either side', () => {
    const thread = seat(world(), [], 'thread')
    const main = gated(() => {})
    const { to, peer, listKey, poll } = main.state.get()
    expect(main.state.get().to).toBe(to)
    expect(peer).toBe(!hosted)
    expect(listKey).not.toBeNull()
    expect<string | null>(to.hidden).toBe(
      hosted ? (kind === 'hostedDm' ? 'Send a direct message' : null) : 'Send a P2P message'
    )
    if (kind === 'hostedServer' || kind === 'p2pRoom') expect(to.what?.kind).toBe('channel')
    if (kind === 'p2pDm' && to.what?.kind === 'person') expect(nameText(to.what.name)).toBe('Bob')
    expect(thread.state.get().to.what).toEqual({ kind: 'thread' })
    if (!hosted) expect(isUnsupported(poll) && poll.line).toBe('Polls are not available in P2P')
    if (kind === 'hostedServer') expect(poll).toEqual({ kind: 'channel', id: 1 })
    const { account, app } = world().ann
    Object.assign(account.store.getInitialState(), account.store.getState())
    if (app) Object.assign(app.useP2p.getInitialState(), app.useP2p.getState())
    const html = renderToStaticMarkup(
      <AccountProvider session={account}>
        <P2pProvider identity={app}>
          <PlaceProvider place={world().ann.place}>
            <Composer />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain(`data-composer="${hosted ? 'hosted' : 'p2p'}"`)
    expect(html).toContain('see you at noon')
    expect(html).toContain('aria-label="Send"')
    expect(html.includes('aria-label="Create poll"')).toBe(main.state.get().poll !== null)
    expect(
      /disabled=""[^>]*aria-label="Create poll"|aria-label="Create poll"[^>]*disabled=""/.test(html)
    ).toBe(!hosted)
    if (!hosted) expect(html).toContain('title="Polls are not available in P2P"')
    if (kind === 'p2pDm') expect(html).toContain('placeholder="Message Bob')
  })

  test('a draft is scheduled where the place keeps its scheduled messages', async () => {
    const calls: unknown[][] = []
    const main = seat(world(), calls)
    const { ann } = world()
    const key = mainKey()
    if (hosted)
      ann.account.store.setState({
        scheduleDraft: async (k: string, at: number) => {
          calls.push(['later', k, at])
          return null
        },
      } as never)
    else if (ann.app)
      Object.assign(ann.app.p2pScheduled, {
        add: async (k: string, d: { at: number; draft: string }) => {
          calls.push(['later', k, d.at, d.draft])
          return null
        },
        here: () => true,
      })
    const later = main.later.get()
    expect(main.later.get()).toBe(later)
    expect(later.side).toBe(hosted ? 'hosted' : 'device')
    expect(later.ops?.side).toBe(later.side)
    expect(later.notice).toBe(hosted ? `scheduled:${key}` : null)
    expect(await main.scheduleAt(9_000)).toBeNull()
    expect(calls).toEqual([
      hosted ? ['later', key, 9_000] : ['later', key, 9_000, 'see you at noon'],
    ])
    let picked = 0
    const draft = main.laterDraft({ pick: () => void picked++, busy: false })
    expect(draft).toMatchObject({
      side: later.side,
      place: key,
      text: 'see you at noon',
      reply: null,
    })
    draft?.pick()
    expect(picked).toBe(1)
    expect(main.laterDraft({ pick: () => {}, busy: true })?.blocked).not.toBeNull()
  })

  test('a member who may write has an open composer', () => {
    const main = gated(() => {})
    const gate = main.gate.get()
    expect(main.gate.get()).toBe(gate)
    expect(gate).toEqual({ first: null, until: null, then: null })
    expect(drawn(main)).toBe('')
  })

  test('what holds the composer back is said in its place', () => {
    if (hosted) {
      const main = gated(() => {})
      const { ann, server } = world()
      if (kind === 'hostedDm') {
        const bob = user('bob')
        const asked: unknown[][] = []
        ann.account.store.setState({
          dms: [{ id: world().dmId, other: bob }],
          blocked: { bob: true },
          unblockUser: async (...a: unknown[]) => void asked.push(a),
        } as never)
        expect(main.gate.get().first).toMatchObject({ kind: 'blocked', unblock: true })
        expect(drawn(main)).toContain('data-blocked')
        expect(drawn(main)).toContain('Unblock')
        main.unblock()
        expect(asked).toEqual([[bob.username, bob.display_name]])
        ann.account.store.setState({ blocked: {} } as never)
        expect(main.gate.get().first).toBeNull()
        ann.account.store.setState({ guest: true } as never)
        expect(main.gate.get().first?.kind).toBe('guest')
        expect(drawn(main)).toContain('data-guest-notice')
        return
      }
      ann.account.store.setState({ me: { ...user('ann'), servers: [] } } as never)
      expect(main.gate.get().first).toEqual({ kind: 'join', server, name: server })
      expect(drawn(main)).toContain('data-preview-bar')
      expect(drawn(main)).toContain('Join server')
      const until = Math.floor(Date.now() / 1000) + 600
      const mine = { name: server, timed_out_until: until }
      ann.account.store.setState({ me: { ...user('ann'), servers: [mine] } } as never)
      expect(main.gate.get()).toEqual({ first: null, until: until * 1000, then: null })
      expect(drawn(main)).toContain('data-timed-out')
      return
    }
    const away = gated(() => {}, { elsewhere: true })
    expect(away.gate.get().first).toEqual({ kind: 'elsewhere' })
    const moved = gated(() => {}, { status: 'moved', movedAt: 5 })
    expect(moved.gate.get().first).toEqual({ kind: 'moved', at: 5 })
    if (kind === 'p2pRoom') {
      const { ann, room } = world()
      const joined = (perms: bigint) => ({
        servers: {
          [room]: {
            id: room,
            me: 'join',
            members: [],
            channels: [{ id: 'c1', perms, send: true }],
          },
        },
        thread: { room, ch: 'c1', root: 'r1', loading: false, head: null, messages: [] },
      })
      const seen = ChannelPermBit.ViewChannels + ChannelPermBit.SendMessages
      gated(() => {}, joined(seen))
      const here = featureAt(composer, ann.place)
      if (isUnsupported(here)) throw new Error('a room has a composer')
      const thread = here.at('thread')
      expect(thread.gate.get().then).toEqual({ kind: 'noThreads' })
      expect(drawn(thread)).toContain(NO_THREADS_TEXT)
      ann.app?.useP2p.setState(joined(seen + ChannelPermBit.StartThreads) as never)
      expect(thread.gate.get().then).toBeNull()
    }
    if (kind === 'p2pDm') {
      const alone = gated(() => {}, { contacts: [] })
      expect(alone.gate.get().first).toEqual({ kind: 'noContact' })
      expect(drawn(alone)).toContain('This contact was removed.')
      const blocked = gated(() => {}, { contacts: [{ ik: 'B', name: 'Bob', state: 'blocked' }] })
      expect(blocked.gate.get().first?.kind).toBe('blocked')
      expect(
        /<span>You blocked .*Remove the block to message them again\.<\/span>/.test(drawn(blocked))
      ).toBe(true)
    }
  })
})
