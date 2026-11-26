//! What lets a test see, hold up and fail the calls a process makes to its stores: the
//! compactor's harness gives the stores one (see the `harness` command of the binary), and a
//! process that serves has none, which costs it a look at an empty option for each call.

use std::sync::Arc;

use anyhow::Result;
use futures::future::BoxFuture;
use serde_json::Value;

/// What a probe says of a call it was shown before the call is made.
#[derive(Debug, Clone, Default)]
pub struct Watched {
    /// Whether it is to be shown the call again once it is made.
    pub after: bool,
    /// For a call that says of each of several things whether it is there: which of them it
    /// is to say so of, the others being said to be gone.
    pub mask: Option<Vec<bool>>,
}

/// What is shown the calls made to the stores.
pub trait Probe: Send + Sync {
    /// Whether it is shown the calls of this name at all.
    fn watches(&self, op: &str) -> bool;
    /// Shown a call before it is made, which waits for the answer. A failure is the call's:
    /// it is not made.
    fn before<'a>(&'a self, op: &'static str, args: Value) -> BoxFuture<'a, Result<Watched>>;
    /// Shown a call once it is made, which returns once this has. A failure is the call's,
    /// though it was made.
    fn after<'a>(&'a self, op: &'static str, args: Value) -> BoxFuture<'a, Result<()>>;
}

/// The probe a store is given, or none.
#[derive(Clone, Default)]
pub struct Probes(Option<Arc<dyn Probe>>);

impl Probes {
    pub fn new(probe: Arc<dyn Probe>) -> Self {
        Self(Some(probe))
    }

    /// The probe, if there is one and it is shown the calls of this name.
    fn watching(&self, op: &str) -> Option<&Arc<dyn Probe>> {
        self.0.as_ref().filter(|probe| probe.watches(op))
    }

    /// Makes a call, shown to the probe first, and after if it asks. `args` is what the probe
    /// is told of the call.
    pub async fn call<T, Fut>(&self, op: &'static str, args: impl Fn() -> Value, run: Fut) -> Result<T>
    where
        Fut: Future<Output = Result<T>>,
    {
        let Some(probe) = self.watching(op) else { return run.await };
        let watched = probe.before(op, args()).await?;
        let out = run.await?;
        if watched.after {
            probe.after(op, args()).await?;
        }
        Ok(out)
    }

    /// Makes a call that says of each of several things whether it is there, as `call` does:
    /// the probe may have some of them said to be gone (see `Watched::mask`).
    pub async fn call_masked<Fut>(&self, op: &'static str, args: impl Fn() -> Value, run: Fut) -> Result<Vec<bool>>
    where
        Fut: Future<Output = Result<Vec<bool>>>,
    {
        let Some(probe) = self.watching(op) else { return run.await };
        let watched = probe.before(op, args()).await?;
        let mut out = run.await?;
        if let Some(mask) = &watched.mask {
            for (there, kept) in out.iter_mut().zip(mask) {
                *there = *there && *kept;
            }
        }
        if watched.after {
            probe.after(op, args()).await?;
        }
        Ok(out)
    }
}
