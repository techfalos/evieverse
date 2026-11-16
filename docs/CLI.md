# The Evieverse CLI

The CLI provides basic tools for the administration and [moderation](API.md#moderation) of Evieverse. It is downloadable from the instance itself, so that it can be updated when the Evieverse instance is updated. It makes requests with the user's userId and API key. 

Requires Node.js 20 or newer and runs macOS, Linux and Windows.

- [Install](#install)
- [Sign in](#sign-in)
- [Commands](#commands)
- [Examples](#examples)

## Install

Install it from the instance it's for:

```bash
curl -fsSL https://api.example.com/cli/install.sh | sh     # macOS, Linux
irm https://api.example.com/cli/install.ps1 | iex          # Windows, in PowerShell
```



## Sign in

Sign in with your userId which `POST /register` returned with the key:

```bash
evieverse login https://api.example.com 3f6c2c0e-…      # retrieves the API key
evieverse whoami
evieverse help                                          # every command
```



### Profiles

A profile is one account on one instance. To work with several instances or accounts, name each profile when you sign in, and on later commands:

```bash
evieverse --profile staging login https://staging.example.com 3f6c2c0e-…
evieverse --profile staging whoami
EVIEVERSE_PROFILE=staging evieverse whoami               # the same
evieverse profiles                                       # the profiles on this machine
```

A deployment made with the [Terraform modules](DEPLOY.md#the-admin-account) writes its admin's profile itself, so that machine does not nee to `login`. The profile is named after the deployment, `evieverse` by default.

## Commands

```
evieverse [--profile <name>] [--json] <command>
```

Users are named by their `userId`, and hashtags without the `#`.


| Option             | What it does                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `--profile <name>` | The profile to use, if there are several. `EVIEVERSE_PROFILE` does the same.   |
| `--json`           | Prints the server's answer as JSON, instead of a line that says what was done. |
| `--help`, `-h`     | The same as `help`.                                                            |
| `--version`        | The same as `version`.                                                         |


Paginated commands require  `--cursor` that gets the next page.

A command exits with:


| Exit code | When                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ |
| 0         | It worked.                                                                                 |
| 1         | It didn't. The reason is on stderr, such as the server's `403` for a key without the role. |
| 2         | The command or its arguments weren't ones the CLI takes.                                   |




### For everyone


| Command                                                                  | What it does                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login <server> <userId>`                                                | Checks your key with the server and saves the profile.                                                                                                                                                   |
| `logout`                                                                 | Removes the profile from this machine. The key still works on the server.                                                                                                                                |
| `profiles`                                                               | Lists the profiles on this machine.                                                                                                                                                                      |
| `whoami`                                                                 | The account the key belongs to, and its roles.                                                                                                                                                           |
| `key rotate`                                                             | Replaces your API key with a new one (`[POST /users/:userId/key](API.md#post-usersuseridkey)`) and saves it in the profile. The old key stops working, wherever else it's in use.                        |
| `account delete --yes`                                                   | Deletes your account, for good ([`DELETE /users/:userId`](API.md#delete-usersuserid)): your key stops working, your posts are deleted, and the profile is removed from this machine. Your comments stay, without your name. It does nothing without `--yes`. |
| `help`                                                                   | Every command, with the ones your key may use marked.                                                                                                                                                    |
| `version`                                                                | The CLI's version and build.                                                                                                                                                                             |
| `update`                                                                 | Replaces the CLI with the one the server ships.                                                                                                                                                          |
| `content delete <contentId>`                                             | Deletes content: your own, or any content if you're an admin.                                                                                                                                            |
| `content report <contentId> [--comment <commentId>] [--reason <text>]`   | Reports a post to the server's moderators, or with `--comment`, a comment on it, with what's wrong with it if you say. You report a post or a comment once.                                              |
| `comments list <contentId> [--newest] [--limit <n>] [--cursor <cursor>]` | A post's [comments](API.md#comments), oldest first, or with `--newest`, newest first: each one's id, author, time and text.                                                                              |
| `comments add <contentId> <text>`                                        | Comments on a post that takes comments (quote the text). A comment the server holds back waits for its moderators, as a post does, and the command says so.                                              |
| `comments delete <contentId> <commentId>`                                | Deletes a comment: your own, one on your post, or any comment if you're an admin.                                                                                                                        |
| `moderators list <tag>`                                                  | A hashtag's moderators.                                                                                                                                                                                  |
| `rules list`                                                             | The server's [rules](API.md#rules), in their order, the email address to write to for support, and its modification disclosure: whether it runs a release of Evieverse or a modified version, which release, and where its source code is. |
| `inbox list [--unread] [--limit <n>] [--cursor <cursor>]`                | Your [inbox](API.md#inbox), newest first: the messages users sent you, and the notices of what moderators did to your posts and comments and of your mutes. With `--unread`, only what you haven't read. |
| `inbox read [--message <messageId>]`                                     | Marks everything in your inbox as read, or with `--message`, one message or notice.                                                                                                                      |
| `inbox delete <messageId>`                                               | Deletes a message or a notice from your inbox.                                                                                                                                                           |
| `messages send <userId> <text>`                                          | Sends a user a message (quote the text). Refused if either of you turned messages off or blocked the other.                                                                                              |
| `messages on`, `messages off`                                            | Turns messages between users on or off for your account. With them off you're sent none and send none. Notices still arrive.                                                                             |
| `blocks list [--limit <n>] [--cursor <cursor>]`                          | The users you block, most recently blocked first.                                                                                                                                                        |
| `blocks add <userId>`                                                    | Blocks a user: no message goes between the two of you, either way.                                                                                                                                       |
| `blocks remove <userId>`                                                 | Unblocks a user.                                                                                                                                                                                         |




### For a hashtag's moderators

Admins can run these on every hashtag.


| Command                                             | What it does                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `words list (--tag                                  | --server)`                                                                                                                   |
| `words add (--tag                                   | --server) ...`                                                                                                               |
| `words remove (--tag                                | --server) ...`                                                                                                               |
| `mute list <tag> [--limit <n>] [--cursor <cursor>]` | The users muted on a hashtag, most recently muted first.                                                                     |
| `mute add <tag> <userId>`                           | Mutes a user on a hashtag: their new posts and updates don't get it.                                                         |
| `mute remove <tag> <userId>`                        | Unmutes a user on a hashtag.                                                                                                 |
| `tag queue <tag> [--limit <n>] [--cursor <cursor>]` | [The hashtag's queue](API.md#a-hashtags-queue): the posts under it that no moderator has approved, or removed it from, yet.  |
| `tag approve <contentId> <tag>`                     | Approves content under a hashtag, which takes it out of the hashtag's queue until it's updated.                              |
| `tag remove <contentId> <tag> [--mute]`             | Removes a hashtag from content, for good: updates don't get it back. With `--mute`, also mutes its publisher on the hashtag. |




### For server moderators

Both queue and reports contain posts and comments. Each line starts with `post` or `comment`. A comment's line also contains the ID of the post it's on. The commands that decide on a post decide on a comment with `--comment`, given the post's id and the comment's.


| Command                                                                              | What it does                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queue list [--limit <n>] [--cursor <cursor>]`                                       | [The moderation queue](API.md#the-moderation-queue): the posts and the comments whose trust score held them back, longest waiting first.         |
| `queue accept <contentId> [--comment <commentId>]`                                   | Publishes a post from the moderation queue, or with `--comment`, a comment on it.                                                                |
| `queue reject <contentId> [--comment <commentId>]`                                   | Deletes a post in the moderation queue, or with `--comment`, a comment on it.                                                                    |
| `reports list [--limit <n>] [--cursor <cursor>]`                                     | [The report queue](API.md#the-report-queue): the posts and the comments users reported that nobody has decided on, longest reported first.       |
| `reports show <contentId> [--comment <commentId>] [--limit <n>] [--cursor <cursor>]` | A post's reports that nobody has decided on, or with `--comment`, a comment's, most recent first: who made each, when, and the reason they gave. |
| `reports accept <contentId> [--comment <commentId>]`                                 | Accepts a reported post, or with `--comment`, a reported comment on it: it stays as it is, and leaves the report queue.                          |
| `reports delete <contentId> [--comment <commentId>]`                                 | Deletes a reported post, or with `--comment`, a reported comment on it.                                                                          |
| `bans list [--limit <n>] [--cursor <cursor>]`                                        | The [banned](API.md#bans) users, most recently banned first: who banned each, when, and why.                                                     |
| `bans add <userId> [--reason <text>]`                                                | Bans a user: they can't post, comment, like or send messages, and can still read. They're told. Not an admin or a server moderator.              |
| `bans remove <userId>`                                                               | Ends a ban. The user is told.                                                                                                                    |




### For admins


| Command                                   | What it does                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register <username> [--language <code>]` | Registers a user (`[POST /register](API.md#post-register)`), with no challenge, and prints their `userId` and their API key. The key is shown this once, for you to pass on. With `--language`, the server answers them in that [language](LANGUAGES.md), instead of yours. |
| `admins list`                             | Lists the admins.                                                                                                                                                                                                                                                               |
| `admins grant <userId>`                   | Makes a user an admin.                                                                                                                                                                                                                                                          |
| `admins revoke <userId>`                  | Revokes a user's admin role. The server refuses to revoke its only admin's.                                                                                                                                                                                                     |
| `server-moderators list`                  | Lists the server moderators.                                                                                                                                                                                                                                                    |
| `server-moderators add <userId>`          | Makes a user a server moderator.                                                                                                                                                                                                                                                |
| `server-moderators remove <userId>`       | Ends a user's time as a server moderator.                                                                                                                                                                                                                                       |
| `moderators add <tag> <userId>`           | Appoints a moderator of a hashtag.                                                                                                                                                                                                                                              |
| `moderators remove <tag> <userId>`        | Ends a user's moderation of a hashtag.                                                                                                                                                                                                                                          |
| `rules add <text> [--position <n>]`       | Adds a rule (quote the text). It goes at the end of the list, or with `--position`, at that place, counted from 1.                                                                                                                                                              |
| `rules update <ruleId> [--text <text>] [--position <n>]` | Changes a rule: with `--text`, what it says, and with `--position`, its place in the list.                                                                                                                                                                       |
| `rules remove <ruleId>`                   | Removes a rule.                                                                                                                                                                                                                                                                 |
| `users rotate-key <userId>`             | Rotates a user's key.                                                                                                                    |
| `users delete <userId> --yes`             | Deletes any user's account, for good: their key stops working and their posts are deleted. Not the only admin's account. It does nothing without `--yes`.                                                                                                                      |




## Examples

Register a user, and make them an admin:

```bash
evieverse register alice                                 # as an admin: prints alice's userId and API key
evieverse admins grant 56243052-…
```

Set the server's rules, and read them as anyone would:

```bash
evieverse rules add "Be kind."                           # as an admin: prints the rule's id
evieverse rules add "Read these first." --position 1
evieverse rules update 0b7c0f5e-… --text "Be kind to each other."
evieverse rules list
```

```
1  9a41c3d0-…  Read these first.
2  0b7c0f5e-…  Be kind to each other.

Support: support@example.com

Modification disclosure: this server runs Evieverse 0.1.0, unmodified.
```

Appoint a moderator of `#news`, who then blocks a word, a phrase and a pattern there:

```bash
evieverse moderators add news 3f6c2c0e-…                 # as an admin
evieverse words add --tag news spam "buy now"            # as the moderator, or an admin
evieverse words add --tag news '/垃圾|广告/'              # a pattern, in single quotes
```

A pattern is a regular expression between slashes, which matches anywhere in a text ([API.md](API.md#blocked-words)). Put it in single quotes, so the shell passes it on as it's written. `words list` shows it with its slashes, and `words remove` takes it the same way.

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

Ban a user, and delete accounts:

```bash
evieverse bans add 56243052-… --reason "Spam"                     # as a server moderator, or an admin
evieverse bans list                                               # who is banned, by whom, and why
evieverse bans remove 56243052-…
evieverse users delete 56243052-… --yes                           # as an admin: any account, for good
evieverse account delete --yes                                    # as anyone: your own, and the profile with it
```

Use it from a script:

```bash
EVIEVERSE_API_KEY="$KEY" evieverse login https://api.example.com "$USER_ID"
evieverse --json queue list | jq -r '.queue[] | select(.kind == "post") | .contentId'
```



