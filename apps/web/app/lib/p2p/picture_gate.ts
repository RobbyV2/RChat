import { picFiles, type P2pPic } from './pictures'

// What a picture file was made for on this device: the picture of our identity, our picture in
// one room, or one room's own picture.
export type PictureScope = 'identity' | `profile:${string}` | `about:${string}`

// Who may fetch a picture's files from this device, and whom to ask for someone's. A picture is
// no message attachment: the gates of conversations know nothing of it, so it has its own.
export interface PictureGate {
  // Whether `ik` may fetch the file `h` from us.
  entitled: (ik: string, h: string) => Promise<boolean>
  // Who to ask for the file `h`.
  holders: (h: string) => string[]
}

// What the gate reads: our own pictures, our contacts, and the rooms we are in.
export interface PictureFacts {
  me: string | null
  // The picture of our identity.
  own: P2pPic | null
  // The contacts we exchange files with, each with the picture they sent.
  contacts: readonly { ik: string; pic: P2pPic | null }[]
  // The rooms we are joined in: our picture there (`mine`), whether the room shows the picture
  // of our identity instead (`identity`), the room's own picture, and the other joined members
  // with the picture each of them names.
  rooms: readonly {
    id: string
    mine: P2pPic | null
    identity: boolean
    about: P2pPic | null
    members: readonly { ik: string; pic: P2pPic | null }[]
  }[]
}

const has = (pic: P2pPic | null, h: string) => picFiles(pic).some(f => f.h === h)

// This device serves a file only as the picture it made it for (`made`): the picture of our
// identity to our contacts and to the joined members of the rooms that show it, our picture in
// a room to that room's joined members, and a room's own picture to its joined members. A file
// made for one of these never answers for another, and a hash someone names as a picture
// entitles nobody to a file we hold for another reason, so naming the hash of a file learned
// elsewhere fetches nothing. A picture is asked of the one who names it as theirs; a room's of
// its members.
export const pictureGate = (
  facts: () => PictureFacts,
  made: (h: string, scope: PictureScope) => Promise<boolean>
): PictureGate => ({
  async entitled(ik, h) {
    const f = facts()
    if (ik === f.me) return false
    const scopes = new Set<PictureScope>()
    if (has(f.own, h) && f.contacts.some(c => c.ik === ik)) scopes.add('identity')
    for (const room of f.rooms) {
      if (!room.members.some(m => m.ik === ik)) continue
      if (has(room.mine, h)) scopes.add(`profile:${room.id}`)
      if (room.identity && has(f.own, h)) scopes.add('identity')
      if (has(room.about, h)) scopes.add(`about:${room.id}`)
    }
    for (const scope of scopes) if (await made(h, scope)) return true
    return false
  },
  holders(h) {
    const f = facts()
    const out = new Set<string>()
    for (const c of f.contacts) if (has(c.pic, h)) out.add(c.ik)
    for (const room of f.rooms)
      for (const m of room.members) if (has(m.pic, h) || has(room.about, h)) out.add(m.ik)
    if (f.me) out.delete(f.me)
    return [...out]
  },
})
