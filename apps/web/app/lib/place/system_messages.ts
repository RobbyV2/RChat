import { viewCan } from '../p2p/roles'
import { P } from '../p2p/state'
import { ownsP2pServer } from '../p2p/server/types'
import { myPerms } from '../selectors'
import { choiceId, systemChoices, type SystemChoice } from '../system_messages'
import { Perm, hasPerm, type SystemMessages as HostedSettings } from '../types'
import { defineFeature, featureAt, isUnsupported, notInDms } from './feature'
import { derived, fromStore, type Live } from './live'
import type { HostedServer, P2pRoom } from './place'

// Where join and leave lines go and which of them show. `channel` is a choice's value; '' is
// the default channel (the first text channel).
export interface SystemSettings {
  channel: string
  join: boolean
  leave: boolean
}

export type SystemState =
  | { state: 'loading' }
  | { state: 'failed' }
  | {
      state: 'ready'
      settings: SystemSettings
      choices: SystemChoice[]
      // Whether channel names go through your display filter.
      masked: boolean
    }

// The right to change the settings of one place. Only a side of the feature makes one, for
// someone it found to hold Manage Server there.
class Editor {
  declare private readonly held: true
  constructor(readonly save: (patch: Partial<SystemSettings>) => Promise<void>) {}
}
export type SystemEditor = Editor

export interface SystemMessagesAt {
  settings: Live<SystemState>
  // Null while you may not change the settings here.
  editor: Live<SystemEditor | null>
  // Fetches the settings where the place keeps them elsewhere.
  load: () => void
  // What the place adds under the settings.
  note: string | null
}

export type SystemPlace = HostedServer | P2pRoom

const LOADING: SystemState = { state: 'loading' }
const FAILED: SystemState = { state: 'failed' }

const hosted = ({ account, server }: HostedServer): SystemMessagesAt => {
  const { store, api } = account
  type Saved = HostedSettings | 'loading' | 'failed'
  type Channels = { id: number; name: string; kind?: string }[] | undefined
  let saved = 'loading' as Saved
  let turn = 0
  const waiting = new Set<() => void>()
  const set = (next: Saved) => {
    saved = next
    for (const changed of waiting) changed()
  }
  const channels = (): Channels => store.getState().servers[server]?.channels
  let shown: { saved: Saved; channels: Channels; state: SystemState } = {
    saved,
    channels: undefined,
    state: LOADING,
  }
  const read = (): SystemState => {
    const list = channels()
    if (shown.saved === saved && shown.channels === list) return shown.state
    const state: SystemState =
      saved === 'loading'
        ? LOADING
        : saved === 'failed'
          ? FAILED
          : {
              state: 'ready',
              settings: {
                channel: saved.channel_id === null ? '' : String(saved.channel_id),
                join: saved.join_messages,
                leave: saved.leave_messages,
              },
              choices: systemChoices(list ?? [], saved.channel_id),
              masked: false,
            }
    shown = { saved, channels: list, state }
    return state
  }
  const load = () => {
    const mine = ++turn
    if (typeof saved === 'string') set('loading')
    api.systemMessages(server).then(
      account.lifetime.inSession((s: HostedSettings) => {
        if (mine === turn) set(s)
      }),
      account.lifetime.inSession(() => {
        if (mine === turn && typeof saved === 'string') set('failed')
      })
    )
  }
  const editor = new Editor(async patch => {
    const before = saved
    const body: Partial<HostedSettings> = {
      ...(patch.channel === undefined ? {} : { channel_id: choiceId(patch.channel) }),
      ...(patch.join === undefined ? {} : { join_messages: patch.join }),
      ...(patch.leave === undefined ? {} : { leave_messages: patch.leave }),
    }
    const mine = ++turn
    if (typeof before !== 'string') set({ ...before, ...body })
    try {
      const next = await api.updateSystemMessages(server, body)
      if (mine === turn) set(next)
    } catch (err) {
      if (mine === turn) set(before)
      throw err
    }
  })
  return {
    settings: {
      get: read,
      subscribe: changed => {
        waiting.add(changed)
        const off = store.subscribe(changed)
        return () => {
          waiting.delete(changed)
          off()
        }
      },
    },
    editor: derived(
      fromStore(store, s => s.me !== null && hasPerm(myPerms(s, server), Perm.ManageServer)),
      may => (may ? editor : null)
    ),
    load,
    note: null,
  }
}

const peer = ({ app, room }: P2pRoom): SystemMessagesAt => {
  const view = () => app.useP2p.getState().servers[room]
  const editor = new Editor(async patch => {
    const v = view()
    if (!v) return
    const next = {
      ch: patch.channel === undefined ? v.systemPick : patch.channel || null,
      join: patch.join ?? v.system.join,
      leave: patch.leave ?? v.system.leave,
    }
    if (next.ch === v.systemPick && next.join === v.system.join && next.leave === v.system.leave)
      return
    await app.p2pServer.setSystem(room, next)
  })
  return {
    settings: derived(
      fromStore(
        app.useP2p,
        s => {
          const v = s.servers[room]
          return [v?.system, v?.systemPick, v?.channels, !!v && !ownsP2pServer(v, s.me)] as const
        },
        (a, b) => a.every((x, i) => Object.is(x, b[i]))
      ),
      ([system, pick, channels, masked]): SystemState =>
        system === undefined || channels === undefined
          ? LOADING
          : {
              state: 'ready',
              settings: { channel: pick ?? '', join: system.join, leave: system.leave },
              choices: systemChoices(channels, pick ?? null),
              masked,
            }
    ),
    editor: derived(
      fromStore(app.useP2p, s => {
        const v = s.servers[room]
        return !!v && viewCan(v, P.ManageServer)
      }),
      may => (may ? editor : null)
    ),
    load: () => {},
    note: "Every member's device writes these lines itself from who joins and leaves.",
  }
}

export const systemMessages = defineFeature<SystemMessagesAt>('system messages', {
  hostedServer: hosted,
  p2pRoom: peer,
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})

// The join and leave message settings of a server or a room, which both have them.
export const systemMessagesOf = (place: SystemPlace): SystemMessagesAt => {
  const here = featureAt(systemMessages, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}
