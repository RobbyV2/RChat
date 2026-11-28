// Client-only fields of API types: what P2P rooms add to the shapes the hosted API sends. The
// generated types extend these, so the wire fields come only from the server's document.
import type { FwdPlace } from '../p2p/content'
import type { P2pPic } from '../p2p/pictures'

export interface UserRefExtra {
  // The picture of a P2P identity, as P2P files.
  avatar_pic?: P2pPic | null
}

export interface MemberLookExtra {
  // The member's picture in a P2P room as P2P files (their room picture, else the one of their
  // identity).
  avatar_pic?: P2pPic | null
}

export interface ForwardRefExtra {
  // What a P2P copy says of where it's from.
  p2p?: FwdPlace
}
