//! Bringing users' indexes of comments up to what the store holds. The comment store keeps,
//! for each user, an index of the comments they wrote and of the ones they liked
//! (`CommentStore`), which the compactor writes with each comment and like. A server that had
//! comments before it kept that index has none for them: this is what writes theirs, once, in
//! the process that runs the compactor, beside its runs and outside its lease (see
//! `CommentStore::index_authors` for why that is safe).
//!
//! On a server with no comment older than the index, which is every new one, it finds nothing
//! to do, says in the store that the indexes hold everything, and is over. Until the store
//! says so, a user's export gives none of their comments (src/export.ts): it would lack the
//! old ones.

use std::time::Duration;

use anyhow::Result;
use evieverse_core::log;
use serde_json::json;

use crate::compactor::Stopper;
use crate::deps::Deps;

/// How long until the work is taken up again after it failed: the store couldn't be read or
/// written.
const RETRY: Duration = Duration::from_secs(60);

/// What the work says when it starts.
const STARTING: &str = "indexing the comments and likes that are older than users' indexes of them";

/// What it says when it is done.
const DONE: &str = "users' indexes of their comments and likes hold everything";

/// One go at that work: nothing, if the store says it is done. Ends early once `stopper` is
/// told to stop, at the post whose comments are being indexed, and the work goes on from
/// there the next time a process takes it up.
pub async fn index_authors(deps: &Deps, stopper: &Stopper) -> Result<()> {
    let Deps { comments, log, .. } = deps;
    if comments.indexed().await? {
        return Ok(());
    }
    log.info(json!({}), STARTING);
    if comments.index_authors(&|| stopper.is_stopped()).await? {
        log.info(json!({}), DONE);
    }
    Ok(())
}

/// Does that work, unless the store says it is done, and returns once it is done or stopped.
/// A failure is logged, and the work taken up again a minute later.
pub async fn run(deps: &Deps, stopper: &Stopper) {
    while !stopper.is_stopped() {
        match index_authors(deps, stopper).await {
            Ok(()) => return,
            Err(err) => deps.log.error(
                json!({ "err": log::err(&err) }),
                "could not index users' comments and likes; trying again in a minute",
            ),
        }
        tokio::select! {
            () = stopper.stopped() => {}
            () = tokio::time::sleep(RETRY) => {}
        }
    }
}
