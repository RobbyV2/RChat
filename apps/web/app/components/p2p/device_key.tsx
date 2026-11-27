'use client'
import { time } from '../../lib/platform/time'
import { useEffect } from 'react'
import { useAccount } from '../../lib/client/react'
import { useP2p, useP2pApp, withP2pIdentity } from '../../lib/client/p2p_react'
import {
  REPLACE_KEY,
  REPLACE_KEY_CONFIRM,
  REPLACE_KEY_HINT,
  REPLACING_KEY,
  showsDeviceKey,
} from '../../lib/device_key'
import { Button } from '../controls'
import { Row, Surface } from '../layout'
import { sectionCls } from '../ui'

// "Replace this device's key", where this device stores P2P data encrypted.
export const DeviceKeySection = withP2pIdentity(function DeviceKeySection() {
  const { p2pServer } = useP2pApp()!
  const acct = useAccount()
  const seal = useP2p(s => s.seal)
  useEffect(() => {
    void p2pServer.replacingDeviceKey().catch(() => {})
  }, [p2pServer])
  useEffect(() => {
    if (!seal.replacing) return
    return time().every(2000, () => void p2pServer.replacingDeviceKey().catch(() => {}))
  }, [seal.replacing, p2pServer])
  if (!showsDeviceKey(seal)) return null
  return (
    <>
      <p className={sectionCls}>Device key</p>
      <Surface tone="plain" pad="sm" gap="2xs">
        <p className="text-xs text-on-surface-variant">{REPLACE_KEY_HINT}</p>
        {seal.replacing ? (
          <p role="status" className="text-sm">
            {REPLACING_KEY}
          </p>
        ) : (
          <Row gap="none">
            <Button
              onClick={() =>
                acct.store.getState().askConfirm({
                  title: REPLACE_KEY,
                  body: REPLACE_KEY_CONFIRM,
                  confirm: 'Replace',
                  action: () => void p2pServer.replaceDeviceKey().catch(() => {}),
                })
              }
            >
              {REPLACE_KEY}
            </Button>
          </Row>
        )}
      </Surface>
    </>
  )
})
