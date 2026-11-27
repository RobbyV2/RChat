import type { P2pApp } from '../../p2p/app/runtime'
import { P2pDm, type P2pList } from '../../place/place'
import { user } from '../fixtures'

// A P2P conversation shown through a list that knows nobody and reacts to nothing, with `over`
// in place of what a test is about.
export const peerPlace = (app: P2pApp, over: Partial<P2pList> = {}) =>
  P2pDm.open(app, 'dm').shownBy({
    me: 'me',
    idOf: () => null,
    message: () => undefined,
    user: ik => user(ik),
    names: new Map(),
    people: () => [],
    openPicker: () => {},
    ...over,
  })
