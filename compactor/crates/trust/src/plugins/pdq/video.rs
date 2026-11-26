//! Checking a video against the list, as the plugin checks an image: by the PDQ hashes of its
//! pictures. Not of every one. The video worker (the compactor's `video::worker`) reads the
//! keyframes of a rendition the server has just made of the video, which has one every two
//! seconds whatever the file that was sent had, and shows each to a `FrameCheck`, from the
//! first, as a picture of its own: this is what Meta's vPDQ does with the frames it takes.
//! They are matched as an image's are: within `pdq.maxDistance` bits of a listed hash, and
//! not at all under `pdq.minQuality`, which a black or a blank picture is.
//!
//! It is the rendition that is read, and not the file as it was sent: its keyframes are where
//! the server put them, so a file made with one keyframe, or with them placed around what it
//! shows, is checked as often as any other; and it is upright, at the size it is published at.
//!
//! What it doesn't see: what a video shows for less than two seconds, between two of the
//! pictures that are checked; a picture that was mirrored, rotated or cropped far; and one
//! that fills only a part of the frame, as a picture shown inside another does.

use evieverse_core::config::PdqConfig;

use super::hash::{Words, luma_of, pdq_hash, to_hex};
use super::list::{HashList, nearest};

/// The picture of a video that matched the list, and how.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameMatch {
    /// The hash on the list that the picture's is near.
    pub listed: String,
    /// How many of the 256 bits the two differ in.
    pub distance: u32,
    /// The PDQ hash of the picture, as it is written.
    pub pdq: String,
    /// That hash's quality, from 0 to 100.
    pub quality: i64,
    /// Which of the pictures that were checked it is, from 0.
    pub frame: usize,
    /// Where in the video it is, in seconds.
    pub seconds: f64,
}

/// What the pictures of one video are checked with, one after another.
pub struct FrameCheck<'a> {
    list: &'a HashList,
    most: u32,
    least: i64,
    frame: usize,
    /// The hash of the picture before this one. A picture hashed like it, as in a video that
    /// stands still, isn't looked up again.
    last: Option<Words>,
}

impl<'a> FrameCheck<'a> {
    pub fn new(list: &'a HashList, config: &PdqConfig) -> Self {
        Self {
            list,
            most: u32::try_from(config.max_distance).unwrap_or(0),
            least: config.min_quality,
            frame: 0,
            last: None,
        }
    }

    /// Checks the next picture: `pixels` is 3 bytes a pixel (red, green, blue), row after
    /// row, `width` by `height`, and `seconds` where in the video it is. Returns how it
    /// matches, if it does.
    pub fn check(&mut self, pixels: &[u8], width: usize, height: usize, seconds: f64) -> Option<FrameMatch> {
        let hash = pdq_hash(&mut luma_of(pixels, 3), height, width);
        let frame = self.frame;
        self.frame += 1;
        let again = self.last.replace(hash.words) == Some(hash.words);
        if hash.quality < self.least || again {
            return None;
        }
        nearest(self.list, &hash.words, self.most).map(|found| FrameMatch {
            listed: found.listed,
            distance: found.distance,
            pdq: to_hex(&hash.words),
            quality: hash.quality,
            frame,
            seconds,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::image::tests::picture;
    use super::super::list::list_of;
    use super::*;

    /// A picture as a rendition's frame is given: its pixels, and its size.
    type Shown = (Vec<u8>, usize, usize);

    /// A picture of these tests with enough in it to tell it by.
    fn frame(seed: u32) -> Shown {
        (picture(320, 180, seed).into_raw(), 320, 180)
    }

    fn hash_of((pixels, width, height): &Shown) -> String {
        to_hex(&pdq_hash(&mut luma_of(pixels, 3), *height, *width).words)
    }

    fn config(min_quality: i64) -> PdqConfig {
        PdqConfig {
            hash_list: None,
            authorization: None,
            max_distance: 31,
            min_quality,
            refresh_minutes: 60,
        }
    }

    #[test]
    fn finds_the_first_picture_of_a_video_that_is_near_a_listed_hash() {
        let (known, other) = (frame(1), frame(2));
        let list = list_of([hash_of(&known).as_str()]).unwrap();
        let config = config(50);
        let mut check = FrameCheck::new(&list, &config);
        assert_eq!(check.check(&other.0, other.1, other.2, 0.0), None);
        assert_eq!(check.check(&other.0, other.1, other.2, 2.0), None);
        let found = check.check(&known.0, known.1, known.2, 4.0).unwrap();
        assert_eq!((found.listed.as_str(), found.distance, found.frame, found.seconds), (hash_of(&known).as_str(), 0, 2, 4.0));
        assert_eq!(found.pdq, hash_of(&known));
    }

    #[test]
    fn a_picture_with_nothing_in_it_is_not_matched() {
        let plain: Shown = (vec![40_u8; 320 * 180 * 3], 320, 180);
        let list = list_of([hash_of(&plain).as_str(), hash_of(&frame(1)).as_str()]).unwrap();
        let config = config(50);
        let mut check = FrameCheck::new(&list, &config);
        assert_eq!(check.check(&plain.0, plain.1, plain.2, 0.0), None);
    }
}
