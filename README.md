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

Evieverse is designed with the idea that clients will enable users to connect to multiple different Evieverse servers. Content is not federated from server-to-server, but from client to servers they have subscribed to.

| To                                               | Read                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| Deploy an instance to AWS, Google Cloud or Azure | [docs/DEPLOY.md](docs/DEPLOY.md)               |
| Configure an instance, and deploy a change       | [docs/CONFIG.md](docs/CONFIG.md)               |
| Administer or moderate an instance               | [docs/CLI.md](docs/CLI.md)                     |
| Build a client, or call the API                  | [docs/API.md](docs/API.md)                     |
| Add a language the server answers in             | [docs/LANGUAGES.md](docs/LANGUAGES.md)         |
| Write a trust plugin, to score posts             | [docs/TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md) |
| Understand how it works inside                   | [docs/APP.md](docs/APP.md)                     |


## Getting started

These steps put an instance in your cloud account and sign you in as its admin. To try one on your own machine first, see [On your own machine](#on-your-own-machine).

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

The admin account the deployment made is for emergencies, so give yourself an account of your own.

Accounts are created by registering with the instance. To keep bots out, registering takes a challenge that a person solves, but not when an admin registers the user. So register your account as the deployment's admin, which the CLI is signed in as:

```sh
evieverse register evelynn
```

```
Registered evelynn (56243052-…).
Their API key, shown this once: tu_cba15064d3f1_…
```

The id and the key are the new account's, not the admin's. Keep the key: it's shown this once. An instance takes 10 registration requests an hour from one address by default, an admin's included.

To make the new account an admin, and sign the CLI in as it:

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
3. **Let the user set the parameters of each request,** such as a feed's tags, window and algorithm, so the experience is theirs to shape.
4. **Syndicate a post to several instances** by posting it to each one. Instances don't pass posts on to each other, so a user's key for one instance never goes to another.

## Bring your own client

Every instance serves the same API, so anyone can register on an instance directly, keep their own key, and use whatever client they like, including one they wrote. [API.md](docs/API.md) is the contract: every endpoint, what it takes and what it returns.

## User registration and API keys

When a user registers using the register endpoint(`POST /register`), unless pre-existing admin credentials are supplied (the CLI does this automatically), the instance responds with a challenge. Once the challenge is solved, the instance returns the user's id and an API key. The key is shown once, and an instance has no way to show it again, so it's the client's job to keep it safe. A user who still has their key can replace it (`POST /users/:userId/key`, or `evieverse key rotate`): the old key stops working at once and a new one comes back, which is what to do when a key may have leaked. A key that's lost can't be replaced. The details are in [API.md](docs/API.md#post-usersuseridkey).

If the characters were wrong, the answer is a new challenge instead, so run both requests again. An instance takes up to 10 registration requests an hour from one address by default.

## Content organization and moderation

As on most social media, content is organized by tags (hashtags). An instance is deployed in one of two tagging modes:

- **User-supplied tags** (the default): a post carries the tags its publisher gives it, up to 10.
- **Server-enforced tags:** the instance's operator sets the tags a post is allowed to have, and a publisher gives each post up to 10 of them. A post with any other tag is rejected. Clients get the list of allowed tags from the instance (`GET /tagging`), so they can offer them to choose from.

In both modes, a post with no valid tags is rejected.

**Auto-moderation.** Every new post and update gets a trust score when it arrives. Depending on the score, the post is published, held in the moderation queue until someone accepts or rejects it, or rejected outright. Out of the box, the score comes from the instance's list of blocked words. A post containing a blocked word is assigned a trust score of zero. Additional [trust plugins](docs/TRUST_PLUGINS.md) may be used to modified the trust score further. 

**Moderators** 

- **Admins** can delete any post, comment or account, ban users, accept or reject held posts and comments, keep the instance's blocked words, and appoint the other two roles. They also [register users without a challenge](#user-registration-and-api-keys).
- **Server moderators** accept or reject the posts and comments held in the moderation queue, accept or delete the posts and comments users reported, and ban users.
- **Tag moderators** look after one or more tags. Under their tag, they can approve a post or remove the tag from it, block words, and mute a user, whose later posts then don't get the tag. They have no say over comments.

**Bans.** A server moderator or an admin can ban a user (`evieverse bans add <userId>`). A banned user can't post, comment or send messages, but can still read, receive messages, and delete their own posts and account. The user is told, with a notice, and again when the ban ends. Admins and server moderators can't be banned until their role ends. See [API.md](docs/API.md#bans).

**Deleting accounts.** A user can delete their own account (`evieverse account delete --yes`), and an admin can delete any (`evieverse users delete <userId> --yes`), except the only admin's. The account's posts are deleted with it, and its comments stay, without its name. The account is gone to everyone at once, but its username is free again only when its posts have been removed, which the compactor does. See [API.md](docs/API.md#delete-usersuserid).

**Reports.** Any user can report a published post or comment. Reported posts and comments stay published and wait in the report queue, where a server moderator or an admin accepts each, which leaves it as it is, or deletes it.

If removing a tag would leave a post with no tags, the post itself is removed.

All of the moderation functions are available via the CLI [CLI](docs/CLI.md).

## Posts

A post is one of five types:

- an image, a video or an audio file, each with an optional caption;
- text, of up to 40,000 characters;
- a link, which is also how any other kind of file, such as a PDF, is shared.

With each post, its publisher declares whether it was created with AI, and readers can filter feeds on that. 

To keep bots from flooding an instance, a user who posts again within a minute first solves a challenge, or two if they keep posting. By default nobody posts more than 3 times a minute.

## Comments

A post takes comments if its publisher turns them on, which they do post by post, and can change later. They're off unless the publisher says.

- A comment is text, of up to 2,000 characters, an image or a video
- Comments are stored in a tree form on each post
- Anyone can read a post's comments, oldest or newest first, and any user can add one, up to 10 a minute by default.
- **Comments are moderated as posts are.** Each gets a trust score from the same checks, and by the same thresholds is published, held in the moderation queue or rejected outright. Held comments wait in the same queue as held posts, for a server moderator or an admin.
- **Comments can be reported,** and then wait in the same report queue as reported posts.
- A comment can be deleted by its author, by the publisher of the post it's on, and by an admin.
- Turning comments off on a post closes and hides them without deleting them. Deleting the post deletes them.

The details are in [API.md](docs/API.md#comments).

## Likes

A user can like any post once and cannot be taken back. A post's likes are shown wherever the post is, in feeds and on the post itself, and they're what the `popular` feed algorithm orders posts by.

## Following

A user can follow any other user, up to 1,000 of them by default, and read a feed of everything those users post, newest first. Whom a user follows, and who follows them, is hidden: only the user can list either. They can show one list or both to everyone, each with a setting of its own. Their following feed shows whose posts they follow, so it goes with the list of them: it's theirs alone to read, with their key, unless they show whom they follow.

## Inbox

Every user has an inbox, which only they can read. Two things arrive in it:

- **Notices.** When a moderator or an admin removes a tag from a user's post, accepts or rejects it in the moderation queue, deletes it, or mutes or bans the user, a message is sent to the user. 
- **Messages from other users.** A user can turn these off, and is then sent none and sends none. A user can also block other users: no message goes between the two, and the blocked user isn't told.

By default a user sends at most 10 messages a minute, and an inbox keeps what arrives for 90 days. The details are in [API.md](docs/API.md#inbox).

## Feed

A feed is what the reader asks for. The reader chooses:

- **Tags:** one or more, and optionally the tags related to them, which are the ones that tend to appear on the same posts.
- **A window:** from the past hour to the past 90 days. A feed holds the posts of its window and no others.
- **An algorithm:**
  - `popular` (the default) returns the window's most liked posts first. The tags asked for take turns, and some places go to new posts nobody has liked yet, so that new posts get seen.
  - `chronological` returns the window's posts in order of time, newest first.
- **Filters:** only content declared as created with AI, or only content that wasn't. Only posts a tag's moderators have approved, or only posts they haven't.

A second kind of feed returns the posts of the users someone follows, newest first.

Feeds come a page at a time, 50 posts by default. Reading one needs no account, and nothing about the reader goes into it: the same request is answered by the same rules for everyone. The rules are spelled out in [API.md](docs/API.md#get-feed), and [APP.md](docs/APP.md#9-how-a-feed-is-built) explains how the server carries them out.

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

- **The CLI.** A server run from source ships no CLI. `npm run build && npm start` builds and ships it, and `curl -fsSL http://localhost:3000/cli/install.sh | sh` then installs it.
- **Redis.** Without `REDIS_URL`, the feed index lives inside the process, and the server rebuilds it from the database and the content store each time it starts. To keep it across restarts, point `REDIS_URL` at a local Redis or Valkey (`docker compose up -d redis`, then `REDIS_URL=redis://127.0.0.1:6379`).
- **Browsers.** The API in Docker (`docker-compose.server.yml`) accepts browser requests from any origin. Set `CORS_ORIGINS` (e.g. `CORS_ORIGINS=http://localhost:5173`) to allow only your frontend's.

### The first admin

Making an admin takes an admin, so the first one comes from whoever runs the instance:

- The [Terraform modules](docs/DEPLOY.md#the-admin-account) create an admin account with every deployment, and put its API key on the machine that applies.
- Anywhere else, the operator makes one from the command line, with the server's configuration:
  ```bash
  npm run build
  npm run admin -- grant alice      # a username or a userId
  npm run admin -- revoke alice
  npm run admin -- list
  ```
  In the Docker image, that's `node dist/moderation/admin.js grant alice` (with the testbed, `docker compose -f testbed/docker-compose.yml exec app node dist/moderation/admin.js grant alice`). Like the server, it applies the database migrations first. It writes to the database directly, so it also works when no admin's key is at hand.

From then on, admins make more with the CLI (`evieverse admins grant <userId>`).

### Configuration

Every setting is an environment variable, and each has a default, so an instance runs with none set. [CONFIG.md](docs/CONFIG.md) lists every setting, and says how to deploy a changed one. `[.env.example](.env.example)` is the same list as a file to copy to `.env`.

Two things are files in the source rather than settings: the languages the server answers in ([LANGUAGES.md](docs/LANGUAGES.md)) and the trust plugins that score posts ([TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md)).

## Development

```bash
npm test     # unit tests, migration tests, API and feed-index tests on SQLite with the in-process store
docker compose up -d postgres mysql redis
TEST_POSTGRES_URL=postgres://evieverse:evieverse@localhost:5432/evieverse \
TEST_MYSQL_URL=mysql://evieverse:evieverse@localhost:3306/evieverse \
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
```

Each test against Redis uses its own key prefix and deletes its keys afterwards, so any Redis or Valkey will do. Tests against Postgres or MySQL recreate the database's tables, so give them a database of their own, and add `--no-file-parallelism` to run the test files one at a time.

What the server doesn't do, or doesn't do yet, is listed in [APP.md](docs/APP.md#14-known-limits).

## AI-Usage Disclosure

AI tools, including Generative AI tools, were used in the planning, development, and analysis of Evieverse

## License

See [[LICENSE.md](LICENSE.md)]

## Implementations

Open a PR to see your implementation here!

## Code Owners
Evelynn McDermott <contact@techfalos.com>