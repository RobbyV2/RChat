// Interactive elements inside other interactive elements in static markup (the axe
// nested-interactive idea, plus `a` and `label`, whose content may not hold other controls).
const VOID = new Set([
  'area',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'wbr',
])
const ROLES =
  /\srole="(button|link|option|menuitem|menuitemcheckbox|menuitemradio|tab|checkbox|radio|switch)"/

const interactive = (name: string, attrs: string) =>
  name === 'button' ||
  name === 'select' ||
  name === 'textarea' ||
  name === 'summary' ||
  name === 'label' ||
  (name === 'a' && /\shref=/.test(attrs)) ||
  (name === 'input' && !/\stype="hidden"/.test(attrs)) ||
  ROLES.test(attrs) ||
  /\stabindex="(?!-)/.test(attrs)

export const nestedInteractive = (html: string): string[] => {
  const found: string[] = []
  const stack: { name: string; on: boolean }[] = []
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [tag, close, raw, attrs, self] = m
    const name = raw.toLowerCase()
    if (close) {
      const at = stack.map(s => s.name).lastIndexOf(name)
      if (at >= 0) stack.length = at
      continue
    }
    const on = interactive(name, attrs)
    const field = name === 'input' || name === 'select' || name === 'textarea'
    // A label may hold the field it labels.
    if (on && stack.some(s => s.on && !(field && s.name === 'label'))) found.push(tag)
    if (!self && !VOID.has(name)) stack.push({ name, on })
  }
  return found
}
