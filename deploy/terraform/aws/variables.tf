variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "theuniverse"
}

variable "image" {
  description = "Prebuilt container image. Leave empty to build the repo with docker and push it to ECR."
  type        = string
  default     = ""
}

variable "app_count" {
  description = "Number of API tasks."
  type        = number
  default     = 2
}

variable "app_cpu" {
  type    = number
  default = 1024
}

variable "app_memory" {
  type    = number
  default = 2048
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "redis_node_type" {
  description = "ElastiCache node type. Size it for the feed index (~30 bytes per indexed post) plus 8 days of compressed summaries; see deploy/README.md."
  type        = string
  default     = "cache.t4g.small"
}

variable "redis_replicas" {
  description = "Read replicas of the ElastiCache primary; at least 1 gives automatic failover across AZs."
  type        = number
  default     = 1
}

variable "environment" {
  description = "Extra environment variables, e.g. { TAGGING_MODE = \"server\", TAGGING_SERVER_TAGS = \"news\" }."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret environment variables, e.g. storage credentials in SUMMARY_OPTIONS. Stored in Secrets Manager."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete the database (no final snapshot) and non-empty buckets."
  type        = bool
  default     = false
}
