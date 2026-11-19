// Which open layer Esc belongs to. From the bottom: the stage, side panels, full pages, dialogs,
// confirms; a context menu sits above them all.

import type { RChatState } from './store_types'

export type EscapeLayer = 'stage' | 'panel' | 'page' | 'dialog' | 'confirm'

// Whether something is open above `layer` in the app's state `s`. `modal` says whether any modal
// shows; a page is one itself, so only the layers below it ask.
export const layerCovered = (layer: EscapeLayer, s: RChatState, modal: () => boolean) => {
  if (s.contextMenu) return true
  if (layer === 'confirm') return false
  if (s.confirm) return true
  if (layer === 'dialog') return false
  if (s.activeDialog !== null || s.profile !== null || s.invite !== null) return true
  if (layer === 'page') return false
  if (modal()) return true
  return layer === 'stage' && s.panel !== null
}
