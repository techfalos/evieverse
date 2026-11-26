//! Links that spread malware: a post with a link that is on URLhaus's list
//! (https://urlhaus.abuse.ch) isn't trusted at all, and neither is a comment, nor what a user
//! puts on their profile. Every link in what there is of it to read is checked: a link post's
//! URL, the links written in a text, a caption or a comment, with a scheme or without one
//! (see `find_links`), and a profile's links, with the ones written in its bio.
//!
//! The server never follows a link. It looks each up in the copy of the list this process
//! keeps (see `MalwareList`), so a link is checked for what URLhaus knew of it when the post
//! was sent: one that is listed later stays, and so does one that leads to a listed URL
//! without naming it, as a shortened link does.
//!
//! The plugin is optional: it runs on a server that names it in TRUST_OPTIONAL_PLUGINS, which
//! then needs an Auth-Key to download the list with (`urlhaus.authKey`, URLHAUS_AUTH_KEY),
//! and on no other. Where it runs, a post that has a link isn't published unchecked: while
//! the process has no list, because its first download failed, a post with an http or https
//! link fails, as a plugin that fails has it. What only may be a link (example.com/file,
//! which a filename is read as too) is let through then, so posts without links are stored
//! whatever URLhaus does.

pub mod links;
pub mod list;

use anyhow::Result;
use async_trait::async_trait;

use self::links::find_links;
use self::list::{MalwareList, is_listed};
use crate::trust::{MIN_TRUST_SCORE, TrustChange, TrustContext, TrustPlugin, TrustPost, msg};

#[derive(Default)]
struct Urlhaus {
    list: MalwareList,
}

#[async_trait]
impl TrustPlugin for Urlhaus {
    fn optional(&self) -> bool {
        true
    }

    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        let mut links = vec![];
        for text in &post.texts {
            links.extend(find_links(text)?);
        }
        if links.is_empty() {
            // Nothing to check, but the list is kept current for the post that has.
            self.list.refresh(ctx);
            return Ok(None);
        }
        let listed = match self.list.get(ctx).await {
            Ok(listed) => listed,
            Err(err) if links.iter().any(|link| link.schemed) => return Err(err),
            Err(_) => return Ok(None),
        };
        if !links.iter().any(|link| is_listed(&listed, link)) {
            return Ok(None);
        }
        let key = if post.profile {
            "user.profile_malware_link"
        } else if post.comment_on.is_none() {
            "moderation.malware_link"
        } else {
            "comment.malware_link"
        };
        Ok(Some(TrustChange::set(MIN_TRUST_SCORE).because(msg(key))))
    }
}

/// The plugin, as the registry asks for it (see build.rs).
pub fn plugin() -> Box<dyn TrustPlugin> {
    Box::new(Urlhaus::default())
}

#[cfg(test)]
mod tests {
    use evieverse_core::log::Level;
    use evieverse_core::time::{MINUTE, fixed_clock};
    use serde_json::json;

    use super::*;
    use crate::trust::tests::{Served, World};

    fn post(texts: &[&str]) -> TrustPost {
        TrustPost { user_id: "u1".into(), texts: texts.iter().map(|t| (*t).to_owned()).collect(), ..TrustPost::default() }
    }

    async fn world(served: &Served) -> World {
        World::new(json!({ "trust": { "optionalPlugins": ["urlhaus"] }, "urlhaus": { "authKey": "the key/1", "listUrl": format!("{}/list/{{key}}/", served.url), "refreshMinutes": 5 } })).await
    }

    /// Waits until the download that was started is over.
    async fn settled(served: &Served, requests: usize) {
        for _ in 0..500 {
            if served.requests().len() >= requests {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the list was not asked for");
    }

    #[tokio::test]
    async fn a_post_with_a_listed_link_is_not_trusted_at_all() {
        let served = Served::start(200, "# the list\nhttp://bad.example/a.exe\n\"1\",\"x\",\"https://worse.example/b\",\"online\"\n").await;
        let world = world(&served).await;
        let plugin = plugin();
        assert!(plugin.optional() && !plugin.reads_images());

        let refused = |key: &str| Some(TrustChange::set(0).because(msg(key)));
        assert_eq!(plugin.assess(&post(&["get it at bad.example/a.exe!"]), &world.ctx()).await.unwrap(), refused("moderation.malware_link"));
        assert_eq!(plugin.assess(&post(&["fine", "https://worse.example/b"]), &world.ctx()).await.unwrap(), refused("moderation.malware_link"));
        assert_eq!(plugin.assess(&post(&["https://good.example/b and bad.example/other"]), &world.ctx()).await.unwrap(), None);
        assert_eq!(plugin.assess(&post(&["no link at all"]), &world.ctx()).await.unwrap(), None);
        let comment = TrustPost { comment_on: Some("p1".into()), ..post(&["http://bad.example/a.exe"]) };
        assert_eq!(plugin.assess(&comment, &world.ctx()).await.unwrap(), refused("comment.malware_link"));
        let profile = TrustPost { profile: true, ..post(&["a bio", "http://bad.example/a.exe"]) };
        assert_eq!(plugin.assess(&profile, &world.ctx()).await.unwrap(), refused("user.profile_malware_link"));

        // Downloaded once, with the key in the address and in its header, and the log told.
        let requests = served.requests();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /list/the%20key%2F1/ "), "{}", requests[0]);
        assert!(requests[0].to_lowercase().contains("auth-key: the key/1"));
        let said = world.said();
        assert_eq!(said.len(), 1);
        assert_eq!((said[0].0, &said[0].2), (Level::Info, &json!({ "urls": 2, "hosts": 2 })));
    }

    #[tokio::test]
    async fn the_list_is_downloaded_again_when_it_is_due_and_kept_if_that_fails() {
        let served = Served::start(200, "http://bad.example/a.exe\n").await;
        let mut world = world(&served).await;
        let plugin = plugin();
        let start = (world.now)();
        assert!(plugin.assess(&post(&["bad.example/a.exe"]), &world.ctx()).await.unwrap().is_some());

        // Not due yet.
        world.now = fixed_clock(start + 5 * MINUTE - 1);
        assert_eq!(plugin.assess(&post(&["nothing"]), &world.ctx()).await.unwrap(), None);
        assert_eq!(served.requests().len(), 1);

        // Due: a post without a link starts the download, and waits for nothing.
        served.answer(200, "http://bad.example/a.exe\nhttp://new.example/n\n");
        world.now = fixed_clock(start + 5 * MINUTE);
        assert_eq!(plugin.assess(&post(&["nothing"]), &world.ctx()).await.unwrap(), None);
        settled(&served, 2).await;
        assert!(plugin.assess(&post(&["new.example/n"]), &world.ctx()).await.unwrap().is_some());

        // One that fails leaves the list there is, and is tried again a minute later.
        served.answer(403, "no");
        world.now = fixed_clock(start + 10 * MINUTE);
        world.said();
        assert!(plugin.assess(&post(&["new.example/n"]), &world.ctx()).await.unwrap().is_some());
        settled(&served, 3).await;
        let said = world.said();
        assert_eq!(said[0].0, Level::Error);
        assert_eq!(said[0].2["stale"], json!(true));
        assert!(said[0].2["err"]["message"].as_str().unwrap().contains("URLhaus answered 403: it refused the Auth-Key"), "{}", said[0].2);
        assert!(!said[0].2.to_string().contains("the key") && !said[0].2.to_string().contains("the%20key"));
        world.now = fixed_clock(start + 11 * MINUTE - 1);
        assert!(plugin.assess(&post(&["new.example/n"]), &world.ctx()).await.unwrap().is_some());
        assert_eq!(served.requests().len(), 3);
        world.now = fixed_clock(start + 11 * MINUTE);
        assert!(plugin.assess(&post(&["new.example/n"]), &world.ctx()).await.unwrap().is_some());
        settled(&served, 4).await;
    }

    #[tokio::test]
    async fn without_a_list_a_post_with_a_link_fails_and_what_only_may_be_one_is_let_through() {
        for (status, body, why) in [(500, "", "URLhaus answered 500"), (200, "<html>not the list</html>", "has no URL in it")] {
            let served = Served::start(status, body).await;
            let world = world(&served).await;
            let plugin = plugin();
            let err = plugin.assess(&post(&["see https://example.com/a"]), &world.ctx()).await.unwrap_err();
            assert!(err.to_string().contains("the urlhaus trust plugin has no list of malware URLs to check links with") && err.to_string().contains(why), "{err}");
            assert_eq!(plugin.assess(&post(&["report.final.pdf"]), &world.ctx()).await.unwrap(), None);
            assert_eq!(plugin.assess(&post(&["no link"]), &world.ctx()).await.unwrap(), None);
        }
    }
}
