import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Download, Pin, Trash2, X } from 'lucide-react'
import {
  Badge,
  Button,
  ButtonLink,
  CallButton,
  Chip,
  EmojiCell,
  Hotspot,
  IconButton,
  IconLink,
  LinkButton,
  ListRow,
  Pressable,
  Pill,
  SectionHeading,
  SideRow,
  Swatch,
  SwitchRow,
  Tab,
  Tick,
  Tile,
  TriButton,
  WindowButton,
} from '../../components/controls'
import { CloseButton, PanelHeader, sectionCls } from '../../components/ui'
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
    expect(attr(on, 'class')).toBe(`inline-flex ${chipLook(true)}`)
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
    expect(html).toContain('<span class="truncate">Week</span></button>')
  })

  test('a chip can be a switch or a tab, and a reaction keeps what it holds as given', () => {
    const sw = renderToStaticMarkup(
      <Chip on as="switch">
        Show
      </Chip>
    )
    expect(sw).toContain('role="switch" aria-checked="true"')
    const tab = renderToStaticMarkup(
      <Chip on={false} as="tab" variant="reaction" plain label="2 reactions">
        <span>2</span>
      </Chip>
    )
    expect(tab).toContain('role="tab"')
    expect(tab).toContain('aria-selected="false"')
    expect(tab).toContain('aria-label="2 reactions"')
    expect(tab).toContain('<span>2</span></button>')
    expect(attr(tab, 'class')).toBe(`inline-flex ${chipLook(false, 'reaction')}`)
  })
})

describe('controls that show no words', () => {
  test('each has a name and a tooltip', () => {
    for (const html of [
      renderToStaticMarkup(<Tile label="Home">H</Tile>),
      renderToStaticMarkup(<CallButton icon={Trash2} label="Home" />),
      renderToStaticMarkup(<Hotspot label="Home" />),
      renderToStaticMarkup(<Swatch color="#fff" ink="#000" on label="Home" />),
      renderToStaticMarkup(
        <WindowButton kind="dot" label="Home">
          x
        </WindowButton>
      ),
      renderToStaticMarkup(<TriButton icon={Trash2} tone="allow" on label="Home" />),
      renderToStaticMarkup(<Tick checked label="Home" />),
      renderToStaticMarkup(<IconButton glyph="x" label="Home" />),
    ]) {
      expect(html).toContain('aria-label="Home"')
      expect(html).toContain('title="Home"')
      expect(html).toContain('type="button"')
    }
  })

  test('a tooltip that differs from the name replaces it', () => {
    const html = renderToStaticMarkup(
      <Tile label="alice" tooltip="Account">
        A
      </Tile>
    )
    expect(html).toContain('aria-label="alice"')
    expect(html).toContain('title="Account"')
  })

  test('a switch row says whether it is on and is described by its hint', () => {
    const html = renderToStaticMarkup(<SwitchRow checked label="Sounds" hint="Plays" hintId="h" />)
    expect(html).toContain(
      'role="switch" aria-checked="true" aria-label="Sounds" aria-describedby="h"'
    )
    expect(html).toContain('<span id="h"')
  })

  test('a sidebar row marks the open one and a heading says whether it is unfolded', () => {
    expect(renderToStaticMarkup(<SideRow current>general</SideRow>)).toContain(
      'aria-current="page"'
    )
    const heading = renderToStaticMarkup(
      <SideRow tone="heading" open={false}>
        Text
      </SideRow>
    )
    expect(heading).toContain('aria-expanded="false"')
    expect(heading).not.toContain('aria-current')
  })

  test('an emoji cell is an unselected option the keys move over', () => {
    const html = renderToStaticMarkup(<EmojiCell label="grin">g</EmojiCell>)
    expect(html).toContain('role="option"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-selected="false"')
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

describe('links that look like controls', () => {
  test('a ButtonLink is a link with the look of the Button of its variant and size', () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/files/a.txt" download="a.txt" variant="danger">
        Get it
      </ButtonLink>
    )
    expect(html.startsWith('<a ')).toBe(true)
    expect(attr(html, 'href')).toBe('/files/a.txt')
    expect(attr(html, 'download')).toBe('a.txt')
    expect(attr(html, 'class')).toContain(buttonLook('danger', 'sm'))
  })

  test('an IconLink is named by its label, which is also its tooltip unless one is given', () => {
    const html = renderToStaticMarkup(
      <IconLink href="/f" icon={Download} label="Download" tone="filled" size="xl" shape="square" />
    )
    expect(html.startsWith('<a ')).toBe(true)
    expect(attr(html, 'aria-label')).toBe('Download')
    expect(attr(html, 'title')).toBe('Download')
    expect(attr(html, 'class')).toContain(iconButtonLook('filled', 'xl', 'square'))
    const tipped = renderToStaticMarkup(
      <IconLink href="/f" icon={Download} label="Download" tooltip="Download a.txt" />
    )
    expect(attr(tipped, 'title')).toBe('Download a.txt')
  })
})

describe('Pressable', () => {
  test('is a real button with no box of its own around what it holds', () => {
    const html = renderToStaticMarkup(
      <Pressable title="View profile">
        <span>alice</span>
      </Pressable>
    )
    expect(html.startsWith('<button type="button"')).toBe(true)
    expect(attr(html, 'title')).toBe('View profile')
    const cls = attr(html, 'class') ?? ''
    for (const c of ['inline-flex', 'min-w-0', 'cursor-pointer', 'focus-visible:outline-2'])
      expect(cls.split(' ')).toContain(c)
    expect(/(^| )(p|px|py|bg)-/.test(cls)).toBe(false)
  })

  test('flows in a line of text when inline, and rings an avatar or a row by its shape', () => {
    const inline = attr(renderToStaticMarkup(<Pressable inline>@bob</Pressable>), 'class') ?? ''
    expect(inline.split(' ')).toContain('inline')
    expect(inline.split(' ')).not.toContain('inline-flex')
    const round = renderToStaticMarkup(<Pressable shape="round">x</Pressable>)
    expect(attr(round, 'class')).toContain('rounded-full')
    const row = renderToStaticMarkup(<Pressable shape="row">x</Pressable>)
    expect(attr(row, 'class')).toContain('w-full rounded-lg -outline-offset-2')
  })
})
