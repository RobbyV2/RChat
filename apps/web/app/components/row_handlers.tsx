'use client'

import { useMemo } from 'react'
import { useAccount } from '../lib/client/react'
import type { ComposerList } from '../lib/place/composer'
import { featureAt, isUnsupported } from '../lib/place/feature'
import type { Place } from '../lib/place/place'
import { PlaceProvider, useLive, usePlace } from '../lib/place/react'
import { accountThread, thread as threadFeature } from '../lib/place/thread'
import { accountRowActs, rowActs, type EditBinding, type RowActs } from '../lib/place/row_acts'
import type { Message } from '../lib/types'
import type { RowHandlers } from './message_row'
import { QuickReactions, rowAt } from './reactions'

// What `list` of `place` does for its rows; without a place, of the one around the component,
// or the account's with none open.
export function useRowActs(list: ComposerList, place?: Place): RowActs {
  const account = useAccount()
  const around = usePlace()
  const here = featureAt(rowActs, place ?? around)
  return (isUnsupported(here) ? accountRowActs(account) : here).at(list)
}

// The handlers the rows of `list` take: `on` for its rows, `onRoot` for the message a thread
// hangs from (its quotes show in the conversation, which a phone's thread panel covers). And
// `editing(m, event)`: the edit box of a row being edited in place, else false.
export function useRowHandlers(list: ComposerList, given?: Place) {
  const account = useAccount()
  const around = usePlace()
  const place = given ?? around
  const acts = useRowActs(list, given)
  const edit = useLive(acts.editing)
  const handlers = useMemo(() => {
    const quick = (m: Message, x: number, y: number) => {
      const row = <QuickReactions m={m} anchor={rowAt(x, y)} />
      return place ? <PlaceProvider place={place}>{row}</PlaceProvider> : row
    }
    const open = featureAt(threadFeature, place)
    const thread = isUnsupported(open) ? accountThread(account) : open
    const on = (root: boolean): RowHandlers => ({
      menu: (m, x, y) => acts.menu(m, x, y, quick(m, x, y)),
      jump: id => {
        if (root && !window.matchMedia('(min-width: 768px)').matches) thread.close()
        acts.jump(id, root)
      },
      edit: acts.edit,
      reply: acts.reply,
      forward: acts.forward,
      thread: acts.thread,
      remove: acts.remove,
      retry: acts.retry,
    })
    return { on: on(false), onRoot: on(true) }
  }, [acts, place, account])
  return {
    ...handlers,
    forwardShown: acts.forwardShown,
    editing: (m: Message, event?: string): EditBinding | false =>
      edit !== null && edit.key === (event ?? String(m.id)) ? edit.binding : false,
  }
}
