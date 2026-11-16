# Evieverse on Google Cloud:
#   API Gateway (HTTPS *.gateway.dev URL) -> one Cloud Run service per route group (feed, content,
#   store, api), each scaling with its own traffic, down to none. All run the one container image.
#   The compactor is one process that is always up: a Cloud Run worker pool of one instance. The
#   feed index and hot summaries are in Memorystore for Redis, content and summaries in GCS,
#   metadata in Cloud SQL PostgreSQL over the built-in Cloud SQL connector.

locals {
  root        = abspath("${path.module}/../../..")
  source_hash = sha1(join("", [for f in concat(sort(fileset(local.root, "src/**")), ["package.json", "package-lock.json", "Dockerfile", "tsconfig.json", "tsconfig.build.json", "scripts/build-cli.mjs"]) : filesha1("${local.root}/${f}")]))
  registry    = "${var.region}-docker.pkg.dev"
  image       = var.image != "" ? var.image : "${local.registry}/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/app:${substr(local.source_hash, 0, 12)}"
  url         = "https://${google_api_gateway_gateway.main.default_hostname}"
  secret_keys = nonsensitive(toset(keys(var.secrets)))

  # The route groups of src/functions/groups.ts. Only instances of the groups that use the database
  # hold connections to it: see `max_instances`.
  groups = {
    feed    = { max_instances = var.feed_max_instances }
    content = { max_instances = var.max_instances }
    store   = { max_instances = var.max_instances }
    api     = { max_instances = var.max_instances }
  }
  # Deterministic Cloud Run URLs, known before the services exist (the gateway is configured with
  # them, and the services need the gateway's address as PUBLIC_BASE_URL).
  service_url = { for group in keys(local.groups) : group => "https://${var.name}-${group}-${data.google_project.this.number}.${var.region}.run.app" }

  # Which service serves which requests. This follows src/functions/groups.ts: change the two
  # together. `{rest=**}` matches any number of path segments; the most specific path wins.
  methods = ["get", "head", "post", "put", "patch", "delete", "options"]
  routes = {
    "/feed"              = { get = "feed", head = "feed", options = "feed" }
    "/feed/{rest=**}"    = { get = "feed", head = "feed", options = "feed" }
    "/content/{rest=**}" = merge({ for method in local.methods : method => "api" }, { get = "content", head = "content" })
    "/uploads"           = { post = "store", options = "store" }
    "/store"             = { post = "store", options = "store" }
    "/{rest=**}"         = { for method in local.methods : method => "api" }
  }
  openapi = jsonencode({
    swagger = "2.0"
    info    = { title = var.name, version = "1" }
    schemes = ["https"]
    paths = { for path, operations in local.routes : path => { for method, group in operations : method => {
      operationId = "${method}${index(keys(local.routes), path)}"
      parameters  = strcontains(path, "{rest=**}") ? [{ name = "rest", in = "path", required = true, type = "string" }] : []
      responses   = { default = { description = "The server's response." } }
      # The gateway signs in to the service as its own service account, in the Authorization header;
      # the client's Authorization header arrives as X-Forwarded-Authorization (src/auth/apiKey.ts).
      "x-google-backend" = {
        address          = local.service_url[group]
        jwt_audience     = local.service_url[group]
        path_translation = "APPEND_PATH_TO_ADDRESS"
        deadline         = var.request_timeout
      }
    } } }
  })

  # With a key to sign with, /store takes files of any size from the bucket; without one, files
  # arrive through Cloud Run, which caps HTTP/1.1 request bodies at 32 MiB. The first figure is an
  # estimate of what /store can check within `request_timeout`, not a measurement.
  max_upload_bytes = var.direct_uploads ? "1073741824" : "33000000"

  env = merge({
    DB_DIALECT         = "postgres"
    CONTENT_SCHEME     = "gcs"
    PUBLIC_BASE_URL    = local.url
    COMPACT_IN_PROCESS = "false"
    MAX_UPLOAD_BYTES   = local.max_upload_bytes
  }, var.environment)

  # Every instance keeps up to this many database connections. See `max_instances`.
  function_env = merge({
    DB_POOL_SIZE = tostring(var.db_pool_size)
    TRUST_PROXY  = tostring(var.trust_proxy)
  }, local.env)

  builtin_secrets = {
    DATABASE_URL    = google_secret_manager_secret.db_url.secret_id
    REDIS_URL       = google_secret_manager_secret.redis_url.secret_id
    CONTENT_OPTIONS = google_secret_manager_secret.content_options.secret_id
  }
  secret_env = merge(local.builtin_secrets, { for key in local.secret_keys : key => google_secret_manager_secret.extra[key].secret_id })
}

data "google_project" "this" {}

resource "google_project_service" "apis" {
  for_each = toset([
    "apigateway.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicecontrol.googleapis.com",
    "servicemanagement.googleapis.com",
    "sqladmin.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "random_id" "suffix" {
  byte_length = 3
}

# ---------------------------------------------------------------- image

resource "google_artifact_registry_repository" "app" {
  repository_id = var.name
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "terraform_data" "image" {
  count            = var.image == "" ? 1 : 0
  triggers_replace = [local.image]
  provisioner "local-exec" {
    working_dir = local.root
    command     = <<-EOT
      set -e
      gcloud auth configure-docker ${local.registry} --quiet
      docker build --platform linux/amd64 -t ${local.image} .
      docker push ${local.image}
    EOT
  }
}

# ---------------------------------------------------------------- network + redis

resource "google_compute_network" "main" {
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "main" {
  name          = var.name
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = "10.30.0.0/24"
}

# The feed index, tails, hot summaries and publisher credits, reached over Cloud Run's direct VPC
# egress. volatile-lru only ever evicts keys with a TTL (hot summaries and superseded index keys),
# so a full cache degrades to object-store reads instead of losing the index. Traffic stays inside
# the VPC and needs the AUTH string; Memorystore's TLS uses a private CA the app doesn't load.
resource "google_redis_instance" "main" {
  name               = var.name
  region             = var.region
  tier               = var.redis_tier
  memory_size_gb     = var.redis_memory_gb
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.main.id
  auth_enabled       = true
  redis_configs = {
    maxmemory-policy = "volatile-lru"
  }
  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------- content + database

# Summaries share the content bucket, under summaries/<UTC day>/; the compactor deletes days past retention.

resource "google_storage_bucket" "content" {
  name                        = "${var.project_id}-${var.name}-content"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = !var.deletion_protection

  # Browsers send files straight to the bucket, with the link POST /uploads signs.
  cors {
    origin          = var.upload_origins
    method          = ["PUT"]
    response_header = ["Content-Type", "ETag"]
    max_age_seconds = 3600
  }

  # POST /store moves an upload into content/ and removes it; one nobody stored goes after a day.
  lifecycle_rule {
    condition {
      age            = 1
      matches_prefix = ["uploads/"]
    }
    action {
      type = "Delete"
    }
  }
}

# Links to the bucket are signed with a private key, and Cloud Run's own credentials have none.
# This account can do nothing but read and write the bucket's objects, and its key is what the
# functions use for the bucket, so they can sign upload and download links. The key does not
# expire: it is kept in Secret Manager and in the Terraform state. `direct_uploads = false`
# leaves the key out, and POST /uploads answers 501.
resource "google_service_account" "storage" {
  count        = var.direct_uploads ? 1 : 0
  account_id   = "${var.name}-storage"
  display_name = "Evieverse content bucket (signs upload links)"
  depends_on   = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "storage" {
  count  = var.direct_uploads ? 1 : 0
  bucket = google_storage_bucket.content.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.storage[0].email}"
}

resource "google_service_account_key" "storage" {
  count              = var.direct_uploads ? 1 : 0
  service_account_id = google_service_account.storage[0].name
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name                = "${var.name}-${random_id.suffix.hex}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.deletion_protection
  settings {
    tier    = var.db_tier
    edition = "ENTERPRISE"
    ip_configuration {
      # Reached only through the Cloud SQL connector (IAM-authorised); no authorised networks.
      ipv4_enabled = true
    }
    backup_configuration {
      enabled = true
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "main" {
  name     = "evieverse"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "evieverse"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

resource "google_secret_manager_secret" "db_url" {
  secret_id = "${var.name}-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "db_url" {
  secret      = google_secret_manager_secret.db_url.id
  secret_data = "postgres://evieverse:${random_password.db.result}@localhost/evieverse?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

resource "google_secret_manager_secret" "redis_url" {
  secret_id = "${var.name}-redis-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "redis_url" {
  secret      = google_secret_manager_secret.redis_url.id
  secret_data = "redis://:${google_redis_instance.main.auth_string}@${google_redis_instance.main.host}:${google_redis_instance.main.port}"
}

resource "google_secret_manager_secret" "content_options" {
  secret_id = "${var.name}-content-options"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "content_options" {
  secret = google_secret_manager_secret.content_options.id
  secret_data = jsonencode(merge(
    { bucket = google_storage_bucket.content.name },
    # OpenDAL takes the key as base64 of its JSON, which is how the provider returns it.
    var.direct_uploads ? { credential = google_service_account_key.storage[0].private_key } : {},
  ))
}

resource "google_secret_manager_secret" "extra" {
  for_each  = local.secret_keys
  secret_id = "${var.name}-${lower(replace(each.value, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "extra" {
  for_each    = local.secret_keys
  secret      = google_secret_manager_secret.extra[each.value].id
  secret_data = var.secrets[each.value]
}

# ---------------------------------------------------------------- identity

resource "google_service_account" "app" {
  account_id   = "${var.name}-app"
  display_name = "Evieverse functions and compactor"
}

resource "google_storage_bucket_iam_member" "content" {
  bucket = google_storage_bucket.content.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}

resource "google_project_iam_member" "sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.app.email}"
}

resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = local.secret_env
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

locals {
  # What every service, the compactor and every job wait for before they start.
  ready = [
    terraform_data.image,
    google_project_iam_member.sql,
    google_storage_bucket_iam_member.content,
    google_storage_bucket_iam_member.storage,
    google_secret_manager_secret_iam_member.app,
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_version.redis_url,
    google_secret_manager_secret_version.content_options,
    google_secret_manager_secret_version.extra,
  ]
}

# ---------------------------------------------------------------- admin account

# The server's first admin, and its API key in the server's own format (src/auth/apiKey.ts). The
# migrate job below creates the account from the key's hash (src/moderation/bootstrap.ts), so
# the key itself is only in the state and in the profile file. To replace the key:
#   terraform apply -replace=random_password.admin_key
resource "random_uuid" "admin" {}

resource "random_id" "admin_key_prefix" {
  byte_length = 6
}

# 43 characters of the 64 that base64url uses, which is what the server's keys end in.
resource "random_password" "admin_key" {
  length           = 43
  override_special = "-_"
}

locals {
  # random_uuid gives 32 random hex digits in a UUID's shape, where the server's ids are version 4
  # UUIDs and its API takes nothing else. So the two digits that make it one are set here: the
  # version (4) and the variant (8, 9, a or b).
  admin_user_id = join("", [
    substr(random_uuid.admin.result, 0, 14), "4", substr(random_uuid.admin.result, 15, 4),
    element(["8", "9", "a", "b"], parseint(substr(random_uuid.admin.result, 19, 1), 16) % 4),
    substr(random_uuid.admin.result, 20, 16),
  ])
  admin_api_key = sensitive("tu_${random_id.admin_key_prefix.hex}_${random_password.admin_key.result}")
  bootstrap_admin = jsonencode({
    userId   = local.admin_user_id
    username = var.admin_username
    keyHash  = nonsensitive(sha256(local.admin_api_key))
  })
  admin_profile_path = pathexpand("~/.evieverse/profiles/${var.name}.json")
}

# The admin's profile for the CLI, on the machine that applies: `evieverse --profile ${var.name} whoami`.
resource "local_sensitive_file" "admin_profile" {
  count                = var.install_admin_profile ? 1 : 0
  filename             = local.admin_profile_path
  file_permission      = "0600"
  directory_permission = "0700"
  content = jsonencode({
    server   = local.url
    userId   = local.admin_user_id
    username = var.admin_username
    apiKey   = local.admin_api_key
  })
  depends_on = [terraform_data.migrate]
}

# ---------------------------------------------------------------- migrations

# Functions never migrate the database when they start (many start at once), so each apply that
# changes the image or the admin account runs this job first and waits for it. The job also sets up
# the admin account.
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${var.name}-migrate"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account       = google_service_account.app.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      timeout               = "600s"
      max_retries           = 0

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image   = local.image
        command = ["node"]
        args    = ["dist/db/migrate.js"]
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        env {
          name  = "DB_DIALECT"
          value = "postgres"
        }
        env {
          name  = "BOOTSTRAP_ADMIN"
          value = local.bootstrap_admin
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_url.secret_id
              version = "latest"
            }
          }
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  depends_on = [
    terraform_data.image,
    google_project_iam_member.sql,
    google_secret_manager_secret_iam_member.app,
    google_secret_manager_secret_version.db_url,
    google_sql_database.main,
    google_sql_user.app,
  ]
}

resource "terraform_data" "migrate" {
  triggers_replace = [local.image, local.bootstrap_admin]
  provisioner "local-exec" {
    command = "gcloud run jobs execute ${google_cloud_run_v2_job.migrate.name} --project ${var.project_id} --region ${var.region} --wait"
  }

  lifecycle {
    precondition {
      condition     = can(regex("^tu_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$", local.admin_api_key))
      error_message = "The admin API key isn't in the format the server issues and accepts (KEY_PATTERN in src/auth/apiKey.ts)."
    }
    precondition {
      condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", local.admin_user_id))
      error_message = "The admin account's id isn't a version 4 UUID, which is what the server's user ids are."
    }
  }
}

# ---------------------------------------------------------------- functions

resource "google_cloud_run_v2_service" "group" {
  for_each            = local.groups
  name                = "${var.name}-${each.key}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.app.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "${var.request_timeout}s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = each.value.max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image   = local.image
      command = ["node"]
      args    = ["dist/functions/http.js"]
      ports {
        container_port = 3000
      }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
        # Billed while a request is being served, and given extra CPU while starting.
        cpu_idle          = true
        startup_cpu_boost = true
      }
      env {
        name  = "FUNCTION_GROUP"
        value = each.key
      }
      dynamic "env" {
        for_each = local.function_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        period_seconds    = 1
        failure_threshold = 60
        http_get {
          path = "/health"
        }
      }
    }
  }

  depends_on = [terraform_data.migrate, local.ready]
}

# Only the gateway may call the services, so a request can't reach one with a made-up
# X-Forwarded-For. (This also means no `allUsers` binding, which some organisations forbid.)
resource "google_service_account" "gateway" {
  account_id   = "${var.name}-gateway"
  display_name = "Evieverse API gateway"
  depends_on   = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "gateway" {
  for_each = local.groups
  name     = google_cloud_run_v2_service.group[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

# ---------------------------------------------------------------- gateway

resource "google_api_gateway_api" "main" {
  provider   = google-beta
  api_id     = var.name
  depends_on = [google_project_service.apis]
}

resource "google_project_service" "gateway" {
  service            = google_api_gateway_api.main.managed_service
  disable_on_destroy = false
}

resource "google_api_gateway_api_config" "main" {
  provider             = google-beta
  api                  = google_api_gateway_api.main.api_id
  api_config_id_prefix = "${var.name}-"

  openapi_documents {
    document {
      path     = "openapi.json"
      contents = base64encode(local.openapi)
    }
  }
  gateway_config {
    backend_config {
      google_service_account = google_service_account.gateway.email
    }
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_api_gateway_gateway" "main" {
  provider   = google-beta
  gateway_id = var.name
  region     = var.gateway_region != "" ? var.gateway_region : var.region
  api_config = google_api_gateway_api_config.main.id
  depends_on = [google_project_service.gateway]
}

# ---------------------------------------------------------------- compactor

# The compactor is one process that stays up: pass after pass over the feed index, never two at
# once, and never more than one in COMPACT_INTERVAL_SECONDS (5 unless `environment` says otherwise).
# A service can't be that (it runs while it is called, and a schedule calls once a minute at most),
# so it is a worker pool: Cloud Run's resource for continuous background work, with no endpoint and
# no autoscaling. It keeps one instance up and starts another whenever that one stops. While a
# deploy replaces the instance there can be two for a moment: their passes still don't overlap,
# since each takes the compactor's lease in the database and a pass that finds it held is skipped.
resource "google_cloud_run_v2_worker_pool" "compactor" {
  name                = "${var.name}-compactor"
  location            = var.region
  deletion_protection = false

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = 1
  }

  template {
    service_account = google_service_account.app.email

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image   = local.image
      command = ["node"]
      args    = ["dist/compact/main.js"]
      resources {
        limits = { cpu = var.compactor_cpu, memory = var.compactor_memory }
      }
      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }
  }

  depends_on = [terraform_data.migrate, local.ready]
}

# `--rebuild` rebuilds the whole feed index from the database and the bucket, after Redis lost data.
# It is a job, started by hand (see deploy/README.md): nothing schedules it. It can run beside the
# compactor: the lease makes each wait for the other's pass.
resource "google_cloud_run_v2_job" "rebuild" {
  name                = "${var.name}-rebuild"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account       = google_service_account.app.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      timeout               = "86400s"
      max_retries           = 0

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image   = local.image
        command = ["node"]
        args    = ["dist/compact/main.js", "--once", "--rebuild"]
        resources {
          limits = { cpu = "1", memory = "1Gi" }
        }
        dynamic "env" {
          for_each = local.env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = local.secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  depends_on = [terraform_data.migrate, local.ready]
}
