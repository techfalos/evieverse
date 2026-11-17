terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.10"
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

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  # Container Apps is Microsoft.App, which is not among the resource providers this provider
  # registers on a subscription by itself, and a new subscription has not registered it.
  resource_providers_to_register = ["Microsoft.App"]
  # The storage account takes no account key (shared_access_key_enabled = false), so what the
  # provider itself asks of it, it asks signed in as whoever applies.
  storage_use_azuread = true
}
