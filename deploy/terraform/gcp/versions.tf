terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source = "hashicorp/google"
      # The first with Cloud Run worker pools as they are now, which the compactor runs in.
      version = "~> 6.50"
    }
    # API Gateway's resources are only in the beta provider.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.50"
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
