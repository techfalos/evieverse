variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "evieverse"
}

variable "image" {
  description = "Prebuilt container image, in an ECR repository of this account and region (Lambda runs images from nowhere else). Leave empty to build the repo with docker and push it to ECR."
  type        = string
  default     = ""
}

variable "function_memory" {
  description = "Memory of each function, in MB. A function's share of CPU grows with it."
  type        = number
  default     = 1024
}

variable "store_function_memory" {
  description = "Memory of the store function, in MB. It takes in the files of posts, so it gets more memory and CPU than the rest."
  type        = number
  default     = 2048
}

variable "function_max_concurrency" {
  description = "Most instances of each function that uses the database (content, store, api) that run at once. Lambda gives an instance one request at a time, so this is also how many requests the function answers at once; one more is refused, not queued. Without it a flood of requests starts instances up to the account's limit, each with its own connections to Redis and the database proxy, and each billed. It is Lambda's reserved concurrency, which also sets that many aside from the account's quota: the three of these and `feed_function_max_concurrency` must leave the account 100 unreserved, so the defaults need a quota of 350 (`aws lambda get-account-settings`; a new account may have less, and a quota increase is a request to AWS). null: no limit, and nothing set aside."
  type        = number
  default     = 50
  validation {
    condition     = var.function_max_concurrency == null ? true : var.function_max_concurrency >= 1 && floor(var.function_max_concurrency) == var.function_max_concurrency
    error_message = "A whole number of instances, 1 or more, or null for no limit."
  }
}

variable "feed_function_max_concurrency" {
  description = "Most instances of the feed function that run at once, which is how many feeds are answered at once: the server's own limit on that (FEED_MAX_CONCURRENT) is per process, and never reached where a process has one request at a time. See `function_max_concurrency`. null: no limit."
  type        = number
  default     = 100
  validation {
    condition     = var.feed_function_max_concurrency == null ? true : var.feed_function_max_concurrency >= 1 && floor(var.feed_function_max_concurrency) == var.feed_function_max_concurrency
    error_message = "A whole number of instances, 1 or more, or null for no limit."
  }
}

variable "compactor_cpu" {
  description = "CPU units of the compactor's Fargate task (1024 is one vCPU). The compactor is one task that is always up; how often it makes a pass is COMPACT_INTERVAL_SECONDS in `environment` (5 by default). It also processes the videos users send, with ffmpeg, which is CPU work: where videos are common, give it 2048 or more (and memory to match), or set VIDEO_PROCESSING to false in `environment`."
  type        = number
  default     = 512
}

variable "compactor_memory" {
  description = "Memory of the compactor's Fargate task, in MB. Fargate takes only some pairs of CPU and memory."
  type        = number
  default     = 1024
}

variable "upload_origins" {
  description = "Origins whose pages may send files straight to the content bucket with an upload link. The link itself is the permission; this only tells browsers which pages may use one."
  type        = list(string)
  default     = ["*"]
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "redis_node_type" {
  description = "ElastiCache node type. Size it for the feed index (~30 bytes per indexed post) plus 8 days of compressed summaries; see docs/DEPLOY.md."
  type        = string
  default     = "cache.t4g.small"
}

variable "redis_replicas" {
  description = "Read replicas of the ElastiCache primary; at least 1 gives automatic failover across AZs."
  type        = number
  default     = 1
}

variable "audit_archive_after_days" {
  description = "Days after a record of the audit log (every request that added, updated or deleted something) is written that it moves to S3 Glacier Deep Archive, if it is 128 KB or larger. null, the default: records stay in S3 Standard. Nearly every record is about 1 KB, and archiving one that small costs more than keeping it: Deep Archive bills 40 KB of overhead for each object and $0.05 per 1,000 objects moved. So smaller records stay where they are either way. Restoring an archived one takes hours."
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
  description = "Secret environment variables, e.g. storage credentials in SUMMARY_OPTIONS. Stored in Secrets Manager, where the functions, the compactor and the rebuild task read them as they start: none is in a function's configuration."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete the database (no final snapshot) and non-empty buckets."
  type        = bool
  default     = false
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
