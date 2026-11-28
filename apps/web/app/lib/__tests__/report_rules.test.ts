import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAnswers, contextOf, defaultForms, reportAllowed } from '../report_rules'
import { jsBuild, loadPerms, wasmBuild } from './helpers/perms'

interface CapCase {
  name: string
  caps: {
    same_target_secs: number
    targets_per_day: number
    per_week: number
    feedback_per_week: number
  }
  t: number
  sent: { target: string | null; ago: number }[]
  target: string | null
  allowed: boolean
}

const CASES = JSON.parse(
  readFileSync(
    join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      '..',
      'assets',
      'report_cap_cases.json'
    ),
    'utf8'
  )
) as CapCase[]

for (const [name, build] of [
  ['wasm', wasmBuild],
  ['js', jsBuild],
] as const) {
  describe(`report rules (${name})`, () => {
    test('the cap cases hold', async () => {
      await loadPerms(build)
      expect(CASES.length).toBeGreaterThanOrEqual(10)
      for (const c of CASES) {
        const sent = c.sent.map(s => ({ target: s.target, at: c.t - s.ago }))
        const caps = {
          sameTargetSecs: c.caps.same_target_secs,
          targetsPerDay: c.caps.targets_per_day,
          perWeek: c.caps.per_week,
          feedbackPerWeek: c.caps.feedback_per_week,
        }
        expect([c.name, reportAllowed(sent, c.target, caps, c.t)]).toEqual([c.name, c.allowed])
      }
    })

    test('the default forms are the built-in categories', async () => {
      await loadPerms(build)
      const forms = defaultForms()
      expect(forms.forms.map(f => [f.id, f.base])).toEqual([
        ['user', 'user'],
        ['bug', 'none'],
        ['server', 'server'],
        ['general', 'none'],
        ['message', 'message'],
      ])
    })

    test('answers are checked and kept as the server keeps them', async () => {
      await loadPerms(build)
      const forms = defaultForms()
      const bug = checkAnswers(
        forms,
        'bug',
        [
          { id: 'kind', value: 'exploded' },
          { id: 'summary', value: 'The page is blank' },
          { id: 'steps', value: '1. \n2. \n3. ' },
        ],
        100
      )
      expect(bug).toEqual({
        ok: true,
        answers: [
          {
            id: 'kind',
            label: 'What kind',
            kind: 'single_choice',
            value: 'other',
            shown: ['Other'],
          },
          {
            id: 'summary',
            label: 'What went wrong',
            kind: 'short_text',
            value: 'The page is blank',
            shown: null,
          },
        ],
      })
      expect(checkAnswers(forms, 'nope', [], 100)).toEqual({
        ok: false,
        refused: { part: 'form', msg: 'Unknown form' },
      })
      expect(checkAnswers(forms, 'bug', [{ id: 'kind', value: 'broke' }], 100)).toEqual({
        ok: false,
        refused: { part: 'answers', msg: 'Missing required field: summary' },
      })
      expect(
        checkAnswers(forms, 'user', [{ id: 'evidence', value: { username: 'x' } }], 100)
      ).toEqual({ ok: false, refused: { part: 'answers', msg: 'Answer of the wrong kind' } })
    })

    test('a report takes the latest earlier messages along, oldest first', async () => {
      await loadPerms(build)
      expect(contextOf([5, 1, 9, 3, 7], 7, 2)).toEqual([3, 5])
      expect(
        contextOf(
          Array.from({ length: 40 }, (_, i) => i),
          40,
          200
        )
      ).toHaveLength(10)
    })
  })
}
