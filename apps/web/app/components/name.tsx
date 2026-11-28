'use client'

import {
  createElement,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import type { LayoutPlace, Look } from '../lib/controls'
import {
  masksName,
  nameLabel,
  nameParts,
  nameTitle,
  revealKeyOf,
  type NameValue,
  type NameView,
} from '../lib/names'
import { useMask, useStore } from '../lib/store'
import { Row } from './layout'
import {
  Masked,
  MaskedTogether,
  RevealScope,
  fieldCls,
  useOwn,
  useOwnServer,
  useRevealed,
} from './ui'

// Whether a name is the viewer's own: their account or identity, a server they named, one of
// their accounts.
const useOwnName = (name: NameValue) => {
  const mine = useOwn(name.kind === 'person' ? name.who : null)
  const myServer = useOwnServer(name.kind === 'server' ? name.server : null)
  if (name.kind === 'account') return true
  if (name.kind === 'instance') return false
  if (name.own !== undefined) return name.own
  return name.kind === 'person' ? mine : name.kind === 'server' ? myServer : false
}

const useNameView = (name: NameValue, revealed = false): NameView => {
  const own = useOwnName(name)
  const mask = useMask(own || revealed)
  const streamer = useStore(s => s.streamer)
  return { streamer, mask, own }
}

// A name as text for a label or a tooltip: `generic` (what kind of thing it is) in streamer
// mode, else the name as the viewer's filter shows it.
export function useNameLabel(name: NameValue, generic?: string, withUsername = false) {
  return nameLabel(name, useNameView(name), generic, withUsername)
}

// The same for several names at once: a function from a name to its label.
export function useNameLabels() {
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  return (name: NameValue, generic?: string, withUsername = false) =>
    nameLabel(name, { streamer, mask, own: name.kind === 'account' }, generic, withUsername)
}

function Body({ of, withUsername, fit }: { of: NameValue; withUsername: boolean; fit: boolean }) {
  const own = useOwnName(of)
  const shown = !masksName(of, own)
  const { main, handle } = nameParts(of, withUsername)
  if (handle === null) return shown ? main : <Masked text={main} />
  if (fit)
    return (
      <MaskedTogether word={revealKeyOf(of)}>
        <Row
          as="span"
          gap="2xs"
          align="baseline"
          wrap
          look="h-lh text-ellipsis"
          place="min-w-0 overflow-hidden"
        >
          <span dir="auto" className="max-w-max min-w-0 shrink grow basis-16 truncate">
            <Masked text={main} own={shown} />
          </span>
          <span className="shrink-0 text-on-surface-variant">
            (<Masked text={handle} own={shown} />)
          </span>
        </Row>
      </MaskedTogether>
    )
  return (
    <MaskedTogether word={revealKeyOf(of)}>
      <Row as="span" gap="2xs" align="baseline" place="inline-flex max-w-full">
        <span className="min-w-0 truncate">
          <Masked text={main} own={shown} />
        </span>
        <span className="max-w-full shrink-0 truncate text-on-surface-variant">
          (<Masked text={handle} own={shown} />)
        </span>
      </Row>
    </MaskedTogether>
  )
}

const nameTriggerCls =
  'cursor-pointer rounded-sm outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary'

type Tag = 'span' | 'p' | 'div' | 'h1' | 'h2' | 'h3' | 'strong' | 'small' | 'dt' | 'dd' | 'li'

type NameProps<S extends string, L extends string> = Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'style' | 'title' | 'children' | 'color'
> & {
  of: NameValue
  // A person's username after their display name, when the two differ.
  withUsername?: boolean
  // For a row the name fills: the display name is cut short first, then the username.
  fit?: boolean
  // The whole name as the element's tooltip (always with `fit`), or the text given. None in
  // streamer mode.
  titled?: boolean | string
  // The name opens something (a profile): it looks pressable.
  link?: boolean
  as?: Tag
  place?: LayoutPlace<S>
  look?: Look<L>
  // A role's color.
  color?: string
  // Text drawn with the name, inside its element: an `@`, a label.
  before?: ReactNode
  after?: ReactNode
  ref?: Ref<HTMLElement>
}

function Drawn<const S extends string, const L extends string>({
  of,
  withUsername = false,
  fit = false,
  titled = fit,
  link = false,
  as = 'span',
  place,
  look,
  color,
  before,
  after,
  ...rest
}: NameProps<S, L>) {
  const revealed = useRevealed(revealKeyOf(of))
  const view = useNameView(of, revealed)
  return createElement(
    as,
    {
      id: rest.id,
      title:
        typeof titled === 'string'
          ? view.streamer
            ? undefined
            : titled
          : titled
            ? nameTitle(of, view, withUsername)
            : undefined,
      ...rest,
      style: color === undefined ? undefined : { color },
      className: ['streamer', place, look, link ? nameTriggerCls : ''].filter(Boolean).join(' '),
    },
    before,
    <Body of={of} withUsername={withUsername} fit={fit} />,
    after
  )
}

// A name on screen. Streamer mode hides it, the viewer's own filter masks it (never their own
// names), and a reveal of one masked word shows the whole name.
export function Name<const S extends string = never, const L extends string = never>(
  props: NameProps<S, L>
) {
  if (!(props.titled ?? props.fit)) return <Drawn {...props} />
  return (
    <RevealScope>
      <Drawn {...props} />
    </RevealScope>
  )
}

const fieldMark = (className: string | undefined, named: boolean) =>
  `${named ? 'streamer ' : ''}${className ?? fieldCls}`.trim()

// A form field that holds a name, an address or a secret: streamer mode hides what is typed in
// it. `className` replaces the plain field's look; `named` false is a field whose text is a name
// only sometimes.
export function NameInput({
  className,
  named = true,
  ...rest
}: ComponentProps<'input'> & { named?: boolean }) {
  return <input {...rest} className={fieldMark(className, named)} />
}

// The same for text of several lines.
export function NameArea({
  className,
  named = true,
  ...rest
}: ComponentProps<'textarea'> & { named?: boolean }) {
  return <textarea {...rest} className={fieldMark(className, named)} />
}

// The same for a choice among names (accounts, identities).
export function NameSelect({
  className,
  named = true,
  ...rest
}: ComponentProps<'select'> & { named?: boolean }) {
  return <select {...rest} className={fieldMark(className, named)} />
}
