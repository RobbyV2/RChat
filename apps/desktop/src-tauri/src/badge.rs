// Unread count shown on the tray icon and, where the OS has no badge, as a dot overlay.

const DOT: [u8; 4] = [0xe5, 0x39, 0x35, 0xff];

pub fn tooltip(name: &str, count: u32) -> String {
    match count {
        0 => name.to_string(),
        1..=99 => format!("{name} ({count})"),
        _ => format!("{name} (99+)"),
    }
}

fn inside(x: u32, y: u32, cx: f32, cy: f32, r: f32) -> bool {
    let dx = x as f32 + 0.5 - cx;
    let dy = y as f32 + 0.5 - cy;
    dx * dx + dy * dy <= r * r
}

// Paints a red dot into the top right corner of an RGBA image.
pub fn with_dot(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let size = width.min(height) as f32;
    let r = size * 0.24;
    let (cx, cy) = (width as f32 - r - size * 0.02, r + size * 0.02);
    for (i, px) in out.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (x, y) = (i as u32 % width, i as u32 / width);
        if inside(x, y, cx, cy, r) {
            *px = DOT;
        }
    }
    out
}

// A dot alone, for the Windows taskbar overlay.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn dot(size: u32) -> Vec<u8> {
    let half = size as f32 / 2.0;
    (0..size * size)
        .flat_map(|i| {
            if inside(i % size, i / size, half, half, half) {
                DOT
            } else {
                [0; 4]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltips() {
        assert_eq!(tooltip("RChat", 0), "RChat");
        assert_eq!(tooltip("RChat", 7), "RChat (7)");
        assert_eq!(tooltip("RChat", 99), "RChat (99)");
        assert_eq!(tooltip("RChat", 100), "RChat (99+)");
    }

    #[test]
    fn dot_sits_top_right() {
        let w = 32;
        let base = vec![0u8; (w * w * 4) as usize];
        let out = with_dot(&base, w, w);
        assert_eq!(out.len(), base.len());
        let at = |x: u32, y: u32| &out[((y * w + x) * 4) as usize..][..4];
        assert_eq!(at(w - 8, 8), DOT);
        assert_eq!(at(2, w - 2), [0; 4]);
        assert_eq!(at(2, 2), [0; 4]);
    }

    #[test]
    fn overlay_dot_is_round() {
        let out = dot(16);
        assert_eq!(out.len(), 16 * 16 * 4);
        assert_eq!(&out[(8 * 16 + 8) * 4..][..4], DOT);
        assert_eq!(&out[..4], [0; 4]);
    }
}
