//! What makes the videos users send into videos that play: the video worker (see `worker`),
//! the programs it works with (`ffmpeg`) and its queue (`jobs`).

pub mod ffmpeg;
pub mod jobs;
pub mod worker;

use tokio::sync::watch;

/// What stops a job whose write is gone: nothing of it is anybody's any more.
#[derive(Debug, thiserror::Error)]
#[error("the write the video came with is gone")]
pub struct Dropped;

/// What stops the work on a video while the process shuts down: the job is the next worker's.
#[derive(Debug, thiserror::Error)]
#[error("the process is shutting down")]
pub struct Stopped;

/// Why the work on a video is stopped before it is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// It took longer than `video.timeoutSeconds`, which is this many.
    Timeout(i64),
    /// The job is no longer there: its post was deleted.
    Gone,
    /// The process is shutting down.
    Stopped,
}

impl Why {
    /// The failure the work ends with.
    pub fn error(self) -> anyhow::Error {
        match self {
            Self::Timeout(seconds) => ffmpeg::VideoError(format!("the video took longer than {seconds} seconds to process")).into(),
            Self::Gone => Dropped.into(),
            Self::Stopped => Stopped.into(),
        }
    }
}

/// What tells the work on one video to stop: the programs it runs are killed, and it fails
/// with what stopped it (see `Why::error`).
#[derive(Clone)]
pub struct Halt {
    told: watch::Receiver<Option<Why>>,
}

/// What stops the work a `Halt` was made for. The first reason it is given stands.
pub struct Halter {
    tell: watch::Sender<Option<Why>>,
}

impl Halter {
    pub fn halt(&self, why: Why) {
        self.tell.send_if_modified(|told| {
            let first = told.is_none();
            if first {
                *told = Some(why);
            }
            first
        });
    }
}

impl Halt {
    /// A halt, and what tells it.
    pub fn new() -> (Halter, Self) {
        let (tell, told) = watch::channel(None);
        (Halter { tell }, Self { told })
    }

    /// One that nothing ever tells: for what runs to its end.
    pub fn never() -> Self {
        // The sender is dropped: what was told stays None, and `halted` waits for good.
        Self::new().1
    }

    /// Why the work was stopped, if it was.
    pub fn why(&self) -> Option<Why> {
        *self.told.borrow()
    }

    /// Fails if the work was stopped, with what stopped it.
    pub fn check(&self) -> anyhow::Result<()> {
        self.why().map_or(Ok(()), |why| Err(why.error()))
    }

    /// Returns once the work is stopped, with why. Never, if it never is.
    pub async fn halted(&self) -> Why {
        let mut told = self.told.clone();
        loop {
            if let Some(why) = *told.borrow_and_update() {
                return why;
            }
            if told.changed().await.is_err() {
                return std::future::pending().await;
            }
        }
    }
}
