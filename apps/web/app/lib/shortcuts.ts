// The keyboard shortcuts, listed under Settings > Information. A new shortcut goes here first,
// and the test checks that no two of them share a key in the same place. The formatting keys come
// from `FORMATS`.

import { FORMATS, isApple, keysLabel } from './format'

export interface Shortcut {
  // Keys as shown, "Mod" being Ctrl (Cmd on Apple devices).
  keys: string
  action: string
  // Where it works.
  where: 'anywhere' | 'composer' | 'messages' | 'selection'
}

export const SHORTCUTS: Shortcut[] = [
  { keys: 'Enter', action: 'Send the message', where: 'composer' },
  { keys: 'Shift+Enter', action: 'New line', where: 'composer' },
  { keys: 'Up', action: 'Edit your last message (empty composer)', where: 'composer' },
  ...FORMATS.flatMap(({ label, keys }): Shortcut[] =>
    keys === null ? [] : [{ keys, action: label, where: 'composer' }]
  ),
  { keys: 'Mod+K', action: 'Open the command palette', where: 'anywhere' },
  { keys: 'Escape', action: 'Mark the conversation as read, close a panel', where: 'anywhere' },
  { keys: 'Shift+Escape', action: 'Mark everything as read', where: 'anywhere' },
  { keys: 'Shift+Click', action: 'Delete without confirming (trash icon)', where: 'messages' },
  { keys: 'Mod+Shift+S', action: 'Select messages (on again to stop)', where: 'anywhere' },
  { keys: 'Mod+Click', action: 'Select or unselect a message', where: 'messages' },
  {
    keys: 'Click, then Shift+Click',
    action: 'Select a range of messages',
    where: 'messages',
  },
  { keys: 'Shift+Click', action: 'Select a range of messages', where: 'selection' },
  { keys: 'Mod+A', action: 'Select all messages here', where: 'selection' },
  { keys: 'Escape', action: 'Stop selecting', where: 'selection' },
]

export { isApple }

export const shortcutLabel = (keys: string, apple = isApple()) => keysLabel(keys, apple)

// Shortcuts that share keys in the same place (`anywhere` counts everywhere). Selection mode
// replaces what plain clicks and Escape do in the message list, so it is its own place.
export const conflicts = (list: Shortcut[] = SHORTCUTS) =>
  list.filter((a, i) =>
    list.some(
      (b, j) =>
        j !== i &&
        a.keys === b.keys &&
        (a.where === b.where ||
          (a.where === 'anywhere' && b.where !== 'selection') ||
          (b.where === 'anywhere' && a.where !== 'selection'))
    )
  )

// Ctrl/Cmd+Shift+S, the selection mode toggle.
export const selectKey = (
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's'

// Ctrl/Cmd+A.
export const allKey = (
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
) => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a'
