import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Pin, Trash2, X } from 'lucide-react'
import {
  Badge,
  Button,
  Chip,
  IconButton,
  LinkButton,
  ListRow,
  Pill,
  SectionHeading,
  Tab,
} from '../../components/controls'
import {
  CloseButton,
  PanelHeader,
  dangerBtn,
  filledBtn,
  filledDangerBtn,
  iconBtn,
  sectionCls,
  textBtn,
} from '../../components/ui'
import {
  buttonLook,
  chipLook,
  iconBoxLook,
  iconButtonLook,
  rowLook,
  sectionHeadingLook,
} from '../controls'

const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1]

describe('Button', () => {
  test('is a plain button unless asked to submit', () => {
    const html = renderToStaticMarkup(<Button>Save</Button>)
    expect(attr(html, 'type')).toBe('button')
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toContain('type="submit"')
  })

  test('takes its look from its variant and size, and its placement after it', () => {
    const html = renderToStaticMarkup(
      <Button variant="filled" size="md" place="ml-auto">
        Save
      </Button>
    )
    expect(attr(html, 'class')).toBe(
      `inline-flex items-center justify-center gap-1.5 ${buttonLook('filled', 'md')} ml-auto`
    )
  })

  test('a busy button is disabled, says so, and keeps its label for its width and name', () => {
    const html = renderToStaticMarkup(
      <Button busy icon={Trash2}>
        Delete
      </Button>
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('animate-spin')
    expect(html).toContain('Delete')
    const label = /<span class="([^"]*)">(<svg[^>]*>.*?<\/svg>)?Delete/.exec(html)?.[1] ?? ''
    expect(label.split(' ')).toContain('opacity-0')
    expect(html).not.toContain('invisible')
  })

  test('a button that is not busy has no spinner', () => {
    const html = renderToStaticMarkup(<Button icon={Pin}>Pin</Button>)
    expect(html).not.toContain('aria-busy')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('disabled=""')
  })
})

describe('IconButton', () => {
  test('its label is both its accessible name and its tooltip', () => {
    const html = renderToStaticMarkup(<IconButton icon={X} label="Close panel" />)
    expect(attr(html, 'title')).toBe('Close panel')
    expect(attr(html, 'aria-label')).toBe('Close panel')
    expect(html).toContain('aria-hidden="true"')
  })

  test('a tooltip can stand in for a name the tooltip must not show', () => {
    const html = renderToStaticMarkup(<IconButton icon={X} label="Delete Dana" tooltip="Delete" />)
    expect(attr(html, 'title')).toBe('Delete')
    expect(attr(html, 'aria-label')).toBe('Delete Dana')
  })

  test('a toggle says whether it is on', () => {
    expect(renderToStaticMarkup(<IconButton icon={Pin} label="Pin" pressed />)).toContain(
      'aria-pressed="true"'
    )
    expect(renderToStaticMarkup(<IconButton icon={Pin} label="Pin" pressed={false} />)).toContain(
      'aria-pressed="false"'
    )
    expect(renderToStaticMarkup(<IconButton icon={Pin} label="Pin" />)).not.toContain(
      'aria-pressed="'
    )
  })

  test('something over the icon sits in the mouse-sized box, so it stays by the icon on touch', () => {
    const over = renderToStaticMarkup(
      <IconButton icon={Pin} label="Pins">
        <Badge>3</Badge>
      </IconButton>
    )
    expect(over).toContain(`<span class="${iconBoxLook('md')}"><svg`)
    expect(attr(over, 'class')?.split(' ')).not.toContain('relative')
    const placed = renderToStaticMarkup(
      <IconButton icon={Pin} label="Pins" place="absolute top-2 right-2">
        <Badge>3</Badge>
      </IconButton>
    )
    const cls = attr(placed, 'class')?.split(' ') ?? []
    expect(cls).toContain('absolute')
    expect(cls).not.toContain('relative')
  })

  test('a placement that hides it replaces its display', () => {
    const cls =
      attr(
        renderToStaticMarkup(<IconButton icon={Pin} label="Pins" place="hidden md:inline-flex" />),
        'class'
      )?.split(' ') ?? []
    expect(cls).toContain('hidden')
    expect(cls).not.toContain('inline-flex')
  })
})

describe('ListRow, SectionHeading, Badge, Pill', () => {
  test('a row shows its icon, label, line and trailing slot, and marks the open one', () => {
    const html = renderToStaticMarkup(
      <ListRow
        icon={Pin}
        label="Pinned"
        description="3 messages"
        trailing={<Badge>3</Badge>}
        current
      />
    )
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('Pinned')
    expect(html).toContain('3 messages')
    expect(html.indexOf('Pinned')).toBeLessThan(html.indexOf('>3<'))
    expect(renderToStaticMarkup(<ListRow label="Other" />)).not.toContain('aria-current')
  })

  test('a card row has its own surface and is 44 px high, an avatar leads, a chevron trails', () => {
    const html = renderToStaticMarkup(
      <ListRow variant="card" chevron leading={<img alt="" src="a.png" />} label="dana" />
    )
    expect(attr(html, 'class')).toBe(`flex ${rowLook('plain', 'card')}`)
    expect(attr(html, 'class')?.split(' ')).toContain('min-h-11')
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('dana'))
    expect(html.lastIndexOf('lucide-chevron-right')).toBeGreaterThan(html.indexOf('dana'))
    expect(renderToStaticMarkup(<ListRow label="x" />)).not.toContain('chevron')
  })

  test('a name row blurs its label in streamer mode, on the element that cuts it short', () => {
    const html = renderToStaticMarkup(<ListRow streamer label="Dana" />)
    expect(html).toContain('<span class="streamer truncate">Dana</span>')
    expect(renderToStaticMarkup(<ListRow label="Dana" />)).not.toContain('streamer')
  })

  test('a section heading is a heading with the shared look', () => {
    expect(renderToStaticMarkup(<SectionHeading>Members</SectionHeading>)).toBe(
      `<h3 class="${sectionHeadingLook}">Members</h3>`
    )
    const html = renderToStaticMarkup(
      <SectionHeading as="h2" action={<Button>Add</Button>}>
        Roles
      </SectionHeading>
    )
    expect(html).toContain('<h2')
    expect(html).toContain('Add')
  })

  test('badges and pills take a tone', () => {
    expect(renderToStaticMarkup(<Badge tone="primary">5</Badge>)).toContain('bg-primary')
    expect(renderToStaticMarkup(<Pill tone="tertiary">P2P</Pill>)).toContain(
      'bg-tertiary-container'
    )
  })
})

describe('LinkButton', () => {
  test('a button inside a sentence reads as a link and is 44 px to tap on a coarse pointer', () => {
    const html = renderToStaticMarkup(<LinkButton>Add friend</LinkButton>)
    expect(attr(html, 'type')).toBe('button')
    expect(attr(html, 'class')?.split(' ')).toContain('inline-flex')
    const cls = attr(html, 'class')?.split(' ') ?? []
    expect(cls).toContain('pointer-coarse:py-3.5')
    expect(cls).toContain('pointer-coarse:-my-3.5')
    expect(html).toContain('>Add friend</button>')
  })
})

describe('Chip', () => {
  test('a toggle chip says whether it is on', () => {
    const on = renderToStaticMarkup(<Chip on>Mods</Chip>)
    expect(on).toContain('aria-pressed="true"')
    expect(on).not.toContain('role=')
    expect(attr(on, 'class')).toBe(`inline-block ${chipLook(true)}`)
    expect(renderToStaticMarkup(<Chip on={false}>Mods</Chip>)).toContain('aria-pressed="false"')
  })

  test('in a radio group a chip is a radio that says whether it is chosen', () => {
    const html = renderToStaticMarkup(
      <Chip on radio>
        Week
      </Chip>
    )
    expect(html).toContain('role="radio" aria-checked="true"')
    expect(html).not.toContain('aria-pressed')
    expect(html).toContain('>Week</button>')
  })
})

describe('Tab', () => {
  test('a tab says whether it is selected and shows it through that', () => {
    const on = renderToStaticMarkup(<Tab selected>Incoming</Tab>)
    expect(on).toContain('role="tab" aria-selected="true"')
    expect(attr(on, 'class')?.split(' ')).toContain('selected:bg-secondary-container')
    expect(renderToStaticMarkup(<Tab selected={false}>Outgoing</Tab>)).toContain(
      'aria-selected="false"'
    )
  })
})

describe('the shared class names and close buttons', () => {
  test('the class names are the looks of the controls', () => {
    expect(filledBtn).toBe(buttonLook('filled', 'md'))
    expect(filledDangerBtn).toBe(buttonLook('filled-danger', 'md'))
    expect(textBtn).toBe(buttonLook('text', 'sm'))
    expect(dangerBtn).toBe(buttonLook('danger', 'sm'))
    expect(iconBtn).toBe(`inline-flex ${iconButtonLook('plain', 'lg')}`)
    expect(sectionCls).toBe(sectionHeadingLook)
  })

  test('close buttons are labelled icon buttons', () => {
    const close = renderToStaticMarkup(<CloseButton onClick={() => {}} />)
    expect(attr(close, 'aria-label')).toBe('Close')
    expect(attr(close, 'title')).toBe('Close')
    const header = renderToStaticMarkup(
      <PanelHeader icon={Pin} title="Pins" closeTitle="Close pins" onClose={() => {}} />
    )
    expect(attr(header, 'aria-label')).toBe('Close pins')
    expect(attr(header, 'title')).toBe('Close pins')
  })
})
