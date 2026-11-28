// Padding of a list row by its place in its group: the pane's side inset, and no gap between rows
// of one group.
export const groupPadCls = (first: boolean, last: boolean) =>
  `px-(--space-lg) ${first ? 'pt-(--space-xs)' : 'pt-(--space-3xs)'} ${last ? 'pb-(--space-xs)' : 'pb-(--space-3xs)'}`

export const gutterTimeCls =
  'absolute top-0 left-1/2 -translate-x-1/2 text-2xs leading-[22.75px] whitespace-nowrap text-on-surface-variant tabular-nums opacity-0 group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100'
