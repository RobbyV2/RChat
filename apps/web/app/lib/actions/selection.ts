import { selectionActions as selectionList } from '../selection_actions'
import type { Action } from './types'

// The selection bar's actions, one row each (`selection_<id>`).
export const selectionActions: Action[] = [
  {
    id: 'selection',
    title: 'Selected messages',
    scope: 'message',
    group: 'selection',
    keywords: ['selected', 'messages'],
    available: ({ s }) => s.selection !== null,
    expand: ({ s }) =>
      selectionList(s).map(a => ({
        key: a.id,
        label: a.label,
        icon: a.icon,
        danger: a.danger,
        args: { id: a.id },
      })),
    run: ({ s }, { id }) =>
      selectionList(s)
        .find(a => a.id === id)
        ?.run(),
  },
]
