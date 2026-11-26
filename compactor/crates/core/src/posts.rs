//! What a post is, and how it is shown: its preview, and where its bytes are read. The same as
//! src/posts.ts, for the parts the stored formats are made of.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

/// The content type of a text post, whose bytes are its text in UTF-8.
pub const TEXT_MIME: &str = "text/plain";
/// The content type of a link post, whose bytes are its URL.
pub const LINK_MIME: &str = "text/uri-list";
/// The longest text of a text post, and the longest caption, in UTF-16 units.
pub const MAX_TEXT_CHARS: usize = 40_000;
/// The longest address `link_url` takes, in characters, counted as the URL parser writes it.
const MAX_URL_CHARS: usize = 2048;

/// An http or https address as the URL parser writes it, which is how every link is kept: a
/// link post's, and the address of a repost's original. None for anything else, and for an
/// address longer than MAX_URL_CHARS.
pub fn link_url(text: &str) -> Option<String> {
    let text = crate::text::trim(text);
    let scheme = &text[..text.find("://")?];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let href = String::from(url::Url::parse(text).ok()?);
    (href.len() <= MAX_URL_CHARS).then_some(href)
}

/// The post type of files of a content type, if they can be posted.
pub fn media_type(mime_type: &str) -> Option<PreviewKind> {
    match mime_type.split_once('/')?.0 {
        "image" => Some(PreviewKind::Image),
        "video" => Some(PreviewKind::Video),
        "audio" => Some(PreviewKind::Audio),
        _ => None,
    }
}

/// The server's own address as the URL parser writes it, without the slashes at its end: what
/// the addresses of its posts start with. None for a server that has no public address.
pub fn own_address(public_base_url: &str) -> Option<String> {
    if public_base_url.is_empty() {
        return None;
    }
    let href = String::from(url::Url::parse(public_base_url).ok()?);
    Some(href.trim_end_matches('/').to_owned())
}

/// A post's address on the server at `base`, where GET /content/:id reads it.
pub fn post_address(base: &str, content_id: &str) -> String {
    format!("{base}/content/{content_id}")
}

/// A user a text mentions, as the text names them (see src/mentions.types.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub user_id: String,
    pub username: String,
}

/// Who published the original of a repost of a post on another server, there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginPublisher {
    pub user_id: String,
    pub username: String,
}

/// The original of a repost of a post on another server: where it is read, and who published
/// it there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// The original's address on its own server: `https://other.example/content/<id>`.
    pub url: String,
    pub publisher: OriginPublisher,
}

/// What a post is: its type, which is its preview's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewKind {
    Text,
    Image,
    Video,
    Audio,
    Link,
}

impl PreviewKind {
    /// The kind as it is written: in a meta file, and on the kind line of a summary.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
            Self::Link => "link",
        }
    }

    /// The kind a summary's kind line names; none for a line that names none of a post's.
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "text" => Some(Self::Text),
            "image" => Some(Self::Image),
            "video" => Some(Self::Video),
            "audio" => Some(Self::Audio),
            "link" => Some(Self::Link),
            _ => None,
        }
    }
}

/// A video the server has processed, as a meta file and a summary keep it, and with `poster`
/// and `hls`, as a preview that is read gives it. The numbers are kept as they were written,
/// so that they are written again the same.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    /// The id of this version of the video: what its poster and stream are kept under.
    pub id: String,
    /// Of the picture as it is shown, in pixels.
    pub width: Number,
    pub height: Number,
    /// In seconds.
    pub duration: Number,
    /// A JPEG of a frame near its start. Only on a preview that is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    /// Its HLS master playlist. Only on a preview that is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hls: Option<String>,
}

/// A post as feeds show it, and as a meta file keeps it. As it is stored, an image's, video's
/// or audio's `url` is left out, or there but not used, and so are the addresses of a
/// processed video's poster and stream: `read_preview` builds them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub kind: PreviewKind,
    /// A link's URL; on a preview that is read, where an image's, video's or audio's bytes are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// A text post's text, or a caption, cut to the length of the server's previews.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// On an image post of more than one image: how many it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_count: Option<i64>,
    /// The alternative text of each image, in the order of the images, '' for one that has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<Vec<String>>,
    /// On a video post whose video the server has processed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<Video>,
    /// Whatever else a preview written by a later version says, which is kept as it is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Preview {
    /// A preview of `kind` that says nothing else yet.
    pub fn of(kind: PreviewKind) -> Self {
        Self {
            kind,
            url: None,
            text: None,
            image_count: None,
            alt: None,
            video: None,
            extra: Map::new(),
        }
    }

    /// How many images the post has, by its preview: one, unless it is an image post of several.
    pub fn images(&self) -> i64 {
        match self.image_count {
            Some(count) if self.kind == PreviewKind::Image && count > 1 => count,
            _ => 1,
        }
    }

    /// How many images the post has, if it is an image post of more than one.
    pub fn album(&self) -> Option<i64> {
        match self.image_count {
            Some(count) if self.kind == PreviewKind::Image && count > 1 => Some(count),
            _ => None,
        }
    }

    /// The alternative texts the preview has of its post's images, one for each image in their
    /// order ('' for an image that has none). None where no image has any, and for a post that
    /// is no image post.
    pub fn alts(&self) -> Option<Vec<String>> {
        let alt = self.alt.as_ref()?;
        if self.kind != PreviewKind::Image || alt.iter().all(String::is_empty) {
            return None;
        }
        let images = usize::try_from(self.images()).unwrap_or(1);
        Some((0..images).map(|i| alt.get(i).cloned().unwrap_or_default()).collect())
    }
}

/// Where a piece of content's bytes are read.
pub fn media_url(public_base_url: &str, content_id: &str) -> String {
    format!("{public_base_url}/content/{content_id}/raw")
}

/// Where the bytes of the original of a repost from another server are read: on that server.
pub fn origin_media_url(origin: &Origin) -> String {
    format!("{}/raw", origin.url)
}

/// Where an image of an image post is read, given where the post's bytes are: its place among
/// the post's images, counted from 1, after that address. The first is the post's bytes.
pub fn image_url(bytes_url: &str, image: i64) -> String {
    if image == 1 { bytes_url.to_owned() } else { format!("{bytes_url}/{image}") }
}

/// Where a file of a processed video is read, given where the post's bytes are (`bytes_url`,
/// which ends in /raw): beside them, under the id of that version of the video.
pub fn video_file_url(bytes_url: &str, video_id: &str, file: &str) -> String {
    let base = bytes_url.strip_suffix("/raw").unwrap_or(bytes_url);
    format!("{base}/video/{video_id}/{file}")
}

/// A stored preview (in a meta file or a summary) as feeds show it. An image's, video's or
/// audio's URL is always `bytes_url`, where its bytes are read. An image post of several
/// images says how many, and one whose images are described says how. A processed video says
/// what it is, with where its poster and its stream are read, beside its bytes.
pub fn read_preview(stored: &Preview, bytes_url: &str) -> Preview {
    match stored.kind {
        PreviewKind::Text => Preview {
            text: Some(stored.text.clone().unwrap_or_default()),
            ..Preview::of(PreviewKind::Text)
        },
        PreviewKind::Link => Preview {
            url: Some(stored.url.clone().unwrap_or_default()),
            ..Preview::of(PreviewKind::Link)
        },
        kind => Preview {
            url: Some(bytes_url.to_owned()),
            text: stored.text.clone().filter(|text| !text.is_empty()),
            image_count: stored.album(),
            alt: stored.alts(),
            video: stored.video.as_ref().filter(|_| kind == PreviewKind::Video).map(|video| Video {
                id: video.id.clone(),
                width: video.width.clone(),
                height: video.height.clone(),
                duration: video.duration.clone(),
                poster: Some(video_file_url(bytes_url, &video.id, "poster.jpg")),
                hls: Some(video_file_url(bytes_url, &video.id, "master.m3u8")),
            }),
            ..Preview::of(kind)
        },
    }
}

/// The preview of the content a meta file describes, its link to the bytes built for this
/// server. A repost of a post on another server links to the original's bytes.
pub fn preview_of(content_id: &str, preview: &Preview, origin: Option<&Origin>, public_base_url: &str) -> Preview {
    let bytes_url = origin.map_or_else(|| media_url(public_base_url, content_id), origin_media_url);
    read_preview(preview, &bytes_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_stored_preview_with_the_addresses_of_its_files() {
        let stored: Preview = serde_json::from_str(r#"{"kind":"video","text":"","video":{"id":"v1","width":1280,"height":720,"duration":12.5}}"#).unwrap();
        let read = read_preview(&stored, "https://a.example/content/c1/raw");
        assert_eq!(
            serde_json::to_string(&read).unwrap(),
            r#"{"kind":"video","url":"https://a.example/content/c1/raw","video":{"id":"v1","width":1280,"height":720,"duration":12.5,"poster":"https://a.example/content/c1/video/v1/poster.jpg","hls":"https://a.example/content/c1/video/v1/master.m3u8"}}"#
        );
    }

    #[test]
    fn gives_each_image_of_an_album_an_alternative_text() {
        let stored: Preview = serde_json::from_str(r#"{"kind":"image","imageCount":3,"alt":["a",""]}"#).unwrap();
        assert_eq!(stored.alts(), Some(vec!["a".to_owned(), String::new(), String::new()]));
        let none: Preview = serde_json::from_str(r#"{"kind":"image","alt":["",""]}"#).unwrap();
        assert_eq!(none.alts(), None);
        assert_eq!(image_url("u", 1), "u");
        assert_eq!(image_url("u", 2), "u/2");
    }

    #[test]
    fn keeps_a_link_as_the_url_parser_writes_it() {
        assert_eq!(
            link_url(" HTTPS://News.example/a b?c=d#e ").as_deref(),
            Some("https://news.example/a%20b?c=d#e")
        );
        assert_eq!(link_url("http://news.example").as_deref(), Some("http://news.example/"));
        for not in [
            "",
            "news.example",
            "ftp://news.example/",
            "javascript:alert(1)",
            "https:news.example",
            "https://",
        ] {
            assert_eq!(link_url(not), None, "{not}");
        }
        assert_eq!(link_url(&format!("https://news.example/{}", "a".repeat(2048))), None);
        assert_eq!(media_type("image/png"), Some(PreviewKind::Image));
        assert_eq!(media_type("text/plain"), None);
        assert_eq!(media_type("image"), None);
        assert_eq!(own_address("https://A.example/api//").as_deref(), Some("https://a.example/api"));
        assert_eq!(own_address("https://a.example").as_deref(), Some("https://a.example"));
        assert_eq!(own_address(""), None);
        assert_eq!(own_address("nowhere"), None);
        assert_eq!(post_address("https://a.example", "c1"), "https://a.example/content/c1");
    }
}
