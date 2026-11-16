# Deploying theuniverse with Terraform

Each directory under `terraform/` is a self-contained root module that builds the image from this repo, provisions everything the server needs, and prints the HTTPS URL when it finishes.

| Cloud | API | HTTPS | Redis (feed index, hot summaries) | Content and summaries | Database | Compactor |
|-------|-----|-------|-----------------------------------|-----------------------|----------|-----------|
| AWS | ECS Fargate behind an ALB | CloudFront (`*.cloudfront.net`) | ElastiCache for Valkey 8, with a replica | S3 | RDS PostgreSQL 16 | ECS service, 1 task |
| GCP | Cloud Run (gen2) | Built in (`*.run.app`) | Memorystore for Redis 7.2, Standard tier | GCS | Cloud SQL PostgreSQL 16 | Cloud Run job, every minute |
| Azure | Container Apps | Built in (`*.azurecontainerapps.io`) | Azure Managed Redis, highly available | Blob Storage | PostgreSQL Flexible Server 16 | Container App, 1 replica |

Summaries share the content bucket, under `summaries/`.

## Prerequisites

- Terraform 1.5 or newer.
- Docker for AWS and GCP (the image is built locally and pushed). Azure builds remotely with `az acr build`, so Docker isn't needed there.
- The cloud's CLI, signed in: `aws configure` / `gcloud auth login && gcloud auth application-default login` / `az login`.

To skip the build, set `image` to an image you've already pushed.

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

At the end of `apply`, Terraform prints `url` (for example `https://d1234abcd.cloudfront.net`) and `try_it`, which shows ready-to-paste `curl` commands. To see them again later, run `terraform output url`.

Settings are passed through `environment`, and credentials (such as those in `SUMMARY_OPTIONS`, for summaries kept outside the content bucket) through `secrets`. Secrets go to Secrets Manager, Secret Manager or Container Apps secrets respectively, never into plain environment variables:

```hcl
# terraform.tfvars (git-ignored)
environment = { TAGGING_MODE = "server", TAGGING_SERVER_TAGS = "news" }
secrets     = { SUMMARY_OPTIONS = "{\"bucket\":\"summaries\",\"access_key_id\":\"...\",\"secret_access_key\":\"...\"}" }
```

## Redis

Every module sets the eviction policy to `volatile-lru`. Only keys with a TTL (hot summaries, challenges and superseded index keys) are ever evicted, so a full Redis costs object-store reads, never the index. `REDIS_URL` reaches the containers only as a secret.

Size it for about 30 bytes per indexed post per hashtag (10,000 busy hashtags take about 1.4 GB) plus about 0.4 KB per post of the last 8 days (about 0.3 GB at 100,000 posts a day). The defaults have about 1 GB; raise `redis_node_type`, `redis_memory_gb` or `redis_sku` as you grow. [APP.md](../APP.md#12-performance-and-scale) has the details.

If Redis loses its data, or to migrate a deployment that used tag files, run the compactor once with `--rebuild`. It rebuilds the feed index, the hot summaries and the publisher credits from the database and the content bucket:

```sh
# AWS: a one-off task, with the same subnets and security group as the theuniverse-app service
aws ecs run-task --cluster theuniverse --task-definition theuniverse-compactor --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-...],securityGroups=[sg-...],assignPublicIp=ENABLED}' \
  --overrides '{"containerOverrides":[{"name":"compactor","command":["node","dist/compact/main.js","--once","--rebuild"]}]}'

# GCP
gcloud run jobs execute theuniverse-compactor --region us-central1 --args=dist/compact/main.js,--once,--rebuild

# Azure
az containerapp exec --resource-group theuniverse-rg --name theuniverse-compactor \
  --command "node dist/compact/main.js --once --rebuild"
```

If it logs that another run holds the lease, the regular compactor is mid-run; run it again.

## Notes per cloud

**AWS**
- CloudFront supplies HTTPS with its default certificate. The ALB only accepts traffic from CloudFront's origin-facing IP ranges.
- ElastiCache runs a primary plus `redis_replicas` replicas (default 1) on `redis_node_type` (default `cache.t4g.small`, about 1.4 GB). With a replica, failover is automatic and the nodes span availability zones. It requires TLS and an AUTH token, and keeps a daily snapshot for one day.
- CloudFront waits at most 60 seconds for the origin to respond, so an upload whose AI analysis takes longer gets a 504. You can ask AWS Support to raise the limit (up to 180 seconds), or put your own domain and ACM certificate directly on the ALB.
- `force_destroy = true` lets `terraform destroy` delete the content bucket and the database without a final snapshot.

**GCP**
- Cloud Run limits request bodies to 32 MiB, so `MAX_UPLOAD_BYTES` is set to 33,000,000. For bigger uploads, use AWS or Azure instead, or put a load balancer in front.
- Public access is granted with an `allUsers` invoker binding. Organisations that enforce domain-restricted sharing block this; if so, ask for an exception on the project.
- Memorystore uses `redis_tier` (default `STANDARD_HA`, with a replica in another zone) and `redis_memory_gb` (default 1). Cloud Run reaches it through direct VPC egress, with the AUTH string. Traffic stays inside the VPC unencrypted, because Memorystore's TLS uses a private CA the app doesn't load.
- The compactor job runs every minute. If a run outlasts the interval, the next one starts while it's still going. It finds the compactor's lease in the database held and exits at once, so runs never overlap. If a run is killed before it releases the lease, later runs skip until it expires (`COMPACT_LEASE_SECONDS`, 5 minutes by default).
- `deletion_protection = false` is required before `terraform destroy` can delete Cloud SQL and the content bucket.

**Azure**
- Azure Managed Redis uses `redis_sku` (default `Balanced_B1`) and `redis_high_availability` (default `true`). Its Enterprise cluster policy presents one endpoint, so the app connects as it would to a single Redis, over TLS on port 10000 with an access key.
- The storage account key and the Redis access key reach the containers only as Container Apps secrets.
- PostgreSQL accepts connections only from Azure services (the `0.0.0.0` firewall rule), and TLS is required.

## Custom domains

- **AWS:** add `aliases` and an ACM certificate (issued in `us-east-1`) to the CloudFront distribution.
- **GCP:** use a Cloud Run domain mapping, or a global external load balancer with a serverless NEG.
- **Azure:** add `azurerm_container_app_custom_domain` with a managed certificate.

In every case, also set `PUBLIC_BASE_URL` through `environment` so that links the server generates use the new domain.
