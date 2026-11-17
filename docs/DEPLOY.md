# Deploying Evieverse with Terraform

Each directory under `deploy/terraform/` is a self-contained root module that builds the image from this repo, provisions everything the instance needs, and prints the HTTPS URL when it finishes.


| Cloud | Functions                               | One address in front                                                | Compactor                                     | Redis (feed index, hot summaries)        | Content and summaries | Database                           |
| ----- | --------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- | --------------------- | ---------------------------------- |
| AWS   | Lambda (container image), one per group | CloudFront (`*.cloudfront.net`) in front of an API Gateway HTTP API | ECS Fargate service of one task               | ElastiCache for Valkey 8, with a replica | S3                    | RDS PostgreSQL 16 behind RDS Proxy |
| GCP   | Cloud Run services, one per group       | API Gateway (`*.gateway.dev`)                                       | Cloud Run worker pool of one instance         | Memorystore for Redis 7.2, Standard tier | GCS                   | Cloud SQL PostgreSQL 16            |
| Azure | Container Apps, one per group           | Front Door (`*.azurefd.net`)                                        | Container App of one replica, with no ingress | Azure Managed Redis, highly available    | Blob Storage          | PostgreSQL Flexible Server 16      |


Summaries share the content bucket, under `summaries/`, and so do comments, under `comments/`: one small object each, which is the only place a published comment is kept.

## Route groups


| Group     | Requests                                                                                                                                                                       | Uses                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `feed`    | `GET /feed`                                                                                                                                                                    | Redis and the bucket only: no database connection |
| `content` | `GET /content/:id`, `GET /content/:id/raw`, `GET /content/:id/attestation`, and reading a post's comments: `GET /content/:id/comments`, `GET /content/:id/comments/:commentId` | Database, bucket, and Redis for comments          |
| `store`   | `POST /uploads`, `POST /store`                                                                                                                                                 | Database, Redis, bucket                           |
| `api`     | Everything else                                                                                                                                                                | Database, Redis, bucket                           |




## Prerequisites

- Terraform 1.5 or newer.
- Docker for AWS and GCP (the image is built locally and pushed). Azure builds remotely with `az acr build`, so Docker isn't needed there.
- The cloud's CLI: `aws configure` / `gcloud auth login && gcloud auth application-default login`  or  `az login`. Terraform also uses `gcloud` and `az` to run the database migrations.

To skip the build, set `image` to an image you've already pushed. On AWS it must be in an ECR repository of the same account and region.

## Deploy

```sh
# AWS
cd deploy/terraform/aws
terraform init
terraform apply -var region=us-east-1

# GCP
cd deploy/terraform/gcp
terraform init
terraform apply -var project_id=my-project -var region=us-central1

# Azure
cd deploy/terraform/azure
terraform init
terraform apply -var subscription_id=00000000-0000-0000-0000-000000000000 -var location=eastus
```

At the end of `apply`, Terraform prints the instance `url` (for example `https://d1234abcd.cloudfront.net`) and `try_it`, which shows ready-to-paste `curl` commands and how to install the CLI and use it as the deployment's [admin](#the-admin-account). To see them again later, run `terraform output url`.

**Settings check and database migrations**

Every `apply` that changes the image, a setting or the admin account first runs one step (a Lambda function on AWS, a job on GCP and Azure), waits for it, and only then updates the functions and the compactor. The step does two things, in this order:

1. **It checks the settings.** It's given the settings the functions are about to get, and starts each route group with them as its function would. A setting the server refuses, such as a misspelt plugin name in `TRUST_OPTIONAL_PLUGINS` or a `TAGGING_MODE=server` with no hashtags, fails the step with the reason.
2. **It runs the migrations,** and sets up the [admin account](#the-admin-account).

If the step fails, the `apply` stops there. Nothing else is changed: the functions and the compactor keep the image and the settings they have, and go on serving. Fix the setting and apply again, which runs the step again.

The check is there because updating a function doesn't start it. Without it, a mistake in `environment` or `secrets` would pass the `apply`, and then every request would fail. It tells you that the server starts with your settings, not that they're right: a bucket that doesn't exist, or a key that a service refuses, passes the check and shows when it's used.

**Settings**

Settings are passed through `environment`, and credentials through `secrets`. On GCP and Azure, secrets go to Secret Manager and Container Apps secrets, never into plain environment variables. On AWS they go to Secrets Manager, and none is in a function's configuration, which anyone allowed to read it (`lambda:GetFunctionConfiguration`) would see. A function reads them as an instance starts, and the compactor's task is given them as it starts, each by the version the apply wrote, so a new value waits for the settings check like any other change.

```hcl
# terraform.tfvars (git-ignored)
support_email = "support@example.com"
environment   = { TAGGING_MODE = "server", TAGGING_SERVER_TAGS = "news" }
secrets       = { SUMMARY_OPTIONS = "{\"bucket\":\"summaries\",\"access_key_id\":\"...\",\"secret_access_key\":\"...\"}" }
```

The support address has a variable of its own, `support_email`: the email address [`GET /rules`](API.md#get-rules) gives people to write to for support (`SUPPORT_EMAIL`). It's `noreply@yoururl.com` until you set it, a placeholder that nobody reads, and the plan fails if it isn't an email address.

**Optional trust plugins**

An optional [trust plugin](TRUST_PLUGINS.md#optional-plugins) is turned on the same way. For `urlhaus`, which refuses posts and comments with a link that spreads malware, name it in `environment` and put its Auth-Key in `secrets`:

```hcl
environment = { TRUST_OPTIONAL_PLUGINS = "urlhaus" }
secrets     = { URLHAUS_AUTH_KEY = "..." }
```

- Set both in the same `apply`. The server doesn't start with `urlhaus` named and no key, so the modules check for it: the plan fails, before anything is changed, if `TRUST_OPTIONAL_PLUGINS` names `urlhaus` and `URLHAUS_AUTH_KEY` is missing or empty. The check is on the key being there, not on URLhaus accepting it. A name that isn't a plugin, such as `urlhouse`, gets past the plan and is refused by the [settings check](#deploy), which stops the `apply` before any function is updated.
- Each function instance downloads URLhaus's list when it first has a link to check, and keeps it while it lives. A post with a link that reaches a new instance waits for that download, on top of the cold start.
- The functions need a way out to `urlhaus-api.abuse.ch`, which the three modules give them: through the NAT gateway on AWS, and directly on GCP and Azure. If the list can't be downloaded, posts with a link fail with `500` on instances that have no list yet.

**The signing key for reposts**

Each module makes the key the instance signs its posts with, which is what lets them be [reposted on other servers](API.md#a-post-on-another-server): 32 random bytes, kept with the instance's other secrets as `REPOSTS_SIGNING_KEYS`. There's nothing to set.

- **To replace the key,** run `terraform apply -replace=random_bytes.repost_signing`. Nothing of the old key has to be kept: an attestation is asked for when it's used, and is good for 10 minutes at most. A server that has the old key asks for the instance's keys again when it meets the new one, at most once a minute, so at worst it refuses reposts of the instance's posts for a minute after the change.
- **To sign with keys of your own,** put `REPOSTS_SIGNING_KEYS` in `secrets`, and the module's key isn't used. Several keys, separated by commas or spaces, change the key with no gap: the first signs, and all are published.
- **To sign nothing,** set `REPOSTS_SIGNING_KEYS = ""` in `environment`. The instance's posts are then reposted only on the instance itself.
- **The key is in the Terraform state,** in plain text, like the other secrets these modules create.
- To check a repost of a post on another server, the functions ask that server for its public keys over `https`. That takes the same way out as above: the NAT gateway on AWS, and directly on GCP and Azure.
- The [compactor](#compactor)'s container asks other servers too: about once a day, for the attestation of each post the instance holds a repost of (`REPOSTS_REFRESH_HOURS`). It takes the same way out.

[CONFIG.md](CONFIG.md) lists all settings.

## The admin account

Initial deployment creates an [admin](API.md#moderation) account:

1. **Terraform makes the account's id and API key,** in the format the server issues keys in. The key is random, and exists in two places only: the Terraform state, and the profile file below.
2. **The migration step creates the account.** It's given the key's SHA-256, not the key (`BOOTSTRAP_ADMIN`), and after the migrations it creates the user if it isn't there, makes it an admin, and, if the key is new to the account, makes that key its only one. It runs again whenever the image, a setting or the account's values change, and changes nothing about the account when its values haven't.
3. **The key is installed on the machine that applies,** once the account exists: Terraform writes `~/.evieverse/profiles/<name>.json` (`name` is the module's variable, `evieverse` by default, unless `admin_profile_name` gives the profile a name of its own), readable only by you. That's a profile of the server's [CLI](CLI.md), so after installing the CLI, it works as the admin with no sign-in:

```sh
curl -fsSL "$(terraform output -raw url)/cli/install.sh" | sh     # Windows: irm <url>/cli/install.ps1 | iex
evieverse --profile evieverse whoami
evieverse --profile evieverse register alice                   # an account of your own: prints its userId and API key
evieverse --profile evieverse admins grant <userId>            # make your own account an admin
```

With no other profile on the machine, `--profile` can be left out.

Deployments with the same `name` that are applied from one machine write the same file, so each apply writes its admin's key over the other's. Give each a profile of its own with `admin_profile_name`: with `admin_profile_name = "evieverse-aws"`, the file is `~/.evieverse/profiles/evieverse-aws.json`, and the CLI uses it with `--profile evieverse-aws`. Changing it on a deployment that's applied already removes the file under the old name and writes the new one.


| Variable                | Default |                                                                                                                                                                               |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_username`        | `admin` | The account's username when it's created. It fails the apply if another user has it. To rename the account later, use `PATCH /users/:userId`: changing this variable doesn't. |
| `install_admin_profile` | `true`  | Write the profile file. Set it to `false` where applies run unattended (CI), and read the key with `terraform output -raw admin_api_key`.                                     |
| `admin_profile_name`    | `""`    | The profile's name, and so its file's. Empty: the same as `name`. A name is 1 to 64 letters, digits, `.`, `_` and `-`, the first a letter or a digit.                         |



| Output          |                                                                 |
| --------------- | --------------------------------------------------------------- |
| `admin_user_id` | The account's `userId`.                                         |
| `admin_api_key` | Its API key (sensitive): `terraform output -raw admin_api_key`. |
| `admin_profile` | The profile file the apply wrote, if it did.                    |


Things to know:

- **On another machine,** sign in with the outputs: `EVIEVERSE_API_KEY="$(terraform output -raw admin_api_key)" evieverse login "$(terraform output -raw url)" "$(terraform output -raw admin_user_id)"`. A machine that applies an existing deployment gets the profile file written too.
- **The key is in the Terraform state,** in plain text, like the database password and the other secrets these modules create. Keep the state where only the deployment's operators can read it (an encrypted remote backend, rather than a file in the repo).
- **To replace the key,** run `terraform apply -replace=random_password.admin_key`. The migration step gives the account the new key and revokes the old one, and the profile file is rewritten.
- **A key replaced through the API lasts, but the deployment doesn't learn of it** (`[POST /users/:userId/key](API.md#post-usersuseridkey)`, or `evieverse key rotate`). Later applies leave the new key in place, and the deployment's key stays revoked. Terraform still holds the old key, so the `admin_api_key` output no longer works, and the next apply writes the old key back to the profile file, over the one `key rotate` saved there. To give the deployment a working key again, replace the key as above.
- **The account is a break-glass one.** Make your own account an admin with it, and use that from day to day. It can't be locked out for good by the API: the server refuses to revoke or delete its only admin, and if this account's role is revoked while others remain, the next apply that runs the migration step restores it. If another admin replaces its key, replacing the key as above takes the account back. An admin can't ban it either. If its account is deleted while others remain, the migration step fails until the compactor has purged the account (which frees its username), and then creates it again.
- `terraform destroy` removes the profile file with the deployment.



## Upgrading from the container deployment

These modules used to run the server as long-running containers. Applying them to a deployment made that way keeps the database, Redis and the bucket, and replaces what runs the server:

- **AWS:** the address stays the same (the CloudFront distribution is kept and pointed at the gateway). The load balancer and the ECS service that ran the API are removed; the compactor is an ECS service again. Expect errors for a few minutes while that happens.
- **GCP and Azure:** the address changes, to the gateway's (`*.gateway.dev`) or Front Door's (`*.azurefd.net`), and the old one stops working. Clients, and `PUBLIC_BASE_URL` if you set it yourself, need the new one. This server's own feeds build their links from `PUBLIC_BASE_URL` when they're read, so they follow.
- The variables for the containers' number and size (`app_count`, `app_cpu`, `app_memory` on AWS) are gone; `min_instances`, `max_instances`, `min_replicas` and `max_replicas` now apply to each group and have new defaults.

Run `terraform plan` first and read what it will destroy.

## Upgrading to the compactor as the only writer

In earlier versions the requests wrote posts and comments to the bucket themselves. Now they commit to the database, and the [compactor](#compactor) writes everything out. The two don't mix: a function or a node of the version before still writes the bucket itself, beside a compactor that now does. So every function and the compactor change version together, with the migrations that go with them (`0002_pending_writes`, which changes what requests write, `0003_staged_removals`, which only adds a table, and `0004_unnumbered_writes`, which makes `pending_writes` again, with a key for the new comments and the likes of comments that take no write number, and copies its rows):

- **With these modules,** one `apply` does it. It adds the rule that expires `staged/` to the bucket, and runs the migrations in its [first step](#deploy), before it updates the functions and the compactor. Between the migrations and the update, which is a few minutes, the functions of the version before run on the migrated database: they write a column that `0002_pending_writes` drops, so posts and updates sent then fail with a `500`. The compactor of the version before fails its passes for as long. Apply when the server is quiet, and have clients send again what failed.
- **Where you run it yourself,** stop every API node and the compactor, migrate, and start them all on the new version. A rolling restart leaves the two versions writing at once for its length. Give the bucket a rule that deletes objects under `staged/` after 7 days, as the modules do.
- **There's no way back with the same database.** The version before doesn't run on the migrated one.

This upgrade wasn't applied to a live deployment. The modules pass `terraform validate` with the new rule, and applying the writes that waited, and again after a pass that stopped, is covered by the server's tests, on SQLite.

## Upgrading to the `ev` prefixes

Three things change on the first `apply` of a version whose API keys start with `ev_` and whose Redis keys start with `ev:` (they were `tu_` and `tu:`). It also runs migration `0005_origin_gone`, which adds two columns to `content` and changes nothing else.

- **The feed index starts empty.** The modules don't set `REDIS_KEY_PREFIX`, so the functions and the compactor read and write under `ev:` from then on, where there's nothing yet: feeds are empty, and challenges and rate-limit counts start over. Run the [rebuild](#redis) straight after the apply, which fills the index from the database and the bucket. To skip that, keep the old prefix: `environment = { REDIS_KEY_PREFIX = "tu:" }`. The keys under `tu:` aren't deleted: those with no expiry (the index) stay in Redis until you delete them or flush it.
- **The deployment's admin key is replaced.** Terraform makes the key in the server's format, so the same apply gives the [admin account](#the-admin-account) a key that starts with `ev_`, revokes the one it had, and rewrites the profile file and the `admin_api_key` output. A copy of the old key kept anywhere else stops working.
- **Every other user's key keeps working.** The server still takes a key that starts with `tu_`; a key issued or replaced from now on starts with `ev_`.
- **AWS: the functions get a cap on instances** ([below](#scaling-and-the-database)), which needs room in the account's Lambda quota. Check it before applying.

This upgrade wasn't applied to a live deployment either. The modules pass `terraform validate`, and the migration, old keys and the new settings are covered by the server's tests, on SQLite.

## Uploads

A request to a function can't carry a large file. The limits on a file sent in the request to `/store`:


| Cloud | Largest file in a request                                 | Why                                                            |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------- |
| AWS   | About 4 MB                                                | Lambda takes 6 MB per request, and files arrive base64-encoded |
| GCP   | 32 MiB                                                    | Cloud Run's and API Gateway's limit on a request body          |
| Azure | None set by Container Apps; not tested through Front Door |                                                                |


Larger files go straight to the bucket: the client asks `[POST /uploads](API.md#post-uploads)` for a link, sends the file to it, and posts it with `/store` by its `uploadId`. Every module sets the bucket up for that:

- **CORS:** pages on `upload_origins` (any origin by default) may send files to the bucket from a browser. The link is the permission; this only tells browsers which pages may use one.
- **Expiry:** an upload nobody posts is deleted after a day (`uploads/` in the bucket). A file that waits for the [compactor](#compactor) to write it out is kept for a week (`staged/`).
- `MAX_UPLOAD_BYTES` is the largest file `/store` accepts either way. To post an upload, `/store` copies it within the bucket, inside the request's time limit: 30 seconds on AWS, `request_timeout` on GCP (300) and Azure (240). AWS is set to 256 MiB, GCP to 1 GiB and Azure to 512 MiB. Those are estimates of what fits, not measurements; time a large upload on your own deployment before raising them through `environment`.

On GCP, signing a link needs a private key, and Cloud Run's own credentials don't have one. So the services sign as their own service account through IAM (`signBlob`), with a key Google keeps: the module lets the account sign as itself (`roles/iam.serviceAccountTokenCreator`) and turns on the IAM Credentials API. There's no service account key to keep, in Secret Manager or in the Terraform state, so this also works in organisations that forbid them. The `direct_uploads` variable is gone: take it out of your variables if you set it. Each signature is a call to IAM, so a link to read a file with is given again for half the time it's good for, and if IAM can't be reached, `/uploads` answers `501` and files are read through the service for 30 seconds before it's asked again.

## Audit log

Every request that adds, updates or deletes something (a `POST`, `PUT`, `PATCH` or `DELETE` that succeeded) is logged. The records stay where they were written unless you turn on cold storage.

| Cloud | Where                                    | Cold storage, if turned on | Written by                                                        |
| ----- | ---------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| AWS   | S3 bucket `<name>-audit-…`               | Glacier Deep Archive       | Lambda functions (`s3:PutObject` only)                            |
| GCP   | GCS bucket `<project>-<name>-audit`      | Archive storage class      | Cloud Run services (`storage.objectCreator` only)                 |
| Azure | Container `audit` of the storage account | Archive tier               | Container Apps (a managed identity that may only write blobs)     |

Nothing moves records by default: `audit_archive_after_days` is unset (the same variable on every cloud). A record is one object of about 1 KB, and moving one that small costs more than keeping it. Each object moved is charged for ($0.05 per 1,000 on AWS and GCP, about $0.11 per 10,000 on Azure), and Deep Archive bills 40 KB of overhead on top of each, against about $0.02 a month to keep a million records where they are. So with the variable set to a number of days, AWS and GCP move only the records larger than 128 KB once they're that old. Azure's lifecycle rules can't filter by size, so there it moves every record. On AWS and Azure the archive tiers also have a minimum storage duration (180 days), and reading an archived record takes hours to restore. Nothing deletes records. The bucket is named in the `audit_bucket` output (`audit_container` on Azure).

The audit log is written by the functions that answer requests, in each request, before it is answered: a failed write is logged as an error and doesn't fail the request. The log of the functions themselves (CloudWatch, Cloud Logging, Log Analytics) also gets a line for each record, naming its object, for as long as that log is kept.

## Client addresses

The limits on registrations, on feeds and on the other reads that need no key (`REGISTER_RATE_LIMIT_PER_HOUR`, `FEED_RATE_LIMIT_PER_MINUTE`, `FEED_FOLLOWING_RATE_LIMIT_PER_MINUTE`, `CONTENT_RATE_LIMIT_PER_MINUTE`, `COMMENTS_LIST_RATE_LIMIT_PER_MINUTE`, `REPOSTS_ATTESTATION_RATE_LIMIT_PER_MINUTE`) count by the client's address, which the server reads from `X-Forwarded-For`, as far from the end as there are proxies in front of it (`TRUST_PROXY`). Nothing can reach the functions except through the address in front, so a client can't make one up:

- **AWS:** CloudFront sends a secret header (`X-Origin-Secret`) that the functions require, since the API Gateway's own address is public.
- **GCP:** the Cloud Run services only admit the gateway's service account. There's no `allUsers` binding.
- **Azure:** Front Door sends the same secret header, since each Container App's own address is public.

The number of proxies was checked against a live deployment of each module (November 2026), by sending requests with and without an `X-Forwarded-For` of their own, over IPv4 and IPv6, and reading `remoteAddress` in the functions' request logs:

- **AWS** (`TRUST_PROXY` fixed at 1) and **GCP** (`trust_proxy`, 2): every request was recorded under the sender's own address, whatever the header said.
- **Azure** (`trust_proxy`, 2): the same, for every request an app was up for. A request that waited for an app to start from no replicas was recorded under an address of Front Door's own (in its `AzureFrontDoor.Backend` ranges, such as `69.15.x.x` and `147.243.x.x`), with the sender's address one entry further back: it looks as if Front Door sent the slow request again through a second address of its own, which adds a hop. Those few requests are limited and audited as that address. Don't raise `trust_proxy` for them: at 3, every other request could choose its own address. `min_replicas = 1` keeps an app up, and then there are none.

A cloud can change what stands in front of a service, so it's worth a look after the first apply: make a request and read `remoteAddress` in the function's request log, which should be your own public address. If nearly every request shows a Google or Microsoft address, raise `trust_proxy` by one; if it's something a client could choose, lower it. While every reader is seen as one of a few such addresses, they share one address's limits, and most get `429` once those are used. The server logs a warning when it sees that: one address counted as the client, with 20 different public addresses just before it in `X-Forwarded-For`. Setting a limit to `"0"` in `environment` turns it off until the number is right.

## Compactor

The compactor is one container that's always up, and makes pass after pass. Each pass writes out the posts and comments that requests committed since the one before, to the bucket and Redis, and then brings the feed index up to date. It isn't a function and nothing calls it: it has no address, and reaches Redis, the database and the bucket from inside the network, as the functions do.

The same container asks other servers, over `https`, for the attestations of the posts the instance holds reposts of ([API.md](API.md#refreshing-a-repost)): each about once a day, at most 30 a minute. So it needs a way out to the internet, which each module's network gives it as it gives the functions: the NAT gateway on AWS, and directly on GCP and Azure. Without one, the rest of its work is unaffected, its log has a warning an hour for each server it couldn't reach, and reposts follow their originals only when a client brings an attestation. `REPOSTS_REFRESH_HOURS = "0"` in `environment` turns the asking off.


| Cloud | What runs it                                                                | Kept at one by                                                                    |
| ----- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| AWS   | An ECS Fargate service in the private subnets                               | `desired_count = 1`; a deploy stops the running task before it starts the new one |
| GCP   | A Cloud Run worker pool, which is Cloud Run for work that takes no requests | Manual scaling, one instance                                                      |
| Azure | A Container App with no ingress                                             | `min_replicas = max_replicas = 1`, single revision mode                           |


How it's paced:

- **Never two passes at once, and never more than one in 5 seconds.** A pass starts `COMPACT_INTERVAL_SECONDS` (5) after the previous one started, or as soon as that one ends if it took longer. Being one process, it can't overlap itself. To change the pace, set `COMPACT_INTERVAL_SECONDS` through `environment`.
- **Two containers still can't overlap.** Each pass takes the compactor's lease in the database, and a pass that finds it held is skipped. That covers the moments when two are up: a deploy that starts the new one before the old has gone (GCP and Azure can), or a rebuild started by hand. A pass renews the lease for as long as it runs, so a slow write to the bucket doesn't let a second container in.
- **If it stops, the platform starts it again.** A container that's killed mid-pass leaves the lease held until it expires (`COMPACT_LEASE_SECONDS`, 60), and the next pass after that carries on from where the index was: what the killed pass wrote but hadn't published expires by itself.
- **A deploy ends a pass cleanly where it can.** On being told to stop, the compactor finishes the writes it's making, starts no more, frees the lease and exits. That takes as long as the writes under way do, not the rest of the pass, and the next pass, of the container that replaces it, does what was left. AWS and Azure are set to give it two minutes for that. Cloud Run gives a container about ten seconds, and a compactor that hasn't exited by then is killed mid-pass, as above.

What waits for it:

- **Only the compactor writes posts and comments to the bucket.** A request commits its write to the database, and stores a file it came with under `staged/` in the bucket. The next pass writes it out where it's kept (`content/`, `comments/`, `summaries/`), each post and each comment as the newest write of it has it. The staged file is deleted once it's copied, or where the store signs links to its files, once a link given to it can no longer be in use: `CONTENT_SIGNED_URL_SECONDS` (900) and a minute later, by a pass after that. [APP.md](APP.md#what-it-does-each-run) has the details.
- **While it's down, writes are taken and wait.** A post, a comment or a like is answered as ever, and a post or a comment can be read by its id. No feed gets a new post or an update, and no list a new comment, until a pass has run. The passes after it's back write out everything that waited.
- **A staged file is kept for a week.** Every module's bucket deletes what's under `staged/` after 7 days, which clears the files of requests that failed after storing one. A file that waited that long for the compactor goes too, so don't leave the compactor stopped for a week: a post whose file is gone can't be written out until it's next updated, a comment whose file is gone is published with its text alone, or removed if the file was all there was to it, and [APP.md](APP.md#11-consistency-failure-and-recovery) says what that leaves.

Its size is `compactor_cpu` and `compactor_memory` (half a CPU and 1 GB on AWS and Azure, one CPU and 1 GiB on GCP). It runs all the time, so unlike the functions it costs the same with or without traffic: about $18 a month on AWS at the default size, from Fargate's list prices in `us-east-1`. `terraform output compactor` names it, for finding its logs (on AWS, the log group too).

None of this was applied to a live account for this change: the modules pass `terraform validate`, and the pacing, the lease and stopping mid-pass are covered by the server's tests. That the compactor's container reaches other servers is read from each module's network, and wasn't tried on a live one.

## Scaling and the database

Each group scales on its own, and the feed group holds no database connections. The other three groups do, and the database's connection limit is what bounds them:

- **AWS:** the functions connect through RDS Proxy, which shares up to 75% of the database's connections among however many instances are running.
- **GCP and Azure:** the small database sizes these modules default to have no built-in pooler, so the limit is arithmetic: `3 x max_instances x db_pool_size + 5` (or `max_replicas`) must stay within the database's connections, which is 50 on `db-g1-small` and 35 usable on `B_Standard_B1ms`. The defaults (3 instances of 4 connections; 3 replicas of 3) fit. To scale further, raise `db_tier` or `db_sku` with them.

`min_instances` and `min_replicas` are 0, so a group with no traffic costs nothing and its next request waits for an instance to start. Set them to 1 to keep one warm.

Every group has a cap on instances, the feed group too. The limits by address can't tell a flood from many addresses from many readers, so the cap is what bounds what such a flood costs, in Redis load and on the bill: past it, the platform refuses requests itself.

| Cloud | Groups that use the database | The feed group |
| ----- | ---------------------------- | -------------- |
| AWS   | `function_max_concurrency` (50) | `feed_function_max_concurrency` (100) |
| GCP   | `max_instances` (3) | `feed_max_instances` (10) |
| Azure | `max_replicas` (3) | `feed_max_replicas` (10) |

- **On AWS the cap is Lambda's reserved concurrency.** A Lambda instance takes one request at a time, so it's also how many requests a function answers at once, and the server's own bound on feeds at a time (`FEED_MAX_CONCURRENT`) is never reached there. One request more is refused by Lambda, and the gateway answers it with an error; it isn't queued.
- **Reserved concurrency comes out of the account's quota,** which must keep 100 unreserved. The defaults reserve 250 (100 for feeds, 50 for each of the other three), so they need a quota of 350: `aws lambda get-account-settings` shows it. An established account has 1,000; a new one may have less, and the apply then fails on the functions. Lower the two variables, ask AWS for a larger quota, or set them to `null`, which sets no cap and reserves nothing.
- GCP's and Azure's instances take many requests at a time each, so their caps are lower.

## What to expect

Measured for this change, with the limits of each measurement:

- **Latency once warm:** on one machine (1 vCPU and 1 GB per container; Valkey, Postgres and an S3-compatible store beside them), a 10-hashtag feed took 6 ms at the median from a group's own container and 10 ms through the Lambda runtime, against 6 ms from the whole server. A text post took 41 ms from either, against 44 ms. This compares the function code with the server, not one cloud's network with another's.
- **Cold starts:** on AWS Lambda in `us-east-1`, a new instance took 1.0 to 1.6 seconds to start at 1,024 MB (the feed function; 1.1 to 2.3 for the store function), almost all of it loading the server's code, then answered in 30 to 60 ms. More memory made little difference. This was measured outside a VPC with no Redis or database to connect to, so a real cold start adds those connections. Cloud Run and Container Apps weren't measured; Container Apps starting from zero also pulls the image, which usually takes much longer.
- **Cost:** functions swap the cost of containers that run all the time for a cost per request, plus the address in front. From list prices, with the database, Redis, bucket and data transfer left out as they don't change: AWS costs about $70 a month before any traffic (NAT gateway $33, RDS Proxy $22, the Secrets Manager endpoint $15) and about $1.45 per million requests after (API Gateway $1.00, Lambda $0.45), which is less than two always-on containers and a load balancer up to roughly 30 million requests a month and more beyond. On GCP the functions themselves are cheap, but API Gateway is $3.00 per million calls after the first 2 million. On Azure, Front Door adds $35 a month and $0.90 per million requests, the database's private endpoint about $7 a month, and four apps that each stay up for five minutes after a request cost more than one container until there's enough traffic to need several. For a busy server, compare a load balancer with path rules (GCP), or setting `min_replicas` and sizing by hand (Azure).



## Redis

Every module sets the eviction policy to `volatile-lru`. Only keys with a TTL (hot summaries, comments, challenges and superseded index keys) are ever evicted, so a full Redis costs object-store reads, never the index.

Size it for about 25 bytes per indexed post per hashtag (10,000 busy hashtags take about 1.1 GB) plus about 0.4 KB per post of the last 8 days (about 0.3 GB at 100,000 posts a day). Comments are kept for a day (`COMMENTS_HOT_HOURS`), and a million a day need about 0.5 GB. The defaults have about 1 GB; raise `redis_node_type`, `redis_memory_gb` or `redis_sku` as you grow. [APP.md](APP.md#12-performance-and-scale) has the details.

If Redis loses its data, run the compactor once with `--rebuild`. It rebuilds the feed index, the hot summaries and the publisher credits from the database and the content bucket. Comments need no rebuild: each post's are read from the bucket again the first time they're asked for. A rebuild reads every post, so it's a container task or job of its own rather than a pass of the running compactor. Each module keeps one for it, and prints the command that starts it:

```sh
terraform output -raw rebuild_command   # then run what it prints

# AWS: a one-off ECS task in the private subnets
aws ecs run-task --cluster evieverse --task-definition evieverse-rebuild --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-...],securityGroups=[sg-...],assignPublicIp=DISABLED}'

# GCP
gcloud run jobs execute evieverse-rebuild --region us-central1 --wait

# Azure
az containerapp job start --resource-group evieverse-rg --name evieverse-rebuild
```

It runs beside the compactor. If the compactor is mid-pass, the rebuild waits for the pass to end (logging that another run holds the lease meanwhile), and the compactor's passes are skipped while the rebuild runs.

## Notes per cloud

**AWS**

- CloudFront supplies HTTPS with its default certificate, and is the only way in: the functions refuse requests that don't carry the secret header it adds.
- API Gateway gives a function 30 seconds, so a post whose AI analysis takes longer gets a 503. This limit can't be raised on an HTTP API.
- The functions run in the VPC's private subnets, next to Redis and the database. They reach the internet (AI services) through one NAT gateway, S3 through a gateway endpoint, which is free, and Secrets Manager through an interface endpoint in both zones, which isn't (about $15 a month). If the NAT gateway's availability zone fails, the functions lose the internet until it's back, but not Redis, the database, S3 or their secrets, so new instances still start.
- A Lambda response can be at most 6 MB. Feed pages are far smaller, and `/content/:id/raw` answers with a redirect to a signed S3 link rather than the bytes.
- ElastiCache runs a primary plus `redis_replicas` replicas (default 1) on `redis_node_type` (default `cache.t4g.small`, about 1.4 GB). With a replica, failover is automatic and the nodes span availability zones. It requires TLS and an AUTH token, and keeps a daily snapshot for one day.
- `function_memory` (1,024 MB) also sets a function's share of CPU. The store function gets `store_function_memory` (2,048 MB), since it takes uploads.
- `force_destroy = true` lets `terraform destroy` delete the content bucket and the database without a final snapshot.

**GCP**

- API Gateway runs in fewer regions than Cloud Run. If yours isn't one of them, set `gateway_region` to the nearest that is.
- The gateway signs in to the services with its own `Authorization` header, and passes the client's on as `X-Forwarded-Authorization`, which the server reads first. Clients send `Authorization: Bearer <apiKey>` as usual.
- Cloud Run and API Gateway limit request bodies to 32 MiB; larger files use [upload links](#uploads).
- Memorystore uses `redis_tier` (default `STANDARD_HA`, with a replica in another zone) and `redis_memory_gb` (default 1). Cloud Run reaches it through direct VPC egress, with the AUTH string. Traffic stays inside the VPC unencrypted, because Memorystore's TLS uses a private CA the app doesn't load.
- `deletion_protection = false` is required before `terraform destroy` can delete Cloud SQL and the content bucket.

**Azure**

- Front Door Standard supplies HTTPS and the one address. It waits `request_timeout` seconds (240 at most) for an app to answer.
- Front Door sends requests by path only, so a rule on `/content/*` sends everything but `GET`, `HEAD` and `OPTIONS` to the api group, which is where `DELETE /content/:id` belongs, and writing and deleting comments.
- A group at zero replicas takes its next request only after a replica has started, which includes pulling the image. Set `min_replicas = 1` if that wait matters more than the cost.
- Azure Managed Redis uses `redis_sku` (default `Balanced_B1`) and `redis_high_availability` (default `true`). Its Enterprise cluster policy presents one endpoint, so the app connects as it would to a single Redis, over TLS on port 10000 with an access key.
- The Redis access key reaches the containers only as a Container Apps secret. Blob Storage takes no account key at all: shared keys are turned off on the account, and the apps, the compactor and the jobs reach it as one managed identity. That identity may read, write and delete blobs in the content container, only write them in the audit container, and ask the account for the key upload links are signed with (a user delegation key, good for an hour at a time). Downloads aren't signed links: `/content/:id/raw` streams the bytes through the Container App and Front Door, where on AWS and GCP it redirects to the bucket.
- Giving the identity its roles takes more than Contributor: whoever applies needs Owner, or User Access Administrator beside Contributor, on the subscription or the resource group.
- PostgreSQL has no public address. The apps, the compactor and the jobs run in a virtual network, and reach the database through a private endpoint in it. TLS is required.
- Some subscriptions may not create PostgreSQL Flexible Servers in some regions, and the apply then fails with `The value of the 'Version' should be in: []`. Set `db_location` to a region that allows them, which puts only the database there: `az postgres flexible-server list-skus --location <region>` lists what a region allows, and names the restriction where there is one. The private endpoint stays in `location` and reaches the database across regions, so choose one nearby (`eastus2` for `eastus`). Set it before the database holds anything: changing it replaces the database.
- Container Apps needs the `Microsoft.App` resource provider, which a new subscription hasn't registered. The module registers it at the start of an apply, so whoever applies must be allowed to register resource providers (Contributor and Owner are).



## Setting it up yourself

Without these modules, the server runs on any of each cloud's services below, as long-running API nodes with one compactor (`node dist/server.js`, `node dist/compact/main.js`), or as functions (`node dist/functions/http.js` for containers that scale with traffic, `node dist/functions/lambda.js` on Lambda, with `FUNCTION_GROUP` naming the group). The rules that apply on every cloud, and the ones functions add, are in [APP.md](APP.md#13-deployment-topology).

With functions, run the step the modules run before you update them, with the settings they're about to get: `node dist/functions/migrate.js` as a job, or the Lambda entry point with `FUNCTION_GROUP=migrate`. It checks that the functions start with those settings, and then migrates the database. Nothing else tells you about a setting the server refuses until requests fail, since updating a function doesn't start it.

For the instance's posts to be reposted on other servers, give it a signing key and its public address (`REPOSTS_SIGNING_KEYS` and `PUBLIC_BASE_URL`, in [CONFIG.md](CONFIG.md#reposts)), and a way out to the internet over `https`, to ask other servers for their keys.

**AWS**


| Piece                 | Recommended                                                                                                                                | Alternatives                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Content and summaries | S3: `CONTENT_SCHEME=s3`, `CONTENT_OPTIONS='{"bucket":"tu-content","region":"us-east-1"}'`                                                  |                                     |
| Redis                 | **ElastiCache for Valkey or Redis OSS**, cluster mode disabled, with a replica: `REDIS_URL=rediss://:<auth token>@<primary endpoint>:6379` | Valkey or Redis on EC2              |
| API                   | EC2 Auto Scaling or ECS Fargate behind an ALB                                                                                              | EKS                                 |
| Compactor             | An ECS service of one task running `node dist/compact/main.js`                                                                             | The same on EC2 or EKS, as one copy |
| Database              | RDS PostgreSQL or MySQL                                                                                                                    | Aurora                              |


ElastiCache Serverless and MemoryDB only run in cluster mode, so they aren't supported.

**Google Cloud**


| Piece                 | Recommended                                                                                                            | Alternatives                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Content and summaries | Cloud Storage: `CONTENT_SCHEME=gcs`, `CONTENT_OPTIONS='{"bucket":"tu-content","credential_path":"/secrets/gcs.json"}'` |                                                         |
| Redis                 | **Memorystore for Redis**, Standard tier, with AUTH: `REDIS_URL=redis://:<auth string>@<host>:6379`                    | Valkey or Redis on Compute Engine                       |
| API                   | Cloud Run with direct VPC egress, a Managed Instance Group, or GKE, behind a Cloud Load Balancer                       |                                                         |
| Compactor             | A Cloud Run worker pool of one instance running `node dist/compact/main.js`                                            | A GKE Deployment of one replica, or a Compute Engine VM |
| Database              | Cloud SQL for PostgreSQL or MySQL                                                                                      | AlloyDB                                                 |


Memorystore for Redis Cluster runs in cluster mode, so it isn't supported.

**Azure**


| Piece                 | Recommended                                                                                                                                                                  | Alternatives                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Content and summaries | Blob Storage: `CONTENT_SCHEME=azblob`, `CONTENT_OPTIONS='{"container":"content","endpoint":"https://acct.blob.core.windows.net","account_name":"acct","account_key":"..."}'` |                                           |
| Redis                 | **Azure Managed Redis** with the Enterprise cluster policy: `REDIS_URL=rediss://:<access key>@<host>:10000`                                                                  | Azure Cache for Redis, without clustering |
| API                   | VM Scale Sets, AKS, or Container Apps behind Front Door or an Application Gateway                                                                                            |                                           |
| Compactor             | A Container App of one replica, with no ingress, running `node dist/compact/main.js`                                                                                         | An AKS Deployment of one replica          |
| Database              | Azure Database for PostgreSQL or MySQL Flexible Server                                                                                                                       |                                           |




## Custom domains

- **AWS:** add `aliases` and an ACM certificate (issued in `us-east-1`) to the CloudFront distribution.
- **GCP:** put a global external load balancer in front of the gateway (a serverless NEG of the API Gateway type), with your certificate.
- **Azure:** add `azurerm_cdn_frontdoor_custom_domain` to the Front Door profile, with a managed certificate, and associate it with the routes.

In every case, also set `PUBLIC_BASE_URL` through `environment` so that links the server generates use the new domain.