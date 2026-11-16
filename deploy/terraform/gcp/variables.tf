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
  description = "How many proxies in front of a service add to X-Forwarded-For (the gateway, then Cloud Run's front end). The address counted for per-address limits is read that many entries from the end. Check it after the first apply: see deploy/README.md."
  type        = number
  default     = 2
}

variable "gateway_region" {
  description = "Region of the API Gateway, which runs in fewer regions than Cloud Run. Empty: `region`."
  type        = string
  default     = ""
}

variable "direct_uploads" {
  description = "Create a service account key for the content bucket so the server can sign upload links (POST /uploads) and download links. The key does not expire and is kept in Secret Manager and the Terraform state. false: files up to 32 MiB only, sent through the server."
  type        = bool
  default     = true
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
  description = "Memorystore capacity. Size it for the feed index (~30 bytes per indexed post) plus 8 days of compressed summaries; see deploy/README.md."
  type        = number
  default     = 1
}

variable "compactor_cpu" {
  description = "CPUs of the compactor's instance. The compactor is one instance that is always up; how often it makes a pass is COMPACT_INTERVAL_SECONDS in `environment` (5 by default)."
  type        = string
  default     = "1"
}

variable "compactor_memory" {
  description = "Memory of the compactor's instance."
  type        = string
  default     = "1Gi"
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
  description = "Protect the database and content bucket from `terraform destroy`."
  type        = bool
  default     = true
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
  description = "Write the admin account's API key to ~/.evieverse/profiles/<name>.json on the machine that applies, where the CLI reads it. Turn it off where applies run unattended, and read the key with `terraform output -raw admin_api_key`."
  type        = bool
  default     = true
}
