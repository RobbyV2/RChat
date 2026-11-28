// Flags spacing written by hand in a class name or in the look of a layout box: padding, margin (other than auto), gap and
// space-between classes, and arbitrary values. Screens get their spacing from the layout boxes of
// components/layout, which carry the spacing scale, and their controls' fixed padding.

const SPACING =
  /^-?(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-(?!auto$)/

// The utility of a class without its variants (`md:hover:px-2` -> `px-2`) and `!`.
const utility = word => {
  let depth = 0
  let start = 0
  for (let i = 0; i < word.length; i++) {
    const c = word[i]
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    else if (c === ':' && depth === 0) start = i + 1
  }
  return word.slice(start).replace(/^!|!$/g, '')
}

export const handSpacing = text =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => {
      const u = utility(word)
      return SPACING.test(u) || u.includes('[') || u.includes('(--')
    })

const CLASS_WORD =
  /^!?(?:[a-z@][\w@/[\]().%,=&>+*'-]*:)*-?(?:flex|inline-flex|grid|block|hidden|absolute|relative|fixed|sticky|shrink(?:-0)?|grow|truncate|rounded(?:-[\w[\]/.-]+)?|border(?:-[\w[\]/.()%,-]+)?|(?:bg|text|font|items|justify|self|w|h|size|min-w|min-h|max-w|max-h|cursor|overflow|opacity|outline|shadow|z|top|right|bottom|left|inset|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-[\w[\]/.()%,#-]+)$/

// Whether a string outside a class attribute is a class list: two or more words, most of them
// utility classes.
export const classList = text => {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 2) return false
  const known = words.filter(w => CLASS_WORD.test(w)).length
  return known >= 2 && known * 2 >= words.length
}

// The string parts of a class name expression: literals, template parts, both sides of a
// condition, and the strings joined into it.
function* strings(node) {
  if (!node) return
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') yield [node, node.value]
      return
    case 'TemplateLiteral':
      for (const q of node.quasis) yield [q, q.value.cooked ?? '']
      for (const e of node.expressions) yield* strings(e)
      return
    case 'JSXExpressionContainer':
      yield* strings(node.expression)
      return
    case 'ConditionalExpression':
      yield* strings(node.consequent)
      yield* strings(node.alternate)
      return
    case 'LogicalExpression':
      yield* strings(node.left)
      yield* strings(node.right)
      return
    case 'BinaryExpression':
      yield* strings(node.left)
      yield* strings(node.right)
      return
    case 'ArrayExpression':
      for (const e of node.elements) yield* strings(e)
      return
    case 'CallExpression':
      if (node.callee.type === 'MemberExpression') yield* strings(node.callee.object)
      for (const a of node.arguments) yield* strings(a)
      return
    default:
  }
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Spacing comes from the layout boxes, not from class names' },
    schema: [],
    messages: {
      hand: 'Spacing comes from the layout boxes (components/layout), not "{{word}}".',
    },
  },
  create(context) {
    const seen = new Set()
    const check = (node, text) => {
      if (seen.has(node)) return
      seen.add(node)
      for (const word of handSpacing(text))
        context.report({ node, messageId: 'hand', data: { word } })
    }
    return {
      JSXAttribute(attr) {
        if (attr.name.type !== 'JSXIdentifier') return
        if (!/^(look|className|\w+ClassName)$/.test(attr.name.name)) return
        for (const [node, text] of strings(attr.value)) check(node, text)
      },
      // A class list kept in a constant or built in an expression is checked like one written
      // in place.
      Literal(node) {
        if (typeof node.value === 'string' && classList(node.value)) check(node, node.value)
      },
      TemplateElement(node) {
        const text = node.value.cooked ?? ''
        if (classList(text)) check(node, text)
      },
    }
  },
}
