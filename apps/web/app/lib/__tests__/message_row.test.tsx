import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountProvider } from '../client/react'
import { MessageRow, RemovedRow, SlowHiddenRow, type RowProps } from '../../components/message_row'
import { msg, user } from './fixtures'
import { NO_HANDLERS } from './helpers/peer_row'
import { testAccount } from './test_account'

const row = (over: Partial<RowProps> = {}) =>
  renderToStaticMarkup(
    <AccountProvider session={testAccount('ann')}>
      <MessageRow
        m={msg(7, { author: user('bob'), content: 'hello', reply_count: 2 })}
        first
        last
        mentioned={false}
        divider={false}
        flash={false}
        server={null}
        canEdit={false}
        canReply={false}
        canForward={false}
        thread={null}
        canDelete={false}
        canReact={false}
        canUnreact={false}
        editing={false}
        on={NO_HANDLERS}
        {...over}
      />
    </AccountProvider>
  )

const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map(m => m[1])

describe('a message row', () => {
  test('offers only what its list allows', () => {
    expect(labels(row())).toEqual(['Message actions', 'More'])
    const all = labels(
      row({ canEdit: true, canReply: true, canForward: true, canDelete: true, canReact: true })
    )
    for (const label of ['Add reaction', 'Edit', 'Reply', 'Forward'])
      expect(all.some(l => l.startsWith(label))).toBe(true)
    expect(all).toContain('Delete message (hold Shift to skip confirmation)')
  })

  test('names its thread action as the place does, and counts replies only where asked', () => {
    expect(labels(row({ thread: 'Create thread' }))).toContain('Create thread')
    expect(row().includes('data-thread-chip')).toBe(false)
    const chip = row({ chip: true })
    expect(chip).toContain('data-thread-chip')
    expect(chip).toContain('2 replies')
  })

  test('a row of a thread deletes a reply', () => {
    expect(labels(row({ inThread: true, canDelete: true }))).toContain(
      'Delete reply (hold Shift to skip confirmation)'
    )
  })

  test('an account opens a profile', () => {
    expect(row()).toContain('title="View profile"')
  })

  test('says how far your own send got', () => {
    expect(row().includes('data-delivered')).toBe(false)
    expect(row({ sent: 'delivered' })).toContain('data-delivered')
    expect(row({ sent: 'pending', sentTip: 'Waiting' })).toContain('title="Waiting"')
    const failed = row({ sent: 'failed', canRetry: true, canDrop: true })
    expect(failed).toContain('Not sent')
    expect(failed).toContain('>Retry</button>')
    expect(failed).toContain('>Delete</button>')
    const kept = row({ sent: 'failed' })
    expect(kept.includes('>Retry</button>')).toBe(false)
    expect(kept.includes('>Delete</button>')).toBe(false)
  })

  test('marks a message that arrived long after it was sent', () => {
    expect(row({ lateAt: 1_800_000_000_000 })).toContain('sent earlier, arrived later')
  })

  test('a place that loads nothing shows no empty text', () => {
    const empty = { m: msg(8, { author: user('bob'), content: '  ' }) }
    expect(row({ ...empty, local: true }).includes('break-words')).toBe(false)
    expect(row(empty)).toContain('break-words')
  })
})

test('hidden rows say why they are hidden', () => {
  const m = msg(9, { author: user('KEY', { display_name: 'Bob' }) })
  const removed = renderToStaticMarkup(<RemovedRow m={m} divider={false} />)
  expect(removed).toContain('data-hidden-row="removed"')
  expect(removed).toContain('Bob')
  const slow = renderToStaticMarkup(<SlowHiddenRow m={m} divider />)
  expect(slow).toContain('data-hidden-row="slow"')
  expect(slow).toContain('data-divider')
})
