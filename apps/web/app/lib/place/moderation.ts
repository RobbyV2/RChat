import type { ShownPerson } from '../people'
import {
  HOSTED_BAN,
  HOSTED_BAN_NOTE,
  P2P_BAN_NOTE,
  p2pBan,
  p2pBanSupport,
  type BanChoice,
  type BanSupport,
  type TimeoutChoice,
} from '../durations'
import { P } from '../p2p/state'
import { userRefFor } from '../selectors'
import { lookOf, shownUser } from '../server_profile'
import type { ConfirmRequest } from '../store_types'
import type { Timeout } from '../timeouts'
import type { MemberLook, UserRef } from '../types'
import { defineFeature, featureAt, isUnsupported, notInDms } from './feature'
import { constant, derived, fromStore, type Live } from './live'
import type { HostedServer, P2pRoom } from './place'

// A member as the moderation dialogs name them.
export interface Moderated {
  name: string
  // Their account as the place shows it; null where members have none.
  user: ShownPerson | null
  // The timeout set for them, which may have ended.
  timeout: Timeout | null
}

// Kicks, bans and timeouts of a place. `who` is a member as the place keys them: a username in
// a hosted server, an identity key in a P2P room.
export interface Moderation {
  // `known`: what the opener already shows of them.
  member: (who: string, known?: UserRef) => Live<Moderated>
  // The confirmation of a kick; `after` runs once the kick is done.
  kickRequest: (who: string, after?: () => void) => ConfirmRequest
  ban: {
    title: string
    note: string
    support: Live<BanSupport>
    run: (who: string, choice: BanChoice) => Promise<boolean> | boolean
  }
  timeout: (who: string, choice: TimeoutChoice) => Promise<boolean> | boolean
  untimeout: (who: string) => void
}

export type ModerationPlace = HostedServer | P2pRoom

type Parts = readonly [UserRef, MemberLook | null, Timeout | null]

const sameLook = (a: MemberLook | null, b: MemberLook | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.name === b.name &&
    a.avatar_kind === b.avatar_kind &&
    a.avatar_color === b.avatar_color)

const hosted = ({ account, server }: HostedServer): Moderation => {
  const { store } = account
  return {
    member: (who, known) =>
      derived(
        fromStore(
          store,
          (s): Parts => [
            known ?? userRefFor(s, who),
            lookOf(s, { server }, who),
            s.timeouts[server]?.[who] ?? null,
          ],
          (a, b) => a[0] === b[0] && sameLook(a[1], b[1]) && a[2] === b[2]
        ),
        ([ref, look, timeout]) => {
          const user = shownUser(ref, look)
          return { name: user.display_name, user, timeout }
        }
      ),
    kickRequest: (who, after) => ({
      title: 'Kick Member',
      body: 'Kick this member? They are removed from the server but can join again.',
      confirm: 'Kick',
      reason: true,
      action: (_choice, reason) =>
        void store
          .getState()
          .kickMember(server, who, reason)
          .then(after && account.lifetime.inSession(after)),
    }),
    ban: {
      title: 'Ban from Server',
      note: HOSTED_BAN_NOTE,
      support: constant(HOSTED_BAN),
      run: (who, choice) => store.getState().banMember(server, who, choice),
    },
    timeout: (who, choice) =>
      store.getState().timeoutMember(server, who, choice.seconds, choice.reason ?? ''),
    untimeout: who => void store.getState().removeTimeout(server, who),
  }
}

const peer = ({ app, account, room }: P2pRoom): Moderation => {
  const support = fromStore(
    app.useP2p,
    s => {
      const v = s.servers[room]
      return p2pBanSupport(v?.timedBans === true, ((v?.perms ?? 0) & P.ManageMessages) !== 0)
    },
    (a, b) => a.timed === b.timed && a.purge === b.purge
  )
  // The display filter and streamer mode are the account's.
  const shown = (name: string) => (account.store.getState().streamer ? 'this member' : name)
  return {
    member: who =>
      fromStore(
        app.useP2p,
        (s): Moderated => {
          const m = s.servers[room]?.members.find(x => x.ik === who)
          return {
            name: shown(m?.name ?? app.memberName(room, who)),
            user: null,
            timeout:
              m?.timeoutUntil === undefined
                ? null
                : { ends: m.timeoutUntil, reason: m.timeoutReason ?? null },
          }
        },
        (a, b) =>
          a.name === b.name &&
          a.timeout?.ends === b.timeout?.ends &&
          a.timeout?.reason === b.timeout?.reason
      ),
    kickRequest: (who, after) => {
      const m = app.useP2p.getState().servers[room]?.members.find(x => x.ik === who)
      return {
        title: 'Kick Member',
        body: `Kick ${shown(m?.name ?? app.memberName(room, who))}? They can come back with a new invite.`,
        confirm: 'Kick',
        reason: true,
        action: app.inIdentity(
          (_choice: string, reason?: string) =>
            void app.p2pServer.kick(room, who, reason).then(after)
        ),
      }
    },
    ban: {
      title: 'Ban Member',
      note: P2P_BAN_NOTE,
      support,
      // The dialog closes once the ban is asked for; a ban waiting for the room to sync shows
      // with the other moderation actions that wait.
      run: (who, choice) => {
        void app.p2pServer.ban(room, who, p2pBan(choice, support.get()))
        return true
      },
    },
    timeout: (who, choice) => {
      void app.p2pServer.timeout(room, who, choice.seconds, choice.reason ?? undefined)
      return true
    },
    untimeout: who => void app.p2pServer.untimeout(room, who),
  }
}

export const moderation = defineFeature<Moderation>('moderation', {
  hostedServer: hosted,
  p2pRoom: peer,
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})

// Moderation of a server or a room, which both have it.
export const moderationOf = (place: ModerationPlace): Moderation => {
  const here = featureAt(moderation, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

const dialogs = (place: ModerationPlace) => place.account.store.getState()

export const askKick = (place: ModerationPlace, who: string, after?: () => void) =>
  dialogs(place).askConfirm(moderationOf(place).kickRequest(who, after))
export const openBan = (place: ModerationPlace, who: string, known?: UserRef) =>
  dialogs(place).openDialog({ kind: 'ban', place, who, ...(known ? { known } : {}) })
export const openTimeout = (place: ModerationPlace, who: string, known?: UserRef) =>
  dialogs(place).openDialog({ kind: 'timeout', place, who, ...(known ? { known } : {}) })
