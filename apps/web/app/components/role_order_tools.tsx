'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { longPress } from './context_menu'
import { Row, Surface } from './layout'
import { textBtn } from './ui'

// Pieces the Roles pages of hosted servers and P2P rooms share: the Role order and Display order
// tabs, Alt+Up and Alt+Down on a focused role row, and a row of the display order.

export type RolesTab = 'rank' | 'display'

export function RoleTabs({ tab, onTab }: { tab: RolesTab; onTab: (tab: RolesTab) => void }) {
  const tabs: [RolesTab, string][] = [
    ['rank', 'Role order'],
    ['display', 'Display order'],
  ]
  return (
    <Row role="tablist" aria-label="Roles" gap="2xs">
      {tabs.map(([t, text]) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => onTab(t)}
          className={`rounded-full px-3 py-1.5 text-sm pointer-coarse:min-h-11 ${
            tab === t
              ? 'bg-secondary-container text-on-secondary-container'
              : 'text-on-surface-variant hover:bg-surface-container-highest'
          }`}
        >
          {text}
        </button>
      ))}
    </Row>
  )
}

// A menu row's action, when the row is there.
export type Run = (() => void) | undefined

// Alt+Up and Alt+Down on a role row move it as its menu's Move Up and Move Down do.
export const keyMoves = (up: () => Run, down: () => Run) => ({
  tabIndex: 0,
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
    if (!e.altKey || e.target !== e.currentTarget) return
    const run = e.key === 'ArrowUp' ? up() : e.key === 'ArrowDown' ? down() : undefined
    if (!run) return
    e.preventDefault()
    run()
  },
})

// One role in the display order: Show Higher and Show Lower where its menu has them.
export function ShownRow({
  name,
  swatch,
  up,
  down,
  menu,
}: {
  name: ReactNode
  swatch: string | undefined
  up: { text: string; run: Run }
  down: { text: string; run: Run }
  menu: ReturnType<typeof longPress>
}) {
  const btn = ({ text, run }: { text: string; run: Run }, Icon: typeof ChevronUp) => (
    <button
      type="button"
      onClick={() => run?.()}
      disabled={!run}
      title={text}
      aria-label={text}
      className="shrink-0 rounded-full p-1.5 text-on-surface-variant enabled:hover:bg-surface-container-highest disabled:opacity-30 pointer-coarse:p-2.5"
    >
      <Icon size={16} />
    </button>
  )
  return (
    <Surface {...menu} data-shown-role pad="sm" inset="bar" tone="base" radius="lg">
      <Row gap="sm">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: swatch ?? 'var(--color-outline)' }}
        />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {btn(up, ChevronUp)}
        {btn(down, ChevronDown)}
      </Row>
    </Surface>
  )
}

export function FollowButton({ run }: { run: Run }) {
  return run ? (
    <button type="button" onClick={run} className={`${textBtn} self-start`}>
      Follow role order
    </button>
  ) : null
}
