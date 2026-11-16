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
  default     = "theuniverse"
}

variable "image" {
  description = "Prebuilt container image. Leave empty to build the repo with docker and push it to Artifact Registry."
  type        = string
  default     = ""
}

variable "min_instances" {
  type    = number
  default = 1
}

variable "max_instances" {
  type    = number
  default = 10
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

variable "compactor_schedule" {
  description = "Cron schedule (UTC) for the compactor job."
  type        = string
  default     = "* * * * *"
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
