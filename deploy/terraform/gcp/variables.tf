variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "name" {
  description = "Prefix for every resource name (lowercase letters, digits, hyphens)."
  type        = string
  default     = "evieverse"
}

variable "image" {
  description = "Prebuilt container image. Leave empty to build the repo with docker and push it to Artifact Registry."
  type        = string
  default     = ""
}

variable "min_instances" {
  description = "Instances each route group keeps running. 0 lets a group with no traffic cost nothing; its next request then waits for an instance to start."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Most instances of each route group that uses the database (content, store, api). Each keeps up to `db_pool_size` connections, and together with the compactor they must stay under the database's limit: 3 x max_instances x db_pool_size + 5 <= max_connections (50 on db-g1-small)."
  type        = number
  default     = 3
}

variable "feed_max_instances" {
  description = "Most instances of the feed group, which reads Redis and the bucket only."
  type        = number
  default     = 10
}

variable "db_pool_size" {
  description = "Database connections per instance. See `max_instances`."
  type        = number
  default     = 4
}

variable "request_timeout" {
  description = "Seconds the gateway and a service give a request, e.g. a post whose AI analysis is slow."
  type        = number
  default     = 300
}

variable "trust_proxy" {
  description = "How many proxies in front of a service add to X-Forwarded-For (the gateway, then Cloud Run's front end). The client address that the limits by address count, and that the audit log and the request log record, is read that many entries from the end. 2 is what a live deployment showed: `remoteAddress` in a service's request log is the client's own address, whatever X-Forwarded-For the client sent. See docs/IAC.md."
  type        = number
  default     = 2
}

variable "gateway_region" {
  description = "Region of the API Gateway, which runs in fewer regions than Cloud Run. Empty: `region`."
  type        = string
  default     = ""
}

variable "upload_origins" {
  description = "Origins whose pages may send files straight to the content bucket with an upload link. The link itself is the permission; this only tells browsers which pages may use one."
  type        = list(string)
  default     = ["*"]
}

variable "db_tier" {
  type    = string
  default = "db-g1-small"
}

variable "redis_tier" {
  description = "STANDARD_HA keeps a replica in another zone with automatic failover; BASIC is a single node."
  type        = string
  default     = "STANDARD_HA"
}

variable "redis_memory_gb" {
  description = "Memorystore capacity. Size it for the feed index (~30 bytes per indexed post) plus 8 days of compressed summaries; see docs/IAC.md."
  type        = number
  default     = 1
}

variable "compactor_cpu" {
  description = "CPUs of the compactor's instance. The compactor is one instance that is always up; how often it makes a pass is COMPACT_INTERVAL_SECONDS in `environment` (5 by default). It also processes the videos users send, with ffmpeg, which is CPU work: where videos are common, give it 2 or more, or set VIDEO_PROCESSING to false in `environment`."
  type        = string
  default     = "1"
}

variable "compactor_memory" {
  description = "Memory of the compactor's instance. The files of a video it processes count against it, since Cloud Run keeps an instance's files in memory: the video as it was sent and every size it is made in, so a server that takes large videos needs several times the largest (MAX_UPLOAD_BYTES)."
  type        = string
  default     = "1Gi"
}

variable "support_email" {
  description = "The email address people write to for support, which GET /rules gives to anyone (SUPPORT_EMAIL). The default is a placeholder: set it to an address that someone reads. A SUPPORT_EMAIL in `environment` takes its place."
  type        = string
  default     = "noreply@yoururl.com"
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.support_email))
    error_message = "An email address, such as support@example.com."
  }
}

variable "environment" {
  description = "Extra environment variables, e.g. { TAGGING_MODE = \"server\", TAGGING_SERVER_TAGS = \"news\" }."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret environment variables, e.g. storage credentials in SUMMARY_OPTIONS. Stored in Secret Manager."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "deletion_protection" {
  description = "Protect the database from `terraform destroy`, and keep the content and audit log buckets from being deleted while they hold objects. A destroy goes by what the last apply recorded, not by the value it is given: to take the deployment down, run `terraform apply -var deletion_protection=false` first, then `terraform destroy`. Passing it to `terraform destroy` alone changes nothing."
  type        = bool
  default     = true
}

variable "audit_archive_after_days" {
  description = "Days after a record of the audit log (every request that added, updated or deleted something) is written that it moves to the Archive storage class, if it is larger than 128 KB. null, the default: records stay in the Standard class. Nearly every record is about 1 KB, and moving one that small costs more than keeping it: each object moved is billed as a Class A operation of the Archive class ($0.05 per 1,000). So smaller records stay where they are either way."
  type        = number
  default     = null
  validation {
    condition     = var.audit_archive_after_days == null ? true : var.audit_archive_after_days >= 0
    error_message = "A number of days, 0 or more, or null to archive nothing."
  }
}

variable "admin_username" {
  description = "Username of the admin account the deployment creates. It names the account when it's created: to rename it afterwards, use PATCH /users/:userId."
  type        = string
  default     = "admin"
  validation {
    condition     = length(trimspace(var.admin_username)) >= 1 && length(trimspace(var.admin_username)) <= 64
    error_message = "A username is 1 to 64 characters."
  }
}

variable "install_admin_profile" {
  description = "Write the admin account's API key to ~/.evieverse/profiles/<name>.json on the machine that applies, where the CLI reads it (admin_profile_name gives the file another name). Turn it off where applies run unattended, and read the key with `terraform output -raw admin_api_key`."
  type        = bool
  default     = true
}

variable "admin_profile_name" {
  description = "Name of the CLI profile the admin account's key is written to: ~/.evieverse/profiles/<admin_profile_name>.json, used as `evieverse --profile <admin_profile_name>`. Empty: the same as `name`. Set it where one machine applies several deployments with the same `name`, as each apply would otherwise write over the others' profile."
  type        = string
  default     = ""
  validation {
    condition     = var.admin_profile_name == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", var.admin_profile_name))
    error_message = "A profile's name is 1 to 64 letters, digits, \".\", \"_\" and \"-\", the first a letter or a digit."
  }
}
