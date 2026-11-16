# theuniverse on Google Cloud:
#   Cloud Run service (HTTPS *.run.app URL) with the feed index and hot summaries in Memorystore
#   for Redis, content and summaries in GCS, Cloud SQL PostgreSQL over the built-in Cloud SQL
#   connector, and a Cloud Run job for the compactor triggered by Cloud Scheduler.

locals {
  root        = abspath("${path.module}/../../..")
  source_hash = sha1(join("", [for f in concat(sort(fileset(local.root, "src/**")), ["package.json", "package-lock.json", "Dockerfile", "tsconfig.json", "tsconfig.build.json"]) : filesha1("${local.root}/${f}")]))
  registry    = "${var.region}-docker.pkg.dev"
  image       = var.image != "" ? var.image : "${local.registry}/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/app:${substr(local.source_hash, 0, 12)}"
  # Deterministic Cloud Run URL, known before the service exists (the service needs it as PUBLIC_BASE_URL).
  url         = "https://${var.name}-${data.google_project.this.number}.${var.region}.run.app"
  secret_keys = nonsensitive(toset(keys(var.secrets)))

  env = merge({
    DB_DIALECT         = "postgres"
    CONTENT_SCHEME     = "gcs"
    CONTENT_OPTIONS    = jsonencode({ bucket = google_storage_bucket.content.name })
    PUBLIC_BASE_URL    = local.url
    COMPACT_IN_PROCESS = "false"
    # Cloud Run caps HTTP/1.1 request bodies at 32 MiB.
    MAX_UPLOAD_BYTES = "33000000"
  }, var.environment)
}

data "google_project" "this" {}

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
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
  name     = "theuniverse"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "theuniverse"
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
  secret_data = "postgres://theuniverse:${random_password.db.result}@localhost/theuniverse?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
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
  display_name = "theuniverse API and compactor"
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

resource "google_secret_manager_secret_iam_member" "db_url" {
  secret_id = google_secret_manager_secret.db_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

resource "google_secret_manager_secret_iam_member" "redis_url" {
  secret_id = google_secret_manager_secret.redis_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

resource "google_secret_manager_secret_iam_member" "extra" {
  for_each  = local.secret_keys
  secret_id = google_secret_manager_secret.extra[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

# ---------------------------------------------------------------- API service

resource "google_cloud_run_v2_service" "app" {
  name                = var.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.app.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "900s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
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
      image = local.image
      ports {
        container_port = 3000
      }
      resources {
        limits = { cpu = "2", memory = "2Gi" }
      }
      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
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
      env {
        name = "REDIS_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.redis_url.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = local.secret_keys
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.extra[env.value].secret_id
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
        period_seconds    = 3
        failure_threshold = 20
        http_get {
          path = "/health"
        }
      }
    }
  }

  depends_on = [
    terraform_data.image,
    google_project_iam_member.sql,
    google_secret_manager_secret_iam_member.db_url,
    google_secret_manager_secret_iam_member.redis_url,
    google_secret_manager_secret_iam_member.extra,
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_version.redis_url,
    google_secret_manager_secret_version.extra,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------- compactor

resource "google_cloud_run_v2_job" "compactor" {
  name                = "${var.name}-compactor"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account       = google_service_account.app.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      timeout               = "600s"
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
        args    = ["dist/compact/main.js", "--once"]
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
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_url.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "REDIS_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.redis_url.secret_id
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
    google_secret_manager_secret_iam_member.db_url,
    google_secret_manager_secret_iam_member.redis_url,
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_version.redis_url,
  ]
}

resource "google_service_account" "scheduler" {
  account_id   = "${var.name}-scheduler"
  display_name = "Triggers the theuniverse compactor"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler" {
  name     = google_cloud_run_v2_job.compactor.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "compactor" {
  name      = "${var.name}-compactor"
  region    = var.region
  schedule  = var.compactor_schedule
  time_zone = "Etc/UTC"
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.compactor.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.scheduler]
}
