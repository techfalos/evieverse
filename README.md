# Evieverse: An Open Source Cloud-Based Social Media Framework

## Mission

Provide an open source alternative to traditional social media that allows for:

1. Transparent content delivery while delivering engaging content.
2. AI usage disclosure for content and the ability to filter-out content with declared AI usage.
3. Ability to use many different clients on the same server, including a client you build yourself.
4. Optional privacy for user follows and followers.
5. Monetization options.
6. Built-in robot detection and rate limiting.
7. Plugin-based content trust analysis for auto-moderation.
8. Support for multiple languages (English is default)
9. Pay-as-you-go architecture that scales effortlessly.
10. Easy infrastructure-as-code cloud deployment, setup, database migrations, and updates.

Evieverse is designed with the idea that clients will enable users to connect to multiple different Evieverse instances. Content is not federated from server-to-server, but from client to servers they have subscribed to.


| To                                               | Read                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| Deploy an instance to AWS, Google Cloud or Azure | [docs/DEPLOY.md](docs/DEPLOY.md)               |
| Configure an instance, and deploy a change       | [docs/CONFIG.md](docs/CONFIG.md)               |
| Administer or moderate an instance               | [docs/CLI.md](docs/CLI.md)                     |
| Build a client, or call the API                  | [docs/API.md](docs/API.md)                     |
| Write or show formatted posts and comments       | [docs/TEXT_EDITORS.md](docs/TEXT_EDITORS.md)   |
| Add a language the server answers in             | [docs/LANGUAGES.md](docs/LANGUAGES.md)         |
| Write a trust plugin, to score posts             | [docs/TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md) |
| Understand how it works inside                   | [docs/APP.md](docs/APP.md)                     |




## Getting started

You need Terraform 1.5 or newer, your cloud's CLI signed in, Docker (for AWS and Google Cloud), and Node.js 20 or newer for the Evieverse CLI.

### 1. Deploy (or see [Running a Local Instance](#running-an-instance-locally))

```sh
cd deploy/terraform/aws        # or gcp, or azure
terraform init
terraform apply                # gcp: add -var project_id=<project>    azure: add -var subscription_id=<subscription>
```

The apply builds the server, provisions everything it runs on, and prints the instance's HTTPS address as `url`. It also creates the instance's first admin account, and saves that account's API key on your machine, where the CLI reads it. [DEPLOY.md](docs/DEPLOY.md) covers the variables, what each cloud provisions and what it costs.

### 2. Install the CLI

Every instance ships its own CLI, `evieverse`:

```sh
URL="$(terraform output -raw url)"
curl -fsSL "$URL/cli/install.sh" | sh       # Windows, in PowerShell: irm <url>/cli/install.ps1 | iex
evieverse whoami
```

```
admin (10e57144-…) on https://d1234abcd.cloudfront.net: an admin
```

The script says how to add `evieverse` to your `PATH` if it isn't there. `evieverse help` lists what it can do, such as appointing moderators, blocking words and working through the moderation queues, and [CLI.md](docs/CLI.md) is its reference.

### 3. Create another user

To keep bots out, registering requires solving a challenge, but not when an admin registers the user. So to register your account as the deployment's admin you can do:

```sh
evieverse register <username>  #e.g. evelynn
```

```
Registered evelynn (56243052-…).
Their API key, shown this once: tu_cba15064d3f1_…
```

To make the new account an admin:

```sh
evieverse admins grant <userId>                         # as the deployment's admin
evieverse --profile alice login "$URL" <userId>         # asks for the API key, and saves it as the profile "alice"
evieverse --profile alice whoami
```

The machine now has two profiles, so each command names the one it's for: `--profile alice` for your account, and `--profile evieverse` for the deployment's admin.

## Evieverse clients

Apart from its admin CLI, an instance has no client of its own. It's designed for clients, such as single-page apps, that each work with several instances at once. A client should:

1. **Allow the user to register on several instances,** and give them one interface to all of them.
2. **Keep one set of credentials** that unlocks the user's API key for each instance, so the client is the layer between the user and the instances they've registered on.
3. **Let the user set the parameters of each request,** such as a feed's tags, window and algorithm, so the experience is theirs.
4. **Syndicate a post to several instances** by posting it to each one. Instances don't pass posts on to each other, so a user's key for one instance never goes to another.

## Bring your own client

Every instance serves the same API, so anyone can register on an instance directly, keep their own key, and use whatever client they like, including one they wrote. [API.md](docs/API.md) is the contract: every endpoint, what it takes and what it returns.

## User registration and API keys

When a user registers using the register endpoint(`POST /register`), unless pre-existing admin credentials are supplied (the CLI does this automatically), the instance responds with a challenge. Once the challenge is solved, the instance returns the user's id and an API key. The key is shown once, and an instance has no way to show it again, so it's the client's job to keep it safe. A user who still has their key can replace it (`POST /users/:userId/key`, or `evieverse key rotate`): the old key stops working at once and a new one comes back, which is what to do when a key may have leaked. The details are in [API.md](docs/API.md#post-usersuseridkey).

## Content organization and moderation

As on most social media, content is organized by tags (hashtags). An instance is deployed in one of two tagging modes:

- **User-supplied tags** (the default): a post carries the tags its publisher gives it, up to 10.
- **Server-enforced tags:** the instance's operator sets the tags a post is allowed to have, and a publisher gives each post up to 10 of them. A post with any other tag is rejected. Clients get the list of allowed tags from the instance (`GET /tagging`), so they can offer them to choose from.

In both modes, a post with no valid tags is rejected.

**Auto-moderation.** Every new post and update gets a trust score when it arrives. Depending on the score, the post is published, held in the moderation queue until someone accepts or rejects it, or rejected outright. Out of the box, the score comes from the instance's list of blocked words. A post containing a blocked word is assigned a trust score of zero. Additional [trust plugins](docs/TRUST_PLUGINS.md) may be used to modified the trust score further. 

**Moderators** 

- **Admins** can delete any post, comment or account, ban users, accept or reject held posts and comments, keep the instance's blocked words, and appoint the other two roles.
- **Server moderators** accept or reject the posts and comments held in the moderation queue, accept or delete the posts and comments users reported, and ban users.
- **Tag moderators** look after one or more tags. Under their tag, they can remove a tag from a post and mute a user, whose later posts then don't get the tag. They have no say over comments.

**Bans.** A server moderator or an admin can ban a user (`evieverse bans add <userId>`). A banned user can't post, comment or send messages, but can still read, receive messages, and delete their own posts and account. The user is told, with a notice, and again when the ban ends. Admins and server moderators can't be banned until their role ends. See [API.md](docs/API.md#bans).

**Deleting accounts.** A user can delete their own account (`evieverse account delete --yes`), and an admin can delete any (`evieverse users delete <userId> --yes`), except the only admin's. The account's posts are deleted with it, and its comments stay, without its name. The account is gone to everyone at once, but its username is free again only when its posts have been removed, which the compactor does. See [API.md](docs/API.md#delete-usersuserid).

**Reports.** Any user can report a published post or comment. Reported posts and comments stay published and wait in the report queue, where a server moderator or an admin accepts each, which leaves it as it is, or deletes it.

If removing a tag would leave a post with no tags, the post itself is removed.

All of the moderation functions are available via the CLI [CLI](docs/CLI.md).

## Rules

The CLI (and API) allows the admin to set the server rules, which come back in the public `GET /rules` endpoint. The rules also send the modification disclosure clause as appropriate. 

The details are in [API.md](docs/API.md#rules) and [CONFIG.md](docs/CONFIG.md).

## Posts

A post is one of five types:

- an image, a video or an audio file, each with an optional caption;
- text, of up to 40,000 characters;
- a link, which is also how any other kind of file, such as a PDF, is shared.

A text post's text, a caption and a comment's text can be formatted: bold, italic, struck through, code, links, quotes and lists, written in a small subset of Markdown. There's no HTML: a tag is shown as the characters it is. [TEXT_EDITORS.md](docs/TEXT_EDITORS.md) has the format, and how a client writes and shows it.

With each post, its publisher declares whether it was created with AI, and readers can filter feeds on that. 

To keep bots from flooding an instance, a user who posts or comments again within a minute first solves a challenge, or two if they keep posting. By default nobody posts more than 3 times a minute.

## Reposts
Any content can be reposted to this server or to another server with additional tags that it did not have previously. 
- It is not copied and still credited to its publisher.
- A user cannot repost their own posts (but can change the tags by editing the post)
- A repost still goes through tag moderation for its new tags
- A repost to another server contains the URL to access the content, but it still lives on this instance of Evieverse
- An instance can turn reposts off, or only those of posts on other instances (`REPOSTS`, `REPOSTS_REMOTE`).

## Comments

A post takes comments if its publisher turns them on, which they do post by post, and can change later. They're off unless the publisher says.

- A comment can consist of text, an image, or a video
- Comments are stored in a tree form on each post (users may respond to other users comments)
- Anyone can read a post's comments, oldest or newest first, and any user can add one, up to 10 a minute by default.
- Comments are moderated as posts are. Each gets a trust score from the same checks, and by the same thresholds is published, held in the moderation queue or rejected outright. Held comments wait in the same queue as held posts, for a server moderator or an admin.
- Comments can be reported, and then wait in the same report queue as reported posts.
- A comment can be deleted by its author, by the publisher of the post it's on, and by an admin.
- Turning comments off on a post closes and hides them without deleting them. 
- Deleting the post deletes all comments on it.
- Clients are responsible for providing sort options for comments

The details are in [API.md](docs/API.md#comments).

## Likes

A user can like any post once and cannot be taken back. A post's likes are shown wherever the post is, in feeds and on the post itself, and they're what the `popular` feed algorithm orders posts by.

## Following

A user can follow any other user, up to 1,000 of them by default. Followers and whom one follows can be optionally hidden by the user.

## Inbox

Users receive notices and messages from other users in their inbox. Notices include server messages (e.g. moderated posts, bans).

## Feed

A feed is what the reader asks for. The reader chooses:

- **Tags:** The system will return filtered content for one or more tags. If the related option is used, it will also return results for related tags. 
- **A window:** from the past hour to the past 90 days. A feed holds the posts of its window and no others.
- **An algorithm:**
  - `popular` (the default) returns the window's most liked posts first. The tags asked for take turns, and some places go to new posts nobody has liked yet, so that new posts get seen.
  - `chronological` returns the window's posts in order of time, newest first.
- **Filters:** AI-usage content filter. There is also a filter for only posts a tag's moderators have approved, or only posts they haven't.

## Running an instance locally

Requires Node 22+.

```bash
npm install
npm run dev            # SQLite in ./data, content and summaries in ./data/content, the index in memory
```

The server listens on `http://localhost:3000`. Other ways to run it:


| To run                                                                                                                                      | Command                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The testbed: an instance seeded with users and posts, and a web page for reading feeds, posting and registering, at `http://localhost:8080` | `docker compose -f testbed/docker-compose.yml up -d --build` |
| Just the API in Docker, for building a client against, at `http://localhost:3000` (Postgres, Valkey, and content on a local volume)         | `docker compose -f docker-compose.server.yml up -d --build`  |
| The full stack in Docker (Postgres, an S3-compatible store for content and summaries, Valkey for the index, and a separate compactor)       | `docker compose --profile app up --build`                    |


Things to know:

- `curl -fsSL http://localhost:3000/cli/install.sh | sh` downloads and installs the CLI.
- Without `REDIS_URL`, the feed index lives inside the process, and the server rebuilds it from the database and the content store each time it starts. To keep it across restarts, point `REDIS_URL` at a local Redis or Valkey (`docker compose up -d redis`, then `REDIS_URL=redis://127.0.0.1:6379`).
- The API in Docker (`docker-compose.server.yml`) accepts browser requests from any origin. Set `CORS_ORIGINS` (e.g. `CORS_ORIGINS=http://localhost:5173`) to allow only your frontend's.

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

## Benchmarks

Running the benchmarks:
```bash
npm run bench     # load-tests the API in Docker and writes BENCHMARKS.md again, in about 5 minutes
# The settings a run can be given, at their defaults:
BENCH_SERVER_CPUS=2 BENCH_SERVER_MEMORY=2g BENCH_DURATION_SECONDS=10 BENCH_CONNECTIONS=50 BENCH_POSTS=2000 npm run bench
```
Requires Docker

See [[BENCHMARKS.md](BENCHMARKS.md)] for the latest benchmark output. Note: this file is regenerated by the benchmark script. Do not edit it. 

Please run the benchmarking script before submitting PRs that touch API operations. If your PR does not show this file changed, it will be rejected. 

## AI-Usage Disclosure

AI tools, including Generative AI tools, were used in the planning, development, and analysis of Evieverse. Use of these tools has become standard practice in the software development world. I, a software engineer with over 20 years of professional experience, would not have been able to create Evieverse in any reasonable timeframe without them. Particular care was taken to "desloppify" AI output and perfect the product's codebase. If you find, and wish to remove, slop from this application, then open a PR. 

## License

See [[LICENSE.md](LICENSE.md)]

## Client Implementations

Open a PR to see your client implementation here!

## Code Owners

Evelynn McDermott [contact@techfalos.com](mailto:contact@techfalos.com)