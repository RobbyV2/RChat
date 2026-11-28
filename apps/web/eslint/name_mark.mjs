// Flags the `streamer` class written by hand. The components that draw a name, a covered text or
// an avatar put that class on what streamer mode hides; everything else draws through them.
//
// A string is a class list when `streamer` is one of several words, or stands with spaces around
// it. The word alone is a class where a class is built: in JSX, in a template, on either side of
// a condition, in a list, in a joined string, as a variable's or a function's value. Alone as a
// key (a property's value, an argument, a `case`, a comparison, a type) it is data. A sentence
// (a capitalized word, or one that ends in punctuation) is copy, not a class list.

const MARK = 'streamer'
const BUILDS = new Set([
  'ConditionalExpression',
  'LogicalExpression',
  'ArrayExpression',
  'TemplateLiteral',
  'VariableDeclarator',
  'ReturnStatement',
  'ArrowFunctionExpression',
  'AssignmentExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
])
const CLASS_KEY = /^(class(Name)?|look|place)$/i

const inJsx = node => {
  for (let at = node.parent; at; at = at.parent) if (at.type.startsWith('JSX')) return true
  return false
}

const builds = node => {
  const parent = node.parent
  if (!parent) return false
  if (BUILDS.has(parent.type)) return true
  if (parent.type === 'BinaryExpression') return parent.operator === '+'
  if (parent.type === 'Property' && parent.value === node) {
    const key = parent.key
    const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : ''
    return CLASS_KEY.test(String(name))
  }
  return false
}

const SENTENCE = /^\p{Lu}|[.,:;!?]$/u

export const handMarked = (text, node) => {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.includes(MARK)) return false
  if (words.some(word => SENTENCE.test(word))) return false
  if (text !== MARK) return true
  return inJsx(node) || builds(node)
}

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      mark: 'Streamer mode hides what Name, Covered and the avatars draw (components/name.tsx, covered.tsx, user_avatar.tsx). Draw through them: no `streamer` class by hand.',
    },
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === 'string' && handMarked(text, node))
        context.report({ node, messageId: 'mark' })
    }
    return {
      Literal: node => check(node, node.value),
      TemplateElement: node => check(node, node.value.cooked),
    }
  },
}
