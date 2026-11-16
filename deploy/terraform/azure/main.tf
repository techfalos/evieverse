# theuniverse on Azure:
#   Container Apps (HTTPS *.azurecontainerapps.io URL) for the API and a single-replica compactor,
#   the feed index and hot summaries in Azure Managed Redis, content and summaries as blobs,
#   and Azure Database for PostgreSQL Flexible Server.

locals {
  root        = abspath("${path.module}/../../..")
  source_hash = sha1(join("", [for f in concat(sort(fileset(local.root, "src/**")), ["package.json", "package-lock.json", "Dockerfile", "tsconfig.json", "tsconfig.build.json"]) : filesha1("${local.root}/${f}")]))
  compact     = replace(var.name, "-", "")
  image       = var.image != "" ? var.image : "${azurerm_container_registry.main.login_server}/app:${substr(local.source_hash, 0, 12)}"
  # Deterministic app URL, known before the app exists (the app needs it as PUBLIC_BASE_URL).
  url           = "https://${var.name}.${azurerm_container_app_environment.main.default_domain}"
  blob_endpoint = trimsuffix(azurerm_storage_account.main.primary_blob_endpoint, "/")

  blob_options = {
    endpoint     = local.blob_endpoint
    account_name = azurerm_storage_account.main.name
    account_key  = azurerm_storage_account.main.primary_access_key
  }

  env = merge({
    DB_DIALECT         = "postgres"
    CONTENT_SCHEME     = "azblob"
    PUBLIC_BASE_URL    = local.url
    COMPACT_IN_PROCESS = "false"
  }, var.environment)

  # Env var name -> secret value. Container Apps secret names are lowercase with hyphens.
  secret_env = merge({
    DATABASE_URL    = "postgres://theuniverse:${random_password.db.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/theuniverse?sslmode=require"
    REDIS_URL       = "rediss://:${azurerm_managed_redis.main.default_database[0].primary_access_key}@${azurerm_managed_redis.main.hostname}:${azurerm_managed_redis.main.default_database[0].port}"
    CONTENT_OPTIONS = jsonencode(merge(local.blob_options, { container = azurerm_storage_container.content.name }))
  }, var.secrets)
  secret_names = nonsensitive(toset(keys(local.secret_env)))
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_resource_group" "main" {
  name     = "${var.name}-rg"
  location = var.location
}

# ---------------------------------------------------------------- image

resource "azurerm_container_registry" "main" {
  name                = substr("${local.compact}${random_string.suffix.result}", 0, 50)
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = true
}

resource "terraform_data" "image" {
  count            = var.image == "" ? 1 : 0
  triggers_replace = [local.image]
  provisioner "local-exec" {
    working_dir = local.root
    command     = "az acr build --registry ${azurerm_container_registry.main.name} --image app:${substr(local.source_hash, 0, 12)} --platform linux/amd64 ."
  }
}

# ---------------------------------------------------------------- storage

resource "azurerm_storage_account" "main" {
  name                            = substr("${local.compact}${random_string.suffix.result}", 0, 24)
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
}

# Summaries share this container, under summaries/<UTC day>/; the compactor deletes days past retention.
resource "azurerm_storage_container" "content" {
  name                  = "content"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# ---------------------------------------------------------------- redis

# The feed index, tails, hot summaries and publisher credits. The Enterprise clustering policy puts
# one endpoint in front of the shards, so the app connects as to a single Redis. volatile-lru only
# ever evicts keys with a TTL (hot summaries and superseded index keys), so a full cache degrades to
# object-store reads instead of losing the index.
resource "azurerm_managed_redis" "main" {
  name                      = "${var.name}-${random_string.suffix.result}"
  resource_group_name       = azurerm_resource_group.main.name
  location                  = azurerm_resource_group.main.location
  sku_name                  = var.redis_sku
  high_availability_enabled = var.redis_high_availability

  default_database {
    access_keys_authentication_enabled = true
    client_protocol                    = "Encrypted"
    clustering_policy                  = "EnterpriseCluster"
    eviction_policy                    = "VolatileLRU"
  }
}

# ---------------------------------------------------------------- database

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "${var.name}-${random_string.suffix.result}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  administrator_login           = "theuniverse"
  administrator_password        = random_password.db.result
  sku_name                      = var.db_sku
  storage_mb                    = 32768
  backup_retention_days         = 7
  public_network_access_enabled = true
  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "theuniverse"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# 0.0.0.0 - 0.0.0.0 admits Azure services only (Container Apps egress); TLS is required.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# ---------------------------------------------------------------- container apps

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${var.name}-logs"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "main" {
  name                       = "${var.name}-env"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
}

resource "azurerm_container_app" "app" {
  name                         = var.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }
  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }
  dynamic "secret" {
    for_each = local.secret_names
    content {
      name  = lower(replace(secret.value, "_", "-"))
      value = local.secret_env[secret.value]
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 3000
    transport                  = "auto"
    allow_insecure_connections = false
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas
    container {
      name   = "app"
      image  = local.image
      cpu    = 1
      memory = "2Gi"
      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_names
        content {
          name        = env.value
          secret_name = lower(replace(env.value, "_", "-"))
        }
      }
      liveness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/health"
      }
      readiness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/health"
      }
    }
  }

  depends_on = [terraform_data.image, azurerm_postgresql_flexible_server_firewall_rule.azure, azurerm_postgresql_flexible_server_database.main]
}

# Exactly one compactor replica, no ingress.
resource "azurerm_container_app" "compactor" {
  name                         = "${var.name}-compactor"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }
  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }
  dynamic "secret" {
    for_each = local.secret_names
    content {
      name  = lower(replace(secret.value, "_", "-"))
      value = local.secret_env[secret.value]
    }
  }

  template {
    min_replicas = 1
    max_replicas = 1
    container {
      name    = "compactor"
      image   = local.image
      command = ["node", "dist/compact/main.js"]
      cpu     = 0.5
      memory  = "1Gi"
      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_names
        content {
          name        = env.value
          secret_name = lower(replace(env.value, "_", "-"))
        }
      }
    }
  }

  depends_on = [terraform_data.image, azurerm_postgresql_flexible_server_firewall_rule.azure, azurerm_postgresql_flexible_server_database.main]
}
