// Flags spacing written by hand in a class name or in the look of a layout box: padding, margin (other than auto), gap and
// space-between classes, and arbitrary values. Screens get their spacing from the layout boxes of
// components/layout.tsx, which carry the spacing scale, and their controls' fixed padding.

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
      hand: 'Spacing comes from the layout boxes (components/layout.tsx), not "{{word}}".',
    },
  },
  create(context) {
    return {
      JSXAttribute(attr) {
        if (attr.name.type !== 'JSXIdentifier') return
        if (attr.name.name !== 'className' && attr.name.name !== 'look') return
        for (const [node, text] of strings(attr.value))
          for (const word of handSpacing(text))
            context.report({ node, messageId: 'hand', data: { word } })
      },
    }
  },
}
