import { picFiles, type P2pPic } from './pictures'

// Who may fetch a profile picture's files from this device, and whom to ask for someone's. A
// picture is no message attachment: the gates of conversations know nothing of it, so it has
// its own.
export interface PictureGate {
  // Whether `ik` may fetch the file `h` from us.
  entitled: (ik: string, h: string) => boolean
  // Who to ask for the file `h`.
  holders: (h: string) => string[]
}

// What the gate reads: our own pictures, our contacts, and the rooms we are in.
export interface PictureFacts {
  me: string | null
  // The picture of our identity, made on a device of ours.
  own: P2pPic | null
  // The contacts we exchange files with, each with the picture they sent.
  contacts: readonly { ik: string; pic: P2pPic | null }[]
  // The rooms we are joined in: the picture we show there (made on a device of ours), and the
  // other joined members with the picture each of them names.
  rooms: readonly {
    mine: P2pPic | null
    members: readonly { ik: string; pic: P2pPic | null }[]
  }[]
}

const has = (pic: P2pPic | null, h: string) => picFiles(pic).some(f => f.h === h)

// This device serves only the pictures it shows of itself: the one of our identity to our
// contacts, and the one a room shows of us to the joined members of that room. A hash someone
// else names as their picture entitles nobody to anything we hold, so naming the hash of a file
// learned elsewhere fetches nothing. A picture is asked of the one who names it as theirs.
export const pictureGate = (facts: () => PictureFacts): PictureGate => ({
  entitled(ik, h) {
    const f = facts()
    if (ik === f.me) return false
    if (has(f.own, h) && f.contacts.some(c => c.ik === ik)) return true
    return f.rooms.some(room => has(room.mine, h) && room.members.some(m => m.ik === ik))
  },
  holders(h) {
    const f = facts()
    const out = new Set<string>()
    for (const c of f.contacts) if (has(c.pic, h)) out.add(c.ik)
    for (const room of f.rooms) for (const m of room.members) if (has(m.pic, h)) out.add(m.ik)
    if (f.me) out.delete(f.me)
    return [...out]
  },
})
