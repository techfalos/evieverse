# Deploying Evieverse with Terraform

Each directory under `deploy/terraform/` is a self-contained root module that builds the image from this repo, provisions everything the instance needs, and prints the HTTPS URL when it finishes.


| Cloud | Functions                               | One address in front                                                | Compactor                                     | Redis (feed index, hot summaries)        | Content and summaries | Database                           |
| ----- | --------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- | --------------------- | ---------------------------------- |
| AWS   | Lambda (container image), one per group | CloudFront (`*.cloudfront.net`) in front of an API Gateway HTTP API | ECS Fargate service of one task               | ElastiCache for Valkey 8, with a replica | S3                    | RDS PostgreSQL 16 behind RDS Proxy |
| GCP   | Cloud Run services, one per group       | API Gateway (`*.gateway.dev`)                                       | Cloud Run worker pool of one instance         | Memorystore for Redis 7.2, Standard tier | GCS                   | Cloud SQL PostgreSQL 16            |
| Azure | Container Apps, one per group           | Front Door (`*.azurefd.net`)                                        | Container App of one replica, with no ingress | Azure Managed Redis, highly available    | Blob Storage          | PostgreSQL Flexible Server 16      |


Summaries share the content bucket, under `summaries/`, and so do comments, under `comments/`: one small object each, which is the only place a published comment is kept.

## Route groups


| Group     | Requests                                                                                                                                       | Uses                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `feed`    | `GET /feed`                                                                                                                                    | Redis and the bucket only: no database connection |
| `content` | `GET /content/:id`, `GET /content/:id/raw`, and reading a post's comments: `GET /content/:id/comments`, `GET /content/:id/comments/:commentId` | Database, bucket, and Redis for comments          |
| `store`   | `POST /uploads`, `POST /store`                                                                                                                 | Database, Redis, bucket                           |
| `api`     | Everything else                                                                                                                                | Database, Redis, bucket                           |




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

**Database Migrations**

Every `apply` first runs the migrations (powered by a Lambda function on AWS, a job on GCP and Azure), waits for them, and only then updates the functions and the compactor. If the migrations fail, the `apply` stops there with the old functions still serving.

**Settings**

Settings are passed through `environment`, and credentials through `secrets`. On GCP and Azure, secrets go to Secret Manager and Container Apps secrets, never into plain environment variables. On AWS, a Lambda function can only take them as environment variables, which are encrypted at rest but shown to anyone allowed to read the function's configuration (`lambda:GetFunctionConfiguration`). The compactor's task reads them from Secrets Manager.

```hcl
# terraform.tfvars (git-ignored)
environment = { TAGGING_MODE = "server", TAGGING_SERVER_TAGS = "news" }
secrets     = { SUMMARY_OPTIONS = "{\"bucket\":\"summaries\",\"access_key_id\":\"...\",\"secret_access_key\":\"...\"}" }
```

[CONFIG.md](CONFIG.md) lists all settings.

## The admin account

Initial deployment creates an [admin](API.md#moderation) account:

1. **Terraform makes the account's id and API key,** in the format the server issues keys in. The key is random, and exists in two places only: the Terraform state, and the profile file below.
2. **The migration step creates the account.** It's given the key's SHA-256, not the key (`BOOTSTRAP_ADMIN`), and after the migrations it creates the user if it isn't there, makes it an admin, and makes that key its only one. It runs again whenever the image or the account's values change, and changes nothing when they haven't.
3. **The key is installed on the machine that applies,** once the account exists: Terraform writes `~/.evieverse/profiles/<name>.json` (`name` is the module's variable, `evieverse` by default), readable only by you. That's a profile of the server's [CLI](CLI.md), so after installing the CLI, it works as the admin with no sign-in:

```sh
curl -fsSL "$(terraform output -raw url)/cli/install.sh" | sh     # Windows: irm <url>/cli/install.ps1 | iex
evieverse --profile evieverse whoami
evieverse --profile evieverse register alice                   # an account of your own: prints its userId and API key
evieverse --profile evieverse admins grant <userId>            # make your own account an admin
```

With no other profile on the machine, `--profile` can be left out.


| Variable                | Default |                                                                                                                                                                               |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_username`        | `admin` | The account's username when it's created. It fails the apply if another user has it. To rename the account later, use `PATCH /users/:userId`: changing this variable doesn't. |
| `install_admin_profile` | `true`  | Write the profile file. Set it to `false` where applies run unattended (CI), and read the key with `terraform output -raw admin_api_key`.                                     |



| Output          |                                                                 |
| --------------- | --------------------------------------------------------------- |
| `admin_user_id` | The account's `userId`.                                         |
| `admin_api_key` | Its API key (sensitive): `terraform output -raw admin_api_key`. |
| `admin_profile` | The profile file the apply wrote, if it did.                    |


Things to know:

- **On another machine,** sign in with the outputs: `EVIEVERSE_API_KEY="$(terraform output -raw admin_api_key)" evieverse login "$(terraform output -raw url)" "$(terraform output -raw admin_user_id)"`. A machine that applies an existing deployment gets the profile file written too.
- **The key is in the Terraform state,** in plain text, like the database password and the other secrets these modules create. Keep the state where only the deployment's operators can read it (an encrypted remote backend, rather than a file in the repo).
- **To replace the key,** run `terraform apply -replace=random_password.admin_key`. The migration step gives the account the new key and revokes the old one, and the profile file is rewritten.
- **Don't replace it through the API** (`[POST /users/:userId/key](API.md#post-usersuseridkey)`, or `evieverse key rotate`). The deployment doesn't learn of a key made there: the next apply that runs the migration step revokes it and makes the deployment's key work again, which undoes the replacement if that key had leaked.
- **The account is a break-glass one.** Make your own account an admin with it, and use that from day to day. It can't be locked out by the API: the server refuses to revoke or delete its only admin, and if this account's role is revoked while others remain, the next apply that runs the migration step restores it. An admin can't ban it either. If its account is deleted while others remain, the migration step fails until the compactor has purged the account (which frees its username), and then creates it again.
- `terraform destroy` removes the profile file with the deployment.



## Upgrading from the container deployment

These modules used to run the server as long-running containers. Applying them to a deployment made that way keeps the database, Redis and the bucket, and replaces what runs the server:

- **AWS:** the address stays the same (the CloudFront distribution is kept and pointed at the gateway). The load balancer and the ECS service that ran the API are removed; the compactor is an ECS service again. Expect errors for a few minutes while that happens.
- **GCP and Azure:** the address changes, to the gateway's (`*.gateway.dev`) or Front Door's (`*.azurefd.net`), and the old one stops working. Clients, and `PUBLIC_BASE_URL` if you set it yourself, need the new one. This server's own feeds build their links from `PUBLIC_BASE_URL` when they're read, so they follow.
- The variables for the containers' number and size (`app_count`, `app_cpu`, `app_memory` on AWS) are gone; `min_instances`, `max_instances`, `min_replicas` and `max_replicas` now apply to each group and have new defaults.

Run `terraform plan` first and read what it will destroy.

## Uploads

A request to a function can't carry a large file. The limits on a file sent in the request to `/store`:


| Cloud | Largest file in a request                                 | Why                                                            |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------- |
| AWS   | About 4 MB                                                | Lambda takes 6 MB per request, and files arrive base64-encoded |
| GCP   | 32 MiB                                                    | Cloud Run's and API Gateway's limit on a request body          |
| Azure | None set by Container Apps; not tested through Front Door |                                                                |


Larger files go straight to the bucket: the client asks `[POST /uploads](API.md#post-uploads)` for a link, sends the file to it, and posts it with `/store` by its `uploadId`. Every module sets the bucket up for that:

- **CORS:** pages on `upload_origins` (any origin by default) may send files to the bucket from a browser. The link is the permission; this only tells browsers which pages may use one.
- **Expiry:** an upload nobody posts is deleted after a day (`uploads/` in the bucket).
- `MAX_UPLOAD_BYTES` is the largest file `/store` accepts either way. To post an upload, `/store` copies it within the bucket, inside the request's time limit: 30 seconds on AWS, `request_timeout` on GCP (300) and Azure (240). AWS is set to 256 MiB and GCP to 1 GiB. Those are estimates of what fits, not measurements; time a large upload on your own deployment before raising them through `environment`. Azure keeps the server's default (5 GiB), which is more than fits in its timeout.

On GCP, signing a link needs a private key, and Cloud Run's own credentials don't have one. The module therefore creates a service account that can only read and write the content bucket, and a key for it, which the functions use for the bucket (`direct_uploads`, on by default). The key doesn't expire, and is kept in Secret Manager and in the Terraform state. Organisations that forbid service account keys need `direct_uploads = false`: `/uploads` then answers `501`, and files are limited to 32 MiB.

## Audit log

Every request that adds, updates or deletes something (a `POST`, `PUT`, `PATCH` or `DELETE` that succeeded) is written down whole, and no read is: `GET /feed` and the other reads leave nothing. What a record holds, and how a write that fails is handled, is in [CONFIG.md](CONFIG.md#audit-log).

Each module creates a bucket of its own for it, which moves what it holds to the cloud's cold storage, and gives the functions the right to add to it and nothing else: not to read, overwrite or delete a record.


| Cloud | Where                                    | Cold storage          | Written by                                        |
| ----- | ---------------------------------------- | --------------------- | ------------------------------------------------- |
| AWS   | S3 bucket `<name>-audit-…`               | Glacier Deep Archive  | Lambda functions (`s3:PutObject` only)            |
| GCP   | GCS bucket `<project>-<name>-audit`      | Archive storage class | Cloud Run services (`storage.objectCreator` only) |
| Azure | Container `audit` of the storage account | Archive tier          | Container Apps (the account key, as for content)  |


Records stay as they were written for `audit_archive_after_days` (30 by default; the same variable on every cloud), then the bucket's lifecycle rule moves them. A record is one small object, so on AWS and Azure the archive tiers' per-object charges and minimum storage durations (180 days) are worth a look at your volume. Reading an archived record takes hours to restore. Nothing deletes records. The bucket is named in the `audit_bucket` output (`audit_container` on Azure).

The audit log is written by the functions that answer requests, in each request, before it is answered: a failed write is logged as an error and doesn't fail the request. The log of the functions themselves (CloudWatch, Cloud Logging, Log Analytics) also gets a line for each record, naming its object, for as long as that log is kept.

## Client addresses

The limit on registrations counts by the client's address, which the server reads from `X-Forwarded-For`, as far from the end as there are proxies in front of it (`TRUST_PROXY`). Nothing can reach the functions except through the address in front, so a client can't make one up:

- **AWS:** CloudFront sends a secret header (`X-Edge-Secret`) that the functions require, since the API Gateway's own address is public.
- **GCP:** the Cloud Run services only admit the gateway's service account. There's no `allUsers` binding.
- **Azure:** Front Door sends the same secret header, since each Container App's own address is public.

On GCP and Azure the number of proxies (`trust_proxy`, 2) wasn't checked against a live deployment. After the first apply, make a request and look at `remoteAddress` in the function's request log: it should be your own public address. If it's a Google or Microsoft address, raise `trust_proxy` by one; if it's something a client could choose, lower it.

## Compactor

The compactor is one container that's always up, and makes pass after pass over the feed index. It isn't a function and nothing calls it: it has no address, and reaches Redis, the database and the bucket from inside the network, as the functions do.


| Cloud | What runs it                                                                | Kept at one by                                                                    |
| ----- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| AWS   | An ECS Fargate service in the private subnets                               | `desired_count = 1`; a deploy stops the running task before it starts the new one |
| GCP   | A Cloud Run worker pool, which is Cloud Run for work that takes no requests | Manual scaling, one instance                                                      |
| Azure | A Container App with no ingress                                             | `min_replicas = max_replicas = 1`, single revision mode                           |


How it's paced:

- **Never two passes at once, and never more than one in 5 seconds.** A pass starts `COMPACT_INTERVAL_SECONDS` (5) after the previous one started, or as soon as that one ends if it took longer. Being one process, it can't overlap itself. To change the pace, set `COMPACT_INTERVAL_SECONDS` through `environment`.
- **Two containers still can't overlap.** Each pass takes the compactor's lease in the database, and a pass that finds it held is skipped. That covers the moments when two are up: a deploy that starts the new one before the old has gone (GCP and Azure can), or a rebuild started by hand.
- **If it stops, the platform starts it again.** A container that's killed mid-pass leaves the lease held until it expires (`COMPACT_LEASE_SECONDS`, 60), and the next pass after that carries on from where the index was: what the killed pass wrote but hadn't published expires by itself.
- **A deploy lets a pass finish where it can.** On being told to stop, the compactor ends the pass it's making and exits. AWS and Azure are set to give it two minutes for that. Cloud Run gives a container about ten seconds, and a pass cut short there is a killed pass, as above.

Its size is `compactor_cpu` and `compactor_memory` (half a CPU and 1 GB on AWS and Azure, one CPU and 1 GiB on GCP). It runs all the time, so unlike the functions it costs the same with or without traffic: about $18 a month on AWS at the default size, from Fargate's list prices in `us-east-1`. `terraform output compactor` names it, for finding its logs (on AWS, the log group too).

None of this was applied to a live account for this change: the modules pass `terraform validate`, and the pacing and the lease are covered by the server's tests.

## Scaling and the database

Each group scales on its own, and the feed group holds no database connections. The other three groups do, and the database's connection limit is what bounds them:

- **AWS:** the functions connect through RDS Proxy, which shares up to 75% of the database's connections among however many instances are running.
- **GCP and Azure:** the small database sizes these modules default to have no built-in pooler, so the limit is arithmetic: `3 x max_instances x db_pool_size + 5` (or `max_replicas`) must stay within the database's connections, which is 50 on `db-g1-small` and 35 usable on `B_Standard_B1ms`. The defaults (3 instances of 4 connections; 3 replicas of 3) fit. To scale further, raise `db_tier` or `db_sku` with them.

`min_instances` and `min_replicas` are 0, so a group with no traffic costs nothing and its next request waits for an instance to start. Set them to 1 to keep one warm.

## What to expect

Measured for this change, with the limits of each measurement:

- **Latency once warm:** on one machine (1 vCPU and 1 GB per container; Valkey, Postgres and an S3-compatible store beside them), a 10-hashtag feed took 6 ms at the median from a group's own container and 10 ms through the Lambda runtime, against 6 ms from the whole server. A text post took 41 ms from either, against 44 ms. This compares the function code with the server, not one cloud's network with another's.
- **Cold starts:** on AWS Lambda in `us-east-1`, a new instance took 1.0 to 1.6 seconds to start at 1,024 MB (the feed function; 1.1 to 2.3 for the store function), almost all of it loading the server's code, then answered in 30 to 60 ms. More memory made little difference. This was measured outside a VPC with no Redis or database to connect to, so a real cold start adds those connections. Cloud Run and Container Apps weren't measured; Container Apps starting from zero also pulls the image, which usually takes much longer.
- **Cost:** functions swap the cost of containers that run all the time for a cost per request, plus the address in front. From list prices, with the database, Redis, bucket and data transfer left out as they don't change: AWS costs about $55 a month before any traffic (NAT gateway $33, RDS Proxy $22) and about $1.45 per million requests after (API Gateway $1.00, Lambda $0.45), which is less than two always-on containers and a load balancer up to roughly 40 million requests a month and more beyond. On GCP the functions themselves are cheap, but API Gateway is $3.00 per million calls after the first 2 million. On Azure, Front Door adds $35 a month and $0.90 per million requests, and four apps that each stay up for five minutes after a request cost more than one container until there's enough traffic to need several. For a busy server, compare a load balancer with path rules (GCP), or setting `min_replicas` and sizing by hand (Azure).



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
- The functions run in the VPC's private subnets, next to Redis and the database. They reach the internet (AI services) through one NAT gateway, and S3 through a gateway endpoint, which is free. If the NAT gateway's availability zone fails, the functions lose the internet until it's back, but not Redis, the database or S3.
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
- The storage account key and the Redis access key reach the containers only as Container Apps secrets. Upload and download links are signed with the storage account key.
- PostgreSQL accepts connections only from Azure services (the `0.0.0.0` firewall rule), and TLS is required.



## Setting it up yourself

Without these modules, the server runs on any of each cloud's services below, as long-running API nodes with one compactor (`node dist/server.js`, `node dist/compact/main.js`), or as functions (`node dist/functions/http.js` for containers that scale with traffic, `node dist/functions/lambda.js` on Lambda, with `FUNCTION_GROUP` naming the group). The rules that apply on every cloud, and the ones functions add, are in [APP.md](APP.md#13-deployment-topology).

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