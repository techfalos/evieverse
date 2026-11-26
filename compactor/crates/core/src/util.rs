//! Running many things at once, a few at a time, with nothing left running behind.

use std::cell::{Cell, RefCell};

use anyhow::Result;
use futures::StreamExt;
use futures::future::join_all;
use futures::stream;

/// Runs `run` over `items` with at most `limit` running at once. If one fails, no more are
/// started, the ones under way are waited for, and the first failure is returned. So nothing
/// of it is still running once it has returned: a caller that gives something up then (the
/// compactor its lease) gives it up with no write of its own under way.
pub async fn map_limit<T, F, Fut>(items: impl IntoIterator<Item = T>, limit: usize, run: F) -> Result<()>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let failure: RefCell<Option<anyhow::Error>> = RefCell::new(None);
    let failed = Cell::new(false);
    stream::iter(items)
        .for_each_concurrent(limit.max(1), |item| {
            let (run, failure, failed) = (&run, &failure, &failed);
            async move {
                if failed.get() {
                    return;
                }
                if let Err(err) = run(item).await
                    && !failed.replace(true)
                {
                    *failure.borrow_mut() = Some(err);
                }
            }
        })
        .await;
    failure.into_inner().map_or(Ok(()), Err)
}

/// Waits for every one of `tasks`, whatever becomes of each, and then returns the first
/// failure among them, in the order they are given, if there is one. So, as with `map_limit`,
/// none is still running once it has returned.
pub async fn all_done<Fut>(tasks: impl IntoIterator<Item = Fut>) -> Result<()>
where
    Fut: Future<Output = Result<()>>,
{
    join_all(tasks).await.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn starts_nothing_more_after_a_failure_and_waits_for_what_is_under_way() {
        let started = Cell::new(0);
        let finished = Cell::new(0);
        let outcome = map_limit(0..10, 2, |n| {
            let (started, finished) = (&started, &finished);
            async move {
                started.set(started.get() + 1);
                tokio::task::yield_now().await;
                finished.set(finished.get() + 1);
                if n == 1 { Err(anyhow::anyhow!("item {n}")) } else { Ok(()) }
            }
        })
        .await;
        assert_eq!(outcome.unwrap_err().to_string(), "item 1");
        assert_eq!(started.get(), finished.get());
        assert!(started.get() < 10);
    }

    #[tokio::test]
    async fn waits_for_every_task_and_gives_the_first_failure() {
        let done = Cell::new(0);
        let task = |fails: bool| {
            let done = &done;
            async move {
                tokio::task::yield_now().await;
                done.set(done.get() + 1);
                if fails { Err(anyhow::anyhow!("failed {}", done.get())) } else { Ok(()) }
            }
        };
        let outcome = all_done([task(false), task(true), task(true)]).await;
        assert_eq!(done.get(), 3);
        assert_eq!(outcome.unwrap_err().to_string(), "failed 2");
    }
}
