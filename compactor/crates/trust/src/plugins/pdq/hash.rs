//! PDQ, the perceptual hash of an image that Meta published
//! (https://github.com/facebook/ThreatExchange, pdq/): 256 bits that stay nearly the same
//! when the image is resized, compressed again or lightly edited, so two hashes that differ
//! in few bits are of the same picture. This is its reference implementation
//! (pdq/cpp/hashing/pdqhashing.cpp, pdq/cpp/downscaling/downscaling.cpp), step for step and
//! in its 32-bit arithmetic, so that it gives the hashes the lists of hashes were made with.
//!
//! An image is hashed from its luminance: blurred and brought down to 64 by 64, of which the
//! 16 by 16 lowest frequencies are worked out (but for the constant ones), and each is one
//! bit, set if it is above their median. A hash comes with a quality from 0 to 100, which
//! says how much there is in the image to tell it by: one of a single colour has none, and
//! its hash says nothing.

use std::sync::LazyLock;

/// How many bits a hash has.
pub const HASH_BITS: u32 = 256;
/// How many 16-bit words that is, which is how a hash is held.
pub const HASH_WORDS: usize = 16;
/// The side of the square an image is brought down to before its frequencies are worked out.
const SIDE: usize = 64;
/// How many of the lowest frequencies along each side make the hash: a bit for each pair.
const FREQUENCIES: usize = 16;
/// An image smaller than this along either side has no hash: its quality is 0.
const MIN_SIDE: usize = 5;
/// How many times the image is blurred along its rows and then its columns: two box filters
/// make a tent filter.
const BLUR_PASSES: usize = 2;
/// How much of a pixel's luminance each of red, green and blue is.
const LUMA: [f32; 3] = [0.299, 0.587, 0.114];

/// A hash: its 256 bits as 16 words, the lowest first.
pub type Words = [u16; HASH_WORDS];

/// The hash of an image, and how much there was in the image to tell it by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PdqHash {
    pub words: Words,
    /// From 0 to 100.
    pub quality: i64,
}

/// The cosines the frequencies are worked out with: row i is frequency i + 1 across the 64
/// pixels of a side. The reference's DCT matrix: 16 rows of 64, the constant frequency left out.
static DCT: LazyLock<Vec<f32>> = LazyLock::new(|| {
    let mut matrix = vec![0.0_f32; FREQUENCIES * SIDE];
    let scale = f64::from((2.0_f64 / SIDE as f64).sqrt() as f32);
    for i in 0..FREQUENCIES {
        for j in 0..SIDE {
            matrix[i * SIDE + j] = (scale * ((std::f64::consts::PI / 2.0 / SIDE as f64) * (i + 1) as f64 * (2 * j + 1) as f64).cos()) as f32;
        }
    }
    matrix
});

/// The luminance of an image's pixels, from 0 to 255, a row after another: what `pdq_hash`
/// reads. `pixels` holds `channels` bytes a pixel, of which the first three are red, green
/// and blue, or the only one is grey.
pub fn luma_of(pixels: &[u8], channels: usize) -> Vec<f32> {
    if channels < 3 {
        return pixels.chunks_exact(channels.max(1)).map(|pixel| f32::from(pixel[0])).collect();
    }
    let [r, g, b] = LUMA;
    pixels.chunks_exact(channels).map(|pixel| (r * f32::from(pixel[0]) + g * f32::from(pixel[1])) + b * f32::from(pixel[2])).collect()
}

/// A box filter along one row or column: each value becomes the mean of the `window` values
/// around it, or of as many of them as there are at an edge. `length` values are read from
/// `input` at `from`, each `stride` after the last, and written to the same places of `output`.
fn boxed(input: &[f32], output: &mut [f32], from: usize, length: usize, stride: usize, window: usize) {
    let half = (window + 2) >> 1;
    let (mut left, mut right, mut out) = (from, from, from);
    let mut sum = 0.0_f32;
    let mut size = 0.0_f32;
    // The first values are only added up: the window isn't centred on anything yet.
    for _ in 0..half - 1 {
        sum += input[right];
        size += 1.0;
        right += stride;
    }
    // The window grows until it is whole.
    for _ in 0..window + 1 - half {
        sum += input[right];
        size += 1.0;
        output[out] = sum / size;
        right += stride;
        out += stride;
    }
    // The whole window slides along.
    for _ in 0..length.saturating_sub(window) {
        sum = (sum + input[right]) - input[left];
        output[out] = sum / size;
        left += stride;
        right += stride;
        out += stride;
    }
    // It shrinks again at the far edge.
    for _ in 0..half - 1 {
        sum -= input[left];
        size -= 1.0;
        output[out] = sum / size;
        left += stride;
        out += stride;
    }
}

/// The image blurred and brought down to 64 by 64: each pixel of the result is the middle of
/// its part of the image. `luma` is written over.
fn downsample(luma: &mut [f32], rows: usize, cols: usize) -> Vec<f32> {
    let mut other = vec![0.0_f32; luma.len()];
    // Half of what one of the 64 pixels covers, since the two passes together cover all of it.
    let along_rows = cols.div_ceil(2 * SIDE);
    let along_cols = rows.div_ceil(2 * SIDE);
    for _ in 0..BLUR_PASSES {
        for i in 0..rows {
            boxed(luma, &mut other, i * cols, cols, 1, along_rows);
        }
        for j in 0..cols {
            boxed(&other, luma, j, rows, cols, along_cols);
        }
    }
    let mut square = vec![0.0_f32; SIDE * SIDE];
    for i in 0..SIDE {
        let row = (((i as f64 + 0.5) * rows as f64) / SIDE as f64).floor() as usize;
        for j in 0..SIDE {
            square[i * SIDE + j] = luma[row * cols + (((j as f64 + 0.5) * cols as f64) / SIDE as f64).floor() as usize];
        }
    }
    square
}

/// How much there is in the 64 by 64 image to tell it by, from 0 to 100: the steps between
/// neighbouring pixels, counted in hundredths of the whole range so that only steps that
/// show count, and scaled by a factor the reference chose by hand.
fn quality_of(square: &[f32]) -> i64 {
    let step = |u: f32, v: f32| i64::from((((u - v) * 100.0) / 255.0).trunc() as i32).abs();
    let mut gradients = 0_i64;
    for i in 0..SIDE - 1 {
        for j in 0..SIDE {
            gradients += step(square[i * SIDE + j], square[(i + 1) * SIDE + j]);
        }
    }
    for i in 0..SIDE {
        for j in 0..SIDE - 1 {
            gradients += step(square[i * SIDE + j], square[i * SIDE + j + 1]);
        }
    }
    (gradients / 90).min(100)
}

/// The 16 by 16 lowest frequencies of the 64 by 64 image, the constant ones left out:
/// D A Dt, with D the DCT matrix.
fn frequencies_of(square: &[f32]) -> Vec<f32> {
    let dct = &*DCT;
    let mut half = vec![0.0_f32; FREQUENCIES * SIDE];
    for i in 0..FREQUENCIES {
        for j in 0..SIDE {
            let mut sum = 0.0_f32;
            for k in 0..SIDE {
                sum += dct[i * SIDE + k] * square[k * SIDE + j];
            }
            half[i * SIDE + j] = sum;
        }
    }
    let mut frequencies = vec![0.0_f32; FREQUENCIES * FREQUENCIES];
    for i in 0..FREQUENCIES {
        for j in 0..FREQUENCIES {
            let mut sum = 0.0_f32;
            for k in 0..SIDE {
                sum += half[i * SIDE + k] * dct[j * SIDE + k];
            }
            frequencies[i * FREQUENCIES + j] = sum;
        }
    }
    frequencies
}

/// The median of `values`, by Torben Mogensen's method as the reference has it (torben.cpp):
/// of an even number of them, the lower of the two in the middle. It is ported and not
/// sorted for, so that equal values fall on the side of it they do there.
fn median(values: &[f32]) -> f32 {
    let half = values.len().div_ceil(2);
    let mut min = values[0];
    let mut max = min;
    for value in values {
        if *value < min {
            min = *value;
        }
        if *value > max {
            max = *value;
        }
    }
    loop {
        let guess = (min + max) / 2.0;
        let (mut less, mut greater, mut equal) = (0, 0, 0);
        let (mut below, mut above) = (min, max);
        for value in values {
            if *value < guess {
                less += 1;
                if *value > below {
                    below = *value;
                }
            } else if *value > guess {
                greater += 1;
                if *value < above {
                    above = *value;
                }
            } else {
                equal += 1;
            }
        }
        if less <= half && greater <= half {
            return if less >= half {
                below
            } else if less + equal >= half {
                guess
            } else {
                above
            };
        }
        if less > greater {
            max = below;
        } else {
            min = above;
        }
    }
}

/// The PDQ hash of an image, from its luminance (see `luma_of`): `rows` by `cols` values, a
/// row after another, which are written over. An image smaller than 5 along a side has no
/// hash: all its bits are 0, and so is its quality.
pub fn pdq_hash(luma: &mut [f32], rows: usize, cols: usize) -> PdqHash {
    let mut words = [0_u16; HASH_WORDS];
    if rows < MIN_SIDE || cols < MIN_SIDE || luma.len() < rows * cols {
        return PdqHash { words, quality: 0 };
    }
    // An image that is 64 by 64 already is taken as it is.
    let square = if rows == SIDE && cols == SIDE { luma[..SIDE * SIDE].to_vec() } else { downsample(luma, rows, cols) };
    let frequencies = frequencies_of(&square);
    let middle = median(&frequencies);
    for (bit, frequency) in frequencies.iter().enumerate() {
        if *frequency > middle {
            words[bit >> 4] |= 1 << (bit & 15);
        }
    }
    PdqHash { words, quality: quality_of(&square) }
}

/// A hash as it is written: 64 hex digits, its highest word first.
pub fn to_hex(words: &[u16]) -> String {
    words[..HASH_WORDS].iter().rev().map(|word| format!("{word:04x}")).collect()
}

/// Reads a hash as it is written. None for what isn't 64 hex digits.
pub fn from_hex(hex: &str) -> Option<Words> {
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut words = [0_u16; HASH_WORDS];
    for (i, word) in words.iter_mut().rev().enumerate() {
        *word = u16::from_str_radix(&hex[i * 4..i * 4 + 4], 16).ok()?;
    }
    Some(words)
}

/// How many bits two hashes differ in. Past `most`, the count stops, and what is returned is
/// only more than it.
pub fn distance(a: &[u16], b: &[u16], most: u32) -> u32 {
    let mut bits = 0;
    for (x, y) in a[..HASH_WORDS].iter().zip(&b[..HASH_WORDS]) {
        if bits > most {
            break;
        }
        bits += (x ^ y).count_ones();
    }
    bits
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A picture with enough in it to tell it by: `rows` by `cols` of luminance, made from
    /// `seed` so that two seeds give two pictures.
    ///
    /// It is a grid of 24 by 24 values, spread smoothly over the picture, so the same seed
    /// gives the same picture at any size. It is made with whole numbers and the four
    /// operations alone, so that the API's own implementation, which the hashes in
    /// fixtures/pdq.json were made with, made the very same pixels.
    pub(crate) fn picture(rows: usize, cols: usize, seed: u32) -> Vec<f32> {
        const GRID: usize = 24;
        let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
        let grid: Vec<f64> = (0..GRID * GRID)
            .map(|_| {
                state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                f64::from((state >> 16) & 0xff)
            })
            .collect();
        let at = |n: f64| (n.clamp(0.0, (GRID - 1) as f64)) as usize;
        let mut luma = Vec::with_capacity(rows * cols);
        for i in 0..rows {
            let y = ((i as f64 + 0.5) / rows as f64) * GRID as f64 - 0.5;
            let (y0, fy) = (y.floor(), y - y.floor());
            for j in 0..cols {
                let x = ((j as f64 + 0.5) / cols as f64) * GRID as f64 - 0.5;
                let (x0, fx) = (x.floor(), x - x.floor());
                let top = grid[at(y0) * GRID + at(x0)] * (1.0 - fx) + grid[at(y0) * GRID + at(x0 + 1.0)] * fx;
                let bottom = grid[at(y0 + 1.0) * GRID + at(x0)] * (1.0 - fx) + grid[at(y0 + 1.0) * GRID + at(x0 + 1.0)] * fx;
                luma.push((top * (1.0 - fy) + bottom * fy + 0.5).floor() as f32);
            }
        }
        luma
    }

    #[test]
    fn gives_the_hashes_the_api_gave() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/pdq.json");
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let hashes = fixture["hashes"].as_array().unwrap();
        assert!(hashes.len() >= 8);
        for case in hashes {
            let (rows, cols, seed) = (case["rows"].as_u64().unwrap() as usize, case["cols"].as_u64().unwrap() as usize, case["seed"].as_u64().unwrap() as u32);
            let hash = pdq_hash(&mut picture(rows, cols, seed), rows, cols);
            assert_eq!((to_hex(&hash.words), hash.quality), (case["pdq"].as_str().unwrap().to_owned(), case["quality"].as_i64().unwrap()), "{rows} by {cols}, seed {seed}");
        }
        for case in fixture["luma"].as_array().unwrap() {
            let pixels: Vec<u8> = case["pixels"].as_array().unwrap().iter().map(|byte| byte.as_u64().unwrap() as u8).collect();
            let luma = luma_of(&pixels, case["channels"].as_u64().unwrap() as usize);
            // Written as the 64-bit numbers JSON has, each of which is one 32-bit one.
            let expected: Vec<f32> = case["luma"].as_array().unwrap().iter().map(|value| value.as_f64().unwrap() as f32).collect();
            assert_eq!(luma, expected);
        }
    }

    #[test]
    fn writes_and_reads_a_hash_and_counts_the_bits_two_differ_in() {
        let hex = "f8f8f0cee0f4a84f06370a22038f63f0b36e2ed596621e1d33e6b39c4e9c9b22";
        let words = from_hex(hex).unwrap();
        assert_eq!(words[15], 0xf8f8);
        assert_eq!(words[0], 0x9b22);
        assert_eq!(to_hex(&words), hex);
        assert_eq!(from_hex(&hex.to_uppercase()), Some(words));
        assert_eq!(from_hex(&hex[1..]), None);
        assert_eq!(from_hex(&format!("{}g", &hex[1..])), None);

        let mut other = words;
        other[3] ^= 0b1011;
        other[9] ^= 0x8000;
        assert_eq!(distance(&words, &other, HASH_BITS), 4);
        assert_eq!(distance(&words, &words, HASH_BITS), 0);
        // Past the most that is asked for the count stops.
        let none = [0_u16; HASH_WORDS];
        let all = [0xffff_u16; HASH_WORDS];
        assert_eq!(distance(&none, &all, HASH_BITS), 256);
        assert_eq!(distance(&none, &all, 31), 32);
    }

    #[test]
    fn an_image_too_small_or_of_one_colour_has_nothing_to_tell_it_by() {
        assert_eq!(pdq_hash(&mut [9.0; 16], 4, 4), PdqHash { words: [0; HASH_WORDS], quality: 0 });
        assert_eq!(pdq_hash(&mut vec![200.0; 100 * 80], 100, 80).quality, 0);
    }

    #[test]
    fn a_picture_keeps_its_hash_when_it_is_resized_and_another_has_another() {
        let large = pdq_hash(&mut picture(512, 384, 1), 512, 384);
        let small = pdq_hash(&mut picture(200, 150, 1), 200, 150);
        let other = pdq_hash(&mut picture(512, 384, 2), 512, 384);
        assert_eq!(large.quality, 100);
        // Half the bits of a hash are set: those above the median.
        assert_eq!(large.words.iter().map(|word| word.count_ones()).sum::<u32>(), 128);
        assert!(distance(&large.words, &small.words, HASH_BITS) <= 31, "{}", distance(&large.words, &small.words, HASH_BITS));
        assert!(distance(&large.words, &other.words, HASH_BITS) > 60, "{}", distance(&large.words, &other.words, HASH_BITS));
    }

    #[test]
    fn the_median_is_the_lower_of_the_two_in_the_middle() {
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), 2.0);
        assert_eq!(median(&[5.0, 1.0, 3.0]), 3.0);
        assert_eq!(median(&[2.0, 2.0, 2.0, 2.0]), 2.0);
        assert_eq!(median(&[1.0, 9.0, 9.0, 9.0, 1.0, 1.0]), 1.0);
    }

    #[test]
    fn reads_luminance_from_grey_and_from_colour() {
        assert_eq!(luma_of(&[7, 255, 9, 255], 2), [7.0, 9.0]);
        assert_eq!(luma_of(&[255, 255, 255, 0, 0, 0], 3), [(0.299_f32 * 255.0 + 0.587_f32 * 255.0) + 0.114_f32 * 255.0, 0.0]);
    }
}
