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

variable "compactor_cpu" {
  description = "CPU units of the compactor's Fargate task (1024 is one vCPU). The compactor is one task that is always up; how often it makes a pass is COMPACT_INTERVAL_SECONDS in `environment` (5 by default)."
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
  description = "Days after a record of the audit log (every request that added, updated or deleted something) is written that it moves to S3 Glacier Deep Archive, the cold storage it stays in. Restoring one takes hours."
  type        = number
  default     = 30
  validation {
    condition     = var.audit_archive_after_days >= 0
    error_message = "A number of days, 0 or more."
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
  description = "Secret environment variables, e.g. storage credentials in SUMMARY_OPTIONS. Stored in Secrets Manager for the compactor and the rebuild task, and in the functions' encrypted environment."
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
  description = "Write the admin account's API key to ~/.evieverse/profiles/<name>.json on the machine that applies, where the CLI reads it. Turn it off where applies run unattended, and read the key with `terraform output -raw admin_api_key`."
  type        = bool
  default     = true
}
