// Cursor faults in measured elements, for browser tests: something clickable without the hand,
// or a disabled control that shows it. Text fields and drag handles keep their own cursor. No
// imports, so a test script can load it directly.

export interface CursorNode {
  label: string
  // The computed cursor.
  cursor: string
  // Does something on click: a control, a link, a clickable role or a click handler.
  clickable: boolean
  disabled: boolean
  // Takes typing (a text field), so the text cursor is right.
  typing: boolean
  // Moves by dragging, so a grab cursor is right.
  drag: boolean
}

export interface CursorFault {
  label: string
  cursor: string
  want: string
}

export function cursorFaults(nodes: CursorNode[]): CursorFault[] {
  return nodes.flatMap(n => {
    if (n.typing || n.drag) return []
    if (n.disabled)
      return n.cursor === 'pointer'
        ? [{ label: n.label, cursor: n.cursor, want: 'default or not-allowed' }]
        : []
    return n.clickable && n.cursor !== 'pointer'
      ? [{ label: n.label, cursor: n.cursor, want: 'pointer' }]
      : []
  })
}
