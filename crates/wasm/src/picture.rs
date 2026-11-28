//! Profile pictures made on the device: what a P2P identity keeps of an image it chose, as the
//! instance makes it for an upload (`rchat-avatar`).

use rchat_avatar::{Crop, Encoded, Refused, encode};
use wasm_bindgen::prelude::*;

/// The files of a picture, in the order of `rchat_avatar::SIZES`.
#[wasm_bindgen]
pub struct PictureFiles {
    made: Encoded,
}

#[wasm_bindgen]
impl PictureFiles {
    /// The content type of every file.
    #[wasm_bindgen(getter)]
    pub fn mime(&self) -> String {
        self.made.mime().as_str().to_string()
    }

    /// The file at `at`; empty past the last one.
    pub fn file(&self, at: usize) -> Vec<u8> {
        self.made.files().get(at).cloned().unwrap_or_default()
    }
}

/// The word a refusal is known by on the device.
fn word(why: Refused) -> &'static str {
    match why {
        Refused::NotImage => "not_image",
        Refused::TooLarge => "too_large",
        Refused::Crop => "crop",
    }
}

fn made(bytes: &[u8], crop: Crop) -> Result<PictureFiles, &'static str> {
    encode(bytes, Some(crop))
        .map(|made| PictureFiles { made })
        .map_err(word)
}

/// The picture the square `x`, `y`, `size` of the image in `bytes` shows. Fails with
/// `not_image`, `too_large` or `crop`.
#[wasm_bindgen]
pub fn picture_files(bytes: &[u8], x: u32, y: u32, size: u32) -> Result<PictureFiles, JsError> {
    made(bytes, Crop { x, y, size }).map_err(JsError::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rchat_avatar::samples::{halves, png, read};
    use rchat_avatar::{MIN_CROP, SIZES};

    #[test]
    fn a_crop_gives_the_files_of_every_size() {
        let whole = Crop {
            x: 20,
            y: 0,
            size: 80,
        };
        let files = made(&png(&halves(120, 80)), whole).unwrap_or_else(|why| panic!("{why}"));
        assert_eq!(files.mime(), "image/jpeg");
        for (at, side) in SIZES.iter().enumerate() {
            let (image, _) = read(&files.file(at)).expect("an image");
            assert_eq!(image.dimensions(), (*side, *side));
        }
        assert!(files.file(SIZES.len()).is_empty());
    }

    #[test]
    fn a_refusal_has_its_word() {
        let crop = |size| Crop { x: 0, y: 0, size };
        assert_eq!(made(b"text", crop(64)).err(), Some("not_image"));
        let source = png(&halves(64, 64));
        assert_eq!(made(&source, crop(65)).err(), Some("crop"));
        assert_eq!(made(&source, crop(MIN_CROP - 1)).err(), Some("crop"));
    }
}
