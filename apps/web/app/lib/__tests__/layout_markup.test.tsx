import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Grid, Row, Stack, Surface } from '../../components/layout'

const cls = (html: string) => /class="([^"]*)"/.exec(html)?.[1].split(' ') ?? []
const has = (html: string, ...want: string[]) => {
  for (const w of want) expect(cls(html)).toContain(w)
}

test('a stack is a column with a gap from the scale, as the element asked for', () => {
  const html = renderToStaticMarkup(
    <Stack as="ul" gap="sm" aria-label="Items">
      <li>a</li>
    </Stack>
  )
  expect(html.startsWith('<ul aria-label="Items" class="')).toBe(true)
  has(html, 'flex', 'flex-col', 'gap-(--space-sm)')
})

test('a placement that hides a row replaces its display', () => {
  const html = renderToStaticMarkup(
    <Row gap="xs" place="hidden md:flex">
      x
    </Row>
  )
  has(html, 'hidden', 'md:flex')
  expect(cls(html).includes('flex')).toBe(false)
})

test('a surface is a padded card around a column of its children', () => {
  const html = renderToStaticMarkup(
    <Surface as="section" pad="lg" gap="md" fit border>
      <img alt="" />
    </Surface>
  )
  expect(html.startsWith('<section class="')).toBe(true)
  has(
    html,
    'flex',
    'p-(--space-lg)',
    'gap-(--space-md)',
    'bg-surface-container-high',
    'rounded-2xl',
    'border',
    'w-fit'
  )
})

test('a grid is a grid', () => {
  has(renderToStaticMarkup(<Grid cols={2} gap="lg" />), 'grid', 'grid-cols-2', 'gap-(--space-lg)')
})

test('the boxes take no class names, styles, off-scale steps or margins', () => {
  const boxes = [
    // @ts-expect-error a box has no className
    <Stack key={0} gap="sm" className="p-4" />,
    // @ts-expect-error a box has no style
    <Row key={1} gap="sm" style={{ padding: 4 }} />,
    // @ts-expect-error the gap is a step of the scale
    <Stack key={2} gap="5" />,
    // @ts-expect-error a surface pads from the scale
    <Surface key={3} pad={4} />,
    // @ts-expect-error a box is placed, never spaced, by its parent
    <Row key={4} gap="sm" place="mt-2" />,
    <Row key={5} gap="sm" place="ml-auto min-w-0 flex-1" />,
    <Stack key={6} gap="sm" place="min-h-0 flex-1 overflow-y-auto overscroll-contain" />,
    <Surface key={7} pad="lg" place="max-w-md w-full" />,
    // @ts-expect-error sizes come from the content or the container scale
    <Surface key={8} pad="lg" place="w-[13rem]" />,
  ]
  expect(boxes.length).toBe(9)
})
