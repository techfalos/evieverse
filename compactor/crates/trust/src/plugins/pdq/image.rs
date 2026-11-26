//! Reading an image for its hash: the pixels of a JPEG, PNG, GIF or WebP file, as their
//! luminance.

use std::fs::File;
use std::io::{BufReader, Seek};
use std::path::Path;

use image::codecs::gif::GifDecoder;
use image::codecs::webp::WebPDecoder;
use image::imageops::FilterType;
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, RgbaImage};

use super::hash::luma_of;

/// The longest side an image is hashed at. A larger one is brought down to this by this
/// first, as the reference's own tool does, since the hash is of a 64 by 64 picture of it
/// anyway: blurring the whole of a large image down to that is slow, and tells nothing more.
/// The hash of such an image is within a few bits of what hashing it at its full size gives,
/// well inside the distance hashes are matched at. The pictures of a video are hashed at the
/// same size.
pub const MAX_SIDE: u32 = 512;
/// The most frames of an animated GIF or WebP that are read: its first ones. Each is hashed,
/// as a picture of its own. What comes after them in a longer animation isn't looked at.
pub const MAX_FRAMES: usize = 32;
/// The most memory the pixels of one image may take as they are decoded. One that needs
/// more is given up as unreadable.
const MAX_DECODE_BYTES: u64 = 1024 * 1024 * 1024;

/// What reading fails with for a file whose pixels can't be read: it isn't an image this
/// decodes, is too large for it, or is damaged.
#[derive(Debug, thiserror::Error)]
#[error("the image can't be decoded: {0}")]
pub struct UnreadableImage(pub String);

/// A frame of an image as its luminance: `rows` by `cols` values, a row after another.
pub struct Frame {
    pub luma: Vec<f32>,
    pub rows: usize,
    pub cols: usize,
}

fn unreadable(err: impl std::fmt::Display) -> UnreadableImage {
    UnreadableImage(err.to_string())
}

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits
}

/// A frame as it shows: what is transparent in it is white. One of an image larger than
/// MAX_SIDE along a side is brought down to MAX_SIDE by MAX_SIDE, whatever its shape was: the
/// hash is of a square picture of it either way.
fn frame_of(image: DynamicImage, large: bool) -> Frame {
    let mut rgba: RgbaImage = image.into_rgba8();
    for pixel in rgba.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        if alpha != 255 {
            for channel in 0..3 {
                pixel[channel] = ((u32::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
            }
            pixel[3] = 255;
        }
    }
    let rgb = DynamicImage::ImageRgba8(rgba).into_rgb8();
    let rgb = if large { image::imageops::resize(&rgb, MAX_SIDE, MAX_SIDE, FilterType::Lanczos3) } else { rgb };
    Frame { luma: luma_of(rgb.as_raw(), 3), rows: rgb.height() as usize, cols: rgb.width() as usize }
}

/// Gives the frames of the image in the file at `path` to `each`, one at a time, each as its
/// luminance, until `each` answers something or there are no more: one for a still image,
/// and the first MAX_FRAMES of an animated one. Fails with `UnreadableImage` for a file that
/// can't be decoded.
///
/// It is work that takes its thread for as long as it lasts: it is called on one that may
/// be kept.
pub fn frames_of<T>(path: &Path, mut each: impl FnMut(usize, Frame) -> Option<T>) -> Result<Option<T>, UnreadableImage> {
    let mut reader = ImageReader::new(BufReader::new(File::open(path).map_err(unreadable)?)).with_guessed_format().map_err(unreadable)?;
    let format = reader.format().ok_or_else(|| unreadable("it is none of the images that are read (JPEG, PNG, GIF, WebP)"))?;
    reader.limits(limits());

    // Of an animated image, each frame is a picture of its own, as it shows over the ones before it.
    let animated = match format {
        ImageFormat::Gif => true,
        ImageFormat::WebP => {
            let mut file = reader.into_inner();
            file.rewind().map_err(unreadable)?;
            let animated = WebPDecoder::new(&mut file).map_err(unreadable)?.has_animation();
            file.rewind().map_err(unreadable)?;
            reader = ImageReader::with_format(file, format);
            reader.limits(limits());
            animated
        }
        _ => false,
    };
    if !animated {
        let image = reader.decode().map_err(unreadable)?;
        let large = image.width() > MAX_SIDE || image.height() > MAX_SIDE;
        return Ok(each(0, frame_of(image, large)));
    }

    let file = reader.into_inner();
    let (dimensions, frames) = match format {
        ImageFormat::Gif => {
            let mut decoder = GifDecoder::new(file).map_err(unreadable)?;
            decoder.set_limits(limits()).map_err(unreadable)?;
            (decoder.dimensions(), decoder.into_frames())
        }
        _ => {
            let mut decoder = WebPDecoder::new(file).map_err(unreadable)?;
            decoder.set_limits(limits()).map_err(unreadable)?;
            (decoder.dimensions(), decoder.into_frames())
        }
    };
    let large = dimensions.0 > MAX_SIDE || dimensions.1 > MAX_SIDE;
    let mut read = 0;
    for frame in frames.take(MAX_FRAMES) {
        // A frame that is damaged ends the image where it is, once there is something of it to
        // show; one with nothing to show is unreadable.
        let frame = match frame {
            Ok(frame) => frame,
            Err(err) if read == 0 => return Err(unreadable(err)),
            Err(_) => break,
        };
        if let Some(answer) = each(read, frame_of(DynamicImage::ImageRgba8(frame.into_buffer()), large)) {
            return Ok(Some(answer));
        }
        read += 1;
    }
    if read == 0 {
        return Err(unreadable("it has no frame"));
    }
    Ok(None)
}

#[cfg(test)]
pub(crate) mod tests {
    use image::{Rgb, RgbImage, Rgba};

    use super::*;

    /// A picture with enough in it to tell it by, as an image of `width` by `height`.
    pub(crate) fn picture(width: u32, height: u32, seed: u32) -> RgbImage {
        let luma = super::super::hash::tests::picture(height as usize, width as usize, seed);
        RgbImage::from_fn(width, height, |x, y| {
            let value = luma[(y * width + x) as usize] as u8;
            Rgb([value, value, value])
        })
    }

    /// Writes a picture as a file of `format`, and returns where.
    pub(crate) fn written(dir: &Path, name: &str, image: &RgbImage, format: ImageFormat) -> std::path::PathBuf {
        let path = dir.join(name);
        image.save_with_format(&path, format).unwrap();
        path
    }

    fn sizes(path: &Path) -> Vec<(usize, usize, usize)> {
        let mut seen = vec![];
        frames_of(path, |at, frame| {
            assert_eq!(frame.luma.len(), frame.rows * frame.cols);
            seen.push((at, frame.rows, frame.cols));
            None::<()>
        })
        .unwrap();
        seen
    }

    #[test]
    fn reads_a_still_image_whatever_its_name_says() {
        let dir = tempfile::tempdir().unwrap();
        let png = written(dir.path(), "upload-1", &picture(120, 80, 1), ImageFormat::Png);
        assert_eq!(sizes(&png), [(0, 80, 120)]);
        let jpeg = written(dir.path(), "upload-2.png", &picture(64, 64, 1), ImageFormat::Jpeg);
        assert_eq!(sizes(&jpeg), [(0, 64, 64)]);
        let webp = written(dir.path(), "upload-3", &picture(90, 30, 1), ImageFormat::WebP);
        assert_eq!(sizes(&webp), [(0, 30, 90)]);
        // A large one is brought down to a square.
        let large = written(dir.path(), "upload-4", &picture(600, 300, 1), ImageFormat::Png);
        assert_eq!(sizes(&large), [(0, 512, 512)]);
    }

    #[test]
    fn reads_what_is_transparent_as_white() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clear.png");
        RgbaImage::from_fn(8, 8, |x, _| if x < 4 { Rgba([0, 0, 0, 0]) } else { Rgba([0, 0, 0, 255]) }).save(&path).unwrap();
        let mut rows = vec![];
        frames_of(&path, |_, frame| {
            rows = frame.luma[..8].to_vec();
            None::<()>
        })
        .unwrap();
        assert!(rows[..4].iter().all(|value| (*value - 255.0).abs() < 0.01) && rows[4..].iter().all(|value| *value == 0.0), "{rows:?}");
    }

    #[test]
    fn reads_the_first_frames_of_an_animation_and_stops_when_it_is_answered() {
        use image::codecs::gif::GifEncoder;
        use image::{Delay, Frame as GifFrame};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("moving");
        {
            let mut encoder = GifEncoder::new(File::create(&path).unwrap());
            for at in 0..40_u32 {
                let frame = DynamicImage::ImageRgb8(picture(40, 30, at)).into_rgba8();
                encoder.encode_frame(GifFrame::from_parts(frame, 0, 0, Delay::from_numer_denom_ms(100, 1))).unwrap();
            }
        }
        let seen = sizes(&path);
        assert_eq!(seen.len(), MAX_FRAMES);
        assert_eq!(seen[31], (31, 30, 40));
        assert_eq!(frames_of(&path, |at, _| (at == 3).then_some(at)).unwrap(), Some(3));
    }

    #[test]
    fn a_file_that_is_no_image_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("text");
        std::fs::write(&text, "not an image at all").unwrap();
        assert!(frames_of(&text, |_, _| None::<()>).is_err());
        // One that starts as an image and holds nothing of one.
        let cut = dir.path().join("cut");
        std::fs::write(&cut, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).unwrap();
        assert!(frames_of(&cut, |_, _| None::<()>).is_err());
        assert!(frames_of(&dir.path().join("missing"), |_, _| None::<()>).is_err());
    }
}
