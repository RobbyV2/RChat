import { home, writeLocal } from '../../instances'
import {
  addToFolder,
  emptyLayout,
  mergeServers,
  moveFolder,
  moveIntoFolder,
  moveServer,
  newFolderId,
  parseLayout,
  renameFolder,
  setFolderColor,
  toggleFolder,
  ungroupFolder,
  type Layout,
  type RailEntry,
} from '../../nav_layout'
import { useP2p } from './store'

// ----- Rail layout -----

// P2P servers' order and folders in the rail, per account in this browser (the instance layout's
// shape, only its server list used). { v: 2, servers, ... } as nav_layout parses it.
export const p2pLayoutKey = (username: string) => `rchat_p2p_layout:${username}`

export const readLayout = (username: string | null) => {
  if (!username) return emptyLayout
  try {
    return parseLayout(localStorage.getItem(home.scoped(p2pLayoutKey(username))))
  } catch {
    return emptyLayout
  }
}

const saveLayout = (layout: Layout) => {
  const user = useP2p.getState().account
  useP2p.setState({ layout })
  if (user) writeLocal(home.scoped(p2pLayoutKey(user)), JSON.stringify(layout))
}

const railRooms = () => Object.keys(useP2p.getState().servers).sort()

export const p2pRail = {
  move: (room: string, index: number) =>
    saveLayout(moveServer(useP2p.getState().layout, railRooms(), room, index)),
  moveFolder: (id: string, index: number) =>
    saveLayout(moveFolder(useP2p.getState().layout, railRooms(), id, index)),
  moveIntoFolder: (room: string, id: string, index: number) =>
    saveLayout(moveIntoFolder(useP2p.getState().layout, railRooms(), room, id, index)),
  addToFolder: (room: string, id: string) =>
    saveLayout(addToFolder(useP2p.getState().layout, railRooms(), room, id)),
  merge: (room: string, target: string) => {
    const layout = useP2p.getState().layout
    saveLayout(mergeServers(layout, railRooms(), room, target, newFolderId(layout.servers)))
  },
  toggleFolder: (id: string) => saveLayout(toggleFolder(useP2p.getState().layout, id)),
  rename: (id: string, name: string) =>
    saveLayout(renameFolder(useP2p.getState().layout, id, name)),
  setFolderColor: (id: string, color: string | null) =>
    saveLayout(setFolderColor(useP2p.getState().layout, id, color)),
  ungroup: (id: string) => saveLayout(ungroupFolder(useP2p.getState().layout, id)),
  // From an imported config (its layout section).
  apply: (servers: RailEntry[]) => saveLayout({ ...useP2p.getState().layout, servers }),
  reload: () => useP2p.setState({ layout: readLayout(useP2p.getState().account) }),
}
