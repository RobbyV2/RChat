export interface EnterLike {
  key: string
  shiftKey: boolean
  keyCode: number
  nativeEvent: { isComposing: boolean }
}

export const composing = (e: Pick<EnterLike, 'keyCode' | 'nativeEvent'>) =>
  e.nativeEvent.isComposing || e.keyCode === 229

export const enterKey = (e: Pick<EnterLike, 'key' | 'keyCode' | 'nativeEvent'>) =>
  e.key === 'Enter' && !composing(e)

export const sendKey = (e: EnterLike) => enterKey(e) && !e.shiftKey
