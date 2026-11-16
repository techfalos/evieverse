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
  default     = "theuniverse"
}

variable "image" {
  description = "Prebuilt container image (must be pullable with the registry credentials). Leave empty to build the repo with `az acr build`."
  type        = string
  default     = ""
}

variable "min_replicas" {
  type    = number
  default = 1
}

variable "max_replicas" {
  type    = number
  default = 10
}

variable "db_sku" {
  type    = string
  default = "B_Standard_B1ms"
}

variable "redis_sku" {
  description = "Azure Managed Redis SKU. Size it for the feed index (~30 bytes per indexed post) plus 8 days of compressed summaries; see deploy/README.md."
  type        = string
  default     = "Balanced_B1"
}

variable "redis_high_availability" {
  description = "Keep a replica with automatic failover."
  type        = bool
  default     = true
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
