'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useStore } from '../../lib/store'
import { ServerManage } from './server_manage'
import { rowBtnCls } from './users'
import { Sentinel } from '../ui'
import { dangerBtn, fieldCls, textBtn } from './touch'

// One server: what its managers can change, and deleting it.
export function ServerPage({ name }: { name: string }) {
  const openAdmin = useStore(s => s.openAdmin)
  const openServer = useStore(s => s.openServer)
  const adminDeleteServer = useStore(s => s.adminDeleteServer)
  const askConfirm = useStore(s => s.askConfirm)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <button onClick={() => openAdmin('servers')} className={`${textBtn} -ml-3 hidden md:block`}>
          Back to servers
        </button>
        <span className="flex-1" />
        <button onClick={() => void openServer(name)} className={textBtn}>
          Open
        </button>
        {name !== 'rchat' && (
          <button
            onClick={() =>
              askConfirm({
                title: 'Delete Server',
                body: 'Delete this server for everyone? All of its channels and messages are deleted. This cannot be undone.',
                confirm: 'Delete',
                action: () => void adminDeleteServer(name).then(() => openAdmin('servers')),
              })
            }
            className={dangerBtn}
          >
            Delete server
          </button>
        )}
      </div>
      <div className="rounded-xl bg-surface-container">
        <ServerManage name={name} onCollapse={() => openAdmin('servers')} />
      </div>
    </div>
  )
}

export function ServersSection() {
  const overview = useStore(s => s.adminOverview)
  const adminServers = useStore(s => s.adminServers)
  const loadAdminServers = useStore(s => s.loadAdminServers)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const openAdmin = useStore(s => s.openAdmin)
  const [q, setQ] = useState('')
  useEffect(() => {
    void loadAdminOverview()
  }, [loadAdminOverview])
  useEffect(() => {
    const t = setTimeout(() => void loadAdminServers(q, true), 300)
    return () => clearTimeout(t)
  }, [q, loadAdminServers])
  const more = useCallback(() => void loadAdminServers(q), [q, loadAdminServers])
  return (
    <div className="space-y-2">
      {overview && (
        <p className="text-sm text-on-surface-variant">
          {overview.server_count.toLocaleString()}{' '}
          {overview.server_count === 1 ? 'server' : 'servers'}
        </p>
      )}
      <div className="flex">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search servers"
          aria-label="Search servers"
          className={`${fieldCls} streamer`}
        />
      </div>
      <div className="space-y-1">
        {adminServers.list.map(sv => (
          <button key={sv.name} onClick={() => openAdmin('servers', sv.name)} className={rowBtnCls}>
            <span className="streamer min-w-0 flex-1 truncate text-sm">
              {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
            </span>
            <ChevronRight size={18} className="shrink-0 text-on-surface-variant" />
          </button>
        ))}
        {adminServers.hasMore && <Sentinel key={adminServers.list.length} onVisible={more} />}
      </div>
    </div>
  )
}
