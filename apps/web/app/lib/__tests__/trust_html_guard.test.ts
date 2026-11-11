import { describe, expect, test } from 'bun:test'
import { isProxyPage } from '../trust/html_guard'

const response = (url: string, type: string | null) => ({
  url,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
})

describe('isProxyPage', () => {
  test('an API answer that is an HTML page comes from something in front of the instance', () => {
    for (const [url, type] of [
      ['https://chat.example.com/api/v1/me', 'text/html'],
      ['https://chat.example.com/api/v1/me', 'text/html; charset=utf-8'],
      ['https://chat.example.com/api/v1/me?x=1', 'Text/HTML;charset=UTF-8'],
      ['https://chat.example.com/api/instance', ' text/html '],
      ['https://api.example.com/prefix/api/v1/servers', 'text/html'],
      ['/api/v1/me', 'text/html'],
      ['https://chat.example.com/api', 'text/html'],
    ])
      expect(isProxyPage(response(url, type))).toBe(true)
  })

  test('JSON, files, missing types and pages outside the API are not', () => {
    for (const [url, type] of [
      ['https://chat.example.com/api/v1/me', 'application/json'],
      ['https://chat.example.com/api/v1/me', null],
      ['https://chat.example.com/api/v1/me', ''],
      ['https://chat.example.com/api/v1/media/7', 'image/png'],
      ['https://chat.example.com/api/v1/media/7', 'application/xhtml+xml'],
      ['https://chat.example.com/api/v1/media/7', 'text/htmlx'],
      ['https://chat.example.com/', 'text/html'],
      ['https://chat.example.com/s/lobby/', 'text/html'],
      ['https://chat.example.com/apiary/x', 'text/html'],
      ['https://chat.example.com/s/api-talk/', 'text/html'],
      ['not a url', 'text/html'],
    ] as [string, string | null][])
      expect(isProxyPage(response(url, type))).toBe(false)
  })
})
