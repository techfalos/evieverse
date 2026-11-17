# Contributing to Evieverse

Pull requests are welcome: fixes, features, trust plugins, languages and documentation. For anything large, open an issue first, so the design is agreed before the code is written.

A security problem isn't reported in an issue or a pull request: see [SECURITY.md](SECURITY.md).

## Setting up

You need Node 22 or newer (`.nvmrc` names the version CI uses).

```bash
npm install
npm run dev            # SQLite in ./data, content in ./data/content, the index in memory
```

The [README](README.md#running-an-instance-locally) has the other ways to run it, and [docs/APP.md](docs/APP.md) says how the server works inside, with a map of the code.

## Before you open a pull request

CI runs these four on every push and pull request, so run them first:

```bash
npm run typecheck
npm run check          # the conventions of src that the compiler doesn't check
npm test               # SQLite with the in-process store
npm run build
```

Two more, depending on what you changed:

- **A change to the database, or to what's kept in Redis:** run the tests against the real backends too.

  ```bash
  docker compose up -d postgres mysql redis
  TEST_POSTGRES_URL=postgres://evieverse:evieverse@localhost:5432/evieverse \
  TEST_MYSQL_URL=mysql://evieverse:evieverse@localhost:3306/evieverse \
  TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
  ```

- **A change to what an API request does:** run the benchmark (`npm run bench`, which needs Docker and takes about 5 minutes) and commit the `BENCHMARKS.md` it writes. A pull request that touches API operations without it is rejected.

On a slow or busy machine a few of the longer tests can pass their 20-second limit when the whole suite runs at once. `npm test -- --no-file-parallelism` runs the files one at a time.

## Conventions

`npm run check` holds `src` to the first three:

- **A module's exported interfaces are in a file of their own beside it,** named after it: those of `src/feed/cursor.ts` are in `src/feed/cursor.types.ts`. Such a file holds types alone.
- **Every module-level constant, exported function and interface has a JSDoc comment** right on top of it, which says what it's for.
- **A module's constants are at the top of the file,** above its first function or class.
- **Text a user reads goes through the languages.** A message is a key in `languages/en.json`, read with `msg('key')`, never a string in the code ([docs/LANGUAGES.md](docs/LANGUAGES.md)).
- **A migration is portable SQL,** a new numbered file in `src/db/migrations` that runs on SQLite, Postgres and MySQL alike, with its tables and columns mirrored in `src/db/schema.ts`. A migration that has been released isn't edited.
- **A change comes with its tests,** in `test/`, beside the ones of what it changes.
- **A new setting** is added to `src/config.ts`, to `.env.example` and to [docs/CONFIG.md](docs/CONFIG.md), with its default.

## Documentation

The documentation is part of the change. What a client or an operator sees goes in the document for them, and how it works inside goes in `docs/APP.md`:

| A change to | Update |
| --- | --- |
| An endpoint: what it takes, returns or refuses | [docs/API.md](docs/API.md) |
| A setting | [docs/CONFIG.md](docs/CONFIG.md) and `.env.example` |
| The Terraform modules, or what a deployment needs | [docs/DEPLOY.md](docs/DEPLOY.md) |
| The CLI | [docs/CLI.md](docs/CLI.md) |
| How the server works inside | [docs/APP.md](docs/APP.md) |

Write it plainly, and say what was measured or tried and what wasn't.

## Trust plugins and languages

Both can be added without touching the rest of the server: a trust plugin is a folder under `src/plugins/trust` ([docs/TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md)), and a language is a file in `languages/` ([docs/LANGUAGES.md](docs/LANGUAGES.md)).

## License

Evieverse is licensed under the GNU Affero General Public License, version 3 ([LICENSE](LICENSE)), with the additional terms in [LICENSE.md](LICENSE.md). By opening a pull request you agree that your contribution is licensed under the same terms, and you say that it's yours to contribute.
