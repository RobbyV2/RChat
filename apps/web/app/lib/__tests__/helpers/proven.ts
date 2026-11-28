import type { CheckedWire, Wire } from '../../p2p/event_v1'
import type { CheckedWire2, WireV2 } from '../../p2p/event_v2'

// A wire a test built with the real signer, taken as checked without the validator.
export function sound(wire: WireV2): CheckedWire2
export function sound(wire: Wire): CheckedWire
export function sound(wire: Wire | WireV2) {
  return wire
}
