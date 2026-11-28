// Flags a button built by hand: a `<button>` element, an element rendered `as="button"`, or
// `createElement('button', ...)`. A screen's buttons are the controls of components/controls.tsx
// and components/ui.tsx, which carry the colors, states, focus ring and touch size of each kind.

const named = (node, name) => node?.type === 'JSXIdentifier' && node.name === name

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
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (named(node.name, 'button')) return context.report({ node, messageId: 'raw' })
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
