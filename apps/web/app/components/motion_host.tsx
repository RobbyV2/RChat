'use client'

import { useEffect } from 'react'
import { useStore } from '../lib/client/react'
import { applyMotion, stopMotion } from '../lib/motion/host'
import { useReducedMotion } from '../lib/motion/use_motion'

// Runs the shown account's Animations setting on this tab.
export function MotionHost() {
  const anim = useStore(s => s.anim)
  const reduced = useReducedMotion(anim.on && anim.motion === 'device')
  useEffect(() => {
    void applyMotion(anim, reduced)
  }, [anim, reduced])
  useEffect(() => stopMotion, [])
  return null
}
