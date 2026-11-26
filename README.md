# Evieverse: An Open Source Social Media Framework

## Mission

Provide an open source alternative to traditional social media that allows for:

1. Transparent content delivery while delivering engaging content.
2. AI usage disclosure for content and the ability to filter-out content with declared AI usage.
3. Ability to use many different clients on the same server, including a client you build yourself.
4. Optional privacy for user follows and followers.
5. Monetization options.
6. Built-in robot detection and rate limiting.
7. Plugin-based content trust analysis for auto-moderation.
8. Support for multiple languages (English is default).
9. Deployment through Docker or IaC (Terraform) for a low-cost or high-scale solution.

Evieverse API is written in Node.js, and the compactor that processes posts and comments is written in Rust. 

## Resources
This repository contains Evieverse Server, which is clientless outside of an admin CLI. To use an Evieverse client, go to:
https://www.evieverse.com

To see the features of Evieverse, go to:
https://www.evieverse.org/features

To find Evieverse servers or register an Evieverse server in the registry, go to:
https://www.evieverse.org/registry

## Table of Contents

| To                                                           | Read                                           |
| ------------------------------------------------------------ | ---------------------------------------------- |
| Run an instance in Docker or in the cloud                    | [Getting started](#getting-started)            |
| Configure Evieverse running in Docker                        | [docs/DOCKER.md](docs/DOCKER.md)               |
| Configure Evieverse in AWS, Google Cloud or Azure            | [docs/IAC.md](docs/IAC.md)                     |
| Configuration options                                        | [docs/CONFIG.md](docs/CONFIG.md)               |
| Administer or moderate an instance                           | [docs/CLI.md](docs/CLI.md)                     |
| Build a client                                               | [docs/API.md](docs/API.md)                     |
| Write or show formatted posts and comments                   | [docs/TEXT_EDITORS.md](docs/TEXT_EDITORS.md)   |
| Add a language to the server                                 | [docs/LANGUAGES.md](docs/LANGUAGES.md)         |
| Write a trust plugin                                         | [docs/TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md) |
| Understand how it works                                      | [docs/APP.md](docs/APP.md)                     |

## Getting started

### 1. Start an instance

**Docker.** From a clone of this repository:

```sh
mkdir -p ~/.evieverse/profiles
docker compose -f docker-compose.server.yml cp app:/app/data/admin-profile.json ~/.evieverse/profiles/evieverse.json
```

The instance is at `http://localhost:3000`. For more info, see [Docker Configuration](docs/DOCKER.md).

**Terraform.** With your cloud's CLI signed in:

```sh
cd deploy/terraform/aws        # or gcp, or azure
terraform init
terraform apply                # gcp: add -var project_id=<project>    azure: add -var subscription_id=<subscription>
```

The apply prints the instance's HTTPS address as `url`. For more info, see [IAC.md](docs/IAC.md).

### 2. Installing the CLI

The CLI `evieverse` code lives on the instance and is updated as the instance is updated. Requires Node.js 20 or greater:

```sh
URL=__evieverse_domain__                    # Terraform: URL="$(terraform output -raw url)"
curl -fsSL "$URL/cli/install.sh" | sh       # Windows, in PowerShell: irm <url>/cli/install.ps1 | iex
                                            # The script says how to add evieverse to your PATH if it isn't there.
evieverse whoami                            # admin (10e57144-…) on http://localhost:3000: an admin
evieverse help                              # Lists what the CLI can do. Its reference is docs/CLI.md.
```

The default user is `admin`

### 3. Create another user

To register another account:

```sh
evieverse register <username>  #e.g. evelynn
```

Registering requires solving a challenge unless it's an admin account registering the user. 

```
Registered evelynn (56243052-…).
Their API key, shown this once: ev_cba15064d3f1_…
```

To make the new account an admin:

```sh
evieverse admins grant <userId>                         # as the deployment's admin
evieverse --profile evelynn login "$URL" <userId>         # asks for the API key, and saves it as the profile "alice"
evieverse --profile evelynn whoami
```

The machine now has two profiles: `--profile evelynn` for your new admin account, and `--profile evieverse` for the deployment's admin.

## Configuration

See [CONFIG.md](docs/CONFIG.md)

## Tests

Commands to run tests:

```bash
npm test     # unit tests, migration tests, API and feed-index tests on SQLite with the in-process store
docker compose up -d postgres mysql redis
TEST_POSTGRES_URL=postgres://evieverse:evieverse@localhost:5432/evieverse \
TEST_MYSQL_URL=mysql://evieverse:evieverse@localhost:3306/evieverse \
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
npm run check    # the conventions of src that the compiler doesn't check: where interfaces are, JSDoc comments, constants at the top
```

Optionally add `--no-file-parallelism` to run the tests one at a time.

The Rust code (the compactor, the trust plugins and the addon the API loads, all under `compactor/`) has tests of its own. They need Rust, which [rustup](https://rustup.rs) installs at the version `compactor/rust-toolchain.toml` pins, and a Redis or Valkey at `redis://127.0.0.1:6379`, which `docker compose up -d redis` starts:

```bash
cd compactor
cargo test --locked --workspace --features compactor/harness,evieverse-node/test-plugin    # every Rust test, as CI runs them
cargo test -p evieverse-trust                                                              # one crate's: evieverse-core, evieverse-trust, evieverse-node or compactor
cargo test -p evieverse-trust blocked_words                                                # the tests whose names have a word in them
```

## Benchmarks

Running the benchmarks:

```bash
npm run bench     # load-tests the API in Docker and writes BENCHMARKS.md again, in about 5 minutes
# The settings a run can be given, at their defaults:
BENCH_SERVER_CPUS=2 BENCH_SERVER_MEMORY=2g BENCH_DURATION_SECONDS=10 BENCH_CONNECTIONS=50 BENCH_POSTS=2000 npm run bench
```

Please run the benchmarking script before submitting PRs that could affect performance. If your PR does not show this file changed, it will be rejected. 

## AI-Usage Disclosure

AI tools, including Generative AI tools, were used in the planning, development, and analysis of Evieverse. Use of these tools has become standard practice in the software development world. I, a software engineer with over 20 years of professional experience, would not have been able to create Evieverse in any reasonable timeframe without them. Particular care was taken to "desloppify" AI output and perfect the product's codebase. If you find, and wish to remove, slop from this application, then open a PR. 

## License

See [[LICENSE.md](LICENSE.md)]

## Code Owners

Evelynn McDermott [contact@techfalos.com](mailto:contact@techfalos.com)