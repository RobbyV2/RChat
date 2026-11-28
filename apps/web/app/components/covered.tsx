import { createElement, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import type { LayoutPlace, Look } from '../lib/controls'

// What a covered text is. The name kinds (a person, a server, an instance, an account, a P2P
// name) are not here: they are drawn by `Name`.
export type CoveredKind =
  // A bio, a server's description, an intro.
  | 'about'
  // A role's name.
  | 'role'
  // A channel's or a category's name.
  | 'channel'
  // Where something is, in words.
  | 'place'
  // A status someone wrote.
  | 'status'
  // Text of a message shown outside its chat.
  | 'preview'
  // A password, a link that grants something, a safety number.
  | 'secret'
  // Text that names a host.
  | 'address'
  // A value of a setting or of a log line, which may hold a name.
  | 'value'
  // Several names together, or a box around names that are drawn inside it.
  | 'names'

type Tag = 'span' | 'p' | 'div' | 'h2' | 'h3' | 'li' | 'code' | 'strong' | 'dd'

// Text that streamer mode hides and that is not one name: `what` says which kind it is. With
// `on` false it is left as it is (a part that needs hiding only sometimes).
export function Covered<const S extends string = never, const L extends string = never>({
  what: _what,
  on = true,
  as = 'span',
  place,
  look,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, 'className' | 'style' | 'children'> & {
  what: CoveredKind
  on?: boolean
  as?: Tag
  place?: LayoutPlace<S>
  look?: Look<L>
  children?: ReactNode
  ref?: Ref<HTMLElement>
}) {
  const className = [on ? 'streamer' : '', place, look].filter(Boolean).join(' ')
  return createElement(as, { ...rest, className: className || undefined }, children)
}
