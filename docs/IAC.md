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
| `content` | `GET /content/:id`, `GET /content/:id/raw`, `GET /content/:id/raw/:n`, `GET /content/:id/video/:videoId/:file`, `GET /content/:id/attestation`, and reading a post's comments: `GET /content/:id/comments`, `GET /content/:id/comments/:commentId` | Database, bucket, and Redis for comments          |
| `store`   | `POST /uploads`, `POST /store`                                                                                                                                                 | Database, Redis, bucket                           |
| `api`     | Everything else                                                                                                                                                                | Database, Redis, bucket                           |




## Prerequisites

- Terraform 1.5 or newer.
- Docker for AWS and GCP (the image is built locally and pushed). Azure builds remotely with `az acr build`, so Docker isn't needed there.
- No Rust on your machine: the compactor and the trust plugins are Rust, and the image's build compiles them inside the image. That makes the first build take several minutes. The image is built for `linux/amd64`, so on a machine with another kind of CPU (an Apple Silicon Mac) Docker emulates that build, which is slower still.
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

1. It checks the settings. It's given the settings the functions are about to get, and starts each route group with them as its function would. A setting the server refuses, such as a misspelt plugin name in `TRUST_OPTIONAL_PLUGINS` or a `TAGGING_MODE=server` with no hashtags, fails the step with the reason.
2. It runs the migrations, and sets up the [admin account](#the-admin-account).

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

For `pdq`, which refuses posts and comments with an [image of known child sexual abuse material](TRUST_PLUGINS.md#images-of-known-child-sexual-abuse-material) and tells the admins, name it and say where its list of hashes is, with the list's Authorization header in `secrets` if it asks for one:

```hcl
environment = { TRUST_OPTIONAL_PLUGINS = "pdq", PDQ_HASH_LIST = "https://hashes.example.com/pdq.csv" }
secrets     = { PDQ_HASH_LIST_AUTHORIZATION = "Bearer ..." }
```

- Set them in the same `apply`. The server doesn't start with `pdq` named and no list, so the modules check for it as they do for `urlhaus`: the plan fails if `TRUST_OPTIONAL_PLUGINS` names `pdq` and `PDQ_HASH_LIST` is empty, or in neither `environment` nor `secrets`. The check is on the setting being there, not on the list being one the server can read.
- Give the list as an address. A path is a file on the function's own disk, so the list would have to be in the image.
- Each function instance reads the list when its first post or comment arrives, and keeps it while it lives, about 100 bytes a hash: count a long list in the functions' memory. A post or a comment with an image that reaches a new instance waits for that download, on top of the cold start.
- The functions need a way out to the list's host, which the three modules give them as they do for URLhaus. If the list can't be read, posts and comments with an image fail with `500` on instances that have no list yet.
- A match is told to the deployment's [admin](#the-admin-account), in its inbox, and to every other admin, and is a warning in the function's log. The server reports it to nobody else: that is yours to do.
- Videos are checked too, by the [compactor](#videos)'s container, before they're published. It gets `environment` and `secrets` as the functions do, so there is nothing more to set, and it reads the list itself: count the list in `compactor_memory` as well.
- The file that matched is kept only if you set up a [quarantine](#quarantine), which the modules don't do for you.

For `synthid`, which holds or refuses posts and comments with an [image that carries a SynthID watermark](TRUST_PLUGINS.md#images-made-with-ai), which says it was made with AI, name it in `environment` and put the detector's API key in `secrets`:

```hcl
environment = { TRUST_OPTIONAL_PLUGINS = "synthid" }
secrets     = { SYNTHID_API_KEY = "..." }
```

- Set both in the same `apply`. The server doesn't start with `synthid` named and no key, so the modules check for it as they do for `urlhaus`: the plan fails if `TRUST_OPTIONAL_PLUGINS` names `synthid` and `SYNTHID_API_KEY` is missing or empty. The check is on the key being there, not on the detector accepting it: with a key it refuses, images wait in the moderation queue unchecked, and the function's log has an error for each.
- Each image is sent to the detector while its post waits, so the functions need a way out to it (`api.openai.com`, unless `SYNTHID_URL` names another), which the three modules give them as they do for URLhaus. If it can't be reached, posts and comments with an image are held for a moderator, unless `SYNTHID_UNCHECKED = "allow"` lets them through.
- The request that sent an image waits for the detector, up to 15 seconds an image, with the images of an album asked about four at a time. `request_timeout` on GCP (300) and Azure (240) leaves room for that. On AWS a request has 30 seconds, so while the detector answers slowly, an album of more than four images can run past it.
- The [compactor](#compactor)'s container gets `environment` and `secrets` as the functions do, so there is nothing more to set. It sends no image itself.

**The signing key for reposts**

Each module makes the key the instance signs its posts with, which is what lets them be [reposted on other servers](API.md#a-post-on-another-server): 32 random bytes, kept with the instance's other secrets as `REPOSTS_SIGNING_KEYS`. There's nothing to set.

- To replace the key, run `terraform apply -replace=random_bytes.repost_signing`. Nothing of the old key has to be kept: an attestation is asked for when it's used, and is good for 10 minutes at most. A server that has the old key asks for the instance's keys again when it meets the new one, at most once a minute, so at worst it refuses reposts of the instance's posts for a minute after the change.
- To sign with keys of your own, put `REPOSTS_SIGNING_KEYS` in `secrets`, and the module's key isn't used. Several keys, separated by commas or spaces, change the key with no gap: the first signs, and all are published.
- To sign nothing, set `REPOSTS_SIGNING_KEYS = ""` in `environment`. The instance's posts are then reposted only on the instance itself.
- The key is in the Terraform state, in plain text, like the other secrets these modules create.
- To check a repost of a post on another server, the functions ask that server for its public keys over `https`. That takes the same way out as above: the NAT gateway on AWS, and directly on GCP and Azure.
- The [compactor](#compactor)'s container asks other servers too: about once a day, for the attestation of each post the instance holds a repost of (`REPOSTS_REFRESH_HOURS`). It takes the same way out.

[CONFIG.md](CONFIG.md) lists all settings.

## The admin account

Initial deployment creates an [admin](API.md#moderation) account:

1. Terraform makes the account's id and API key, in the format the server issues keys in. The key is random, and exists in two places only: the Terraform state, and the profile file below.
2. The migration step creates the account. It's given the key's SHA-256, not the key (`BOOTSTRAP_ADMIN`), and after the migrations it creates the user if it isn't there, makes it an admin, and, if the key is new to the account, makes that key its only one. It runs again whenever the image, a setting or the account's values change, and changes nothing about the account when its values haven't.
3. The key is installed on the machine that applies, once the account exists: Terraform writes `~/.evieverse/profiles/<name>.json` (`name` is the module's variable, `evieverse` by default, unless `admin_profile_name` gives the profile a name of its own), readable only by you. That's a profile of the server's [CLI](CLI.md), so after installing the CLI, it works as the admin with no sign-in:

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
| `admin_username`        | `admin` | The account's username when it's created. It fails the apply if another user has it. It's the account's name for good: a username can't be changed, and changing this variable later renames nothing. |
| `install_admin_profile` | `true`  | Write the profile file. Set it to `false` where applies run unattended (CI), and read the key with `terraform output -raw admin_api_key`.                                     |
| `admin_profile_name`    | `""`    | The profile's name, and so its file's. Empty: the same as `name`. A name is 1 to 64 letters, digits, `.`, `_` and `-`, the first a letter or a digit.                         |



| Output          |                                                                 |
| --------------- | --------------------------------------------------------------- |
| `admin_user_id` | The account's `userId`.                                         |
| `admin_api_key` | Its API key (sensitive): `terraform output -raw admin_api_key`. |
| `admin_profile` | The profile file the apply wrote, if it did.                    |


Things to know:

- On another machine, sign in with the outputs: `EVIEVERSE_API_KEY="$(terraform output -raw admin_api_key)" evieverse login "$(terraform output -raw url)" "$(terraform output -raw admin_user_id)"`. A machine that applies an existing deployment gets the profile file written too.
- The key is in the Terraform state, in plain text, like the database password and the other secrets these modules create. Keep the state where only the deployment's operators can read it (an encrypted remote backend, rather than a file in the repo).
- To replace the key, run `terraform apply -replace=random_password.admin_key`. The migration step gives the account the new key and revokes the old one, and the profile file is rewritten.
- A key replaced through the API lasts, but the deployment doesn't learn of it (`[POST /users/:userId/key](API.md#post-usersuseridkey)`, or `evieverse key rotate`). Later applies leave the new key in place, and the deployment's key stays revoked. Terraform still holds the old key, so the `admin_api_key` output no longer works, and the next apply writes the old key back to the profile file, over the one `key rotate` saved there. To give the deployment a working key again, replace the key as above.
- The account is a break-glass one. Make your own account an admin with it, and use that from day to day. It can't be locked out for good by the API: the server refuses to revoke or delete its only admin, and if this account's role is revoked while others remain, the next apply that runs the migration step restores it. If another admin replaces its key, replacing the key as above takes the account back. An admin can't ban it either. If its account is deleted while others remain, the migration step fails until the compactor has purged the account (which frees its username), and then creates it again.
- `terraform destroy` removes the profile file with the deployment.

## Deploying a change

Change the setting in `terraform.tfvars`, then apply. A setting is read by each process on its own, so every process that reads it needs the new value: the functions and the compactor. The modules give them all the same settings. [CONFIG.md](CONFIG.md) lists the settings, and [DOCKER.md](DOCKER.md#deploying-a-change) has the same for an instance in Docker.

A change to a **language or a plugin** is a change to the code. It needs a rebuild, which a Terraform apply does on its own. A change to a setting never needs one.

### With the Terraform modules

Settings go in the module's `environment` variable, and credentials in `secrets` ([Settings](#deploy)). Both are maps of strings, written [as CONFIG.md shows](CONFIG.md#how-to-write-a-value), in `terraform.tfvars` (which is git-ignored, and which Terraform reads without being told):

```hcl
# deploy/terraform/<cloud>/terraform.tfvars
environment = {
  TAGGING_MODE        = "server"
  TAGGING_SERVER_TAGS = "news,local"
  CORS_ORIGINS        = "https://app.example.com"
}
```

Then deploy it, from the module's directory, with the same `-var` flags you first applied with (or put those in `terraform.tfvars` too, and leave them out here):

```sh
# AWS
cd deploy/terraform/aws
terraform plan  -var region=us-east-1
terraform apply -var region=us-east-1

# Google Cloud
cd deploy/terraform/gcp
terraform plan  -var project_id=my-project -var region=us-central1
terraform apply -var project_id=my-project -var region=us-central1

# Azure
cd deploy/terraform/azure
terraform plan  -var subscription_id=00000000-0000-0000-0000-000000000000 -var location=eastus
terraform apply -var subscription_id=00000000-0000-0000-0000-000000000000 -var location=eastus
```

`terraform plan` shows what the apply would change without changing it. For a setting, it should list only the functions and the compactor. To apply exactly the plan you read, in a pipeline or after a review, save it:

```sh
terraform plan -out=settings.tfplan [the same -var flags]
terraform apply settings.tfplan
```

The first time in a checkout, run `terraform init` too. The apply prints `url` again at the end, and `terraform output url` shows it later.

What the apply does depends on what you changed:


| You changed                                   | The apply                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` or `secrets`                    | Checks the new settings, and only then updates every function and the compactor with them. If the server refuses one, the apply stops there with the old settings still in use ([below](#when-a-setting-is-refused)). It doesn't rebuild the image, and the migrations have nothing to do. Running instances are replaced by ones with the new settings: a new Lambda configuration, a new Cloud Run revision, a new Container Apps revision. The compactor stops, finishing its pass where it can, and starts again, so there's a moment with none, which the next pass makes up. |
| A language, a plugin, or any file under `src` or `compactor` | Rebuilds the image and pushes it, checks the settings with the new image and runs the migrations, and only then updates the functions and the compactor. If either fails, the apply stops there with the old functions still serving.                                                                                                                                                                                                  |
| `image`                                       | The same, with the image you name instead of one it builds.                                                                                                                                                                                                                                                                                                                                                                             |


Things to know:

- Some settings are set by the module, and `environment` replaces them. The modules set `DB_DIALECT`, `CONTENT_SCHEME`, `CONTENT_OPTIONS`, `PUBLIC_BASE_URL` and, per cloud, `STORAGE_TMP_PATH` and `MAX_UPLOAD_BYTES` ([the limits](#uploads)). A value in `environment` takes their place, and the apply checks only that the server starts with it, not that it suits the deployment: `DB_DIALECT=mysql`, against the PostgreSQL the module made, passes the check and breaks the instance.
- `TRUST_PROXY` differs by cloud. On GCP and Azure it follows the module's `trust_proxy` variable (2), and an `environment` value replaces that. On AWS it's fixed at `1` for the functions, and an `environment` value is ignored by them. Change it on GCP and Azure with the variable ([Client addresses](#client-addresses)).
- `DB_POOL_SIZE` on GCP and Azure is the module's `db_pool_size` variable, which an `environment` value overrides. Keep to the connection arithmetic in [Scaling and the database](#scaling-and-the-database).
- `secrets` on AWS are read by version. They're kept in Secrets Manager, not in a function's configuration. A function reads them as an instance starts, and the compactor's task is given them as it starts, each by the version the apply wrote, not the current one. So a changed secret is a new function configuration and a new task definition, which wait for the settings check like any other change, and the compactor restarts with the new value by itself.
- `secrets` on GCP are read by version. Each value in `secrets` is a version of a secret in Secret Manager, and the services, the compactor and the jobs read the version the apply wrote, by its number, not the latest. So a changed secret is a new revision, which waits for the settings check like any other change, and the version before it is deleted once the services read the new one.
- The signing key for reposts is the module's too. Each module makes a key and gives it to the functions as `REPOSTS_SIGNING_KEYS` ([above](#deploy)). To sign with keys of your own, put `REPOSTS_SIGNING_KEYS` in `secrets`; to sign nothing, set it to `""` in `environment`.
- Changing where data lives doesn't move it. `CONTENT_SCHEME`, `CONTENT_OPTIONS`, `SUMMARY_SCHEME`, `SUMMARY_OPTIONS`, `AUDIT_SCHEME` and `AUDIT_OPTIONS` point the server at another store, which starts empty, and so do `QUARANTINE_SCHEME` and `QUARANTINE_OPTIONS` ([Quarantine](#quarantine)). Likewise, a new `REDIS_KEY_PREFIX` points it at an empty index, which the [rebuild](#redis) fills from the database and the content store.
- `PUBLIC_BASE_URL` for a custom domain goes in `environment` too ([Custom domains](#custom-domains)).
- Leave `BOOTSTRAP_ADMIN`, `FUNCTION_GROUP`, `FUNCTION_EDGE_SECRET`, `AUDIT_SCHEME` and `AUDIT_OPTIONS` out of `environment`. The modules set them, and the admin account has [variables of its own](#the-admin-account).
- Keep `terraform.tfvars` and the state where only the people who deploy can read them. The secrets are in the state in plain text.

To check a change took effect, ask the instance. `curl "$(terraform output -raw url)/health"` says it's up, and a setting with a visible effect shows itself: `GET /tagging` lists the hashtags in server mode, and a browser request from an origin shows whether `CORS_ORIGINS` allows it. For one that doesn't, the function's or compactor's log shows the settings it started with. `terraform output compactor` names the compactor, and its log group on AWS.

### When a setting is refused

Updating a function doesn't start it, so a setting the server refuses wouldn't show until requests failed. The apply checks first instead. Before it updates anything, it runs one step (the migrate function on AWS, the migrate job on GCP and Azure) with the settings the functions are about to get, which starts each route group as its function would. If the server doesn't start with them, the step fails and the apply stops:

- Nothing was changed. The functions and the compactor keep the settings they had, and go on serving.
- The step's log says which setting, and why, for example "the functions would not start with these settings, so nothing was changed: TRUST_OPTIONAL_PLUGINS names urlhouse, which isn't one of the trust plugins this server was built with…". The step is named after the deployment, `<name>-migrate`: on AWS its log group is `/aws/lambda/<name>-migrate`, and on GCP and Azure it's the job's log.
- Fix the value and apply again. The step runs again on every apply until it passes.

What the check catches is what stops the server from starting: a value in the wrong format, a name that isn't one (a plugin in `TRUST_OPTIONAL_PLUGINS`, a `CONTENT_SCHEME`, a `DEFAULT_LANGUAGE` with no file), and settings that need each other (`TAGGING_MODE=server` without `TAGGING_SERVER_TAGS`, `urlhaus` without `URLHAUS_AUTH_KEY`, `pdq` without `PDQ_HASH_LIST`, `synthid` without `SYNTHID_API_KEY`). The last three of these fail sooner, in the plan. What it doesn't catch is a value the server starts with but that is wrong: a bucket that doesn't exist, or a key a service refuses, shows when it's used.

### Without the Terraform modules

Where you built the cloud setup yourself ([Setting it up yourself](#setting-it-up-yourself)), change the settings where your platform keeps them, so that each API node, function and the compactor starts with them. Most platforms start new instances for a changed setting and retire the old, and the commands below do that:


| Platform                        | What to change                                       | How                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS ECS** (API, compactor)    | The container's `environment` in the task definition | Register a new revision, then `aws ecs update-service --cluster <cluster> --service <service> --task-definition <family> --force-new-deployment`                                                  |
| **AWS Lambda**                  | The function's configuration                         | `aws lambda update-function-configuration --function-name <name> --environment 'Variables={KEY=value,...}'`. This replaces all the function's variables, so list every one, not only the changed. |
| **Google Cloud Run** (services) | The service's environment variables                  | `gcloud run services update <service> --region <region> --update-env-vars KEY=value`. It starts a new revision. Update a worker pool's environment too, if the compactor runs in one.             |
| **Azure Container Apps**        | The app's environment variables                      | `az containerapp update --name <app> --resource-group <group> --set-env-vars KEY=value`. A secret is `KEY=secretref:<secret>`, set first with `az containerapp secret set`.                       |
| **Kubernetes** (GKE, AKS, EKS)  | The ConfigMap or Secret the pods read                | `kubectl apply -f <file>`, then `kubectl rollout restart deployment/<name>`. Pods don't take a changed ConfigMap into their environment until they restart.                                       |


A function isn't started by updating it, so a setting the server refuses shows only when requests fail. Check the settings first, as the modules do: run `node dist/functions/migrate.js` (on Lambda, the function whose `FUNCTION_GROUP` is `migrate`) with the settings the functions are about to get, and update them only if it succeeds ([Setting it up yourself](#setting-it-up-yourself)).

Keep the compactor to one copy while you do it. Where the platform starts the new one before it stops the old (Cloud Run and Container Apps can), the two overlap for a moment, and [the compactor's lease](#compactor) makes a second copy's passes wait, so nothing is corrupted. On ECS, set `deployment_minimum_healthy_percent` to 0 and `deployment_maximum_percent` to 100, as the module does, so the old task stops first.

## Upgrading from the container deployment

These modules used to run the server as long-running containers. Applying them to a deployment made that way keeps the database, Redis and the bucket, and replaces what runs the server:

- AWS: the address stays the same (the CloudFront distribution is kept and pointed at the gateway). The load balancer and the ECS service that ran the API are removed; the compactor is an ECS service again. Expect errors for a few minutes while that happens.
- GCP and Azure: the address changes, to the gateway's (`*.gateway.dev`) or Front Door's (`*.azurefd.net`), and the old one stops working. Clients, and `PUBLIC_BASE_URL` if you set it yourself, need the new one. This server's own feeds build their links from `PUBLIC_BASE_URL` when they're read, so they follow.
- The variables for the containers' number and size (`app_count`, `app_cpu`, `app_memory` on AWS) are gone; `min_instances`, `max_instances`, `min_replicas` and `max_replicas` now apply to each group and have new defaults.

Run `terraform plan` first and read what it will destroy.

## Upgrading to the compactor as the only writer

In earlier versions the requests wrote posts and comments to the bucket themselves. Now they commit to the database, and the [compactor](#compactor) writes everything out. The two don't mix: a function or a node of the version before still writes the bucket itself, beside a compactor that now does. So every function and the compactor change version together, with the migrations that go with them (`0002_pending_writes`, which changes what requests write, `0003_staged_removals`, which only adds a table, and `0004_unnumbered_writes`, which makes `pending_writes` again, with a key for the new comments and the likes of comments that take no write number, and copies its rows):

- With these modules, one `apply` does it. It adds the rule that expires `staged/` to the bucket, and runs the migrations in its [first step](#deploy), before it updates the functions and the compactor. Between the migrations and the update, which is a few minutes, the functions of the version before run on the migrated database: they write a column that `0002_pending_writes` drops, so posts and updates sent then fail with a `500`. The compactor of the version before fails its passes for as long. Apply when the server is quiet, and have clients send again what failed.
- Where you run it yourself, stop every API node and the compactor, migrate, and start them all on the new version. A rolling restart leaves the two versions writing at once for its length. Give the bucket a rule that deletes objects under `staged/` after 7 days, as the modules do.
- There's no way back with the same database. The version before doesn't run on the migrated one.

This upgrade wasn't applied to a live deployment. The modules pass `terraform validate` with the new rule, and applying the writes that waited, and again after a pass that stopped, is covered by the server's tests, on SQLite.

## Upgrading to the `ev` prefixes

Three things change on the first `apply` of a version whose API keys start with `ev_` and whose Redis keys start with `ev:` (they were `tu_` and `tu:`). It also runs migration `0005_origin_gone`, which adds two columns to `content` and changes nothing else.

- The feed index starts empty. The modules don't set `REDIS_KEY_PREFIX`, so the functions and the compactor read and write under `ev:` from then on, where there's nothing yet: feeds are empty, and challenges and rate-limit counts start over. Run the [rebuild](#redis) straight after the apply, which fills the index from the database and the bucket. To skip that, keep the old prefix: `environment = { REDIS_KEY_PREFIX = "tu:" }`. The keys under `tu:` aren't deleted: those with no expiry (the index) stay in Redis until you delete them or flush it.
- The deployment's admin key is replaced. Terraform makes the key in the server's format, so the same apply gives the [admin account](#the-admin-account) a key that starts with `ev_`, revokes the one it had, and rewrites the profile file and the `admin_api_key` output. A copy of the old key kept anywhere else stops working.
- Every other user's key keeps working. The server still takes a key that starts with `tu_`; a key issued or replaced from now on starts with `ev_`.
- AWS: the functions get a cap on instances ([below](#scaling-and-the-database)), which needs room in the account's Lambda quota. Check it before applying.

This upgrade wasn't applied to a live deployment either. The modules pass `terraform validate`, and the migration, old keys and the new settings are covered by the server's tests, on SQLite.

## Upgrading to the data export

The first `apply` of a version that has a user's [export](API.md#get-usersuseridexport) (`GET /users/:userId/export`) needs nothing set. What it does:

- It runs migration `0006_export_indexes`, in its [first step](#deploy): three indexes (`content (user_id, created_at, id)`, `reposts (user_id, content_id)` and `inbox (sender_id, created_at, id)`), which let a page of an export read the rows it returns and no others. It changes no row.
- The [compactor](#compactor) indexes the comments the deployment already has, once, by who wrote them and who liked them: comments are objects in the bucket, so that index is what finds a user's. It starts when the new compactor's container does, beside its passes, and reads every comment. A container that's replaced meanwhile leaves the work where it was, and the next one goes on from there; a failure is logged, and tried again a minute later. The compactor's log says when it starts ("indexing the comments and likes that are older than users' indexes of them") and when it's done ("users' indexes of their comments and likes hold everything").
- Until that's done, every export answers `503`, with `Retry-After: 60`, so that no client takes an export without its old comments for a whole one. Nothing else waits for it. A new deployment has no comments to index, and answers exports as soon as its compactor first starts.

A user can read 120 pages of their export a minute (`EXPORT_PAGES_PER_MINUTE`, through `environment`).

This upgrade wasn't applied to a live deployment either: the migration, the indexing and the export are covered by the server's tests, on SQLite.

## Upgrading to search

[Search](API.md#search) (`GET /search`) finds posts by keywords that the compactor keeps in the database, and users by a copy of their username in lowercase and without accents. The first `apply` of a version that has it needs nothing set, and leaves one thing to do by hand: the posts and the names that were there before are indexed by a command of their own, run once after the apply.

What the apply does:

- It runs migration `0009_search`, in its [first step](#deploy): a table for the keywords (`search_terms`), and a column on `users` for the name as a search compares it (`username_folded`), which it fills with each username in lowercase. That writes every row of `users` once.
- The gateways get no new route. `GET /search` is in the `api` [group](#route-groups), which is sent every path that has no route of its own.
- The compactor indexes what it writes out from then on: new posts, updates, and the posts whose hashtags a repost or a moderator changed.

What that leaves, until the reindex has run:

- A post from before the upgrade is found by no search, unless it has been written out again since.
- A name with an accent is found only by the letters before it. The migration can put a name in lowercase, and can't take its accents off: `jos` finds José, and `jose` and `josé` don't.
- An account registered between the migration and the functions' update, which is a few minutes, was written by the version before. It has no name to be found by.

The reindex is `compactor reindex`, run in the deployment's image with the compactor's settings. It reads every post's meta file from the bucket and every user, writes what's missing, and ends. It opens what the compactor opens, so it needs every setting the compactor does, `REDIS_URL` among them, though what it reads and writes is the database and the bucket. It doesn't bring the database up to date: the apply has. The modules keep no task of its own for it. On AWS and GCP, start the [rebuild](#redis)'s task or job, which has those settings, with this command in place of its own. On Azure, run it in the compactor's container:

```sh
# AWS: what `terraform output -raw rebuild_command` prints, with --overrides added
aws ecs run-task --cluster evieverse --task-definition evieverse-rebuild --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-...],securityGroups=[sg-...],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"compactor","command":["compactor","reindex"]}]}'

# GCP: the rebuild job, with other arguments
gcloud run jobs execute evieverse-rebuild --region us-central1 --wait --args=reindex

# Azure: a shell in the compactor's container (`terraform output compactor` names it), then the command in it
az containerapp exec --resource-group evieverse-rg --name evieverse-compactor --command sh
compactor reindex
```

- It runs beside the functions and the compactor. It takes the compactor's lease for each 500 posts and leaves it free for as long between them, so passes go on while it works, about half as often: posts are published a little later meanwhile.
- Its log says where it is (`1500 posts read...`), and ends with `Reindex complete:` and how many posts it indexed, how many still wait for the compactor, which indexes those itself, and how many usernames it changed. On Azure, keep the session open until then.
- It can be run again, at any time. What's right already is read and left as it is, so one that was stopped is started again from the beginning.
- Run it again after changing `SEARCH_MAX_KEYWORDS` (100, through `environment`), the most words a post is found by. The compactor applies a new value to the posts it writes out from then on, and the reindex to the rest.
- Where you run the server yourself, it's `npm run reindex` from the built source, or `compactor reindex` in a container, with the compactor's settings.
- A new deployment needs none of this: it has no post or name from before.
- A deployment whose compactor was the JavaScript one runs it once more, after [the upgrade to the Rust compactor](#upgrading-to-the-rust-compactor).
- A deployment that had posts before the server counted them runs it once more as well, after [the upgrade to post counts](#upgrading-to-post-counts): the same command counts them.

What search costs from then on:

- Rows in the database: one for each distinct word of a post, up to `SEARCH_MAX_KEYWORDS`, and one for each of its hashtags. They're deleted with the post.
- Database reads that need no key: every search is a query from the `api` group. One address gets 60 a minute (`SEARCH_RATE_LIMIT_PER_MINUTE`), counted by the [client's address](#client-addresses).
- A search of users reads more as the users grow. PostgreSQL reads only the names that start with what was asked for where the database sorts text byte by byte (the `C` collation). With any other, it reads names past those too, in the index's order, until the page is full. A database these modules make has another: `en_US.utf8`, which the Azure module sets, and which is the default on RDS and Cloud SQL.

This upgrade wasn't applied to a live deployment either, and the three commands above weren't run on one. The migration, the search and the reindex are covered by the server's tests, on SQLite, so the note on PostgreSQL is read from the query and wasn't measured.

## Upgrading to likes that can be taken back

A user can take back a like of a post or of a comment ([`DELETE /like`](API.md#delete-like)). The first `apply` of a version that has it needs nothing set, and nothing done by hand afterwards. What it does:

- It runs migration `0010_unlikes`, in its [first step](#deploy): a column on `content` for when a post last lost a like (`unliked_at`), with an index, and a column on `pending_writes` for what a like of a comment that waits comes to (`net`). Both are empty on the rows that are there, and it changes no row.
- The gateways get no new route. `DELETE /like` is in the `api` [group](#route-groups), which is sent every path that has no route of its own.
- The compactor has to be of the new version before a like of a comment is taken back. The request commits the taking back as a row, which the compactor applies. A compactor of the version before reads such a row as a like: the like stays, or is made. So between the functions' update and the compactor's, which is a few minutes, a like of a comment that's taken back may be there still afterwards, and the user takes it back again. A post's likes don't wait for the compactor, and are taken back at once either way.
- The version before runs on the migrated database: it writes neither column, and a like of a comment it commits meanwhile counts as any other.
- Where you run it yourself, migrate, then start the compactor on the new version, and then the API nodes. In that order no taking back is committed before there's a compactor that can apply it.

This upgrade wasn't applied to a live deployment either. The migration and the likes taken back are covered by the server's tests, on SQLite, and the tests of likes were run on PostgreSQL and MySQL as well.

## Upgrading to the Rust compactor

The compactor is now a program of its own, written in Rust (`compactor/`), and so are the trust plugins, which the functions load as an addon and the compactor has built in. The compactor could once run inside a long-running server, and no longer can: every instance runs one beside the API. The first `apply` of a version that has them needs nothing set, and leaves one thing to do by hand: the reindex, run once after the apply.

What the apply does:

- It builds the image again, which now compiles the Rust code, so this build takes several minutes longer than the ones before it ([Prerequisites](#prerequisites)).
- It replaces the compactor's container with one whose command is `compactor`, where it was `node dist/compact/main.js`, and gives the [rebuild](#redis)'s task or job the command `compactor --once --rebuild`. `terraform output -raw rebuild_command` starts it as before.
- The settings check of its [first step](#deploy) now loads the addon: a plugin named in `TRUST_OPTIONAL_PLUGINS` that the image wasn't built with fails the step, as a misspelt name did before. The upgrade has no migration of its own.
- The modules no longer set `COMPACT_IN_PROCESS`, which nothing reads any more. Take it out of `environment` if you set it there.
- The functions and the compactor change together, as with any new image. What is in the database, the bucket and Redis keeps its format: the compactor reads and writes what the version before did, so no [rebuild](#redis) is needed.

What that leaves:

- Run the reindex once, as [above](#upgrading-to-search): `compactor reindex`. The compactor used to cut a text into words with Node's `Intl.Segmenter`, and now does with ICU4X, whose rules differ in places, most of all for languages written without spaces. Until the reindex has run, a post indexed before may not be found by all of its words. Posts written out from then on are indexed the new way without it.
- Blocked patterns are run by another engine (QuickJS), in the functions. They are written as before, and each list still has 100 ms for one post, past which the post counts as a match. That time is used up sooner than it was: measured on one machine, a pattern took about 1 ms over a post of 40,000 characters, the longest there is, so a list of 100 patterns over such a post reaches the 100 ms. A hashtag or a server with many patterns may see very long posts held or refused that weren't before. Shorter posts are far from it: 100 patterns over a short post took under 1 ms.
- The `pdq` plugin decodes images with another library. It reads a picture's pixels as they are stored, without applying a colour profile the file carries, so a hash may differ in a few of its bits from the one the version before made of the same file, which is what `PDQ_MAX_DISTANCE` allows for.
- An image of your own (`image`) has to have the compactor at `compactor` on its `PATH` and the addon at `/app/native/evieverse.node`, as the `Dockerfile` puts them.

Where you run it yourself:

- Stop the API nodes and the compactor, and start them on the new version: the API with `node dist/server.js`, and the compactor with `compactor` (`npm run compact` from source, after `npm run build:native`). A node that was started with `COMPACT_IN_PROCESS=true` has no compactor inside it any more: without one beside it, posts are accepted and never published.
- `REDIS_URL` is required, for the API and for the compactor. A single node that ran without it, on the store in its own memory, needs a Redis or Valkey now ([Redis](#redis)).
- Then run `compactor reindex` once (`npm run reindex` from source).

This upgrade wasn't applied to a live deployment either. The three modules pass `terraform validate`, and the image was built and started in Docker on one machine. The compactor, the plugins and the reindex are covered by the server's tests, which run against the Rust program, on SQLite. The timings of patterns were measured on one machine, and the note on hashes is read from the code: the two decoders weren't compared on a set of images.

## Upgrading to views and dislikes

Every post now has a count of its views, and, on an instance that turns them on, of its dislikes ([API.md](API.md#views), [`POST /dislike`](API.md#post-dislike)). Both are in feed records, so the feed index in Redis has a new layout. The first `apply` of a version that has them needs nothing set, and nothing done by hand afterwards. What it does:

- It runs migration `0018_views_dislikes`, in its [first step](#deploy): four columns on `content` (`view_count`, `viewed_at`, `dislike_count`, `disliked_at`), an index on each of the two times, and a table, `dislikes`. The posts that are there start with 0 views and 0 dislikes.
- The gateways get no new route. `POST /dislike` and `DELETE /dislike` are in the `api` [group](#route-groups), which is sent every path that has no route of its own. Views are counted by `GET /content/:id`, which the `content` group already answers.
- The feed index is upgraded as it's used. An entry of the index goes from 25 to 33 bytes. The new functions read an index of either layout, and the new compactor writes a hashtag's whole index in the new one the first time anything happens under that hashtag. Until then the hashtag's feeds are as before, with `views: 0` on every record. No [rebuild](#redis) is needed, and running one upgrades every hashtag at once.
- Dislikes stay off. To turn them on, set `DISLIKES = "true"` in `environment` ([CONFIG.md](CONFIG.md#dislikes)), with this apply or a later one. With them off, every post's `dislikes` is `null`, which is what tells clients to show none.

**The functions have to be of the new version before the compactor is.** A function of the version before can't read an index the new compactor wrote: it takes the 33-byte entries for 25-byte ones, so under a hashtag that was compacted meanwhile its feed has the day's first post, and is missing the others or has them wrong. The apply updates the functions and the compactor together, after the migrations, in no order. So between the two updates, which is a few minutes at most, a feed that an old function instance answers can be short of posts under the hashtags that were posted to, liked or viewed in that time, and a following feed short of the posts of the users who posted then. Nothing is stored wrong, and it ends when the last old instance is gone: the same feed asked for again is whole. To keep it small, apply when the server is quiet. To have no such moment, update the functions first, and everything else with a second apply:

```sh
# AWS
terraform apply -target=aws_lambda_function.fn [the same -var flags]
# GCP
terraform apply -target=google_cloud_run_v2_service.group [the same -var flags]
# Azure
terraform apply -target=azurerm_container_app.group [the same -var flags]

# then, on any of them
terraform apply [the same -var flags]
```

The first builds the image, runs the migrations and updates the functions, which they depend on. The compactor of the version before goes on meanwhile: it keeps writing the old layout, which the new functions read, and it shows no views until it's replaced.

The other way round is harmless, and so is the migrated database to the version before:

- New functions beside the old compactor: views and dislikes are counted in the database, and feeds show them once the new compactor has run. `GET /content/:id` shows them at once.
- The version before runs on the migrated database. It writes none of the new columns, and a post it stores starts at 0 of each.
- Going back to the version before, once the new compactor has run, needs a [rebuild](#redis) by the old compactor, which writes the index in the old layout again. The counts stay in the database for the next upgrade.

What to expect afterwards:

- Redis holds about a third more for the index: 33 bytes per indexed post per hashtag where it was 25 ([Redis](#redis)).
- A read of a post with a user's credentials is now a write to the database too: one `UPDATE` of the post's row for each view. Reads without credentials write nothing.
- The compactor has more to do on an instance whose posts are read a lot. A pass writes again the index entries of every post that was viewed since the pass before, once per post however many views that was. Its log's `lagMs` shows whether passes keep up ([APP.md](APP.md#12-performance-and-scale)).
- Where you run it yourself: migrate, then start every API node on the new version, and only then the compactor. The compactor of the new version waits for the migration, and doesn't wait for the API nodes.

This upgrade wasn't applied to a live deployment either, and the two-step apply above wasn't run on one: that the functions and the compactor are updated in no order is read from the modules, where both wait for the migration step and neither waits for the other. The migration, the two layouts and the upgrade of an index from one to the other are covered by the server's tests, on SQLite.

## Upgrading to post counts

The server now counts its posts, and each hashtag's. [`GET /rules`](API.md#get-rules) gives how many posts the server has, as `postCount`, and [`GET /tags`](API.md#get-tags) gives each hashtag's, can list the hashtags by it (`sort=popular`), and comes a page at a time. The compactor keeps both counts in the database as it writes posts out, and requests only read them. The first `apply` of a version that has them needs nothing set, and leaves one thing to do by hand: the posts that were there before are counted by the reindex, run once after the apply.

What the apply does:

- It runs migration `0020_post_counts`, in its [first step](#deploy): a column on `tags` for how many posts a hashtag has (`post_count`), with an index, a column on `content` for what a post is counted as (`counted_tags`), and a table of one row for the server's own count (`server_counts`). Every count starts at 0, and no post is counted yet.
- The gateways get no new route. `GET /tags` and `GET /rules` are in the `api` [group](#route-groups), as they were.
- The compactor counts what it writes out from then on: new posts, updates, and the posts whose hashtags a repost or a moderator changed. It takes a post out of the counts as it deletes it.

What that leaves, until the reindex has run:

- A post from before the upgrade is in neither count, unless it has been written out again since. So `postCount` is short of those posts, and so is each hashtag's count: a hashtag whose posts are all from before is listed with `0`.
- `sort=popular` orders the hashtags by those counts, so by the posts since the upgrade alone.

Run the reindex once, as for [search](#upgrading-to-search): `compactor reindex`, with the same task, job or container, and the same commands as there.

- Run it once the compactor is of the new version. A compactor of the version before counts nothing: a post it writes out after the reindex has passed it stays uncounted until something writes it again, or the reindex is run again.
- It counts each post it reads by what the compactor counts it with: once for the server, and once for each hashtag the post's meta file has. A post that waits in the moderation queue isn't counted, and is when it's accepted.
- It can be run again, at any time: a post that's counted for what it should be costs one more read, and is left as it is. Its log and what it ends with are as they were, since it has no line of its own for the counts.
- Where you run the server yourself, it's `npm run reindex` from the built source, or `compactor reindex` in a container.
- A new deployment needs none of this: it has no post from before.

The functions and the compactor can be updated in either order, and the version before runs on the migrated database:

- New functions beside the old compactor: `GET /rules` and `GET /tags` give the counts as they are, which nothing changes until the new compactor runs.
- Old functions beside the new compactor: the counts are kept, and those functions show none.
- The version before writes neither count. A post its compactor deletes stays in the counts it was in, since only the new compactor takes one out. That's what going back to the version before leaves behind, and what an old compactor that's still up beside the new one for a moment can.
- To count from nothing after that, set the counts back in one transaction, then run the reindex:

```sql
BEGIN;
UPDATE content SET counted_tags = NULL;
UPDATE tags SET post_count = 0;
UPDATE server_counts SET post_count = 0;
COMMIT;
```

  The first statement writes every row of `content`, and a request that writes a post waits for it, so run it when the server is quiet. The counts are 0 from the commit until the reindex has passed each post.

What to expect afterwards:

- One small transaction in the database for each post whose count changes: when it's first written out, when its hashtags change, and when it's deleted. A post that's written again with the hashtags it had costs one read.
- `GET /rules` reads one more row. `GET /tags` reads one page of hashtags, as it did, and one hashtag more, to know whether there's a next page.
- Clients that read `GET /tags` before read it as they did: the most recently active first, 200 hashtags unless they ask for more.

This upgrade wasn't applied to a live deployment either, and neither the reindex nor the statements above were run on one. The migration, the counts and the reindex are covered by the server's tests, which were run on SQLite, PostgreSQL and MySQL. The tests set the counts back with the same three statements, one by one and with no compactor running beside them, before they reindex.

## Uploads

A request to a function can't carry a large file. The limits on a file sent in the request to `/store`:


| Cloud | Largest file in a request                                 | Why                                                            |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------- |
| AWS   | About 4 MB                                                | Lambda takes 6 MB per request, and files arrive base64-encoded |
| GCP   | 32 MiB                                                    | Cloud Run's and API Gateway's limit on a request body          |
| Azure | None set by Container Apps; not tested through Front Door |                                                                |


The limit is on the request, so an [album](API.md#albums) sent in one request has it for all its images together. A larger album sends each image by its own upload link.

Larger files go straight to the bucket: the client asks `[POST /uploads](API.md#post-uploads)` for a link, sends the file to it, and posts it with `/store` by its `uploadId`. Every module sets the bucket up for that:

- CORS: pages on `upload_origins` (any origin by default) may send files to the bucket from a browser, and read from it the segments of a [processed video](#videos)'s stream. The link is the permission; this only tells browsers which pages may use one.
- Expiry: an upload nobody posts is deleted after a day (`uploads/` in the bucket). A file that waits for the [compactor](#compactor) to write it out is kept for a week (`staged/`).
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

## Quarantine

With the `pdq` trust plugin on, the server can keep the files that matched its list, for the report you may have to make and for the time the law has you keep a reported file afterwards ([TRUST_PLUGINS.md](TRUST_PLUGINS.md#the-quarantine)). **The modules don't set this up:** they make no bucket for it, give no role access to one, and set none of its settings. Until you do, a matched file is refused and nothing of it is kept, and the server says so in its log when it starts with `pdq` on.

To have one:

1. Make a store for it yourself, outside the module: a bucket or container that nothing else uses. Keep it private and encrypted, turn on its access log, and give it no lifecycle rule that deletes, since the server deletes what is due.
2. Let the server reach it, and nothing else. The functions write files to it and read them for admins. The compactor writes a video's file, and deletes the files whose time is over. Either give the module's roles those rights on the bucket, or put credentials that have them in `QUARANTINE_OPTIONS`.
3. Pass its settings, in the same `apply`:

```hcl
environment = { TRUST_OPTIONAL_PLUGINS = "pdq", PDQ_HASH_LIST = "https://hashes.example.com/pdq.csv", QUARANTINE_SCHEME = "s3" }
secrets     = { QUARANTINE_OPTIONS = "{\"bucket\":\"my-quarantine\",\"region\":\"us-east-1\",\"access_key_id\":\"...\",\"secret_access_key\":\"...\"}" }
```

What to know:

- The settings check doesn't reach the bucket. It refuses a quarantine that is the content store, the summary store or the audit log, with the same options. A bucket that doesn't exist, or that the roles can't write, passes it: the first match then logs an error that starts `pdq:` and says the file couldn't be kept, the post is refused all the same, and nothing is kept. Read the log after you turn it on.
- A file is read through the function, never by a link to the bucket: `GET /moderation/quarantine/:quarantineId/file`, which is in the `api` group. On AWS a Lambda response can be at most 6 MB, so expect a larger file, which a video usually is, not to come through that way: fetch it from the bucket with credentials of your own, and note that the server's record of who read the file doesn't have that reading. The bucket's own access log does, if you turned it on.
- Files are deleted by the compactor, once a day, `QUARANTINE_RETENTION_DAYS` (365) after the report an admin recorded. A file no report was recorded of stays, and the compactor's log says once a day how many wait.
- Changing the bucket doesn't move the files. The database goes on naming them: move them before you change `QUARANTINE_OPTIONS`.
- `terraform destroy` leaves the bucket, since it isn't the module's. The record of what was kept and who read it is in the database, which is the module's and goes with it.

The first `apply` of a version that has the quarantine runs migration `0016_quarantine`: two tables, for the files that are kept and for what was done with each, and two columns on the videos that wait, for where each was sent from. It runs whether or not you turn the quarantine on.

None of this was applied to a live account for this change. Keeping, reading, reporting and deleting files are covered by the server's tests, against a folder on disk and SQLite; a quarantine in a bucket, the roles' rights on it, and reading a file through a function weren't tried.

## Client addresses

The limits on registrations, on feeds and on the other reads that need no key (`REGISTER_RATE_LIMIT_PER_HOUR`, `FEED_RATE_LIMIT_PER_MINUTE`, `FEED_FOLLOWING_RATE_LIMIT_PER_MINUTE`, `CONTENT_RATE_LIMIT_PER_MINUTE`, `PROFILE_POSTS_RATE_LIMIT_PER_MINUTE`, `AVATAR_RATE_LIMIT_PER_MINUTE`, `COMMENTS_LIST_RATE_LIMIT_PER_MINUTE`, `REPOSTS_ATTESTATION_RATE_LIMIT_PER_MINUTE`, `SEARCH_RATE_LIMIT_PER_MINUTE`) count by the client's address, which the server reads from `X-Forwarded-For`, as far from the end as there are proxies in front of it (`TRUST_PROXY`). Nothing can reach the functions except through the address in front, so a client can't make one up:

- AWS: CloudFront sends a secret header (`X-Origin-Secret`) that the functions require, since the API Gateway's own address is public.
- GCP: the Cloud Run services only admit the gateway's service account. There's no `allUsers` binding.
- Azure: Front Door sends the same secret header, since each Container App's own address is public.

The number of proxies was checked against a live deployment of each module (November 2026), by sending requests with and without an `X-Forwarded-For` of their own, over IPv4 and IPv6, and reading `remoteAddress` in the functions' request logs:

- AWS (`TRUST_PROXY` fixed at 1) and GCP (`trust_proxy`, 2): every request was recorded under the sender's own address, whatever the header said.
- Azure (`trust_proxy`, 2): the same, for every request an app was up for. A request that waited for an app to start from no replicas was recorded under an address of Front Door's own (in its `AzureFrontDoor.Backend` ranges, such as `69.15.x.x` and `147.243.x.x`), with the sender's address one entry further back: it looks as if Front Door sent the slow request again through a second address of its own, which adds a hop. Those few requests are limited and audited as that address. Don't raise `trust_proxy` for them: at 3, every other request could choose its own address. `min_replicas = 1` keeps an app up, and then there are none.

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

- Never two passes at once, and never more than one in 5 seconds. A pass starts `COMPACT_INTERVAL_SECONDS` (5) after the previous one started, or as soon as that one ends if it took longer. Being one process, it can't overlap itself. To change the pace, set `COMPACT_INTERVAL_SECONDS` through `environment`.
- Two containers still can't overlap. Each pass takes the compactor's lease in the database, and a pass that finds it held is skipped. That covers the moments when two are up: a deploy that starts the new one before the old has gone (GCP and Azure can), or a rebuild started by hand. A pass renews the lease for as long as it runs, so a slow write to the bucket doesn't let a second container in.
- If it stops, the platform starts it again. A container that's killed mid-pass leaves the lease held until it expires (`COMPACT_LEASE_SECONDS`, 60), and the next pass after that carries on from where the index was: what the killed pass wrote but hadn't published expires by itself.
- A deploy ends a pass cleanly where it can. On being told to stop, the compactor finishes the writes it's making, starts no more, frees the lease and exits. That takes as long as the writes under way do, not the rest of the pass, and the next pass, of the container that replaces it, does what was left. AWS and Azure are set to give it two minutes for that. Cloud Run gives a container about ten seconds, and a compactor that hasn't exited by then is killed mid-pass, as above.

What waits for it:

- Only the compactor writes posts and comments to the bucket. A request commits its write to the database, and stores a file it came with under `staged/` in the bucket. The next pass writes it out where it's kept (`content/`, `comments/`, `summaries/`), each post and each comment as the newest write of it has it. The staged file is deleted once it's copied, or where the store signs links to its files, once a link given to it can no longer be in use: `CONTENT_SIGNED_URL_SECONDS` (900) and a minute later, by a pass after that. [APP.md](APP.md#what-it-does-each-run) has the details.
- While it's down, writes are taken and wait. A post, a comment or a like is answered as ever, and a post or a comment can be read by its id. No feed gets a new post or an update, and no list a new comment, until a pass has run. The passes after it's back write out everything that waited.
- The counts in feeds wait for it too. A like, a view and a dislike are counted in the database by the request, which is what `GET /content/:id` shows at once. A feed's records have a post's likes, views and dislikes as of the last pass.
- A staged file is kept for a week. Every module's bucket deletes what's under `staged/` after 7 days, which clears the files of requests that failed after storing one. A file that waited that long for the compactor goes too, so don't leave the compactor stopped for a week: a post whose file is gone can't be written out until it's next updated, a comment whose file is gone is published with its text alone, or removed if the file was all there was to it, and [APP.md](APP.md#11-consistency-failure-and-recovery) says what that leaves.

Its size is `compactor_cpu` and `compactor_memory` (half a CPU and 1 GB on AWS and Azure, one CPU and 1 GiB on GCP). It runs all the time, so unlike the functions it costs the same with or without traffic: about $18 a month on AWS at the default size, from Fargate's list prices in `us-east-1`. `terraform output compactor` names it, for finding its logs (on AWS, the log group too).

None of this was applied to a live account for this change: the modules pass `terraform validate`, and the pacing, the lease and stopping mid-pass are covered by the server's tests. That the compactor's container reaches other servers is read from each module's network, and wasn't tried on a live one.

## Videos

The compactor's container also processes the videos users send ([API.md](API.md#videos)): it makes each an MP4 that plays anywhere, without its metadata, and for a post, a poster and an adaptive stream. The functions only mark a video to be processed, and serve what the compactor made. The settings are in [CONFIG.md](CONFIG.md#videos).

- The image has ffmpeg. The compactor checks for it when it starts, and doesn't start without it. An image of your own needs `ffmpeg` and `ffprobe` with `libx264` and `aac`.
- The default size is small for it. Encoding is CPU work, and at half a CPU a minute of 1080p video takes several minutes. Videos are processed one at a time, so they queue behind each other, and each post waits to be published until its own is done. Where videos are common, raise `compactor_cpu` to 2 CPUs or more and `compactor_memory` to at least 2 GB (4 GB for 4K sources), which raises the compactor's cost in proportion. Fewer or smaller `VIDEO_HEIGHTS` cut the work too.
- It needs disk for the video as it was sent, and for every size it's made in, twice over (the MP4 and its stream's segments). On AWS that's the task's ephemeral storage (20 GB), and on Azure the replica's, which Container Apps sizes by its CPUs (2 GB at half a CPU, 8 GB above one). On GCP the files count against `compactor_memory`, since Cloud Run keeps an instance's files in memory: there, set `compactor_memory` to several times the largest video the server takes (`MAX_UPLOAD_BYTES`), or lower `MAX_UPLOAD_BYTES`.
- A video that takes longer than `VIDEO_TIMEOUT_SECONDS` (an hour) is given up, and so is one the compactor was stopped on three times, which is what running out of memory looks like. Its publisher gets a notice. The compactor's log says why, in a line that starts `could not process a video`, and has `processed a video` with the time it took for each one that went through.
- Passes go on while a video is processed. The video worker runs beside the passes in the same process, so posts and comments without a video are written out as ever, though more slowly on a machine whose CPUs the encoder is using.
- The stream's segments are read from the bucket on AWS and GCP, by a redirect to a signed link, as `/raw` is. A player that fetches them by script (hls.js, in every browser but Safari) is held to the bucket's CORS rule, so the modules allow `GET` there for `upload_origins`. On Azure they're streamed through the Container App and Front Door.
- Processed videos take more room: each rendition is stored twice, as the stream's segments and, for one of them, as the MP4. The file as it was sent isn't kept.
- To turn it off, set `VIDEO_PROCESSING = "false"` in `environment`. It applies to the functions and the compactor alike, as every setting there does. Videos are then stored and served as they're sent.
- With the `pdq` trust plugin on, each video is checked before it's published, against the plugin's list of hashes of known child sexual abuse material ([TRUST_PLUGINS.md](TRUST_PLUGINS.md#videos)). The compactor's container reads the list from `PDQ_HASH_LIST` itself, so it needs the way out to the list's host that the functions have, and room for the list in `compactor_memory`. While it has no list, videos wait unpublished. With `VIDEO_PROCESSING = "false"`, no video is checked.

The first `apply` of a version that processes videos runs migration `0007_media` (a table for the videos that wait, and a column on ads), adds `GET` and `HEAD` to the bucket's CORS rule, and replaces the compactor's container with one that has ffmpeg. Videos stored before it stay as they were sent: nothing processes them again.

None of this was applied to a live account for this change. The processing itself is covered by the server's tests, with ffmpeg 8; the timings above are estimates, so time a video of the length your users send on your own deployment.

## Scaling and the database

Each group scales on its own, and the feed group holds no database connections. The other three groups do, and the database's connection limit is what bounds them:

- AWS: the functions connect through RDS Proxy, which shares up to 75% of the database's connections among however many instances are running.
- GCP and Azure: the small database sizes these modules default to have no built-in pooler, so the limit is arithmetic: `3 x max_instances x db_pool_size + 5` (or `max_replicas`) must stay within the database's connections, which is 50 on `db-g1-small` and 35 usable on `B_Standard_B1ms`. The defaults (3 instances of 4 connections; 3 replicas of 3) fit. To scale further, raise `db_tier` or `db_sku` with them.

`min_instances` and `min_replicas` are 0, so a group with no traffic costs nothing and its next request waits for an instance to start. Set them to 1 to keep one warm.

Every group has a cap on instances, the feed group too. The limits by address can't tell a flood from many addresses from many readers, so the cap is what bounds what such a flood costs, in Redis load and on the bill: past it, the platform refuses requests itself.

| Cloud | Groups that use the database | The feed group |
| ----- | ---------------------------- | -------------- |
| AWS   | `function_max_concurrency` (50) | `feed_function_max_concurrency` (100) |
| GCP   | `max_instances` (3) | `feed_max_instances` (10) |
| Azure | `max_replicas` (3) | `feed_max_replicas` (10) |

- On AWS the cap is Lambda's reserved concurrency. A Lambda instance takes one request at a time, so it's also how many requests a function answers at once, and the server's own bound on feeds at a time (`FEED_MAX_CONCURRENT`) is never reached there. One request more is refused by Lambda, and the gateway answers it with an error; it isn't queued.
- Reserved concurrency comes out of the account's quota, which must keep 100 unreserved. The defaults reserve 250 (100 for feeds, 50 for each of the other three), so they need a quota of 350: `aws lambda get-account-settings` shows it. An established account has 1,000; a new one may have less, and the apply then fails on the functions. Lower the two variables, ask AWS for a larger quota, or set them to `null`, which sets no cap and reserves nothing.
- GCP's and Azure's instances take many requests at a time each, so their caps are lower.

## What to expect

Measured for this change, with the limits of each measurement:

- Latency once warm: on one machine (1 vCPU and 1 GB per container; Valkey, Postgres and an S3-compatible store beside them), a 10-hashtag feed took 6 ms at the median from a group's own container and 10 ms through the Lambda runtime, against 6 ms from the whole server. A text post took 41 ms from either, against 44 ms. This compares the function code with the server, not one cloud's network with another's.
- Cold starts: on AWS Lambda in `us-east-1`, a new instance took 1.0 to 1.6 seconds to start at 1,024 MB (the feed function; 1.1 to 2.3 for the store function), almost all of it loading the server's code, then answered in 30 to 60 ms. More memory made little difference. This was measured outside a VPC with no Redis or database to connect to, so a real cold start adds those connections. Cloud Run and Container Apps weren't measured; Container Apps starting from zero also pulls the image, which usually takes much longer.
- Cost: functions swap the cost of containers that run all the time for a cost per request, plus the address in front. From list prices, with the database, Redis, bucket and data transfer left out as they don't change: AWS costs about $70 a month before any traffic (NAT gateway $33, RDS Proxy $22, the Secrets Manager endpoint $15) and about $1.45 per million requests after (API Gateway $1.00, Lambda $0.45), which is less than two always-on containers and a load balancer up to roughly 30 million requests a month and more beyond. On GCP the functions themselves are cheap, but API Gateway is $3.00 per million calls after the first 2 million. On Azure, Front Door adds $35 a month and $0.90 per million requests, the database's private endpoint about $7 a month, and four apps that each stay up for five minutes after a request cost more than one container until there's enough traffic to need several. For a busy server, compare a load balancer with path rules (GCP), or setting `min_replicas` and sizing by hand (Azure).



## Redis

Every module sets the eviction policy to `volatile-lru`. Only keys with a TTL (hot summaries, comments, challenges and superseded index keys) are ever evicted, so a full Redis costs object-store reads, never the index.

Size it for about 33 bytes per indexed post per hashtag (10,000 busy hashtags take about 1.5 GB) plus about 0.4 KB per post of the last 8 days (about 0.3 GB at 100,000 posts a day). Comments are kept for a day (`COMMENTS_HOT_HOURS`), and a million a day need about 0.5 GB. The defaults have about 1 GB; raise `redis_node_type`, `redis_memory_gb` or `redis_sku` as you grow. [APP.md](APP.md#12-performance-and-scale) has the details.

If Redis loses its data, run the compactor once with `--rebuild` (`compactor --once --rebuild`). It rebuilds the feed index, the hot summaries and the publisher credits from the database and the content bucket. Comments themselves need no rebuild: each post's are read from the bucket again the first time they're asked for. The number of comments a feed gives with each post (`commentCount`) does: Redis alone holds it, so a post reads as having `0` until the rebuild counts its comments from the bucket, or until a comment of it is next written or removed. The same goes for an instance that had comments before the upgrade that added the number: run the rebuild once after it. A rebuild reads every post, and every comment of each post that has any, so it's a container task or job of its own rather than a pass of the running compactor. Each module keeps one for it, and prints the command that starts it:

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

Without these modules, the server runs on any of each cloud's services below, as long-running API nodes with one compactor (`node dist/server.js`, and `compactor`, the program the image has on its `PATH`), or as functions (`node dist/functions/http.js` for containers that scale with traffic, `node dist/functions/lambda.js` on Lambda, with `FUNCTION_GROUP` naming the group). The rules that apply on every cloud, and the ones functions add, are in [APP.md](APP.md#13-deployment-topology).

Every setup has all three: the API, one compactor, and a Redis or Valkey that both reach (`REDIS_URL`), since the compactor writes the feed index the API reads. The compactor also needs ffmpeg, which the image has, unless `VIDEO_PROCESSING=false`.

With functions, run the step the modules run before you update them, with the settings they're about to get: `node dist/functions/migrate.js` as a job, or the Lambda entry point with `FUNCTION_GROUP=migrate`. It checks that the functions start with those settings, and then migrates the database. Nothing else tells you about a setting the server refuses until requests fail, since updating a function doesn't start it.

For the instance's posts to be reposted on other servers, give it a signing key and its public address (`REPOSTS_SIGNING_KEYS` and `PUBLIC_BASE_URL`, in [CONFIG.md](CONFIG.md#reposts)), and a way out to the internet over `https`, to ask other servers for their keys.

**AWS**


| Piece                 | Recommended                                                                                                                                | Alternatives                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Content and summaries | S3: `CONTENT_SCHEME=s3`, `CONTENT_OPTIONS='{"bucket":"tu-content","region":"us-east-1"}'`                                                  |                                     |
| Redis                 | **ElastiCache for Valkey or Redis OSS**, cluster mode disabled, with a replica: `REDIS_URL=rediss://:<auth token>@<primary endpoint>:6379` | Valkey or Redis on EC2              |
| API                   | EC2 Auto Scaling or ECS Fargate behind an ALB                                                                                              | EKS                                 |
| Compactor             | An ECS service of one task running `compactor`                                                                             | The same on EC2 or EKS, as one copy |
| Database              | RDS PostgreSQL or MySQL                                                                                                                    | Aurora                              |


ElastiCache Serverless and MemoryDB only run in cluster mode, so they aren't supported.

**Google Cloud**


| Piece                 | Recommended                                                                                                            | Alternatives                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Content and summaries | Cloud Storage: `CONTENT_SCHEME=gcs`, `CONTENT_OPTIONS='{"bucket":"tu-content","credential_path":"/secrets/gcs.json"}'` |                                                         |
| Redis                 | **Memorystore for Redis**, Standard tier, with AUTH: `REDIS_URL=redis://:<auth string>@<host>:6379`                    | Valkey or Redis on Compute Engine                       |
| API                   | Cloud Run with direct VPC egress, a Managed Instance Group, or GKE, behind a Cloud Load Balancer                       |                                                         |
| Compactor             | A Cloud Run worker pool of one instance running `compactor`                                            | A GKE Deployment of one replica, or a Compute Engine VM |
| Database              | Cloud SQL for PostgreSQL or MySQL                                                                                      | AlloyDB                                                 |


Memorystore for Redis Cluster runs in cluster mode, so it isn't supported.

**Azure**


| Piece                 | Recommended                                                                                                                                                                  | Alternatives                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Content and summaries | Blob Storage: `CONTENT_SCHEME=azblob`, `CONTENT_OPTIONS='{"container":"content","endpoint":"https://acct.blob.core.windows.net","account_name":"acct","account_key":"..."}'` |                                           |
| Redis                 | **Azure Managed Redis** with the Enterprise cluster policy: `REDIS_URL=rediss://:<access key>@<host>:10000`                                                                  | Azure Cache for Redis, without clustering |
| API                   | VM Scale Sets, AKS, or Container Apps behind Front Door or an Application Gateway                                                                                            |                                           |
| Compactor             | A Container App of one replica, with no ingress, running `compactor`                                                                                         | An AKS Deployment of one replica          |
| Database              | Azure Database for PostgreSQL or MySQL Flexible Server                                                                                                                       |                                           |




## Custom domains

- AWS: add `aliases` and an ACM certificate (issued in `us-east-1`) to the CloudFront distribution.
- GCP: put a global external load balancer in front of the gateway (a serverless NEG of the API Gateway type), with your certificate.
- Azure: add `azurerm_cdn_frontdoor_custom_domain` to the Front Door profile, with a managed certificate, and associate it with the routes.

In every case, also set `PUBLIC_BASE_URL` through `environment` so that links the server generates use the new domain.