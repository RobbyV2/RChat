// Flags an overlay built by hand: a `<dialog>` element, or a class list that pins a box over the
// whole window (`fixed` with `inset-0`). Overlays are the Dialog, TopDialog, Sheet and Overlay of
// components/ui.tsx, which own the layer, the backdrop, Esc and the app area above the keyboard.

const covers = text => {
  const words = text.split(/\s+/)
  return words.includes('fixed') && words.includes('inset-0')
}

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      own: 'An overlay comes from Dialog, TopDialog, Sheet or Overlay (components/ui.tsx), never a hand-built one.',
    },
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === 'string' && covers(text)) context.report({ node, messageId: 'own' })
    }
    return {
      JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'dialog')
          context.report({ node, messageId: 'own' })
      },
      Literal(node) {
        check(node, node.value)
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map(q => q.value.cooked ?? '').join(' '))
      },
    }
  },
}
