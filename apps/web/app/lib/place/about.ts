import type { AvatarCrop } from '../avatar_images'
import { ask, sendTo } from '../asks'
import type { AccountSession } from '../client/session'
import { errorText } from '../slices/ctx'
import { limitsOf } from '../instance_limits'
import { keptPic } from '../p2p/app/pictures'
import type { P2pApp } from '../p2p/app/runtime'
import type { P2pPic } from '../p2p/pictures'
import { hex, viewCan } from '../p2p/roles'
import { ownsP2pServer } from '../p2p/server/types'
import { P } from '../p2p/state'
import { pictureFiles } from '../picture_files'
import {
  hostedAbout,
  hostedAboutPatch,
  type AboutChange,
  type ServerAbout,
  type ServerIconKind,
} from '../server_about'
import { defineFeature, notInDms } from './feature'
import { built, type Live } from './live'

// The picture a server's icon shows while its about is edited.
export type AboutGlyph =
  | { kind: 'hosted'; server: string; displayName: string }
  | {
      kind: 'room'
      seed: string
      name: string
      icon: ServerIconKind
      color: string | null
      pic: P2pPic | undefined
    }

export interface AboutState {
  ready: boolean
  // The name as it is now, and the longest one the place takes (null: no limit of its own).
  name: string
  nameMax: number | null
  // Whether the reader may rename the server; the line that says why not, where one shows.
  canRename: boolean
  renameLocked: string | null
  // The about (text, icon, picture) shows for this server.
  shown: boolean
  seed: string
  color: string | null
  about: ServerAbout
  editable: boolean
  // The server is the reader's own: its text shows unmasked to them.
  own: boolean
  locked: string
  // Where its picture is kept; null for who may not change it.
  picture: { off: string | null; maxBytes: number; has: boolean } | null
  glyph: AboutGlyph
}

export interface PlaceAbout {
  state: Live<AboutState>
  // The text of what went wrong, or null once it is renamed.
  rename: (name: string) => Promise<string | null>
  save: (change: AboutChange) => Promise<unknown>
  upload: (file: Blob, crop: AvatarCrop) => Promise<string | null>
  removePicture: () => Promise<string | null>
}

const LOCKED = 'Only members with Manage server can change this.'
const RENAME_LOCKED = 'Only members with Manage server can rename the server.'

const failed = (change: Promise<unknown>) =>
  change.then(
    () => null,
    (e: unknown) => errorText(e)
  )

const WAITING = (seed: string): AboutState => ({
  ready: false,
  name: '',
  nameMax: null,
  canRename: false,
  renameLocked: null,
  shown: false,
  seed,
  color: null,
  about: { text: null, icon: 'letter' },
  editable: false,
  own: false,
  locked: LOCKED,
  picture: null,
  glyph: { kind: 'hosted', server: seed, displayName: seed },
})

const hosted = (account: AccountSession, server: string): PlaceAbout => {
  const { store } = account
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        const detail = s.servers[server]
        const me = s.me?.username ?? null
        return [
          detail,
          me !== null &&
            detail !== undefined &&
            (s.me?.servers.find(x => x.name === server)?.creator ?? detail.creator) === me,
          s.settings.profile_pictures,
          limitsOf(s.instance).avatar_upload_bytes,
        ] as const
      },
      ([detail, own, pictures, maxBytes]): AboutState => {
        if (!detail) return WAITING(server)
        const shown = server !== 'rchat'
        return {
          ready: true,
          name: detail.display_name,
          nameMax: null,
          canRename: shown,
          renameLocked: null,
          shown,
          seed: server,
          color: detail.banner_color ?? null,
          about: hostedAbout(detail),
          editable: true,
          own,
          locked: '',
          picture: {
            off: pictures ? null : 'Profile pictures are turned off on this site',
            maxBytes,
            has: !!detail.icon_image,
          },
          glyph: { kind: 'hosted', server, displayName: detail.display_name },
        }
      }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    rename: name =>
      store
        .getState()
        .renameServer(server, name)
        .then(
          () => {
            store.getState().closeDialog()
            return null
          },
          (e: unknown) => errorText(e)
        ),
    save: change => sendTo(account, ask.updateServer(server, hostedAboutPatch(change))),
    upload: (file, crop) => failed(sendTo(account, ask.putServerIcon(server, file as File, crop))),
    removePicture: () => failed(sendTo(account, ask.deleteServerIcon(server))),
  }
}

const peer = (app: P2pApp, room: string): PlaceAbout => {
  const { useP2p, p2p, p2pServer } = app
  const site = app.owner.store
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        const owner = initial ? site.getInitialState() : site.getState()
        return [
          s.servers[room],
          s.me,
          owner.settings.profile_pictures,
          limitsOf(owner.instance).avatar_upload_bytes,
          p2p.limits().server.nameMax,
        ] as const
      },
      ([v, me, pictures, maxBytes, nameMax]): AboutState => {
        if (!v) return WAITING(room)
        const edit = viewCan(v, P.ManageServer)
        const color = hex(v.color) ?? null
        return {
          ready: true,
          name: v.name,
          nameMax,
          canRename: edit,
          renameLocked: edit ? null : RENAME_LOCKED,
          shown: true,
          seed: v.id,
          color,
          about: v.about,
          editable: edit,
          own: ownsP2pServer(v, me),
          locked: LOCKED,
          picture: edit
            ? {
                off: pictures ? null : 'Profile pictures are turned off on this site',
                maxBytes,
                has: v.about.pic !== undefined,
              }
            : null,
          glyph: {
            kind: 'room',
            seed: v.id,
            name: v.name,
            icon: v.about.icon,
            color,
            pic: v.about.pic,
          },
        }
      }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => {
        const stops = [useP2p.subscribe(changed), site.subscribe(changed)]
        return () => stops.forEach(stop => stop())
      },
    },
    rename: name => failed(p2pServer.rename(room, name)),
    save: change => p2pServer.setAbout(room, change),
    upload: async (file, crop) => {
      const animated = site.getState().settings.animated_profile_pictures
      const made = await keptPic(
        app.p2pFiles,
        await pictureFiles(file, crop, animated),
        `about:${room}`
      )
      if (typeof made === 'string') return made
      return failed(p2pServer.setAbout(room, { pic: made }))
    },
    removePicture: () => failed(p2pServer.setAbout(room, { pic: null })),
  }
}

// What a server or a room is called and says about itself, and changing it.
export const about = defineFeature<PlaceAbout>('about', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
