//! What runs beside the compactor's passes, in its process, as this is the one process that
//! is always up:
//!
//! - what asks other servers after the posts this one holds reposts of (`crate::sweep`), so
//!   the process has to reach them over https: without that, a repost learns what its
//!   original became only from an attestation a client brings;
//! - what indexes, by who wrote or liked them, the comments that are older than that index
//!   (`crate::author_index`);
//! - what makes the videos users send into videos that play, where the server processes them
//!   (`crate::video`): the process needs ffmpeg for that, and doesn't start without it.
//!
//! None of them holds the compactor's lease: what they change they commit as a request does,
//! and the compactor applies. A pass that is run by hand (`--once`) runs none of them.

use std::sync::Arc;

use anyhow::Result;
use evieverse_core::config::Config;
use evieverse_trust::plugins::pdq;
use evieverse_trust::plugins::pdq::list::KnownHashes;
use evieverse_trust::trust::{Plugins, load_trust_plugins};

use crate::author_index;
use crate::compactor::Stopper;
use crate::deps::Deps;
use crate::sweep::OriginSweep;
use crate::video::worker::VideoWorker;

/// The trust plugins of this process, which score what an original on another server has
/// become, and the list of hashes the pdq plugin among them checks images against, which the
/// video worker checks videos against: the process holds it once.
pub struct Trust {
    pub plugins: Plugins,
    pub hashes: Arc<KnownHashes>,
}

impl Trust {
    /// The plugins the settings turn on (see `load_trust_plugins`). Fails where they name one
    /// this program was built without, so that a server never runs without an algorithm it
    /// was meant to have.
    pub fn load(config: &Config) -> Result<Self> {
        let hashes = Arc::new(KnownHashes::default());
        let plugins = load_trust_plugins(&config.trust.optional_plugins)?.replace("pdq", pdq::sharing(hashes.clone()));
        Ok(Self { plugins, hashes })
    }

    /// No plugin at all: for a test that describes its own.
    #[cfg(feature = "harness")]
    pub fn none() -> Self {
        Self {
            plugins: Plugins::of(vec![]),
            hashes: Arc::new(KnownHashes::default()),
        }
    }
}

/// What runs beside the passes (see the top of this file).
pub struct Workers {
    deps: Deps,
    sweep: OriginSweep,
    /// None on a server that processes no videos.
    video: Option<VideoWorker>,
}

impl Workers {
    /// Readies them, and starts nothing. Fails in a process that is to process videos and has
    /// no ffmpeg (see `VideoWorker::check`): whoever starts the process sees why it didn't.
    pub async fn ready(deps: &Deps) -> Result<Self> {
        let trust = Trust::load(&deps.config)?;
        let video = if deps.config.video.processing {
            let worker = VideoWorker::new(deps.clone(), trust.hashes.clone());
            worker.check().await?;
            Some(worker)
        } else {
            None
        };
        Ok(Self {
            sweep: OriginSweep::new(deps.clone(), Arc::new(trust.plugins), None, None, None)?,
            video,
            deps: deps.clone(),
        })
    }

    /// Runs them until `stopper` is told to stop, and returns once each has stopped: the look
    /// of the sweep that was under way, the post whose comments were being indexed, and the
    /// video that was being processed, which is given back for the next worker.
    pub async fn run(&self, stopper: &Stopper) {
        let video = async {
            if let Some(worker) = &self.video {
                worker.run(stopper).await;
            }
        };
        tokio::join!(self.sweep.run(stopper), author_index::run(&self.deps, stopper), video);
    }
}
