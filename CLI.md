# The Evieverse CLI

Every Evieverse instance ships a command-line tool, `evieverse`, for the [moderation](API.md#moderation) its API offers. Anyone can download it from the instance, and it signs in with an account's `userId` and API key, as any other client does. What a command may do is decided by the server, from the key: an admin's key can run all of them, a server moderator's the ones for the moderation queue and the report queue, a tag moderator's the ones for their hashtags, and anyone else's only the ones for their own account, for commenting, and for reporting a post or a comment.

It's one file that Node.js 20 or newer runs, so it works the same on macOS, Linux and Windows.

- [Install](#install)
- [Sign in](#sign-in)
- [Commands](#commands)
- [Examples](#examples)
- [Updates](#updates)

## Install

Install it from the instance it's for:

```bash
curl -fsSL https://api.example.com/cli/install.sh | sh     # macOS, Linux
irm https://api.example.com/cli/install.ps1 | iex          # Windows, in PowerShell
```

The script checks for Node.js, downloads the CLI, checks its SHA-256 and puts it in `~/.evieverse/bin` (or `$EVIEVERSE_HOME/bin`), with a `evieverse` command beside it (`evieverse.cmd` on Windows). It prints the line that adds that directory to your `PATH` if it isn't there.

The instance serves the CLI and both scripts itself ([API.md](API.md#the-cli-download)). An instance run from source (`npm run dev`) has no CLI built, so there's nothing to install from it: `npm run build` builds both.

## Sign in

Sign in with your `userId`, which `POST /register` returned with the key:

```bash
evieverse login https://api.example.com 3f6c2c0e-…      # asks for the API key, without showing it
evieverse whoami
evieverse help                                           # every command, with the ones your key may use marked
```

`login` checks the key with the server ([`GET /whoami`](API.md#get-whoami)) and saves it as a profile: `~/.evieverse/profiles/default.json`, a file only you can read (mode `0600`). A script can pass the key in `EVIEVERSE_API_KEY` instead of typing it.

If the key may have leaked, `evieverse key rotate` replaces it: the server revokes the old key and issues a new one, which the CLI writes to the profile in its place. Other clients that used the old key need the new one, which is the profile file's `apiKey`. The admin account of a Terraform deployment is the exception: its key is [replaced through the deployment](deploy/README.md#the-admin-account).

The CLI signs in to an account that exists: it has no command that creates one. Accounts are registered through the API ([`POST /register`](API.md#post-register)), usually by a client. The README shows how to do it from a terminal: [as an admin](README.md#3-create-another-user), which takes one request and no challenge, or [as anyone](README.md#user-registration-and-api-keys).

### Profiles

A profile is one account on one instance. With one profile, there's nothing to name. To work with several instances or accounts, name each profile when you sign in, and on later commands:

```bash
evieverse --profile staging login https://staging.example.com 3f6c2c0e-…
evieverse --profile staging whoami
EVIEVERSE_PROFILE=staging evieverse whoami               # the same
evieverse profiles                                       # the profiles on this machine
```

With several profiles and none named, a command stops and lists them.

A deployment made with the [Terraform modules](deploy/README.md#the-admin-account) writes its admin's profile itself, so that machine needs no `login`. The profile is named after the deployment, `evieverse` by default.

## Commands

```
evieverse [--profile <name>] [--json] <command>
```

Users are named by their `userId`, and hashtags without the `#`.

| Option | What it does |
| --- | --- |
| `--profile <name>` | The profile to use, if there are several. `EVIEVERSE_PROFILE` does the same. |
| `--json` | Prints the server's answer as JSON, instead of a line that says what was done. |
| `--help`, `-h` | The same as `help`. |
| `--version` | The same as `version`. |

Each command is one request to an endpoint of the [API](API.md#moderation-endpoints), and prints what it did. A command that lists a page at a time says so when there are more, with the `--cursor` that gets the next page.

A command exits with:

| Exit code | When |
| --- | --- |
| 0 | It worked. |
| 1 | It didn't. The reason is on stderr, such as the server's `403` for a key without the role. |
| 2 | The command or its arguments weren't ones the CLI takes. |

### For everyone

| Command | What it does |
| --- | --- |
| `login <server> <userId>` | Checks your key with the server and saves the profile. |
| `logout` | Removes the profile from this machine. The key still works on the server. |
| `profiles` | Lists the profiles on this machine. |
| `whoami` | The account the key belongs to, and its roles. |
| `key rotate` | Replaces your API key with a new one ([`POST /users/:userId/key`](API.md#post-usersuseridkey)) and saves it in the profile. The old key stops working, wherever else it's in use. |
| `help` | Every command, with the ones your key may use marked. |
| `version` | The CLI's version and build. |
| `update` | Replaces the CLI with the one the server ships. |
| `content delete <contentId>` | Deletes content: your own, or any content if you're an admin. |
| `content report <contentId> [--comment <commentId>] [--reason <text>]` | Reports a post to the server's moderators, or with `--comment`, a comment on it, with what's wrong with it if you say. You report a post or a comment once. |
| `comments list <contentId> [--newest] [--limit <n>] [--cursor <cursor>]` | A post's [comments](API.md#comments), oldest first, or with `--newest`, newest first: each one's id, author, time and text. |
| `comments add <contentId> <text>` | Comments on a post that takes comments (quote the text). A comment the server holds back waits for its moderators, as a post does, and the command says so. |
| `comments delete <contentId> <commentId>` | Deletes a comment: your own, one on your post, or any comment if you're an admin. |
| `moderators list <tag>` | A hashtag's moderators. |
| `inbox list [--unread] [--limit <n>] [--cursor <cursor>]` | Your [inbox](API.md#inbox), newest first: the messages users sent you, and the notices of what moderators did to your posts and comments and of your mutes. With `--unread`, only what you haven't read. |
| `inbox read [--message <messageId>]` | Marks everything in your inbox as read, or with `--message`, one message or notice. |
| `inbox delete <messageId>` | Deletes a message or a notice from your inbox. |
| `messages send <userId> <text>` | Sends a user a message (quote the text). Refused if either of you turned messages off or blocked the other. |
| `messages on`, `messages off` | Turns messages between users on or off for your account. With them off you're sent none and send none. Notices still arrive. |
| `blocks list [--limit <n>] [--cursor <cursor>]` | The users you block, most recently blocked first. |
| `blocks add <userId>` | Blocks a user: no message goes between the two of you, either way. |
| `blocks remove <userId>` | Unblocks a user. |

### For a hashtag's moderators

Admins can run these on every hashtag.

| Command | What it does |
| --- | --- |
| `words list (--tag <tag> \| --server)` | A hashtag's blocked words, or with `--server` the server's (admins only). |
| `words add (--tag <tag> \| --server) <word>...` | Blocks words and phrases (quote a phrase), and prints the list as it is then. |
| `words remove (--tag <tag> \| --server) <word>...` | Unblocks words and phrases, and prints the list as it is then. |
| `mute list <tag> [--limit <n>] [--cursor <cursor>]` | The users muted on a hashtag, most recently muted first. |
| `mute add <tag> <userId>` | Mutes a user on a hashtag: their new posts and updates don't get it. |
| `mute remove <tag> <userId>` | Unmutes a user on a hashtag. |
| `tag queue <tag> [--limit <n>] [--cursor <cursor>]` | [The hashtag's queue](API.md#a-hashtags-queue): the posts under it that no moderator has approved, or removed it from, yet. |
| `tag approve <contentId> <tag>` | Approves content under a hashtag, which takes it out of the hashtag's queue until it's updated. |
| `tag remove <contentId> <tag> [--mute]` | Removes a hashtag from content, for good: updates don't get it back. With `--mute`, also mutes its publisher on the hashtag. |

### For server moderators

Admins can run these too. Both queues hold posts and comments in one list. Each line starts with which it is, `post` or `comment`, and then its id; a comment's line also names the post it's on. The commands that decide on a post decide on a comment with `--comment`, given the post's id and the comment's.

| Command | What it does |
| --- | --- |
| `queue list [--limit <n>] [--cursor <cursor>]` | [The moderation queue](API.md#the-moderation-queue): the posts and the comments whose trust score held them back, longest waiting first. |
| `queue accept <contentId> [--comment <commentId>]` | Publishes a post from the moderation queue, or with `--comment`, a comment on it. |
| `queue reject <contentId> [--comment <commentId>]` | Deletes a post in the moderation queue, or with `--comment`, a comment on it. |
| `reports list [--limit <n>] [--cursor <cursor>]` | [The report queue](API.md#the-report-queue): the posts and the comments users reported that nobody has decided on, longest reported first. |
| `reports show <contentId> [--comment <commentId>] [--limit <n>] [--cursor <cursor>]` | A post's reports that nobody has decided on, or with `--comment`, a comment's, most recent first: who made each, when, and the reason they gave. |
| `reports accept <contentId> [--comment <commentId>]` | Accepts a reported post, or with `--comment`, a reported comment on it: it stays as it is, and leaves the report queue. |
| `reports delete <contentId> [--comment <commentId>]` | Deletes a reported post, or with `--comment`, a reported comment on it. |

### For admins

| Command | What it does |
| --- | --- |
| `admins list` | Lists the admins. |
| `admins grant <userId>` | Makes a user an admin. |
| `admins revoke <userId>` | Revokes a user's admin role. The server refuses to revoke its only admin's. |
| `server-moderators list` | Lists the server moderators. |
| `server-moderators add <userId>` | Makes a user a server moderator. |
| `server-moderators remove <userId>` | Ends a user's time as a server moderator. |
| `moderators add <tag> <userId>` | Appoints a moderator of a hashtag. |
| `moderators remove <tag> <userId>` | Ends a user's moderation of a hashtag. |

## Examples

Appoint a moderator of `#news`, who then blocks a word and a phrase there:

```bash
evieverse moderators add news 3f6c2c0e-…                 # as an admin
evieverse words add --tag news spam "buy now"            # as the moderator, or an admin
```

Work through a hashtag's queue:

```bash
evieverse tag queue news
evieverse tag approve 5c06badf-… news
evieverse tag remove 5c06badf-… news --mute              # and mute its publisher on #news
```

Work through the moderation queue:

```bash
evieverse queue list
evieverse queue accept 5c06badf-…
evieverse queue reject 5c06badf-…
```

Report a post, and work through the report queue:

```bash
evieverse content report 5c06badf-… --reason "Looks like spam"    # as anyone
evieverse reports list                                            # as a server moderator, or an admin
evieverse reports show 5c06badf-…                                 # who reported it, and why
evieverse reports accept 5c06badf-…                               # it stays
evieverse reports delete 5c06badf-…                               # or it goes
```

Comment on a post, and decide on comments in the two queues:

```bash
evieverse comments add 5c06badf-… "Lovely light."                 # as anyone, on a post that takes comments
evieverse comments list 5c06badf-… --newest
evieverse content report 5c06badf-… --comment 0199c2f4-… --reason "Unkind"
evieverse queue list                                              # posts and comments, as a server moderator or an admin
evieverse queue accept 5c06badf-… --comment 0199c2f5-…            # the comment is published
evieverse reports delete 5c06badf-… --comment 0199c2f4-…          # the reported comment goes
```

Use it from a script:

```bash
EVIEVERSE_API_KEY="$KEY" evieverse login https://api.example.com "$USER_ID"
evieverse --json queue list | jq -r '.queue[] | select(.kind == "post") | .contentId'
```

## Updates

A CLI is built with its server, and the two are held to the same build:
- Every request the CLI makes names its build (an `X-Evieverse-CLI` header). A server that ships another build answers `426` with the one it ships, whatever was asked for, and nothing is done.
- The CLI then downloads the server's build, checks its SHA-256, replaces its own file, and runs the command again. It does that once: if the server still asks for another build straight after, it's mid-deploy, and the CLI says to try again in a minute.
- The build changes when the CLI's code or the version in `package.json` does, so a server update that changes neither asks nothing of the CLI.
- Only the CLI is held to this. Other clients don't send the header.

`evieverse update` does the same without waiting to be asked.

[APP.md](APP.md#the-cli) explains how the CLI is built and shipped, and where it keeps keys.
