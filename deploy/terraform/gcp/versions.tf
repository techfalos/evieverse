terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source = "hashicorp/google"
      # The first with a size condition on a bucket's lifecycle rules, which keeps small audit
      # records out of the Archive class.
      version = "~> 7.38"
    }
    # API Gateway's resources are only in the beta provider.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.38"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}
