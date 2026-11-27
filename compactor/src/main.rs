//! The compactor: the one process that applies the writes requests committed, and builds the
//! feed index from them.
//!
//! It is a process of its own, which is how a deployment runs it: one copy, always up. With
//! no flag it makes pass after pass until it is stopped, never two at once and never more
//! than one in COMPACT_INTERVAL_SECONDS. A second copy does no harm (the lease lets one of
//! them run at a time) and no good.
//!
//! `--all` first rebuilds every day of every tag, and works out every hashtag's related
//! hashtags again. `--rebuild` first rebuilds the whole feed index, the summaries, the
//! publisher credits and the related hashtags from the database and the meta files: run it
//! after Redis lost data. `--once` makes a single pass and ends, which is how to run either of
//! those by hand beside the process that is already up: a rebuild that finds that process
//! mid-pass waits for it, rather than being skipped as an ordinary pass is.
//!
//! Beside its passes, the process asks other servers after the posts this one holds reposts
//! of, indexes the comments that are older than users' indexes of them, and processes the
//! videos users send, unless the server processes none (VIDEO_PROCESSING): it needs ffmpeg for
//! that, and doesn't start without it (see `workers`). A pass that is run by hand (`--once`)
//! does none of that.
//!
//! `compactor reindex` makes every post and every user findable by search again (see
//! `reindex`), and ends.
//!
//! The schema is the API's to bring up to date (`npm run migrate`, or a process of the API as
//! it starts): this process waits until it is at the migration it was built with.

mod accounts;
mod activity;
mod apply;
mod author_index;
mod build;
mod compactor;
mod deps;
#[cfg(feature = "harness")]
mod harness;
mod lease;
mod origins;
mod reindex;
mod replies;
mod rows;
mod run;
mod sweep;
mod video;
mod workers;
mod write;

use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use evieverse_core::azure::TokenRelay;
use evieverse_core::config::{self, Config};
use evieverse_core::log::{self, Logger};
use evieverse_core::time::system_clock;
use serde_json::{Value, json};

use crate::compactor::Compactor;
use crate::deps::Deps;
use crate::lease::is_stopped;
use crate::run::{RunOptions, RunResult};
use crate::workers::Workers;

#[derive(Parser)]
#[command(name = "compactor", version, about = "The Evieverse compactor")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    /// Makes a single pass and ends.
    #[arg(long)]
    once: bool,
    /// First rebuilds every day of every tag, and works out every hashtag's related hashtags again.
    #[arg(long)]
    all: bool,
    /// First rebuilds the whole feed index, the summaries, the publisher credits and the
    /// related hashtags from the database and the meta files: after Redis lost data.
    #[arg(long)]
    rebuild: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Prints the configuration as this process resolved it, as JSON, and ends.
    Config {
        /// With the secrets it holds, which are left out otherwise: the addresses of the
        /// database and of Redis, the options of the stores, the keys.
        #[arg(long)]
        secrets: bool,
    },
    /// Brings what search reads up to what the server holds: the terms of every post, and the
    /// folded name of every user. Beside a server and a compactor that are up, or not.
    Reindex,
    /// Takes a test's commands on the standard input, in place of the passes of a compactor
    /// that is up: what the API's tests run. Only in a build made for them.
    #[cfg(feature = "harness")]
    Harness,
}

/// What stands in for a secret that is set, in a configuration printed without them.
const SET: &str = "<set>";

/// How long a pass that was asked for by hand waits before it tries again for the lease
/// another run holds.
const TURN_WAIT: Duration = Duration::from_secs(1);

/// The configuration as JSON, without the secrets it holds: each is said to be set, and no more.
fn without_secrets(config: &Config) -> Result<Value> {
    let mut shown = serde_json::to_value(config)?;
    let set = json!(SET);
    shown["db"]["url"] = set.clone();
    shown["redis"]["url"] = set.clone();
    for store in ["/storage/content/options", "/storage/summaries/options", "/quarantine/options"] {
        if let Some(options) = shown.pointer_mut(store).and_then(Value::as_object_mut) {
            options.values_mut().for_each(|value| *value = set.clone());
        }
    }
    if let Some(keys) = shown["reposts"]["signingKeys"].as_array_mut() {
        keys.iter_mut().for_each(|key| *key = set.clone());
    }
    for secret in ["/urlhaus/authKey", "/pdq/authorization", "/pdq/hashList", "/synthid/apiKey"] {
        if let Some(value) = shown.pointer_mut(secret) {
            *value = set.clone();
        }
    }
    Ok(shown)
}

/// Returns once the process is told to end: SIGINT or SIGTERM.
async fn told_to_end() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) {
            (Ok(mut interrupt), Ok(mut terminate)) => {
                tokio::select! {
                    _ = interrupt.recv() => {}
                    _ = terminate.recv() => {}
                }
            }
            // A process that can't be told is never told: it runs until it is killed.
            _ => std::future::pending().await,
        }
    }
    #[cfg(not(unix))]
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// One pass. What was asked for by hand isn't lost to a pass another compactor is making: it
/// takes the next turn.
async fn pass(compactor: &Compactor, opts: RunOptions) -> Result<RunResult> {
    let asked = opts.all || opts.rebuild;
    loop {
        let result = compactor.run_once(opts).await?;
        if !result.skipped || !asked {
            return Ok(result);
        }
        tokio::time::sleep(TURN_WAIT).await;
    }
}

/// The passes the command line asks for, until the process is told to end.
async fn compact(cli: &Cli, compactor: &Compactor) -> Result<()> {
    let log = &compactor.deps().log;
    let opts = RunOptions {
        all: cli.all,
        rebuild: cli.rebuild,
    };
    if cli.once {
        let result = pass(compactor, opts).await?;
        if !result.skipped {
            log.info(
                json!({ "tags": result.tags.len(), "deleted": result.deleted.len() }),
                "compaction pass complete",
            );
        }
        return Ok(());
    }
    if opts.all || opts.rebuild {
        let result = pass(compactor, opts).await?;
        log.info(
            json!({ "tags": result.tags.len() }),
            if opts.rebuild { "rebuilt the feed index" } else { "rebuilt every tag" },
        );
    }
    // Before the first pass of its own: a process that can't do what it is there for doesn't start.
    let workers = Workers::ready(compactor.deps()).await?;
    log.info(
        json!({ "intervalSeconds": compactor.deps().config.compact.interval_seconds }),
        "compactor started",
    );
    // Told to stop, the workers stop first, and the pass under way ends: each of them returns once that is done.
    let stopper = compactor.stopper();
    tokio::join!(compactor.run_until_stopped(), workers.run(&stopper));
    Ok(())
}

async fn run(cli: Cli, relay: Option<TokenRelay>) -> Result<()> {
    let config = config::load()?;
    if let Some(Command::Config { secrets }) = cli.command {
        let shown = if secrets { serde_json::to_value(&config)? } else { without_secrets(&config)? };
        println!("{}", serde_json::to_string_pretty(&shown)?);
        return Ok(());
    }
    let log = Logger::stdout(&config.log_level);
    if let Some(relay) = relay {
        let log = log.clone();
        tokio::spawn(async move {
            if let Err(err) = relay.serve().await {
                log.error(
                    json!({ "err": log::err(&err) }),
                    "the relay that gives the stores the tokens of the managed identity ended",
                );
            }
        });
    }
    let deps = Deps::open(config, system_clock(), log.clone()).await?;
    deps.db
        .wait_for_schema(|| log.info(json!({}), "waiting for the database's schema to be brought up to date"))
        .await;
    if matches!(cli.command, Some(Command::Reindex)) {
        let done = reindex::reindex(&deps, &|so_far| println!("{} posts read...", so_far.posts + so_far.pending)).await;
        deps.db.close().await;
        println!("{}", reindex::summary(done?));
        return Ok(());
    }
    let compactor = Compactor::new(deps);
    let stopper = compactor.stopper();
    tokio::spawn(async move {
        told_to_end().await;
        stopper.stop();
    });
    let outcome = match compact(&cli, &compactor).await {
        // Told to end during a pass: the pass stopped at its next step, and what it hadn't got to the next run does.
        Err(err) if is_stopped(&err) => {
            log.info(json!({}), "the compactor was stopped during a run, which the next run makes again");
            Ok(())
        }
        outcome => outcome,
    };
    compactor.deps().db.close().await;
    outcome
}

/// The relay this process gives its stores the tokens of a managed identity through, where it
/// has such an identity (see `TokenRelay`).
#[allow(unsafe_code)]
fn token_relay() -> Result<Option<TokenRelay>> {
    // SAFETY: called as the process starts, before it has a second thread: nothing else reads or writes its environment.
    unsafe { TokenRelay::bind() }
}

fn start(cli: Cli) -> Result<()> {
    let relay = if cli.command.is_none() { token_relay()? } else { None };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("the process could not start its runtime")?;
    #[cfg(feature = "harness")]
    if matches!(cli.command, Some(Command::Harness)) {
        let served = runtime.block_on(tokio::task::LocalSet::new().run_until(harness::serve()));
        // Whatever the test left under way ends here, with the process.
        runtime.shutdown_background();
        return served;
    }
    runtime.block_on(run(cli, relay))
}

fn main() -> ExitCode {
    match start(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err:#}");
            ExitCode::FAILURE
        }
    }
}
