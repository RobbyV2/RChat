//! Profile pictures as an instance and a P2P device keep them: the chosen square of an image,
//! decoded within fixed bounds and encoded again at each size in `SIZES`, with nothing else of
//! the file. The server runs it natively and the client through WebAssembly, so both make the
//! same files.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::{self, FilterType};
use image::{
    DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits, RgbaImage,
};

/// The sides, in pixels, a picture is kept at.
pub const SIZES: [u32; 3] = [64, 128, 512];
/// Most pixels (width times height) of an image that is decoded.
pub const MAX_PIXELS: u64 = 40_000_000;
/// The smallest side of a crop.
pub const MIN_CROP: u32 = 16;
const JPEG_QUALITY: u8 = 88;

/// The square of the image to keep, in pixels of the image as it shows (after its EXIF
/// orientation), from its top left corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub size: u32,
}

/// Why an upload gives no picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// Not a PNG, JPEG, GIF or WebP image that decodes.
    NotImage,
    /// More than `MAX_PIXELS`.
    TooLarge,
    /// The crop is under `MIN_CROP` or reaches outside the image.
    Crop,
}

/// The content type of an encoded picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mime {
    Png,
    Jpeg,
}

impl Mime {
    pub fn as_str(self) -> &'static str {
        match self {
            Mime::Png => "image/png",
            Mime::Jpeg => "image/jpeg",
        }
    }

    pub fn parse(raw: &str) -> Option<Mime> {
        match raw {
            "image/png" => Some(Mime::Png),
            "image/jpeg" => Some(Mime::Jpeg),
            _ => None,
        }
    }
}

/// A picture ready to store: one file per size in `SIZES`, in that order. Only `encode` makes
/// one, so what is stored and served was always decoded and encoded here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Encoded {
    mime: Mime,
    files: [Vec<u8>; 3],
}

impl Encoded {
    pub fn mime(&self) -> Mime {
        self.mime
    }

    pub fn files(&self) -> &[Vec<u8>; 3] {
        &self.files
    }
}

/// Why an image could not be read: past the bounds the decoder was given, or not an image.
fn unread(error: image::ImageError) -> Refused {
    match error {
        image::ImageError::Limits(_) => Refused::TooLarge,
        image::ImageError::Decoding(_)
        | image::ImageError::Encoding(_)
        | image::ImageError::Parameter(_)
        | image::ImageError::Unsupported(_)
        | image::ImageError::IoError(_) => Refused::NotImage,
    }
}

fn decoded(bytes: &[u8]) -> Result<RgbaImage, Refused> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| Refused::NotImage)?;
    match reader.format() {
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP) => {}
        Some(_) | None => return Err(Refused::NotImage),
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4 + 64 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(unread)?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(Refused::TooLarge);
    }
    let orientation = decoder.orientation().map_err(unread)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(unread)?;
    image.apply_orientation(orientation);
    Ok(image.into_rgba8())
}

fn square(image: &RgbaImage, crop: Option<Crop>) -> Result<RgbaImage, Refused> {
    let (width, height) = image.dimensions();
    let Crop { x, y, size } = crop.unwrap_or_else(|| {
        let size = width.min(height);
        Crop {
            x: (width - size) / 2,
            y: (height - size) / 2,
            size,
        }
    });
    let fits = |at: u32, most: u32| at.checked_add(size).is_some_and(|end| end <= most);
    if size < MIN_CROP || !fits(x, width) || !fits(y, height) {
        return Err(Refused::Crop);
    }
    Ok(imageops::crop_imm(image, x, y, size, size).to_image())
}

fn file(image: &RgbaImage, mime: Mime) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (width, height) = image.dimensions();
    match mime {
        Mime::Png => PngEncoder::new(&mut out)
            .write_image(image, width, height, image::ExtendedColorType::Rgba8)
            .ok()?,
        Mime::Jpeg => {
            let rgb = DynamicImage::ImageRgba8(image.clone()).into_rgb8();
            JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
                .write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
                .ok()?
        }
    }
    Some(out)
}

/// The picture `crop` of the image in `bytes` shows (the centered largest square without one):
/// PNG when it has transparency, JPEG otherwise. An animation gives its first frame.
pub fn encode(bytes: &[u8], crop: Option<Crop>) -> Result<Encoded, Refused> {
    let chosen = square(&decoded(bytes)?, crop)?;
    let [small, medium, large] = SIZES;
    let largest = imageops::resize(&chosen, large, large, FilterType::Lanczos3);
    let mime = match largest.pixels().any(|p| p.0[3] < u8::MAX) {
        true => Mime::Png,
        false => Mime::Jpeg,
    };
    let sized = |side| imageops::resize(&largest, side, side, FilterType::Lanczos3);
    let files = [
        file(&sized(small), mime),
        file(&sized(medium), mime),
        file(&largest, mime),
    ];
    match files {
        [Some(small), Some(medium), Some(large)] => Ok(Encoded {
            mime,
            files: [small, medium, large],
        }),
        _ => Err(Refused::NotImage),
    }
}

/// Images for tests of the code that takes pictures.
pub mod samples {
    use image::{Rgba, RgbaImage};

    /// `image` as a PNG file.
    pub fn png(image: &RgbaImage) -> Vec<u8> {
        super::file(image, super::Mime::Png).unwrap_or_default()
    }

    /// An opaque image whose left half is red and right half blue.
    pub fn halves(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, _| match x < width / 2 {
            true => Rgba([255, 0, 0, 255]),
            false => Rgba([0, 0, 255, 255]),
        })
    }

    /// The side and format of an encoded picture file.
    pub fn read(bytes: &[u8]) -> Option<(RgbaImage, image::ImageFormat)> {
        let format = image::guess_format(bytes).ok()?;
        Some((image::load_from_memory(bytes).ok()?.into_rgba8(), format))
    }
}

#[cfg(test)]
mod tests {
    use super::samples::{halves, png};
    use super::*;
    use image::Rgba;

    fn opened(bytes: &[u8]) -> RgbaImage {
        image::load_from_memory(bytes)
            .expect("decodes")
            .into_rgba8()
    }

    #[test]
    fn an_upload_becomes_three_squares_of_the_fixed_sizes() {
        let out = encode(&png(&halves(300, 200)), None).expect("encodes");
        assert_eq!(out.mime(), Mime::Jpeg, "an opaque picture is a JPEG");
        for (file, side) in out.files().iter().zip(SIZES) {
            assert_eq!(
                image::guess_format(file).expect("format"),
                ImageFormat::Jpeg
            );
            assert_eq!(opened(file).dimensions(), (side, side));
        }
    }

    #[test]
    fn the_default_crop_is_the_centered_square_and_a_chosen_crop_is_kept() {
        let source = png(&halves(400, 200));
        let centered = opened(&encode(&source, None).expect("centered").files()[2]);
        let (left, right) = (centered.get_pixel(40, 256), centered.get_pixel(470, 256));
        assert!(
            left.0[0] > 200 && left.0[2] < 60,
            "red on the left: {left:?}"
        );
        assert!(
            right.0[2] > 200 && right.0[0] < 60,
            "blue on the right: {right:?}"
        );
        let chosen = Crop {
            x: 0,
            y: 0,
            size: 200,
        };
        let red = opened(&encode(&source, Some(chosen)).expect("chosen").files()[0]);
        assert!(
            red.pixels().all(|p| p.0[0] > 200 && p.0[2] < 60),
            "the left square is all red"
        );
    }

    #[test]
    fn transparency_keeps_a_png_and_nothing_of_the_source_file_stays() {
        let mut image = halves(64, 64);
        image.put_pixel(3, 3, Rgba([0, 0, 0, 0]));
        let mut source = png(&image);
        let marker = b"tEXtComment\0secret-location";
        let end = source.len() - 12;
        let mut chunk = (marker.len() as u32 - 4).to_be_bytes().to_vec();
        chunk.extend_from_slice(marker);
        chunk.extend_from_slice(&[0, 0, 0, 0]);
        source.splice(end..end, chunk);
        let out = encode(&source, None).expect("encodes");
        assert_eq!(out.mime(), Mime::Png);
        for file in out.files() {
            assert_eq!(image::guess_format(file).expect("format"), ImageFormat::Png);
            assert!(
                !file.windows(6).any(|w| w == b"secret"),
                "no text chunk of the source"
            );
        }
        assert!(opened(&out.files()[2]).pixels().any(|p| p.0[3] < 255));
    }

    #[test]
    fn what_is_not_an_image_too_large_or_cropped_outside_is_refused() {
        assert_eq!(encode(b"not an image", None), Err(Refused::NotImage));
        assert_eq!(encode(&[], None), Err(Refused::NotImage));
        let tiny = {
            let mut out = Vec::new();
            image::codecs::png::PngEncoder::new(&mut out)
                .write_image(&[0u8; 4], 1, 1, image::ExtendedColorType::Rgba8)
                .expect("png");
            out
        };
        assert_eq!(encode(&tiny, None), Err(Refused::Crop), "under MIN_CROP");
        let source = png(&halves(100, 50));
        for crop in [
            Crop {
                x: 60,
                y: 0,
                size: 50,
            },
            Crop {
                x: 0,
                y: 10,
                size: 50,
            },
            Crop {
                x: 0,
                y: 0,
                size: 8,
            },
            Crop {
                x: u32::MAX,
                y: 0,
                size: 50,
            },
        ] {
            assert_eq!(encode(&source, Some(crop)), Err(Refused::Crop), "{crop:?}");
        }
        let mut head = Vec::new();
        head.extend_from_slice(&20_000u32.to_be_bytes());
        head.extend_from_slice(&20_000u32.to_be_bytes());
        head.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut huge = PNG_HEAD.to_vec();
        let chunks: [(&[u8; 4], &[u8]); 3] = [(b"IHDR", &head), (b"IDAT", &[]), (b"IEND", &[])];
        for (kind, data) in chunks {
            huge.extend_from_slice(&(data.len() as u32).to_be_bytes());
            let body = [kind.as_slice(), data].concat();
            huge.extend_from_slice(&body);
            huge.extend_from_slice(&crc32(&body).to_be_bytes());
        }
        assert_eq!(encode(&huge, None), Err(Refused::TooLarge));
    }

    const PNG_HEAD: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & (!(crc & 1)).wrapping_add(1));
            }
        }
        !crc
    }

    #[test]
    fn the_sizes_and_bounds_are_the_shared_ones() {
        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../../../assets/avatar_images.json"))
                .expect("avatar_images.json");
        assert_eq!(shared["sizes"], serde_json::json!(SIZES));
        assert_eq!(shared["max_pixels"], serde_json::json!(MAX_PIXELS));
        assert_eq!(shared["min_crop"], serde_json::json!(MIN_CROP));
        assert_eq!(
            shared["types"],
            serde_json::json!([Mime::Png.as_str(), Mime::Jpeg.as_str()])
        );
    }
}
