variable "subscription_id" {
  type = string
}

variable "location" {
  type    = string
  default = "eastus"
}

variable "name" {
  description = "Prefix for every resource name (lowercase letters and digits)."
  type        = string
  default     = "evieverse"
}

variable "image" {
  description = "Prebuilt container image (must be pullable with the registry credentials). Leave empty to build the repo with `az acr build`."
  type        = string
  default     = ""
}

variable "min_replicas" {
  description = "Replicas each route group keeps running. 0 lets a group with no traffic cost nothing; its next request then waits for a replica to start."
  type        = number
  default     = 0
}

variable "max_replicas" {
  description = "Most replicas of each route group that uses the database (content, store, api). Each keeps up to `db_pool_size` connections, and together with the compactor they must stay under the database's limit: 3 x max_replicas x db_pool_size + 5 <= the connections the server leaves for users (35 on B_Standard_B1ms)."
  type        = number
  default     = 3
}

variable "feed_max_replicas" {
  description = "Most replicas of the feed group, which reads Redis and blobs only."
  type        = number
  default     = 10
}

variable "db_pool_size" {
  description = "Database connections per replica. See `max_replicas`."
  type        = number
  default     = 3
}

variable "request_timeout" {
  description = "Seconds Front Door waits for an app to answer (16 to 240), e.g. for a post whose AI analysis is slow."
  type        = number
  default     = 240
}

variable "trust_proxy" {
  description = "How many proxies in front of an app add to X-Forwarded-For (Front Door, then the Container Apps ingress). The client address that the audit log and the request log record is read that many entries from the end. Check it after the first apply: see docs/DEPLOY.md."
  type        = number
  default     = 2
}

variable "compactor_cpu" {
  description = "CPUs of the compactor's replica. The compactor is one replica that is always up; how often it makes a pass is COMPACT_INTERVAL_SECONDS in `environment` (5 by default)."
  type        = number
  default     = 0.5
}

variable "compactor_memory" {
  description = "Memory of the compactor's replica. Container Apps takes 2Gi for each CPU."
  type        = string
  default     = "1Gi"
}

variable "upload_origins" {
  description = "Origins whose pages may send files straight to blob storage with an upload link. The link itself is the permission; this only tells browsers which pages may use one."
  type        = list(string)
  default     = ["*"]
}

variable "db_sku" {
  type    = string
  default = "B_Standard_B1ms"
}

variable "db_location" {
  description = "Region of the database, where it is not `location`. null, the default: the database is in `location` with everything else. Set it when the subscription may not create PostgreSQL Flexible Servers in `location`, which the apply says as \"The value of the 'Version' should be in: []\": `az postgres flexible-server list-skus --location <region>` lists what a region allows. Choose a region near `location`, as every query then crosses from one to the other. Changing it replaces the database, and what is in it."
  type        = string
  default     = null
}

variable "redis_sku" {
  description = "Azure Managed Redis SKU. Size it for the feed index (~30 bytes per indexed post) plus 8 days of compressed summaries; see docs/DEPLOY.md."
  type        = string
  default     = "Balanced_B1"
}

variable "redis_high_availability" {
  description = "Keep a replica with automatic failover."
  type        = bool
  default     = true
}

variable "audit_archive_after_days" {
  description = "Days after a record of the audit log (every request that added, updated or deleted something) is written that it moves to the Archive tier. null, the default: records stay in the Hot tier. Setting it moves every record, whatever its size, as Azure's lifecycle rules can't filter by size, and for the usual record of about 1 KB that costs more than keeping it: each blob moved is billed as a write to the Archive tier (about $0.11 per 10,000, or $11 per million records), against about $0.02 a month to keep a million of them in the Hot tier. Reading an archived one means rehydrating it first, which takes hours."
  type        = number
  default     = null
  validation {
    condition     = var.audit_archive_after_days == null ? true : var.audit_archive_after_days >= 0
    error_message = "A number of days, 0 or more, or null to archive nothing."
  }
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
  description = "Secret environment variables, e.g. storage credentials in SUMMARY_OPTIONS. Stored as Container Apps secrets."
  type        = map(string)
  default     = {}
  sensitive   = true
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
