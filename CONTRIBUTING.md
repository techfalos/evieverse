# Contributing to Evieverse

Pull requests are welcome: fixes, features, trust plugins, languages and documentation. For anything large, open an issue first, so the design is agreed before the code is written.

A security problem isn't reported in an issue or a pull request: see [SECURITY.md](SECURITY.md).

## Setting up

You need:

- Node 22 or newer (`.nvmrc` names the version CI uses).
- Rust, from [rustup](https://rustup.rs). The compactor and the trust plugins are Rust, all of it under `compactor/`, and `compactor/rust-toolchain.toml` pins the version, which rustup installs by itself the first time cargo runs there.
- A Redis or Valkey, which every server needs and every test uses. `docker compose up -d redis` starts one at `redis://127.0.0.1:6379`.
- ffmpeg, for the compactor to process videos with, or `VIDEO_PROCESSING=false` for the API and the compactor alike.

A server is two programs, the API and the compactor, which publishes what the API takes:

```bash
npm install
npm run build:native                                           # the compactor, and the addon the API loads: a few minutes the first time
docker compose up -d redis
REDIS_URL=redis://127.0.0.1:6379 npm run dev                   # the API: SQLite in ./data, content in ./data/content
REDIS_URL=redis://127.0.0.1:6379 npx tsx src/compactor.ts      # the compactor, in a second terminal
```

- `npm run dev` restarts the API when a file of `src` changes. Nothing rebuilds the Rust: after a change under `compactor/`, run `npm run build:native` again (or `cargo build -p compactor -p evieverse-node` in `compactor/`, which is quicker and makes a slower program), and restart both.
- Run cargo from `compactor/`. Nothing of the Rust is in the repository's root.
- Without a compactor running, the API takes posts and none is published.

The [README](README.md#getting-started) has the other ways to run it, and [docs/APP.md](docs/APP.md) says how the server works inside, with a map of the code.

## Before you open a pull request

CI runs these on every push and pull request, so run them first:

```bash
npm run typecheck
npm run check          # the conventions of src that the compiler doesn't check
npm test               # SQLite, with the feed index in the Redis at TEST_REDIS_URL (redis://127.0.0.1:6379 unless it's set)
npm run build
```

`npm test` runs against the real compactor. It builds the compactor and the addon first, with what the tests drive them by, which takes a few minutes the first time and little after that. It needs the Redis above: `docker compose up -d redis`.

And these as well, for a change under `compactor/`:

```bash
cd compactor
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --features compactor/harness,evieverse-node/test-plugin -- -D warnings
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace --features compactor/harness,evieverse-node/test-plugin
```

The Rust tests reach the Redis at `redis://127.0.0.1:6379`, and no other. `cargo test -p evieverse-trust` runs one crate's.

Three more, depending on what you changed:

- A change to the database, or to what's kept in Redis: run the tests against the real backends too.

  ```bash
  docker compose up -d postgres mysql redis
  TEST_POSTGRES_URL=postgres://evieverse:evieverse@localhost:5432/evieverse \
  TEST_MYSQL_URL=mysql://evieverse:evieverse@localhost:3306/evieverse \
  TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
  ```

- A change to a format that both the API and the compactor read or write, such as a meta file, a summary or a key in Redis: the tests of both read the same examples of them, in `fixtures/`. Write them again, and commit what changed.

  ```bash
  UPDATE_FIXTURES=1 npx vitest run test/fixtures.test.ts
  (cd compactor && UPDATE_FIXTURES=1 cargo test -p evieverse-core --test fixtures)
  ```

- A change to what an API request does: run the benchmark (`npm run bench`, which needs Docker and takes several minutes, and longer the first time, when it builds the image) and commit the `BENCHMARKS.md` it writes. A pull request that touches API operations without it is rejected.

On a slow or busy machine a few of the longer tests can pass their 20-second limit when the whole suite runs at once. `npm test -- --no-file-parallelism` runs the files one at a time.

## Conventions

`npm run check` holds `src` to the first three:

- A module's exported interfaces are in a file of their own beside it, named after it: those of `src/feed/cursor.ts` are in `src/feed/cursor.types.ts`. Such a file holds types alone.
- Every module-level constant, exported function and interface has a JSDoc comment right on top of it, which says what it's for.
- A module's constants are at the top of the file, above its first function or class.
- Text a user reads goes through the languages. A message is a key in `languages/en.json`, read with `msg('key')`, never a string in the code ([docs/LANGUAGES.md](docs/LANGUAGES.md)).
- A migration is portable SQL, a new numbered file in `src/db/migrations` that runs on SQLite, Postgres and MySQL alike, with its tables and columns mirrored in `src/db/schema.ts`. A migration that has been released isn't edited.
- A change comes with its tests, in `test/`, beside the ones of what it changes.
- A new setting is added to `src/config.ts`, to `.env.example` and to [docs/CONFIG.md](docs/CONFIG.md), with its default. One the compactor or a trust plugin reads is added to `compactor/crates/core/src/config.rs` too, with the same name, file key and default: `test/config.test.ts` checks that the two agree.
- The Rust is formatted by `cargo fmt` and passes `cargo clippy` with no warning. It has no `unsafe` code: the workspace denies it (`compactor/Cargo.toml`).
- What the compactor writes, the API reads, and the other way round. A format both use changes on both sides in the same pull request, with its `fixtures/`.
- A secret (a key, a password, a store's options, a database or Redis address) is never put in an error message or a log line.

## Documentation

The documentation is part of the change. What a client or an operator sees goes in the document for them, and how it works inside goes in `docs/APP.md`:

| A change to | Update |
| --- | --- |
| An endpoint: what it takes, returns or refuses | [docs/API.md](docs/API.md) |
| A setting | [docs/CONFIG.md](docs/CONFIG.md) and `.env.example` |
| The Terraform modules, or what a deployment needs | [docs/IAC.md](docs/IAC.md) |
| The Docker images or the compose files | [docs/DOCKER.md](docs/DOCKER.md) |
| What a trust plugin is given, or how one is built | [docs/TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md) |
| The CLI | [docs/CLI.md](docs/CLI.md) |
| How the server works inside | [docs/APP.md](docs/APP.md) |

Write it plainly, and say what was measured or tried and what wasn't.

## Trust plugins and languages

Both can be added without touching the rest of the server: a trust plugin is a folder under `compactor/crates/trust/src/plugins`, written in Rust, with its tests beside it ([docs/TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md)), and a language is a file in `languages/` ([docs/LANGUAGES.md](docs/LANGUAGES.md)).

## License

Evieverse is licensed under the GNU Affero General Public License, version 3 ([LICENSE](LICENSE)), with the additional terms in [LICENSE.md](LICENSE.md). By opening a pull request you agree that your contribution is licensed under the same terms, and you say that it's yours to contribute.
