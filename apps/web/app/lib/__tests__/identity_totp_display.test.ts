import { describe, expect, test } from 'bun:test'
import {
  RECOVERY_LOW,
  base32Decode,
  base32Encode,
  cleanCode,
  cleanRecovery,
  codeComplete,
  groupCode,
  groupKeyText,
  groupedKey,
  issuerLabel,
  otpauthUri,
  recoveryFileName,
  recoveryLeftLine,
  recoveryLine,
  recoveryText,
} from '../identity/totp_display'

const ascii = (s: string) => new TextEncoder().encode(s)
const rfcKey = ascii('12345678901234567890')

describe('the key on the enrolment screen', () => {
  test('base32 round trip and the RFC 4648 vectors', () => {
    expect(base32Encode(ascii('foobar'))).toBe('MZXW6YTBOI')
    expect(base32Encode(ascii('f'))).toBe('MY')
    expect(new TextDecoder().decode(base32Decode('mzxw 6ytb-oi======')!)).toBe('foobar')
    expect(base32Decode('MZXW1')).toBeNull()
    const k = new Uint8Array(20).map((_, i) => i * 13)
    expect(Array.from(base32Decode(base32Encode(k))!)).toEqual(Array.from(k))
    expect(base32Encode(k)).toHaveLength(32)
  })
  test('grouped in fours, from the bytes or from the text the server sent', () => {
    expect(groupedKey(rfcKey)).toBe('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')
    expect(groupKeyText('gezdgnbvgy3tqojqgezdgnbvgy3tqojq')).toBe(
      'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'
    )
    expect(groupKeyText('GEZD GNBV G')).toBe('GEZD GNBV G')
    expect(groupKeyText('')).toBe('')
  })
  test('the otpauth URI and the issuer label', () => {
    expect(otpauthUri('Chat (chat.example.com)', 'alice', rfcKey)).toBe(
      'otpauth://totp/Chat%20(chat.example.com):alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Chat%20(chat.example.com)&algorithm=SHA1&digits=6&period=30'
    )
    expect(issuerLabel('Chat', 'chat.example.com')).toBe('Chat (chat.example.com)')
    expect(issuerLabel('chat.example.com', 'chat.example.com')).toBe('chat.example.com')
  })
})

describe('the code field', () => {
  test('digits with optional spaces; anything else is not a code', () => {
    expect(cleanCode(' 123 456 ')).toBe('123456')
    expect(cleanCode('12345')).toBeNull()
    expect(cleanCode('12a456')).toBeNull()
    expect(cleanCode('１２３４５６')).toBeNull()
  })
  test('shown grouped, and a complete code submits', () => {
    expect(groupCode('123456')).toBe('123 456')
    expect(groupCode('1234')).toBe('123 4')
    expect(groupCode('12 3x4567 89')).toBe('123 456')
    expect(groupCode('')).toBe('')
    expect(codeComplete('123 456')).toBe(true)
    expect(codeComplete('123 45')).toBe(false)
  })
})

describe('recovery codes', () => {
  test('typed forgivingly', () => {
    expect(cleanRecovery('ABCDE fghjk')).toBe('abcdefghjk')
    expect(cleanRecovery('abcde-fgh1k')).toBeNull()
    expect(cleanRecovery('abcde-fghj')).toBeNull()
  })
  test('the low line shows at two or fewer', () => {
    expect(RECOVERY_LOW).toBe(2)
    expect(recoveryLeftLine(8)).toBeNull()
    expect(recoveryLeftLine(2)).toBe('You have 2 recovery codes left.')
    expect(recoveryLeftLine(1)).toBe('You have 1 recovery code left.')
    expect(recoveryLeftLine(0)).toBe('You have no recovery codes left.')
  })
  test('read out, saved and named', () => {
    expect(recoveryLine(0, 10, 'abcde-fghjk')).toBe('Recovery code 1 of 10: abcde fghjk')
    expect(recoveryFileName('chat.example.com')).toBe('chat.example.com-recovery-codes.txt')
    expect(recoveryFileName('Chat.Example.com:8443')).toBe(
      'chat.example.com-8443-recovery-codes.txt'
    )
    expect(recoveryText(['abcde-fghjk', '23456-789ab'])).toBe('abcde-fghjk\n23456-789ab\n')
  })
})
