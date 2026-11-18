// Padding of a list row by its place in its group: no gap between rows of one group.
export const groupPadCls = (first: boolean, last: boolean) =>
  `${first ? 'pt-1.5' : 'pt-0.5'} ${last ? 'pb-1.5' : 'pb-0.5'}`

export const gutterTimeCls =
  'absolute top-0 left-1/2 -translate-x-1/2 text-[11px] leading-[22.75px] whitespace-nowrap text-on-surface-variant tabular-nums opacity-0 group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100'
