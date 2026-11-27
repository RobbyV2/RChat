// "Replace this device's key" in Settings > Privacy: the copy and when it shows.

export const REPLACE_KEY = "Replace this device's key"
export const REPLACE_KEY_CONFIRM =
  'A new key encrypts what this identity stores on this device. The old one is deleted once that is done.'
export const REPLACE_KEY_HINT =
  'For a key that may have leaked: what this identity stores encrypted on this device is encrypted again.'
export const REPLACING_KEY = 'Encrypting with the new key.'

// Whether the section shows: this device stored something encrypted with a device key.
export const showsDeviceKey = (seal: { sealedAny: boolean; replacing: boolean }) =>
  seal.sealedAny || seal.replacing
