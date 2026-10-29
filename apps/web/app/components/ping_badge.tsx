import { badgeText } from '../lib/pings'

export const pingLabel = (n: number) => `${n} ${n === 1 ? 'notification' : 'notifications'}`

export function PingBadge({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      data-ping-badge={count}
      title={pingLabel(count)}
      className={`flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[11px] leading-none font-bold text-on-danger tabular-nums ${className}`}
    >
      <span aria-hidden>{badgeText(count)}</span>
      <span className="sr-only">{pingLabel(count)}</span>
    </span>
  )
}

export function RailPingBadge({ count }: { count: number }) {
  return (
    <PingBadge
      count={count}
      className="absolute -top-1.5 -right-1.5 h-5 min-w-5 border-[3px] border-(--rail-cut,var(--color-surface-container-lowest))"
    />
  )
}
