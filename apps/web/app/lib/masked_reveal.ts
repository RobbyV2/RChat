// Masked words inside controls have no keyboard reveal of their own; the `show_masked_text`
// action reveals them through this event from a row's menu and from the palette.
export const REVEAL_EVENT = 'rchat-reveal'

let element: Element | null = null

// Runs `f` (which opens a menu or runs an action) for `el`: action contexts made meanwhile carry
// it as their `element`.
export const withActionElement = <T>(el: Element | null, f: () => T): T => {
  const outer = element
  element = el
  try {
    return f()
  } finally {
    element = outer
  }
}

export const actionElement = () => element

// The masked words still hidden inside `el`.
export const hiddenWords = (el: Element | null | undefined): Element[] =>
  el ? Array.from(el.querySelectorAll('[data-masked-word]')) : []

// The masked words still hidden on screen, outside the palette.
export const hiddenOnScreen = (): Element[] =>
  typeof document === 'undefined'
    ? []
    : Array.from(document.querySelectorAll('[data-masked-word]')).filter(
        w => !w.closest('[data-palette]')
      )

export const revealWords = (words: Element[]) => {
  for (const w of words) w.dispatchEvent(new Event(REVEAL_EVENT))
}
