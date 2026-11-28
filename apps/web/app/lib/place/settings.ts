import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import { serverAdminPerms } from '../selectors'
import {
  ROOM_SECTIONS,
  ROOM_SECTION_TEXT,
  SERVER_SECTION_LABELS,
  serverSettingsRows,
  serverSettingsSections,
} from '../server_settings_sections'
import type { SearchRow } from '../settings_search'
import { defineFeature, notInDms } from './feature'
import { built, type Live } from './live'

// A section of a place's settings as its nav lists it. `id` names its body and its icon.
export interface SettingsSection {
  id: string
  label: string
  // What search finds in it.
  rows: SearchRow[]
}

export interface PlaceSettings {
  // The sections you see, in nav order; null when the place has no settings to show you.
  sections: Live<SettingsSection[] | null>
  close: () => void
}

const hosted = (account: AccountSession, server: string): PlaceSettings => {
  const { store } = account
  const sections = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        return [
          s.servers[server] !== undefined && s.me !== null,
          serverAdminPerms(s, server),
          s.settings.server_profiles !== false,
        ] as const
      },
      ([here, perms, profiles]) => {
        if (!here || perms === 0n) return null
        const viewer = { perms, builtin: server === 'rchat', profiles }
        return serverSettingsSections(viewer).map((id): SettingsSection => ({
          id,
          label: SERVER_SECTION_LABELS[id],
          rows: serverSettingsRows(id, viewer),
        }))
      }
    )
  return {
    sections: {
      get: sections(false),
      initial: sections(true),
      subscribe: changed => store.subscribe(changed),
    },
    close: () => store.getState().closeDialog(),
  }
}

const ROOM: SettingsSection[] = ROOM_SECTIONS.map(id => ({
  id,
  label: ROOM_SECTION_TEXT[id].label,
  rows: [{ section: id, id: `p2p_${id}`, ...ROOM_SECTION_TEXT[id] }],
}))

const peer = (app: P2pApp, room: string): PlaceSettings => {
  const { useP2p, p2p } = app
  const sections = (initial: boolean) => () =>
    (initial ? useP2p.getInitialState() : useP2p.getState()).servers[room] ? ROOM : null
  return {
    sections: {
      get: sections(false),
      initial: sections(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    close: () => p2p.closeDialog(),
  }
}

// The settings of a server or a room: which sections you see there.
export const settings = defineFeature<PlaceSettings>('settings', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
