//! The formats the API and the compactor both read and write, held together: the files of
//! `fixtures/`, at the top of the repository, say what each format is of a set of inputs, as
//! the API's code makes it (test/fixtures.test.ts there writes and checks them). These tests
//! read the same files and make the same of the same inputs with this crate's code. So a
//! change of a format on one side fails here or there until the other side has it too.
//!
//! `fixtures/from-rust.json` goes the other way: what this code wrote, which the API's tests
//! read. To write it again after a change that is meant, from the folder `compactor`:
//!
//!   UPDATE_FIXTURES=1 cargo test -p evieverse-core --test fixtures
//!
//! The stores are run against the tests' Redis: TEST_REDIS_URL, or the one
//! `docker compose up -d redis` starts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use evieverse_core::comments::{Comment, CommentStore, Removal};
use evieverse_core::content::{BytesOwner, ContentMeta, ContentStore, staged_key};
use evieverse_core::hot::{HotStore, LexRange};
use evieverse_core::layout::{self, Head, IndexEntry, Manifest};
use evieverse_core::object::ObjectStore;
use evieverse_core::pending::{self, CommentLikePayload, CommentPutPayload, CommentRemovePayload, PostPayload};
use evieverse_core::summary::{self, Summary, SummaryOptions, SummaryRef, SummaryStore};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

/// The fixtures both sides read: from compactor/crates/core to the top of the repository.
fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

/// What a fixture file holds.
fn read(name: &str) -> Value {
    let file = dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&file).unwrap_or_else(|err| panic!("{} could not be read: {err}", file.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{} is not JSON: {err}", file.display()))
}

/// A part of a fixture, as the type it is read as.
fn part<T: DeserializeOwned>(value: &Value) -> T {
    T::deserialize(value).unwrap_or_else(|err| panic!("the fixture holds what this code does not read: {err}\n{value:#}"))
}

/// What this code writes as JSON, as the value it is.
fn written<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_else(|| panic!("the fixture holds {value}, where it is to hold text"))
}

fn update() -> bool {
    std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1")
}

#[test]
fn the_feed_index_is_laid_out_as_the_fixture_has_it() {
    let fixture = read("layout");

    let entries: Vec<IndexEntry> = part(&fixture["day"]["entries"]);
    let packed = layout::pack_day(&entries).unwrap();
    assert_eq!(hex::encode(&packed), text(&fixture["day"]["hex"]));
    assert_eq!(written(&layout::unpack_day(&packed, layout::LAYOUT_VERSION)), fixture["day"]["unpacked"]);
    let mut longer = packed.clone();
    longer.extend_from_slice(&[0xff, 0xff]);
    assert_eq!(
        json!(layout::unpack_day(&longer, layout::LAYOUT_VERSION).len()),
        fixture["day"]["withBytesLeftOver"]
    );
    // An index of version 5, written before entries had views and dislikes, is read as having none.
    let v5 = hex::decode(text(&fixture["day"]["v5"]["hex"])).unwrap();
    assert_eq!(written(&layout::unpack_day(&v5, 5)), fixture["day"]["v5"]["unpacked"]);
    assert_eq!(json!(layout::day_entry_bytes(5)), fixture["day"]["v5"]["entryBytes"]);
    assert_eq!(json!(layout::day_entry_bytes(layout::LAYOUT_VERSION)), fixture["day"]["entryBytes"]);

    let ids = |order: fn(&IndexEntry, &IndexEntry) -> std::cmp::Ordering| {
        let mut sorted = entries.clone();
        sorted.sort_by(order);
        json!(sorted.iter().map(|e| e.content_id.clone()).collect::<Vec<_>>())
    };
    assert_eq!(ids(layout::compare_records), fixture["order"]["byRecords"]);
    assert_eq!(ids(layout::compare_recent), fixture["order"]["byRecent"]);

    for quota in fixture["quotas"].as_array().unwrap() {
        let number = |name: &str| quota[name].as_i64().unwrap();
        assert_eq!(layout::day_quota(number("ageDays"), number("max"), number("min")), number("quota"), "{quota}");
    }

    let keys = &fixture["keys"];
    let (tag, user_id) = (text(&keys["tag"]), text(&keys["userId"]));
    let manifest: Manifest = serde_json::from_str(text(&fixture["manifest"])).unwrap();
    assert_eq!(layout::author_index(user_id), text(&keys["authorIndex"]));
    assert_eq!(
        json!([layout::index_author(&layout::author_index(user_id)), layout::index_author(tag)]),
        keys["indexAuthor"]
    );
    assert_eq!(layout::head_key(tag), text(&keys["headKey"]));
    assert_eq!(layout::head_key(&layout::author_index(user_id)), text(&keys["authorHeadKey"]));
    assert_eq!(layout::manifest_key(tag, &manifest.id), text(&keys["manifestKey"]));
    assert_eq!(layout::day_key(tag, &manifest.days[0].generation), text(&keys["dayKey"]));

    // The head and the manifest are written as the API writes them, to the letter.
    let head: Head = serde_json::from_str(text(&fixture["head"])).unwrap();
    assert_eq!(serde_json::to_string(&head).unwrap(), text(&fixture["head"]));
    assert_eq!(serde_json::to_string(&Head::empty()).unwrap(), text(&fixture["emptyHead"]));
    assert_eq!(serde_json::to_string(&manifest).unwrap(), text(&fixture["manifest"]));
}

#[test]
fn a_summary_is_written_and_read_as_the_fixture_has_it() {
    let fixture = read("summaries");
    let base = text(&fixture["publicBaseUrl"]);
    let quality = u32::try_from(fixture["quality"].as_u64().unwrap()).unwrap();

    for case in fixture["written"].as_array().unwrap() {
        let name = text(&case["name"]);
        let summary: Summary = part(&case["summary"]);
        assert_eq!(written(&summary), case["summary"], "{name}: read and written again");
        let encoded = summary::encode_summary(&summary);
        assert_eq!(encoded, text(&case["text"]), "{name}: as text");
        let decoded = summary::decode_summary(&summary.content_id, &encoded, base).unwrap();
        assert_eq!(written(&decoded), case["decoded"], "{name}: read back");
        assert_eq!(summary::summary_key(&summary.content_id), text(&case["redisKey"]), "{name}");
        assert_eq!(
            summary::summary_object_key(&summary.content_id, summary.created_at),
            text(&case["objectKey"]),
            "{name}"
        );

        // What the API compressed is read here, and what this compresses reads back the same.
        let theirs = BASE64.decode(text(&case["brotli"])).unwrap();
        assert_eq!(summary::decompress_summary(&theirs).unwrap(), encoded, "{name}: the API's bytes");
        let ours = summary::compress_summary(&encoded, quality).unwrap();
        assert_eq!(summary::decompress_summary(&ours).unwrap(), encoded, "{name}: this code's bytes");
    }

    for case in fixture["stored"].as_array().unwrap() {
        let name = text(&case["name"]);
        let decoded = summary::decode_summary(text(&case["contentId"]), text(&case["text"]), base).unwrap();
        assert_eq!(written(&decoded), case["decoded"], "{name}");
    }
}

/// Reads each document of a fixture as `T`, holds what this code writes of it to what the
/// fixture has, and returns the text this code writes, by the document's name.
fn documents<T: DeserializeOwned + serde::Serialize>(stored: &Value) -> Map<String, Value> {
    stored
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, stored)| {
            let theirs: Value = serde_json::from_str(text(stored)).unwrap();
            let read: T = evieverse_core::json::from_str(text(stored)).unwrap_or_else(|err| panic!("{name} is not read: {err}"));
            assert_eq!(written(&read), theirs, "{name}: read and written again");
            (name.clone(), json!(serde_json::to_string(&read).unwrap()))
        })
        .collect()
}

#[test]
fn a_stored_document_is_the_json_the_fixture_has() {
    let fixture = read("documents");
    assert!(!documents::<ContentMeta>(&fixture["metas"]).is_empty());
    assert!(!documents::<Comment>(&fixture["comments"]).is_empty());
}

/// The payloads of the fixture, each read as the type its name says and written again.
fn payloads(fixture: &Value) -> Map<String, Value> {
    fixture["payloads"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, stored)| {
            let stored = text(stored);
            let theirs: Value = serde_json::from_str(stored).unwrap();
            let ours = if name.starts_with("post") {
                written(&pending::payload_of::<PostPayload>(Some(stored)).unwrap().unwrap())
            } else if name.starts_with("commentPut") || name.starts_with("commentHeld") {
                written(&pending::payload_of::<CommentPutPayload>(Some(stored)).unwrap().unwrap())
            } else if name.starts_with("commentRemove") {
                written(&pending::payload_of::<CommentRemovePayload>(Some(stored)).unwrap().unwrap())
            } else {
                written(&pending::payload_of::<CommentLikePayload>(Some(stored)).unwrap().unwrap())
            };
            assert_eq!(ours, theirs, "{name}: read and written again");
            (name.clone(), json!(ours.to_string()))
        })
        .collect()
}

#[test]
fn a_pending_write_holds_what_the_fixture_has() {
    let fixture = read("pending");
    assert_eq!(json!(pending::UNNUMBERED), fixture["unnumbered"]);
    let like = &fixture["likeKey"];
    assert_eq!(pending::like_key(text(&like["commentId"]), text(&like["userId"])), text(&like["key"]));
    assert_eq!(staged_key(text(&fixture["stagedKey"]["writeId"])), text(&fixture["stagedKey"]["key"]));

    let read = payloads(&fixture);
    assert!(read.len() >= 9);
    let post = pending::payload_of::<PostPayload>(Some(text(&fixture["payloads"]["postToProcess"])))
        .unwrap()
        .unwrap();
    assert!(post.processing() && !post.keeps_bytes());
    let kept = pending::payload_of::<PostPayload>(Some(text(&fixture["payloads"]["postKeepingBytes"])))
        .unwrap()
        .unwrap();
    assert!(kept.keeps_bytes() && !kept.processing());
    let unlike = pending::payload_of::<CommentLikePayload>(Some(text(&fixture["payloads"]["commentUnlike"])))
        .unwrap()
        .unwrap();
    assert!(unlike.unlikes());

    let metas = read_documents();
    for (name, expected) in fixture["bytes"].as_object().unwrap() {
        let meta: ContentMeta = serde_json::from_str(text(&metas["metas"][name])).unwrap();
        let (bytes, mime_type) = pending::payload_bytes(&meta).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), text(&expected["text"]), "{name}");
        assert_eq!(mime_type, text(&expected["mimeType"]), "{name}");
    }
    let album: ContentMeta = serde_json::from_str(text(&metas["metas"]["album"])).unwrap();
    assert!(pending::payload_bytes(&album).is_err());
}

fn read_documents() -> Value {
    read("documents")
}

/// Whose bytes an operation of the fixture names, as the API's `BytesOwner` says it.
fn owner(of: &Value) -> BytesOwner<'_> {
    let field = |name: &str| text(&of[name]);
    match of {
        Value::String(content_id) => BytesOwner::Post(content_id),
        _ if of.get("image").is_some() => BytesOwner::Image {
            content_id: field("contentId"),
            image: of["image"].as_i64().unwrap(),
        },
        _ if of.get("video").is_some() => BytesOwner::Video {
            content_id: field("contentId"),
            video: field("video"),
            file: field("file"),
        },
        _ if of.get("adId").is_some() => BytesOwner::Ad(field("adId")),
        _ if of.get("avatar").is_some() => BytesOwner::Avatar {
            user_id: field("userId"),
            avatar: field("avatar"),
        },
        _ if of.get("staged").is_some() => BytesOwner::Staged(field("staged")),
        _ => BytesOwner::Comment {
            post_id: field("postId"),
            comment_id: field("commentId"),
        },
    }
}

/// One thing done to the stores, as the fixture says it (see `Op` in test/fixtures.test.ts).
#[derive(Deserialize)]
#[serde(tag = "op", rename_all_fields = "camelCase")]
enum Op {
    #[serde(rename = "content.putBytes")]
    PutBytes { of: Value, text: String, mime_type: String },
    #[serde(rename = "content.putMeta")]
    PutMeta { meta: ContentMeta },
    #[serde(rename = "content.adopt")]
    Adopt { staged: String, of: Value, mime_type: String },
    #[serde(rename = "content.removeStaged")]
    RemoveStaged { staged: String },
    #[serde(rename = "content.remove")]
    RemoveContent { content_id: String, images: i64 },
    #[serde(rename = "content.removeImage")]
    RemoveImage { content_id: String, image: i64 },
    #[serde(rename = "content.removeMedia")]
    RemoveMedia { content_id: String, video_id: Option<String> },
    #[serde(rename = "comments.put")]
    PutComment { comment: Comment, held: bool },
    #[serde(rename = "comments.publish")]
    Publish { comment: Comment },
    #[serde(rename = "comments.hold")]
    Hold { comment: Comment },
    #[serde(rename = "comments.remove")]
    RemoveComment { post_id: String, comment_id: String, keep_place: bool },
    #[serde(rename = "comments.addLike")]
    AddLike { post_id: String, comment_id: String, user_id: String },
    #[serde(rename = "comments.removeLike")]
    RemoveLike { post_id: String, comment_id: String, user_id: String },
    #[serde(rename = "comments.makingLikes")]
    MakingLikes { comment_id: String, done: bool },
    #[serde(rename = "comments.removeAll")]
    RemoveAll { post_id: String },
    #[serde(rename = "summaries.put")]
    PutSummary { summary: Summary },
    #[serde(rename = "summaries.ensureMany")]
    EnsureMany { summaries: Vec<Summary> },
    #[serde(rename = "summaries.erase")]
    Erase {
        #[serde(rename = "ref")]
        of: SummaryRef,
    },
    #[serde(rename = "summaries.eraseCopies")]
    EraseCopies {
        #[serde(rename = "ref")]
        of: SummaryRef,
        gone: Vec<i64>,
    },
    #[serde(rename = "summaries.remove")]
    RemoveSummaries { refs: Vec<SummaryRef> },
    #[serde(rename = "summaries.purgeBefore")]
    PurgeBefore { day: i64 },
    #[serde(rename = "snapshot")]
    Snapshot { name: String },
}

/// What bytes held under a name say: an object's, by its key, or a key's of Redis.
fn held(name: &str, bytes: &[u8]) -> Value {
    let as_text = || String::from_utf8(bytes.to_vec()).unwrap();
    if name.starts_with("cmtlm:") {
        json!({ "making": as_text().starts_with("making:") })
    } else if name.ends_with(".br") || name.starts_with("sum:") {
        json!({ "brotli": summary::decompress_summary(bytes).unwrap() })
    } else if (name.ends_with(".json") || name.starts_with("cmt:")) && !bytes.is_empty() {
        json!({ "json": serde_json::from_slice::<Value>(bytes).unwrap() })
    } else {
        json!({ "text": as_text() })
    }
}

/// Every file under a folder, by its path from there.
fn files(root: &Path, under: &Path, into: &mut BTreeMap<String, Vec<u8>>) {
    let Ok(entries) = std::fs::read_dir(under) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files(root, &path, into);
        } else {
            let key = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            into.insert(key, std::fs::read(&path).unwrap());
        }
    }
}

fn redis_url() -> String {
    std::env::var("TEST_REDIS_URL")
        .ok()
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| "redis://127.0.0.1:6379".to_owned())
}

#[tokio::test]
async fn the_stores_hold_what_the_fixture_has_once_they_are_written() {
    let fixture = read("stores");
    let ops: Vec<Op> = part(&fixture["ops"]);
    let now = fixture["now"].as_i64().unwrap();

    let root = tempfile::tempdir().unwrap();
    let prefix = format!("test:{}:", uuid::Uuid::new_v4());
    let hot = HotStore::connect(&redis_url(), &prefix)
        .await
        .expect("the tests need Redis: TEST_REDIS_URL, or `docker compose up -d redis`");
    let options = BTreeMap::from([("root".to_owned(), root.path().to_string_lossy().into_owned())]);
    let content = ContentStore::open("fs", &options, 900).unwrap();
    let objects = ObjectStore::open("fs", &options).unwrap();
    let comments = CommentStore::new(hot.clone(), objects.clone(), fixture["commentHotMs"].as_i64().unwrap());
    let summaries = SummaryStore::new(
        hot.clone(),
        objects,
        SummaryOptions {
            hot_days: fixture["hotDays"].as_i64().unwrap(),
            quality: u32::try_from(fixture["quality"].as_u64().unwrap()).unwrap(),
            public_base_url: text(&fixture["publicBaseUrl"]).to_owned(),
        },
        Arc::new(move || now),
    );
    let mut redis = redis::Client::open(redis_url()).unwrap().get_multiplexed_async_connection().await.unwrap();

    let mut snapshots = Map::new();
    for op in ops {
        match op {
            Op::PutBytes { of, text, mime_type } => content.put_bytes(owner(&of), text.into_bytes(), &mime_type).await.unwrap(),
            Op::PutMeta { meta } => content.put_meta(&meta).await.unwrap(),
            Op::Adopt { staged, of, mime_type } => content.adopt(&staged, owner(&of), &mime_type).await.unwrap(),
            Op::RemoveStaged { staged } => content.remove_staged(&staged).await.unwrap(),
            Op::RemoveContent { content_id, images } => content.remove(&content_id, images).await.unwrap(),
            Op::RemoveImage { content_id, image } => content.remove_image(&content_id, image).await.unwrap(),
            Op::RemoveMedia { content_id, video_id } => content.remove_media(&content_id, video_id.as_deref()).await.unwrap(),
            Op::PutComment { comment, held } => comments.put(&comment, held).await.unwrap(),
            Op::Publish { comment } => comments.publish(&comment).await.unwrap(),
            Op::Hold { comment } => comments.hold(&comment).await.unwrap(),
            Op::RemoveComment {
                post_id,
                comment_id,
                keep_place,
            } => comments.remove(&post_id, &comment_id, Removal { keep_place, comment: None }).await.unwrap(),
            Op::AddLike { post_id, comment_id, user_id } => comments.add_like(&post_id, &comment_id, &user_id).await.unwrap(),
            Op::RemoveLike { post_id, comment_id, user_id } => comments.remove_like(&post_id, &comment_id, &user_id).await.unwrap(),
            Op::MakingLikes { comment_id, done } => {
                let making = comments.making_likes(&comment_id).await.unwrap();
                if done {
                    making.done().await.unwrap();
                }
            }
            Op::RemoveAll { post_id } => comments.remove_all(&post_id).await.unwrap(),
            Op::PutSummary { summary } => summaries.put(&summary).await.unwrap(),
            Op::EnsureMany { summaries: list } => {
                let errors = summaries.ensure_many(&list).await.unwrap();
                assert!(errors.iter().all(Option::is_none), "{errors:?}");
            }
            Op::Erase { of } => summaries.erase(&of).await.unwrap(),
            Op::EraseCopies { of, gone } => summaries.erase_copies(&of, &gone).await.unwrap(),
            Op::RemoveSummaries { refs } => summaries.remove(&refs).await.unwrap(),
            Op::PurgeBefore { day } => {
                summaries.purge_before(day).await.unwrap();
            }
            Op::Snapshot { name } => {
                let mut stored = BTreeMap::new();
                files(root.path(), root.path(), &mut stored);
                // Where a write is made before it is moved into place.
                let objects: Map<String, Value> = stored
                    .iter()
                    .filter(|(key, _)| !key.starts_with(".tmp/"))
                    .map(|(key, bytes)| (key.clone(), held(key, bytes)))
                    .collect();
                let mut in_redis = Map::new();
                let mut keys = hot.keys("*").await.unwrap();
                keys.sort();
                keys.dedup();
                for key in keys {
                    let full = format!("{prefix}{key}");
                    let left: i64 = redis::cmd("PTTL").arg(&full).query_async(&mut redis).await.unwrap();
                    let kind: String = redis::cmd("TYPE").arg(&full).query_async(&mut redis).await.unwrap();
                    let mut value = if kind == "zset" {
                        json!({ "members": hot.lex_range(&key, &LexRange::default(), 100_000, false).await.unwrap() })
                    } else {
                        held(&key, &hot.get(&key).await.unwrap().unwrap_or_default())
                    };
                    value["expires"] = json!(left > 0);
                    in_redis.insert(key, value);
                }
                snapshots.insert(name, json!({ "objects": objects, "redis": in_redis }));
            }
        }
    }
    hot.clear().await.unwrap();

    let expected = fixture["snapshots"].as_object().unwrap();
    assert_eq!(snapshots.keys().collect::<Vec<_>>(), expected.keys().collect::<Vec<_>>());
    for (name, expected) in expected {
        for tier in ["objects", "redis"] {
            let (ours, theirs) = (snapshots[name][tier].as_object().unwrap(), expected[tier].as_object().unwrap());
            assert_eq!(
                ours.keys().collect::<Vec<_>>(),
                theirs.keys().collect::<Vec<_>>(),
                "{name}: the names of what the {tier} hold"
            );
            for (key, theirs) in theirs {
                assert_eq!(&ours[key], theirs, "{name}: {key}");
            }
        }
    }
}

/// What this code writes of the inputs of the other fixtures, for the API's tests to read.
#[test]
fn what_this_code_writes_is_what_the_api_reads() {
    let layout_fixture = read("layout");
    let entries: Vec<IndexEntry> = part(&layout_fixture["day"]["entries"]);
    let head: Head = serde_json::from_str(text(&layout_fixture["head"])).unwrap();
    let manifest: Manifest = serde_json::from_str(text(&layout_fixture["manifest"])).unwrap();

    let summaries_fixture = read("summaries");
    let quality = u32::try_from(summaries_fixture["quality"].as_u64().unwrap()).unwrap();
    let texts: Vec<(String, String)> = summaries_fixture["written"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| (text(&case["name"]).to_owned(), summary::encode_summary(&part::<Summary>(&case["summary"]))))
        .collect();
    let compressed: Vec<Value> = texts
        .iter()
        .map(|(name, encoded)| json!({ "name": name, "brotli": BASE64.encode(summary::compress_summary(encoded, quality).unwrap()) }))
        .collect();

    let stored = read_documents();
    let made = json!({
        "day": hex::encode(layout::pack_day(&entries).unwrap()),
        "head": serde_json::to_string(&head).unwrap(),
        "manifest": serde_json::to_string(&manifest).unwrap(),
        "summaries": compressed,
        "metas": documents::<ContentMeta>(&stored["metas"]),
        "comments": documents::<Comment>(&stored["comments"]),
        "payloads": payloads(&read("pending")),
    });

    let file = dir().join("from-rust.json");
    if update() {
        std::fs::write(&file, format!("{}\n", serde_json::to_string_pretty(&made).unwrap())).unwrap();
        return;
    }
    let kept = read("from-rust");
    // A summary's compressed bytes may change with the compressor, and read the same: they are held to what they say.
    let said = |summaries: &Value| -> Vec<(String, String)> {
        summaries
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    text(&s["name"]).to_owned(),
                    summary::decompress_summary(&BASE64.decode(text(&s["brotli"])).unwrap()).unwrap(),
                )
            })
            .collect()
    };
    assert_eq!(
        said(&kept["summaries"]),
        texts,
        "fixtures/from-rust.json is not what this code writes: if the change is meant, see the top of this file"
    );
    for name in ["day", "head", "manifest", "metas", "comments", "payloads"] {
        assert_eq!(
            kept[name], made[name],
            "fixtures/from-rust.json is not what this code writes of \"{name}\": if the change is meant, see the top of this file"
        );
    }
}
