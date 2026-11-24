import { expect, test } from 'bun:test'
import { railBlocks } from '../client/rail_blocks'
import type { SwitcherRow } from '../client/switcher_rows'

function row(
  origin: string,
  username: string,
  badge: number,
  local: string | null = null
): SwitcherRow {
  return {
    origin,
    username,
    local,
    display: local ?? username,
    status: 'Online',
    badge,
    unread: badge > 0,
    active: false,
    avatar: null,
    ik: null,
    background: true,
    saved: true,
  }
}
const alpha = 'https://alpha.example',
  beta = 'https://beta.example'
const group = (origin: string, rows: SwitcherRow[]) => ({
  origin,
  name: new URL(origin).hostname,
  host: new URL(origin).host,
  rows,
})

test('orders blocks and account rows like the book, totaling only their own badges', () => {
  const a = group(alpha, [
    row(alpha, 'second', 3),
    row(alpha, 'second', 19, 'work'),
    row(alpha, 'first', 2),
  ])
  const b = group(beta, [row(beta, 'first', 7)])
  const one = railBlocks([b])
  expect([one.accountCount, one.instanceHeaders]).toEqual([1, false])
  const same = railBlocks([a])
  expect([same.accountCount, same.instanceHeaders]).toEqual([2, false])
  const cross = railBlocks([b, a])
  expect(cross.instanceHeaders).toBe(true)
  expect(cross.blocks.map(g => [g.origin, g.pings])).toEqual([
    [beta, 7],
    [alpha, 5],
  ])
  expect(cross.blocks[1].accounts.map(r => r.username)).toEqual(['second', 'first'])
  expect(cross.blocks[1].peers.map(r => r.local)).toEqual(['work'])
})
test('filters the entire foreign instance and identities of signed-out owners before grouping', () => {
  const a = group(alpha, [
    row(alpha, 'alice', 2),
    { ...row(alpha, 'old', 0), status: 'Signed out' },
    row(alpha, 'old', 5, 'old-key'),
  ])
  const b = group(beta, [row(beta, 'alice', 8)])
  const filtered = railBlocks([a, b], alpha)
  expect(filtered.blocks.map(g => [g.origin, g.pings, g.peers.length])).toEqual([[alpha, 2, 0]])
  expect(filtered.instanceHeaders).toBe(false)
})
