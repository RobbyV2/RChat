// The unread count in the tray tooltip, and the dot alone for the Windows taskbar overlay.

pub(crate) const DOT: [u8; 4] = [0xe5, 0x39, 0x35, 0xff];

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

// A dot alone, for the Windows taskbar overlay.
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
    fn overlay_dot_is_round() {
        let out = dot(16);
        assert_eq!(out.len(), 16 * 16 * 4);
        assert_eq!(&out[(8 * 16 + 8) * 4..][..4], DOT);
        assert_eq!(&out[..4], [0; 4]);
    }
}
