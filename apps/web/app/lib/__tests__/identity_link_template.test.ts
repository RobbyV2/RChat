import { expect, test } from 'bun:test'
import { fillTemplate, linkTemplate, placeholdersLeft } from '../identity/link_template'

const input = {
  issuer: 'https://chat.example.com',
  clientId: 'application_1',
  redirect: 'https://pixel.example.com/cb',
  scopes: ['servers', 'servers.join'],
  joinServers: ['lobby'],
  initiateLoginUri: 'https://pixel.example.com/login',
}

test('the link builder gives a template, never a fixed link without PKCE', () => {
  const l = linkTemplate(input)
  expect(l.template).toBe(
    'https://chat.example.com/oauth/authorize?response_type=code&client_id=application_1&redirect_uri=https%3A%2F%2Fpixel.example.com%2Fcb&scope=openid+profile+servers+servers.join&join_servers=lobby&state={state}&code_challenge={code_challenge}&code_challenge_method=S256'
  )
  expect(placeholdersLeft(l.template)).toBe(true)
  expect(l.share).toBe('https://pixel.example.com/login?iss=https%3A%2F%2Fchat.example.com')
})

test('openid and profile are always asked once; at most five servers are suggested; no share link without a start page', () => {
  const l = linkTemplate({
    ...input,
    scopes: ['profile', 'openid', 'servers'],
    joinServers: ['a', 'b', 'c', 'd', 'e', 'f'],
    initiateLoginUri: null,
  })
  expect(l.template).toContain('scope=openid+profile+servers&')
  expect(l.template).toContain('join_servers=a%2Cb%2Cc%2Cd%2Ce&')
  expect(l.share).toBeNull()
  expect(linkTemplate({ ...input, joinServers: [] }).template).not.toContain('join_servers')
})

test('Try it fills both placeholders', () => {
  const filled = fillTemplate(
    linkTemplate(input).template,
    's t',
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  )
  expect(placeholdersLeft(filled)).toBe(false)
  expect(filled).toContain('state=s%20t&')
  expect(filled).toContain('code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&')
  expect(new URL(filled).searchParams.get('state')).toBe('s t')
})
