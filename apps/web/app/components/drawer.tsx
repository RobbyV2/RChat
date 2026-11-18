'use client'

import { createContext, useContext } from 'react'

// Closes the phone drawer a choice was made in; outside a drawer it does nothing.
export const DrawerClose = createContext<() => void>(() => {})

export const useDrawerClose = () => useContext(DrawerClose)
