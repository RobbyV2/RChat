//! Animated pictures: the chosen square of an animated GIF, WebP or PNG, frame by frame within
//! bounds, encoded again as animated GIFs at `ANIMATED_SIZES`. Frames are decoded, cropped,
//! resized and encoded one at a time, so an animation never sits decoded in memory.

use std::io::Cursor;

use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::imageops::{self, FilterType};
use image::{AnimationDecoder, Delay, Frame, Frames, ImageDecoder, ImageFormat, Limits};

use crate::{Crop, MAX_PIXELS, Refused, placed, unread};

/// The sides, in pixels, an animation is kept at.
pub const ANIMATED_SIZES: [u32; 2] = [128, 512];
/// The shortest time a frame shows, in milliseconds: 25 frames a second, the fastest rate under
/// 30 that a GIF's hundredths of a second can say. A faster frame is left out and its time goes
/// to the frame before.
pub const MIN_FRAME_MILLIS: u64 = 40;
/// What a frame without a time shows for, as browsers play it.
const DEFAULT_FRAME_MILLIS: u64 = 100;
/// How hard the encoder looks for colors, 1 (best) to 30 (fastest).
const GIF_SPEED: i32 = 10;

/// The bounds of an animation: past any of them it is refused, never cut.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    /// Most frames.
    pub frames: u32,
    /// Longest duration, in milliseconds.
    pub millis: u64,
    /// Most decoded pixels in all: width times height times frames.
    pub pixels: u64,
    /// Most bytes of one encoded file. The larger file is left out when it passes this; the
    /// smaller one passing it refuses the animation.
    pub bytes: usize,
}

/// An animation ready to store: an animated GIF per size in `ANIMATED_SIZES`. The larger one is
/// missing when it would pass the byte bound. Only `animate` makes one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Animated {
    small: Vec<u8>,
    large: Option<Vec<u8>>,
}

impl Animated {
    /// The content type of every file.
    pub const MIME: &'static str = "image/gif";

    /// The 128 pixel animation.
    pub fn small(&self) -> &[u8] {
        &self.small
    }

    /// The 512 pixel animation, when it fits the byte bound.
    pub fn large(&self) -> Option<&[u8]> {
        self.large.as_deref()
    }
}

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4 + 64 * 1024 * 1024);
    limits
}

/// The size of an animation's canvas, and its frames.
type Source<'a> = ((u32, u32), Frames<'a>);

/// The frames of `bytes` when its format can hold an animation and says it does, with the size
/// of its canvas. `None` for a still image.
fn frames(bytes: &[u8]) -> Result<Option<Source<'_>>, Refused> {
    let format = image::guess_format(bytes).map_err(|_| Refused::NotImage)?;
    Ok(match format {
        ImageFormat::Gif => {
            let mut decoder = GifDecoder::new(Cursor::new(bytes)).map_err(unread)?;
            decoder.set_limits(limits()).map_err(unread)?;
            Some((decoder.dimensions(), decoder.into_frames()))
        }
        ImageFormat::WebP => {
            let mut decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(unread)?;
            match decoder.has_animation() {
                true => {
                    decoder.set_limits(limits()).map_err(unread)?;
                    Some((decoder.dimensions(), decoder.into_frames()))
                }
                false => None,
            }
        }
        ImageFormat::Png => {
            let mut decoder = PngDecoder::new(Cursor::new(bytes)).map_err(unread)?;
            match decoder.is_apng().map_err(unread)? {
                true => {
                    decoder.set_limits(limits()).map_err(unread)?;
                    let size = decoder.dimensions();
                    Some((size, decoder.apng().map_err(unread)?.into_frames()))
                }
                false => None,
            }
        }
        _ => None,
    })
}

/// The time a frame shows, in milliseconds.
fn millis(delay: Delay) -> u64 {
    let (numer, denom) = delay.numer_denom_ms();
    match (numer, denom) {
        (0, _) | (_, 0) => DEFAULT_FRAME_MILLIS,
        (numer, denom) => u64::from(numer).div_ceil(u64::from(denom)),
    }
}

/// Writes the frames of one size into `out`; the file is whole once the writer is dropped.
struct Writer<'a> {
    side: u32,
    encoder: GifEncoder<&'a mut Vec<u8>>,
}

impl<'a> Writer<'a> {
    fn new(side: u32, out: &'a mut Vec<u8>) -> Option<Writer<'a>> {
        let mut encoder = GifEncoder::new_with_speed(out, GIF_SPEED);
        encoder.set_repeat(Repeat::Infinite).ok()?;
        Some(Writer { side, encoder })
    }

    fn frame(&mut self, square: &image::RgbaImage, shown: u64) -> Option<()> {
        let sized = imageops::resize(square, self.side, self.side, FilterType::Triangle);
        let delay = Delay::from_numer_denom_ms(u32::try_from(shown).unwrap_or(u32::MAX), 1);
        self.encoder
            .encode_frame(Frame::from_parts(sized, 0, 0, delay))
            .ok()
    }
}

/// The animation `crop` of the image in `bytes` shows (the centered largest square without
/// one), or `None` when the image is a still: one frame, or a format without animations.
pub fn animate(
    bytes: &[u8],
    crop: Option<Crop>,
    bounds: &Bounds,
) -> Result<Option<Animated>, Refused> {
    let Some(((width, height), frames)) = frames(bytes)? else {
        return Ok(None);
    };
    let each = u64::from(width) * u64::from(height);
    if each > MAX_PIXELS {
        return Err(Refused::TooLarge);
    }
    let Crop { x, y, size } = placed(width, height, crop)?;
    let [small_side, large_side] = ANIMATED_SIZES;
    let (mut small, mut large) = (Vec::new(), Vec::new());
    let count = {
        let mut small = Writer::new(small_side, &mut small).ok_or(Refused::NotImage)?;
        let mut large = Writer::new(large_side, &mut large).ok_or(Refused::NotImage)?;
        let mut write = |square: &image::RgbaImage, shown: u64| {
            small
                .frame(square, shown)
                .and_then(|()| large.frame(square, shown))
                .ok_or(Refused::NotImage)
        };
        // The frame waiting to be written, with the time it shows: a frame faster than
        // `MIN_FRAME_MILLIS` gives its time to it and is left out.
        let mut held: Option<(image::RgbaImage, u64)> = None;
        let (mut count, mut total) = (0u32, 0u64);
        for frame in frames {
            let frame = frame.map_err(unread)?;
            count += 1;
            if count > bounds.frames {
                return Err(Refused::Frames);
            }
            if each.saturating_mul(u64::from(count)) > bounds.pixels {
                return Err(Refused::AnimationPixels);
            }
            let shown = millis(frame.delay());
            total += shown;
            if total > bounds.millis {
                return Err(Refused::Duration);
            }
            let canvas = frame.into_buffer();
            if canvas.dimensions() != (width, height) {
                return Err(Refused::NotImage);
            }
            held = Some(match held.take() {
                Some((before, time)) if time < MIN_FRAME_MILLIS => (before, time + shown),
                Some((before, time)) => {
                    write(&before, time)?;
                    (
                        imageops::crop_imm(&canvas, x, y, size, size).to_image(),
                        shown,
                    )
                }
                None => (
                    imageops::crop_imm(&canvas, x, y, size, size).to_image(),
                    shown,
                ),
            });
        }
        let Some((last, time)) = held else {
            return Err(Refused::NotImage);
        };
        if count >= 2 {
            write(&last, time.max(MIN_FRAME_MILLIS))?;
        }
        count
    };
    if count < 2 {
        return Ok(None);
    }
    if small.len() > bounds.bytes {
        return Err(Refused::AnimationBytes);
    }
    Ok(Some(Animated {
        small,
        large: Some(large).filter(|file| file.len() <= bounds.bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::samples::gif;

    const BOUNDS: Bounds = Bounds {
        frames: 250,
        millis: 20_000,
        pixels: 400_000_000,
        bytes: 8 * 1024 * 1024,
    };

    fn played(file: &[u8]) -> Vec<(u32, u32, u64)> {
        GifDecoder::new(Cursor::new(file))
            .expect("a gif")
            .into_frames()
            .map(|frame| {
                let frame = frame.expect("frame");
                let shown = millis(frame.delay());
                let (width, height) = frame.into_buffer().dimensions();
                (width, height, shown)
            })
            .collect()
    }

    #[test]
    fn an_animation_keeps_its_frames_and_times_at_both_sizes() {
        let made = animate(&gif(64, 5, 100), None, &BOUNDS)
            .expect("animates")
            .expect("an animation");
        assert_eq!(played(made.small()), vec![(128, 128, 100); 5]);
        assert_eq!(
            played(made.large().expect("the large file")),
            vec![(512, 512, 100); 5]
        );
        assert_eq!(Animated::MIME, "image/gif");
    }

    #[test]
    fn an_image_of_one_frame_is_no_animation() {
        assert_eq!(animate(&gif(64, 1, 100), None, &BOUNDS), Ok(None));
        let png = crate::samples::png(&crate::samples::halves(64, 64));
        assert_eq!(animate(&png, None, &BOUNDS), Ok(None));
        assert_eq!(animate(b"text", None, &BOUNDS), Err(Refused::NotImage));
    }

    #[test]
    fn an_animation_past_a_bound_is_refused_with_that_bound() {
        let source = gif(64, 10, 100);
        let within = |bounds: Bounds| animate(&source, None, &bounds).map(|made| made.is_some());
        assert_eq!(within(BOUNDS), Ok(true));
        assert_eq!(
            within(Bounds {
                frames: 9,
                ..BOUNDS
            }),
            Err(Refused::Frames)
        );
        assert_eq!(
            within(Bounds {
                millis: 999,
                ..BOUNDS
            }),
            Err(Refused::Duration)
        );
        assert_eq!(
            within(Bounds {
                pixels: 64 * 64 * 10 - 1,
                ..BOUNDS
            }),
            Err(Refused::AnimationPixels)
        );
        assert_eq!(
            within(Bounds {
                bytes: 16,
                ..BOUNDS
            }),
            Err(Refused::AnimationBytes)
        );
        let outside = Crop {
            x: 40,
            y: 0,
            size: 32,
        };
        assert_eq!(animate(&source, Some(outside), &BOUNDS), Err(Refused::Crop));
    }

    #[test]
    fn the_large_file_is_left_out_when_only_it_passes_the_byte_bound() {
        let source = gif(64, 4, 100);
        let whole = animate(&source, None, &BOUNDS)
            .expect("animates")
            .expect("an animation");
        let between = Bounds {
            bytes: whole.small().len(),
            ..BOUNDS
        };
        assert!(whole.large().expect("large").len() > between.bytes);
        let made = animate(&source, None, &between)
            .expect("animates")
            .expect("an animation");
        assert_eq!(made.small(), whole.small());
        assert_eq!(made.large(), None);
    }

    #[test]
    fn frames_faster_than_the_cap_give_their_time_to_the_frame_before() {
        let made = animate(&gif(64, 6, 10), None, &BOUNDS)
            .expect("animates")
            .expect("an animation");
        let shown: Vec<u64> = played(made.small()).iter().map(|f| f.2).collect();
        assert!(
            shown.iter().all(|time| *time >= MIN_FRAME_MILLIS),
            "{shown:?}"
        );
        assert_eq!(
            shown.iter().sum::<u64>(),
            60 + (MIN_FRAME_MILLIS - 20).min(60)
        );
        assert!(shown.len() < 6);
    }
}
