# Records the metrics the vintage style's @font-face overrides are computed from: units per em,
# hhea ascent, descent and line gap, and the average advance width of text weighted by English
# letter frequency (lowercase, digits and space, as UI text is), for the default instance of
# each font. Run by hand on fonts downloaded beforehand; nothing is fetched by the app or the
# build.
#   python3 -I scripts/fx/gen_font_metrics.py <dir with roboto.ttf, pixelify.ttf, silkscreen.ttf>
# writes apps/web/app/lib/__tests__/fixtures/fx_font_metrics.json. The fonts are the Google Fonts
# files ofl/roboto/Roboto[wdth,wght].ttf, ofl/pixelifysans/PixelifySans[wght].ttf and
# ofl/silkscreen/Silkscreen-Regular.ttf.
#
# The bundled files in apps/web/public/fonts are subsets of the same downloads (Basic Latin,
# Latin-1 Supplement and Latin Extended-A), made with fontTools:
#   python3 -I -m fontTools.subset <font.ttf> --unicodes=U+0020-007E,U+00A0-00FF,U+0100-017F \
#     --flavor=woff2 --layout-features='*' --name-IDs='*' --name-languages='*' \
#     --notdef-outline --output-file=<name>.woff2
# Source: google/fonts 8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5, upstream:
#   Pixelify Sans 1.000 (github.com/eifetx/Pixelify-Sans @ 39df74aba80df8157546034b878e8be1eb565ced)
#   Silkscreen 1.001 (github.com/googlefonts/silkscreen @ 206ccf3f5234c281461e63ecc59cbc6b0563472b)
import json
import os
import sys

from fontTools.ttLib import TTFont

# Relative letter frequencies of English text (percent), plus space and digits as UI text has.
FREQ = {
    'e': 12.02, 't': 9.10, 'a': 8.12, 'o': 7.68, 'i': 7.31, 'n': 6.95, 's': 6.28, 'r': 6.02,
    'h': 5.92, 'd': 4.32, 'l': 3.98, 'u': 2.88, 'c': 2.71, 'm': 2.61, 'f': 2.30, 'y': 2.11,
    'w': 2.09, 'g': 2.03, 'p': 1.82, 'b': 1.49, 'v': 1.11, 'k': 0.69, 'x': 0.17, 'q': 0.11,
    'j': 0.10, 'z': 0.07, ' ': 18.0, '0': 0.4, '1': 0.4, '2': 0.4, '3': 0.3, '4': 0.3,
    '5': 0.3, '6': 0.3, '7': 0.3, '8': 0.3, '9': 0.3,
}

OUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '../../apps/web/app/lib/__tests__/fixtures/fx_font_metrics.json',
)


def metrics(path):
    font = TTFont(path)
    upm = font['head'].unitsPerEm
    hhea = font['hhea']
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    total = 0.0
    weight = 0.0
    for ch, f in FREQ.items():
        glyph = cmap.get(ord(ch))
        if glyph is None:
            continue
        total += hmtx[glyph][0] * f
        weight += f
    caps = [hmtx[cmap[ord(c)]][0] for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' if ord(c) in cmap]
    return {
        'upm': upm,
        'ascent': hhea.ascent,
        'descent': hhea.descent,
        'lineGap': hhea.lineGap,
        'avgWidth': round(total / weight, 3),
        'avgCapWidth': round(sum(caps) / len(caps), 3),
    }


if len(sys.argv) < 2:
    sys.exit('usage: python3 -I scripts/fx/gen_font_metrics.py <dir with the three .ttf files>')
src = sys.argv[1]
data = {name: metrics(f'{src}/{name}.ttf') for name in ['roboto', 'pixelify', 'silkscreen']}
with open(OUT, 'w') as fh:
    json.dump(data, fh, indent=2)
    fh.write('\n')
print(json.dumps(data, indent=2))
