import { AVATAR_IMAGES } from '../../avatar_images'
import { PIC_LIMITS, parsePic, type P2pFile, type P2pPic } from '../pictures'
import type { PictureFacts, PictureScope } from '../picture_gate'
import type { P2pState } from './store'

// The picture of an identity as this device knows it outside any room: our own, or the one a
// contact sent.
export const identityPicOf = (
  s: Pick<P2pState, 'ik' | 'pic' | 'contacts'>,
  ik: string
): P2pPic | null =>
  ik === s.ik ? s.pic : (parsePic(s.contacts.find(c => c.ik === ik)?.pic) ?? null)

let last: {
  servers: P2pState['servers']
  contacts: P2pState['contacts']
  facts: PictureFacts
} | null = null

// What the gate of picture files reads from the state. The same contacts and rooms give the
// same facts, so a burst of requests reads them once.
export const pictureFacts = (
  s: Pick<P2pState, 'ik' | 'pic' | 'contacts' | 'servers'>
): PictureFacts => {
  if (last?.servers === s.servers && last.contacts === s.contacts && last.facts.own === s.pic)
    return last.facts
  const facts: PictureFacts = {
    me: s.ik,
    own: s.pic,
    contacts: s.contacts
      .filter(c => c.state === 'mutual')
      .map(c => ({ ik: c.ik, pic: parsePic(c.pic) ?? null })),
    rooms: Object.values(s.servers)
      .filter(v => v.me === 'join')
      .map(v => {
        const mine = parsePic(v.profile.rpic) ?? null
        return {
          id: v.id,
          mine,
          // Without a picture or an avatar kind of our own there, the room shows the picture of
          // our identity.
          identity: mine === null && !v.profile.av,
          about: v.about.pic ?? null,
          members: v.members
            .filter(m => m.m === 'join' && m.ik !== s.ik)
            .map(m => ({ ik: m.ik, pic: m.pic ?? null })),
        }
      }),
  }
  last = { servers: s.servers, contacts: s.contacts, facts }
  return facts
}

export const PICTURE_TOO_DETAILED = 'This picture is too detailed to send. Choose a smaller part.'
export const P2P_NOT_RUNNING = 'P2P is not running on this device'

// The files this device keeps and peers fetch for a picture made here.
export interface PictureKeeper {
  keepPicture: (files: readonly Blob[], scope: PictureScope) => Promise<P2pFile[] | null>
}

// A P2P picture from the files the shared module made (one per size in `AVATAR_IMAGES.sizes`):
// the 128 and 512 pixel files, kept on this device as the picture `scope` names for peers to
// fetch. The text of what went
// wrong when there is none.
export async function keptPic(
  keeper: PictureKeeper,
  made: { files: Blob[]; animation?: Blob | null } | { error: string },
  scope: PictureScope
): Promise<P2pPic | string> {
  if ('error' in made) return made.error
  const stills = AVATAR_IMAGES.p2p_sizes.map(
    side => made.files[(AVATAR_IMAGES.sizes as readonly number[]).indexOf(side)]
  )
  if (stills.some(file => !file || file.size < 1 || file.size > PIC_LIMITS.still))
    return PICTURE_TOO_DETAILED
  const moving =
    made.animation && made.animation.size <= PIC_LIMITS.animated ? made.animation : null
  const kept = await keeper.keepPicture(moving ? [...stills, moving] : stills, scope)
  if (!kept || kept.length < 2) return P2P_NOT_RUNNING
  return { s: kept[0], l: kept[1], ...(moving && kept[2] ? { a: kept[2] } : {}) }
}
