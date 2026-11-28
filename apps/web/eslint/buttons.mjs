// Flags a button built by hand: a `<button>` element, an element rendered `as="button"`, or
// `createElement('button', ...)`; and a link dressed as a control: an `<a>`, a `<Link>` or any
// element with an `href` whose class list uses a control look (a name ending in `Look`). A
// screen's buttons and button-like links are the controls of components/controls.tsx and
// components/ui.tsx, which carry the colors, states, focus ring and touch size of each kind.

const named = (node, name) => node?.type === 'JSXIdentifier' && node.name === name

const LINKS = new Set(['a', 'Link'])

// Whether an expression names a control look anywhere in it.
const usesLook = node => {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(usesLook)
  if (node.type === 'Identifier' && /Look$/.test(node.name)) return true
  return Object.entries(node).some(([key, value]) => key !== 'parent' && usesLook(value))
}

const attributeOf = (node, name) =>
  node.attributes.find(a => a.type === 'JSXAttribute' && named(a.name, name))

const text = node =>
  node?.type === 'Literal'
    ? node.value
    : node?.type === 'JSXExpressionContainer'
      ? text(node.expression)
      : node?.type === 'TemplateLiteral' && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      raw: 'A button comes from the shared controls (Button, IconButton, ListRow, Chip, Tab, CardButton, ... in components/controls.tsx), never a hand-written <button>.',
      anchor:
        'A link that looks like a control is a ButtonLink, IconLink or LinkButton from components/controls.tsx, never a control look in its class list.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (named(node.name, 'button')) return context.report({ node, messageId: 'raw' })
        const link =
          (node.name.type === 'JSXIdentifier' && LINKS.has(node.name.name)) ||
          attributeOf(node, 'href') !== undefined
        const cls = attributeOf(node, 'className')
        if (link && cls && usesLook(cls.value)) context.report({ node: cls, messageId: 'anchor' })
        for (const attribute of node.attributes)
          if (
            attribute.type === 'JSXAttribute' &&
            named(attribute.name, 'as') &&
            text(attribute.value) === 'button'
          )
            context.report({ node: attribute, messageId: 'raw' })
      },
      CallExpression(node) {
        const callee = node.callee
        const creates =
          (callee.type === 'Identifier' && callee.name === 'createElement') ||
          (callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'createElement' &&
            !(callee.object.type === 'Identifier' && callee.object.name === 'document'))
        if (creates && text(node.arguments[0]) === 'button')
          context.report({ node, messageId: 'raw' })
      },
    }
  },
}
