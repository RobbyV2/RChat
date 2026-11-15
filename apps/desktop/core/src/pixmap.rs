// Tray icons made from the app icon: in color on Windows and Linux, a template glyph on macOS,
// each with and without the unread dot.

use crate::badge::DOT;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pixmap {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Windows,
    Macos,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Os::Macos
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Look {
    pub size: u32,
    // macOS menu bar icons are templates: only their alpha counts, and the system colors them.
    pub template: bool,
}

pub fn look(os: Os) -> Look {
    match os {
        // Windows draws it at 16 to 32 px, depending on the display scale.
        Os::Windows => Look {
            size: 32,
            template: false,
        },
        // The menu bar shows it 18 points high, so 36 px is sharp on Retina displays.
        Os::Macos => Look {
            size: 36,
            template: true,
        },
        // StatusNotifierItem hosts scale it to their panel.
        Os::Linux => Look {
            size: 64,
            template: false,
        },
    }
}

pub fn tray_icon(os: Os, app_icon: &Pixmap, unread: bool) -> Pixmap {
    let Look { size, template } = look(os);
    let (base, dot) = if template {
        (scale(&letter(app_icon), size), BLACK)
    } else {
        (scale(app_icon, size), DOT)
    };
    if unread { with_dot(&base, dot) } else { base }
}

const BLACK: [u8; 4] = [0, 0, 0, 0xff];

fn blank(width: u32, height: u32) -> Pixmap {
    Pixmap {
        width,
        height,
        rgba: vec![0; (width * height * 4) as usize],
    }
}

// Shrinks by averaging the area under each new pixel. Colors are weighted by alpha, so clear
// pixels lower the alpha without darkening the color.
fn scale(src: &Pixmap, size: u32) -> Pixmap {
    let mut out = blank(size, size);
    let fx = src.width as f32 / size as f32;
    let fy = src.height as f32 / size as f32;
    for (i, px) in out.rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (dx, dy) = ((i as u32 % size) as f32, (i as u32 / size) as f32);
        let (x0, x1) = (dx * fx, (dx + 1.0) * fx);
        let (y0, y1) = (dy * fy, (dy + 1.0) * fy);
        let mut sum = [0f32; 4];
        for sy in y0 as u32..(y1.ceil() as u32).min(src.height) {
            let wy = (y1.min(sy as f32 + 1.0) - y0.max(sy as f32)).max(0.0);
            for sx in x0 as u32..(x1.ceil() as u32).min(src.width) {
                let w = wy * (x1.min(sx as f32 + 1.0) - x0.max(sx as f32)).max(0.0);
                let at = ((sy * src.width + sx) * 4) as usize;
                let [r, g, b, a] = [0, 1, 2, 3].map(|c| f32::from(src.rgba[at + c]));
                let wa = w * a;
                sum[0] += wa * r;
                sum[1] += wa * g;
                sum[2] += wa * b;
                sum[3] += wa;
            }
        }
        let alpha = sum[3] / (fx * fy);
        if sum[3] > 0.0 {
            *px = [
                (sum[0] / sum[3]).round() as u8,
                (sum[1] / sum[3]).round() as u8,
                (sum[2] / sum[3]).round() as u8,
                alpha.round().min(255.0) as u8,
            ];
        }
    }
    out
}

// How much of a pixel is the app icon's red letter. The letter is red on a light blue tile: red
// minus blue is about 125 on the letter and -67 on the tile, and its edges fall in between.
fn ink(px: [u8; 4]) -> u8 {
    let [r, _, b, a] = px;
    let t = ((f32::from(r) - f32::from(b) + 20.0) / 100.0).clamp(0.0, 1.0);
    (t * f32::from(a)).round() as u8
}

// The letter alone, in black, on a clear square around it with a small margin.
fn letter(icon: &Pixmap) -> Pixmap {
    let mask: Vec<u8> = icon
        .rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| ink(*px))
        .collect();
    let solid = |x: u32, y: u32| mask[(y * icon.width + x) as usize] > 32;
    let rows: Vec<u32> = (0..icon.height)
        .filter(|&y| (0..icon.width).any(|x| solid(x, y)))
        .collect();
    let cols: Vec<u32> = (0..icon.width)
        .filter(|&x| (0..icon.height).any(|y| solid(x, y)))
        .collect();
    let (Some(&top), Some(&bottom), Some(&left), Some(&right)) =
        (rows.first(), rows.last(), cols.first(), cols.last())
    else {
        return blank(icon.width, icon.height);
    };
    let (w, h) = (right - left + 1, bottom - top + 1);
    let side = w.max(h) * 112 / 100;
    let x0 = i64::from(left) - i64::from((side - w) / 2);
    let y0 = i64::from(top) - i64::from((side - h) / 2);
    let mut out = blank(side, side);
    for (i, px) in out.rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let x = x0 + i64::from(i as u32 % side);
        let y = y0 + i64::from(i as u32 / side);
        if (0..i64::from(icon.width)).contains(&x) && (0..i64::from(icon.height)).contains(&y) {
            px[3] = mask[(y as u32 * icon.width + x as u32) as usize];
        }
    }
    out
}

// The share of a pixel inside a circle, from 4 x 4 samples.
fn coverage(x: u32, y: u32, cx: f32, cy: f32, r: f32) -> f32 {
    let inside = (0..16)
        .filter(|i| {
            let dx = x as f32 + (i % 4) as f32 / 4.0 + 0.125 - cx;
            let dy = y as f32 + (i / 4) as f32 / 4.0 + 0.125 - cy;
            dx * dx + dy * dy <= r * r
        })
        .count();
    inside as f32 / 16.0
}

// The unread dot in the top right corner, in a clear ring so it stands out on any panel.
fn with_dot(icon: &Pixmap, color: [u8; 4]) -> Pixmap {
    let mut out = icon.clone();
    let size = icon.width.min(icon.height) as f32;
    let r = size * 0.22;
    let gap = size * 0.06;
    let (cx, cy) = (icon.width as f32 - r, r);
    for (i, px) in out.rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (x, y) = (i as u32 % icon.width, i as u32 / icon.width);
        let ring = coverage(x, y, cx, cy, r + gap);
        if ring == 0.0 {
            continue;
        }
        let dot = coverage(x, y, cx, cy, r);
        let under = f32::from(px[3]) * (1.0 - ring) / 255.0;
        let alpha = dot + under * (1.0 - dot);
        if alpha == 0.0 {
            *px = [0; 4];
            continue;
        }
        let mix = |c: usize| {
            ((f32::from(color[c]) * dot + f32::from(px[c]) * under * (1.0 - dot)) / alpha).round()
                as u8
        };
        *px = [mix(0), mix(1), mix(2), (alpha * 255.0).round() as u8];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 4] = [0xe5, 0x39, 0x35, 0xff];
    const TILE: [u8; 4] = [0xa9, 0xd3, 0xee, 0xff];
    const INK: [u8; 4] = [0xb8, 0x3b, 0x3b, 0xff];
    const CLEAR: [u8; 4] = [0; 4];
    const OSES: [Os; 3] = [Os::Windows, Os::Macos, Os::Linux];

    fn filled(side: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Pixmap {
        Pixmap {
            width: side,
            height: side,
            rgba: (0..side * side)
                .flat_map(|i| paint(i % side, i / side))
                .collect(),
        }
    }

    fn at(p: &Pixmap, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * p.width + x) * 4) as usize;
        p.rgba[i..i + 4].try_into().unwrap()
    }

    // A light tile with a red block in it, like the app icon's letter.
    fn sticker() -> Pixmap {
        filled(256, |x, y| match (x, y) {
            (90..150, 70..170) => INK,
            (30..226, 30..226) => TILE,
            _ => CLEAR,
        })
    }

    fn opaque(p: &Pixmap) -> usize {
        p.rgba
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|px| px[3] > 0)
            .count()
    }

    #[test]
    fn each_os_gets_its_size_and_kind() {
        assert_eq!(
            look(Os::Windows),
            Look {
                size: 32,
                template: false
            }
        );
        assert_eq!(
            look(Os::Macos),
            Look {
                size: 36,
                template: true
            }
        );
        assert_eq!(
            look(Os::Linux),
            Look {
                size: 64,
                template: false
            }
        );
        for os in OSES {
            for unread in [false, true] {
                let icon = tray_icon(os, &sticker(), unread);
                let size = look(os).size;
                assert_eq!((icon.width, icon.height), (size, size));
                assert_eq!(icon.rgba.len(), (size * size * 4) as usize);
            }
        }
    }

    #[test]
    fn this_build_knows_its_os() {
        let want = if cfg!(target_os = "macos") {
            Os::Macos
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        };
        assert_eq!(Os::current(), want);
    }

    #[test]
    fn color_icons_shrink_by_area() {
        let half = filled(256, |x, _| if x < 128 { RED } else { CLEAR });
        let icon = tray_icon(Os::Windows, &half, false);
        assert_eq!(at(&icon, 0, 0), RED);
        assert_eq!(at(&icon, 15, 31), RED);
        assert_eq!(at(&icon, 16, 0), CLEAR);
        let stripes = filled(256, |x, _| if x % 2 == 0 { RED } else { CLEAR });
        let icon = tray_icon(Os::Linux, &stripes, false);
        // Clear pixels don't darken the color, they only lower the alpha.
        for px in icon.rgba.as_chunks::<4>().0 {
            assert_eq!(*px, [RED[0], RED[1], RED[2], 128]);
        }
    }

    #[test]
    fn the_template_is_the_letter_in_black() {
        let icon = tray_icon(Os::Macos, &sticker(), false);
        for px in icon.rgba.as_chunks::<4>().0 {
            assert_eq!(px[..3], [0, 0, 0]);
        }
        // The letter fills the middle, and the tile around it is gone.
        assert_eq!(at(&icon, 18, 18)[3], 255);
        assert_eq!(at(&icon, 0, 0)[3], 0);
        assert_eq!(at(&icon, 35, 35)[3], 0);
        assert_eq!(at(&icon, 18, 0)[3], 0);
        let tall = icon.height as usize;
        let rows = (0..tall)
            .filter(|&y| (0..icon.width).any(|x| at(&icon, x, y as u32)[3] > 0))
            .count();
        assert!(rows > tall * 3 / 4 && rows < tall, "{rows} rows");
        let colored = tray_icon(Os::Linux, &sticker(), false);
        assert_eq!(at(&colored, 2, 32)[3], 0);
        assert_eq!(at(&colored, 32, 32), INK);
        assert_eq!(at(&colored, 12, 12), TILE);
    }

    #[test]
    fn the_dot_sits_top_right_in_a_clear_ring() {
        for os in OSES {
            let plain = tray_icon(os, &filled(256, |_, _| TILE), false);
            let dot = tray_icon(os, &filled(256, |_, _| TILE), true);
            let size = plain.width;
            let r = size as f32 * 0.22;
            let center = (size as f32 - r) as u32;
            let color = if look(os).template {
                [0, 0, 0, 255]
            } else {
                RED
            };
            assert_eq!(at(&dot, center, size - center - 1), color, "{os:?}");
            // Just outside the dot, toward the middle of the icon.
            let ring = (size as f32 - 2.0 * r - size as f32 * 0.03) as u32;
            assert_eq!(at(&dot, ring, size - center - 1)[3], 0, "{os:?}");
            for y in 0..size {
                for x in 0..size {
                    if x < size / 2 || y > size / 2 {
                        assert_eq!(at(&dot, x, y), at(&plain, x, y), "{os:?} {x},{y}");
                    }
                }
            }
            assert_ne!(dot, plain);
        }
    }

    #[test]
    fn the_unread_template_shows_the_dot_on_a_clear_tile() {
        let icon = tray_icon(Os::Macos, &filled(256, |_, _| CLEAR), true);
        assert!(opaque(&icon) > 0);
        assert!(opaque(&icon) < (36 * 36) / 4);
    }

    fn app_icon() -> Pixmap {
        let file = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src-tauri/icons/128x128@2x.png"
        );
        let mut decoder =
            png::Decoder::new(std::io::BufReader::new(std::fs::File::open(file).unwrap()));
        decoder.set_transformations(png::Transformations::EXPAND);
        let mut reader = decoder.read_info().unwrap();
        let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut rgba).unwrap();
        assert_eq!(info.color_type, png::ColorType::Rgba);
        rgba.truncate(info.buffer_size());
        Pixmap {
            width: info.width,
            height: info.height,
            rgba,
        }
    }

    // The template is made from the letter's red: if the art changes, this shows it.
    #[test]
    fn the_app_icon_gives_a_clean_letter() {
        let icon = tray_icon(Os::Macos, &app_icon(), false);
        let share = opaque(&icon) as f32 / (36.0 * 36.0);
        assert!((0.3..0.75).contains(&share), "{share}");
        let edge = (0..36).all(|i| {
            [
                at(&icon, i, 0),
                at(&icon, 0, i),
                at(&icon, i, 35),
                at(&icon, 35, i),
            ]
            .iter()
            .all(|px| px[3] == 0)
        });
        assert!(edge, "the letter touches the edge");
        let solid = icon
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|px| px[3] == 255);
        assert!(solid.count() as f32 / (36.0 * 36.0) > 0.15);
        for os in OSES {
            let plain = tray_icon(os, &app_icon(), false);
            let dot = tray_icon(os, &app_icon(), true);
            assert_ne!(plain, dot);
        }
    }
}
