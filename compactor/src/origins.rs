//! The server's entries for posts on other servers, as far as an attestation goes: checking
//! one, reading what it says of a post, and bringing the entry of its original up to it. It
//! is what the origin sweep does with an attestation it asked the original's server for (see
//! `crate::sweep`), by the rules the API holds one a client brings to (`originEntries` in
//! src/origins.ts).

use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use evieverse_core::attestation::{
    ATTESTATION_MAX_AGE_MS, ATTESTATION_SKEW_MS, Attested, AttestedPost, PublishedKey, asked_server, origin_hash, post_of, read_attestation, said, signed_by,
    signing_keys,
};
use evieverse_core::config::PostTypesConfig;
use evieverse_core::content::ContentMeta;
use evieverse_core::format::{cut_formatted, plain_text};
use evieverse_core::origin_keys::{KeyFetcher, KeyFound, OriginKeys};
use evieverse_core::pending::effective_meta;
use evieverse_core::posts::{
    LINK_MIME, Origin, Preview, PreviewKind, TEXT_MIME, media_type, origin_media_url, own_address, post_address, preview_of, read_preview,
};
use evieverse_core::reposts::{removed_repost_tags, reposted_tags, reposts_of};
use evieverse_core::text::trim;
use evieverse_trust::policy::{Moderation, PostSent, Unmoderated, moderate_post};
use evieverse_trust::trust::{Plugins, TrustRoute};
use serde_json::Map;

use crate::deps::Deps;
use crate::write::{EntryWrite, Unwritten, withhold, write};

/// What a later attestation did to the entry it is of (see `Origins::refresh`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refreshed {
    /// It says what the entry says: nothing was written.
    None,
    /// It says the post is gone: the entry is hidden, from `gone_at`, which is earlier than
    /// now if it was hidden `already`.
    Gone { gone_at: i64, already: bool },
    /// The entry's summary was written over with it, and waits in the moderation queue if
    /// its trust score has it `queued`.
    Updated { queued: bool },
}

/// What the server keeps of a post on another server, from its attestation.
struct Summarised {
    mime_type: String,
    origin: Origin,
    /// Its title there, if it has one.
    title: Option<String>,
    preview: Preview,
    /// What there is of it to read, as moderation reads a post.
    texts: Vec<String>,
}

/// Whether the server takes posts of a type.
fn takes(types: &PostTypesConfig, kind: PreviewKind) -> bool {
    match kind {
        PreviewKind::Text => types.text,
        PreviewKind::Image => types.image,
        PreviewKind::Video => types.video,
        PreviewKind::Audio => types.audio,
        PreviewKind::Link => types.link,
    }
}

/// What checks attestations and brings the server's entries up to them.
pub struct Origins {
    deps: Deps,
    plugins: Arc<Plugins>,
    keys: OriginKeys,
    /// This server's own address, as an origin under it is told by. None: no address is
    /// known to be its own.
    own_base: Option<String>,
    /// The keys this server signs the attestations of its own posts with, as it publishes
    /// them: no private key among them.
    own_keys: Vec<PublishedKey>,
}

impl Origins {
    /// `key_fetcher` is what gets another server's keys, where a test gives one.
    pub fn new(deps: Deps, plugins: Arc<Plugins>, key_fetcher: Option<KeyFetcher>) -> Result<Self> {
        let keys = OriginKeys::new(deps.hot.clone(), key_fetcher, deps.now.clone(), deps.log.clone());
        // Named by their place among the setting's, never by what they are: they are secrets.
        let own_keys = signing_keys(&deps.config.reposts.signing_keys)
            .map_err(|_| anyhow!("REPOSTS_SIGNING_KEYS holds what is no signing key"))?
            .iter()
            .map(|key| key.published())
            .collect();
        Ok(Self {
            own_base: own_address(&deps.config.public_base_url),
            own_keys,
            keys,
            plugins,
            deps,
        })
    }

    /// Whether an address names a post of this server's own.
    fn is_own(&self, url: &str) -> bool {
        match (&self.own_base, post_of(url)) {
            (Some(base), Some((_, id))) => url == post_address(base, id),
            _ => false,
        }
    }

    /// What an attestation says, once it is found to be what the post's own server said, a
    /// short while ago: the post, or that there is none at its address. Until then nothing in
    /// it is believed.
    ///
    /// - It is written as an attestation, and says what one says.
    /// - It was issued within ATTESTATION_MAX_AGE_MS, by a clock no more than
    ///   ATTESTATION_SKEW_MS ahead of this one: an old one says what the post was, and may
    ///   no longer be.
    /// - It is signed with a key of the server at the address it names. That server is asked
    ///   for its keys, where Redis doesn't hold them (see `OriginKeys`): over https only, on
    ///   the port https has. A server that gives no keys leaves the attestation unchecked,
    ///   and so refused; a key that isn't among the server's, or a signature that isn't that
    ///   key's, is a forgery as far as anyone can tell.
    ///
    /// An address that is this server's own is checked with this server's own keys, and
    /// nobody is asked.
    pub async fn attested(&self, attestation: &str) -> Result<Attested> {
        let read = read_attestation(attestation).context("it is not written as an attestation")?;
        let post = said(&read.payload).map_err(|issues| match issues.first() {
            Some(issue) => anyhow!("it does not say what an attestation says: {} at \"{}\"", issue.message, issue.path.join(".")),
            None => anyhow!("it does not say what an attestation says"),
        })?;
        let age = self.deps.now() - post.issued_at();
        if !(-ATTESTATION_SKEW_MS..=ATTESTATION_MAX_AGE_MS).contains(&age) {
            bail!("it was issued too long ago, or by a clock that is ahead of this server's");
        }
        let key = if self.is_own(post.url()) {
            self.own_keys.iter().find(|key| key.id == post.kid()).cloned()
        } else {
            let server = asked_server(post.url()).context("its post is not at an https address, on the port of https")?;
            match self.keys.find(server, post.kid()).await? {
                KeyFound::Key(key) => Some(key),
                KeyFound::Unknown => None,
                KeyFound::Unavailable => bail!("the keys of {server} could not be had"),
            }
        };
        match key {
            Some(key) if signed_by(&key.public_key, &read) => Ok(post),
            _ => bail!("it is not signed with a key of the server its post is on"),
        }
    }

    /// What the server keeps of a post on another server, from its attestation: its content
    /// type, which an image, video or audio has to say and be, where it is and who published
    /// it there, its title, and its preview, cut to the length of this server's. The type of
    /// post must be one the server takes.
    fn summarised(&self, sent: &AttestedPost) -> Result<Summarised, Unwritten> {
        let config = &self.deps.config;
        let kind = sent.preview.kind;
        if !takes(&config.post_types, kind) {
            return Err(Unwritten::Refused(format!("the server takes no {} posts", kind.as_str())));
        }
        let mime_type = match kind {
            PreviewKind::Text => TEXT_MIME.to_owned(),
            PreviewKind::Link => LINK_MIME.to_owned(),
            _ => sent
                .mime_type
                .clone()
                .filter(|mime_type| media_type(mime_type) == Some(kind))
                .ok_or_else(|| Unwritten::Refused(format!("its content type is not one of a post of type {}", kind.as_str())))?,
        };
        let (words, chars) = (config.feed.preview_words, config.feed.preview_chars);
        let cut = |text: &str| cut_formatted(text, usize::try_from(words).unwrap_or(0), usize::try_from(chars).unwrap_or(0), &[]);
        let origin = Origin {
            url: sent.url.clone(),
            publisher: sent.publisher.clone(),
        };
        let caption = sent.preview.text.as_deref().filter(|text| kind != PreviewKind::Link && !text.is_empty());
        let preview = match kind {
            PreviewKind::Text => Preview {
                text: Some(cut(sent.preview.text.as_deref().unwrap_or_default())),
                ..Preview::of(kind)
            },
            PreviewKind::Link => Preview {
                url: sent.preview.url.clone(),
                ..Preview::of(kind)
            },
            _ => {
                let image = kind == PreviewKind::Image;
                let stored = Preview {
                    text: caption.map(cut),
                    // How many images the original has, for one of several: they are read on its server, each at its place after the first's address.
                    image_count: sent.preview.image_count.filter(|_| image),
                    // What describes its images there, which is read out here as there.
                    alt: sent
                        .preview
                        .alt
                        .as_ref()
                        .filter(|_| image)
                        .map(|alts| alts.iter().map(|alt| trim(alt).to_owned()).collect()),
                    // What a video its server processed is: its poster and its stream are read on that server, as its bytes are.
                    video: sent.preview.video.clone().filter(|_| kind == PreviewKind::Video),
                    ..Preview::of(kind)
                };
                read_preview(&stored, &origin_media_url(&origin))
            }
        };
        // The alternative texts are the post's words as its caption is, and are read as it is.
        let alts = sent.preview.alt.clone().filter(|_| kind == PreviewKind::Image).unwrap_or_default();
        let words = if kind == PreviewKind::Link {
            sent.preview.url.clone()
        } else {
            caption.map(|caption| plain_text(caption, true))
        };
        // Its title, which is plain text, and the post's words as its caption is.
        let title = sent.title.clone().filter(|title| !title.is_empty());
        let texts = title
            .clone()
            .into_iter()
            .chain(words)
            .chain(alts)
            .chain([origin.url.clone(), origin.publisher.username.clone()])
            .collect();
        Ok(Summarised {
            mime_type,
            origin,
            title,
            preview,
            texts,
        })
    }

    /// Brings the server's entry for a post on another server up to a later attestation of
    /// it, which was checked already (see `attested`). The attestation says one of two things:
    ///
    /// - The post, as it is now. The entry's summary is written over with it: an update of
    ///   the entry, in the name of nobody but the original's server. It is held to what an
    ///   update of a post is: the type of post stays what it was, it is given a trust score
    ///   and its hashtags are held to their rules by what it now says, in the name of the
    ///   entry's owner, so it can be refused (and the entry stays as it was), held in the
    ///   moderation queue or lose a hashtag. One that says what the entry says changes
    ///   nothing. An entry that was hidden because the post was gone is published again by
    ///   it, where it was, whether or not the post says what it said before.
    /// - That no post is published there. The entry is hidden, and not deleted (see
    ///   `withhold`). An entry that is hidden already stays hidden from when it first was,
    ///   and holds that the post was still gone when this was said.
    ///
    /// Only an attestation issued after the one the entry is from is taken, so nobody brings
    /// back what the post was with an attestation they kept. That holds for two that arrive
    /// at once: the one that commits second is checked against the first, as it commits.
    pub async fn refresh(&self, attested: &Attested) -> Result<Refreshed, Unwritten> {
        let Deps {
            db, config, content, now, log, ..
        } = &self.deps;
        let no_entry = || Unwritten::Refused("the server has no entry for the post".to_owned());
        let entry = db
            .fetch_optional(
                "SELECT id FROM content WHERE origin_hash = ?",
                evieverse_core::params![origin_hash(attested.url())],
            )
            .await?
            .ok_or_else(no_entry)?;
        // The row, with the entry's write number, before the meta file: what is read after it is no older than the number says.
        let row = db
            .fetch_optional(
                "SELECT content.id AS id, content.user_id AS user_id, content.seq AS seq, content.ai_generated AS ai_generated, \
                 content.origin_gone_at AS origin_gone_at, users.username AS username \
                 FROM content INNER JOIN users ON users.id = content.user_id \
                 WHERE content.id = ? AND content.delete_requested_at IS NULL",
                evieverse_core::params![entry.str("id")?],
            )
            .await?
            .ok_or_else(no_entry)?;
        let content_id = row.str("id")?;
        let meta = effective_meta(db, content, content_id)
            .await?
            .with_context(|| format!("the meta file of {content_id} is missing"))?;
        let issued_at = attested.issued_at();
        let recheck = move |current: &ContentMeta| {
            if issued_at <= current.origin_attested_at.unwrap_or(0) {
                return Err(Unwritten::Refused("it is no newer than the attestation the entry is from".to_owned()));
            }
            Ok(())
        };
        recheck(&meta)?;
        let hidden = row.opt_i64("origin_gone_at")?.is_some();

        let post = match attested {
            Attested::Post(post) => post,
            Attested::Gone(_) => {
                // Written for an entry that is hidden already too: it stays hidden from when it first was, and holds when
                // this was said, which an attestation of the post from before it is then refused by.
                let gone_at = withhold(&self.deps, content_id, issued_at, &recheck).await?;
                return Ok(Refreshed::Gone { gone_at, already: hidden });
            }
        };
        let Summarised {
            mime_type,
            origin,
            title,
            preview,
            texts,
        } = self.summarised(post)?;
        if mime_type != meta.mime_type {
            return Err(Unwritten::Refused(format!(
                "the post is {mime_type} now, and the entry is of a post that is {}",
                meta.mime_type
            )));
        }
        let ai_generated = post.ai_generated;
        let shown = preview_of(content_id, &meta.preview, meta.origin.as_ref(), &config.public_base_url);
        // A hidden entry is written whatever the post says: the write is what publishes it again.
        if !hidden && ai_generated == row.flag("ai_generated")? && meta.origin.as_ref() == Some(&origin) && title == meta.title && preview == shown {
            return Ok(Refreshed::None);
        }

        // What the entry now says is held to the rules of every hashtag it has, those reposts gave it too, as an update of a post is.
        let places = reposts_of(&mut &*db, content_id).await?;
        let given = reposted_tags(places.iter().map(|repost| repost.tag.as_str()));
        // The entry's own are the rest of what its meta file holds, but for those of a repost that was removed and that the
        // compactor is yet to take off it: read after the meta file and the reposts, so one of them is either a repost's
        // there or named here.
        let taken = removed_repost_tags(&mut &*db, content_id).await?;
        let own = meta.tags.iter().filter(|tag| !given.contains(tag) && !taken.contains(tag)).cloned();
        let moderation = Moderation {
            db,
            config,
            plugins: &self.plugins,
            now,
            log,
            process_log: log,
            client: None,
        };
        let sent = PostSent {
            user_id: row.string("user_id")?,
            content_id: Some(content_id.to_owned()),
            tags: own.chain(given.iter().cloned()).collect(),
            texts,
            images: vec![],
            ai_generated,
        };
        let moderated = match moderate_post(&moderation, sent).await {
            Ok(moderated) => moderated,
            Err(Unmoderated::Refused(_)) => return Err(Unwritten::Refused("what the post now says is refused by its trust score".to_owned())),
            Err(Unmoderated::Failed(err)) => return Err(err.into()),
        };
        let queued = moderated.route == TrustRoute::Queue;
        // The hashtags of reposts that what it now says is refused: they come off the entry for good.
        let dropped: Vec<String> = moderated
            .removed_tags
            .iter()
            .filter(|removed| given.contains(&removed.tag) && removed.reason != "removed")
            .map(|removed| removed.tag.clone())
            .collect();
        let written = ContentMeta {
            content_id: content_id.to_owned(),
            mime_type,
            size: i64::try_from(origin.url.len()).unwrap_or(i64::MAX),
            sha256: None,
            images: None,
            ai_generated,
            comments: Some(false),
            title,
            preview,
            text: None,
            mentions: None,
            tags: moderated.tags,
            updated_at: self.deps.now(),
            origin: Some(origin),
            origin_attested_at: Some(issued_at),
            extra: Map::new(),
        };
        let update = EntryWrite {
            user_id: row.str("user_id")?,
            username: row.str("username")?,
            previous: &meta,
            seen_seq: row.i64("seq")?,
            recheck: &recheck,
            given: &given,
            meta: written,
            queued: queued.then_some(moderated.trust_score),
            dropped_reposts: &dropped,
        };
        write(&self.deps, update).await?;
        Ok(Refreshed::Updated { queued })
    }
}
