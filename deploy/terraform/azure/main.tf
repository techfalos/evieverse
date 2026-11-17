# Evieverse on Azure:
#   Front Door (HTTPS *.azurefd.net URL) -> one Container App per route group (feed, content,
#   store, api), each scaling with its own traffic, down to none. All run the one container image.
#   The compactor is one process that is always up: a Container App of one replica, with no
#   ingress. The feed index and hot summaries are in Azure Managed Redis, content and summaries are
#   blobs, metadata is in Azure Database for PostgreSQL Flexible Server.

locals {
  root          = abspath("${path.module}/../../..")
  source_hash   = sha1(join("", [for f in concat(sort(fileset(local.root, "src/**")), sort(fileset(local.root, "languages/**")), ["package.json", "package-lock.json", "Dockerfile", "tsconfig.json", "tsconfig.build.json", "scripts/build-cli.mjs"]) : filesha1("${local.root}/${f}")]))
  compact       = replace(var.name, "-", "")
  image         = var.image != "" ? var.image : "${azurerm_container_registry.main.login_server}/app:${substr(local.source_hash, 0, 12)}"
  url           = "https://${azurerm_cdn_frontdoor_endpoint.main.host_name}"
  blob_endpoint = trimsuffix(azurerm_storage_account.main.primary_blob_endpoint, "/")

  # Where the storage account is, and no key to it: the apps, the compactor and the jobs reach
  # its containers as the deployment's managed identity (see azurerm_user_assigned_identity.app).
  blob_options = {
    endpoint     = local.blob_endpoint
    account_name = azurerm_storage_account.main.name
  }

  # A variable that `secrets` sets is left out here: it is the secret's to set, as CONTENT_OPTIONS
  # is for a deployment that keeps its content somewhere of its own.
  env = { for key, value in merge({
    DB_DIALECT      = "postgres"
    CONTENT_SCHEME  = "azblob"
    CONTENT_OPTIONS = jsonencode(merge(local.blob_options, { container = azurerm_storage_container.content.name }))
    # Which identity the server is to act as: the one of the deployment (src/storage/azureIdentity.ts).
    AZURE_CLIENT_ID    = azurerm_user_assigned_identity.app.client_id
    PUBLIC_BASE_URL    = local.url
    SUPPORT_EMAIL      = var.support_email
    COMPACT_IN_PROCESS = "false"
    # /store makes an upload a post's bytes by copying it within the storage account, inside the
    # `request_timeout` Front Door gives a request (240 seconds at most): 512 MiB. The server's own
    # default (5 GiB) doesn't fit. An estimate of what does, not a measurement: raise it through
    # `environment` after timing a large upload on your own deployment.
    MAX_UPLOAD_BYTES = "536870912"
  }, var.environment) : key => value if !contains(local.secret_names, key) }

  # Env var name -> secret value. Container Apps secret names are lowercase with hyphens.
  secret_env = merge({
    DATABASE_URL = "postgres://evieverse:${random_password.db.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/evieverse?sslmode=require"
    REDIS_URL    = "rediss://:${azurerm_managed_redis.main.default_database[0].primary_access_key}@${azurerm_managed_redis.main.hostname}:${azurerm_managed_redis.main.default_database[0].port}"
  }, var.secrets)
  secret_names = nonsensitive(toset(keys(local.secret_env)))

  # The route groups of src/functions/groups.ts, and the paths Front Door sends to each: change the
  # two together. The most specific pattern wins, so anything not listed goes to the api group,
  # /feed/following among it: only /feed itself is the feed group's.
  # /content/* is the content group's for reading only: see the ContentWrites rule.
  groups = {
    feed    = { patterns = ["/feed"], max_replicas = var.feed_max_replicas }
    content = { patterns = ["/content/*"], max_replicas = var.max_replicas }
    store   = { patterns = ["/uploads", "/store"], max_replicas = var.max_replicas }
    api     = { patterns = ["/*"], max_replicas = var.max_replicas }
  }

  function_env = merge({
    # Every replica keeps up to this many database connections. See `max_replicas`.
    DB_POOL_SIZE = tostring(var.db_pool_size)
    TRUST_PROXY  = tostring(var.trust_proxy)
    # Only the apps answer requests, so only they write the audit log.
    AUDIT_SCHEME  = "azblob"
    AUDIT_OPTIONS = jsonencode(merge(local.blob_options, { container = azurerm_storage_container.audit.name }))
  }, local.env)
  # Front Door sends this to the apps, whose own addresses are public; they refuse requests without it.
  function_secret_env = merge(local.secret_env, local.generated_secrets, {
    FUNCTION_EDGE_SECRET = random_password.edge.result
  })
  function_secret_names = setunion(local.secret_names, ["FUNCTION_EDGE_SECRET"], local.generated_names)

  # What `environment` and `secrets` set, and the optional trust plugins they turn on, read as the
  # server reads TRUST_OPTIONAL_PLUGINS (names separated by commas or spaces): for the one mistake
  # that is caught in the plan, before the migrate job is started (see the preconditions of
  # terraform_data.migrate).
  settings         = merge(var.environment, var.secrets)
  optional_plugins = regexall("[^\\s,]+", lookup(local.settings, "TRUST_OPTIONAL_PLUGINS", ""))

  # The secret settings this stack makes for the apps that answer requests, where the deployment
  # sets none of that name itself: see random_bytes.repost_signing.
  generated_names   = [for name in ["REPOSTS_SIGNING_KEYS"] : name if !nonsensitive(contains(keys(local.settings), name))]
  generated_secrets = { for name in local.generated_names : name => random_bytes.repost_signing.base64 }
}

resource "random_password" "edge" {
  length  = 40
  special = false
}

# The key the server signs the attestations of its posts with, which is what lets them be reposted
# on other servers (src/attestation.ts): 32 random bytes, as REPOSTS_SIGNING_KEYS takes them. Only
# the apps that answer requests are given it (and the migrate job, which checks that they start):
# they sign with it, and publish its public half (GET /repost/keys). To replace it:
#   terraform apply -replace=random_bytes.repost_signing
# Nothing of the old key has to be kept: an attestation is good for ten minutes, and another server
# asks for this one's keys again when it meets a key it doesn't know. A deployment that sets
# REPOSTS_SIGNING_KEYS itself is given none: in `secrets`, to sign with its own keys, or as "" in
# `environment`, to sign nothing, so that its posts are reposted only here.
resource "random_bytes" "repost_signing" {
  length = 32
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

# ---------------------------------------------------------------- network

# The apps, the compactor and the jobs run in one subnet, and the database's private endpoint is
# in the other: it is how they reach the database, which has no public address.
resource "azurerm_virtual_network" "main" {
  name                = "${var.name}-net"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  address_space       = ["10.40.0.0/16"]
}

# The Container Apps environment's, and nothing else's: an environment takes a subnet whole.
resource "azurerm_subnet" "apps" {
  name                 = "apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.40.0.0/23"]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "endpoints" {
  name                 = "endpoints"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.40.2.0/24"]
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
  # The account's keys, which do everything to every container and never expire, open nothing:
  # the server reaches the containers as the managed identity below, with the roles it is given
  # there and no others, and whoever else needs to (you, in the portal) signs in.
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true

  # Browsers send files straight to the container, with the link POST /uploads signs.
  blob_properties {
    cors_rule {
      allowed_methods    = ["PUT"]
      allowed_origins    = var.upload_origins
      allowed_headers    = ["*"]
      exposed_headers    = ["ETag"]
      max_age_in_seconds = 3600
    }
  }
}

# Summaries share this container, under summaries/<UTC day>/; the compactor deletes days past retention.
resource "azurerm_storage_container" "content" {
  name                  = "content"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# POST /store moves an upload into content/ and removes it; one nobody stored goes a day after it
# was sent (Azure applies these rules about once a day).
resource "azurerm_storage_management_policy" "uploads" {
  storage_account_id = azurerm_storage_account.main.id
  rule {
    name    = "expire-unstored-uploads"
    enabled = true
    filters {
      prefix_match = ["${azurerm_storage_container.content.name}/uploads/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 1
      }
    }
  }
  # A request stages a post's file, or a comment's, under staged/, and the compactor's next run
  # moves it to where it is kept and removes it. One left behind (a request that failed, a run
  # that stopped) goes after a week: long enough that no write still waiting to be applied loses
  # its file while the compactor is down for a while.
  rule {
    name    = "expire-staged-files"
    enabled = true
    filters {
      prefix_match = ["${azurerm_storage_container.content.name}/staged/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 7
      }
    }
  }
  # Off by default: moving a blob to the Archive tier is billed as a write there (about $0.11 per
  # 10,000), which for a record of about 1 KB, as nearly all are, is more than it costs to keep in
  # the Hot tier for decades. These rules can't filter by size, so with `audit_archive_after_days`
  # set, every record moves.
  dynamic "rule" {
    for_each = var.audit_archive_after_days == null ? [] : [var.audit_archive_after_days]
    content {
      name    = "archive-audit-log"
      enabled = true
      filters {
        prefix_match = ["${azurerm_storage_container.audit.name}/"]
        blob_types   = ["blockBlob"]
      }
      actions {
        base_blob {
          tier_to_archive_after_days_since_creation_greater_than = rule.value
        }
      }
    }
  }
}

# Every request that adds, updates or deletes something is written here, whole and gzipped, one
# blob each, as the response is sent (src/audit.ts); reads are not. The apps keep what they print in
# the Log Analytics workspace below, which has a line for each, naming its blob.
resource "azurerm_storage_container" "audit" {
  name                  = "audit"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# ---------------------------------------------------------------- identity

# Who the apps, the compactor and the jobs are to blob storage: one managed identity, whose
# tokens Container Apps gives them, so there is no credential for the deployment to keep
# (src/storage/azureIdentity.ts). What it may do is the three roles below, and nothing else.
#
# Assigning a role takes more than Contributor: whoever applies needs Owner, or User Access
# Administrator beside Contributor, on the subscription or on this resource group.
resource "azurerm_user_assigned_identity" "app" {
  name                = "${var.name}-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

# Content and summaries: read, write and delete the blobs of the content container.
resource "azurerm_role_assignment" "content" {
  scope                = azurerm_storage_container.content.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

# The link POST /uploads gives is signed with a user delegation key, which the account gives an
# identity that may ask for one. A link does no more than the identity itself may do.
resource "azurerm_role_assignment" "delegator" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Delegator"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

# The audit log: the identity writes records and does nothing else with the container. It can
# write over a record, as writing a blob is one permission whether or not the blob is there, but
# it can't read a record, list them or delete one. (No built-in role is that: the narrowest that
# writes, Storage Blob Data Contributor, also reads and deletes.)
resource "azurerm_role_definition" "audit_writer" {
  name        = "${var.name}-audit-writer-${random_string.suffix.result}"
  scope       = azurerm_storage_account.main.id
  description = "Write blobs, and nothing else: no reading, listing or deleting."

  permissions {
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
    ]
  }
  assignable_scopes = [azurerm_storage_account.main.id]
}

resource "azurerm_role_assignment" "audit" {
  scope              = azurerm_storage_container.audit.id
  role_definition_id = azurerm_role_definition.audit_writer.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.app.principal_id
  principal_type     = "ServicePrincipal"
}

# ---------------------------------------------------------------- redis

# The feed index, hot summaries and publisher credits. The Enterprise clustering policy puts
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

# In `db_location` where that is set, for a subscription that may not create one in `location`.
# The private endpoint below stays in `location`, with the virtual network it is in: a private
# endpoint reaches a server in another region as it does one in its own.
resource "azurerm_postgresql_flexible_server" "main" {
  name                   = "${var.name}-${random_string.suffix.result}"
  resource_group_name    = azurerm_resource_group.main.name
  location               = coalesce(var.db_location, azurerm_resource_group.main.location)
  version                = "16"
  administrator_login    = "evieverse"
  administrator_password = random_password.db.result
  sku_name               = var.db_sku
  storage_mb             = 32768
  backup_retention_days  = 7
  # Reached through the private endpoint below and no other way: the server has no public address
  # to try a password against. (A firewall rule of 0.0.0.0, "allow Azure services", would admit
  # connections from every Azure customer's resources, not only this deployment's.)
  public_network_access_enabled = false
  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "evieverse"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# The server's address inside the virtual network, where the apps, the compactor and the jobs
# are. Its name (<server>.postgres.database.azure.com) is an alias of one in the zone below,
# which the network resolves to that address, so DATABASE_URL names the server as before. TLS is
# still required.
resource "azurerm_private_dns_zone" "postgres" {
  name                = "privatelink.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${var.name}-postgres"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

resource "azurerm_private_endpoint" "postgres" {
  name                = "${var.name}-postgres"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  subnet_id           = azurerm_subnet.endpoints.id

  private_service_connection {
    name                           = "postgres"
    private_connection_resource_id = azurerm_postgresql_flexible_server.main.id
    subresource_names              = ["postgresqlServer"]
    is_manual_connection           = false
  }
  private_dns_zone_group {
    name                 = "postgres"
    private_dns_zone_ids = [azurerm_private_dns_zone.postgres.id]
  }
}

# ---------------------------------------------------------------- container apps

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${var.name}-logs"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# In the virtual network, so that what runs in it reaches the database at its private address.
# The apps' own addresses stay public, for Front Door, and they reach Redis, blob storage and
# the internet as before. A network of its own needs an environment with workload profiles; the
# one profile here, Consumption, is billed as an environment without them is: by what the
# replicas use, and nothing while there are none.
resource "azurerm_container_app_environment" "main" {
  name                       = "${var.name}-env"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

locals {
  # What every app and job waits for before it starts.
  ready = [
    terraform_data.image,
    azurerm_private_endpoint.postgres,
    azurerm_private_dns_zone_virtual_network_link.postgres,
    azurerm_postgresql_flexible_server_database.main,
    azurerm_role_assignment.content,
    azurerm_role_assignment.delegator,
    azurerm_role_assignment.audit,
  ]
}

# ---------------------------------------------------------------- admin account

# The server's first admin, and its API key in the server's own format (src/auth/apiKey.ts). The
# migrate job below creates the account from the key's hash (src/moderation/bootstrap.ts), so
# the key itself is only in the state and in the profile file. To replace the key:
#   terraform apply -replace=random_password.admin_key
# A key that replaces it through the API (POST /users/:userId/key) lasts, and never reaches the
# state: the output and the profile file keep the key made here, which stays revoked, until it is
# replaced as above.
resource "random_uuid" "admin" {}

resource "random_id" "admin_key_prefix" {
  byte_length = 6
}

# 43 characters of the 64 that base64url uses, which is what the server's keys end in.
resource "random_password" "admin_key" {
  length           = 43
  override_special = "-_"
}

locals {
  # random_uuid gives 32 random hex digits in a UUID's shape, where the server's ids are version 4
  # UUIDs and its API takes nothing else. So the two digits that make it one are set here: the
  # version (4) and the variant (8, 9, a or b).
  admin_user_id = join("", [
    substr(random_uuid.admin.result, 0, 14), "4", substr(random_uuid.admin.result, 15, 4),
    element(["8", "9", "a", "b"], parseint(substr(random_uuid.admin.result, 19, 1), 16) % 4),
    substr(random_uuid.admin.result, 20, 16),
  ])
  admin_api_key = sensitive("tu_${random_id.admin_key_prefix.hex}_${random_password.admin_key.result}")
  bootstrap_admin = jsonencode({
    userId   = local.admin_user_id
    username = var.admin_username
    keyHash  = nonsensitive(sha256(local.admin_api_key))
  })
  # The deployment's own name, unless the profile is given another: two deployments with the same
  # name, applied from one machine, would otherwise write over each other's profile.
  admin_profile_name = var.admin_profile_name != "" ? var.admin_profile_name : var.name
  admin_profile_path = pathexpand("~/.evieverse/profiles/${local.admin_profile_name}.json")
}

# The admin's profile for the CLI, on the machine that applies: `evieverse --profile ${local.admin_profile_name} whoami`.
resource "local_sensitive_file" "admin_profile" {
  count                = var.install_admin_profile ? 1 : 0
  filename             = local.admin_profile_path
  file_permission      = "0600"
  directory_permission = "0700"
  content = jsonencode({
    server   = local.url
    userId   = local.admin_user_id
    username = var.admin_username
    apiKey   = local.admin_api_key
  })
  depends_on = [terraform_data.migrate]
}

# ---------------------------------------------------------------- migrations

# The step every apply that changes the image, the settings or the admin account starts first, and
# waits for (src/functions/deploy.ts). With the settings the apps are about to get, the job checks
# that they start with them, and only then brings the schema up to date and sets up the admin
# account.
#
# The check is what keeps a mistake in `environment` or `secrets` from reaching the deployment: the
# job starts each route group as its app would, and a setting the server refuses (a misspelt plugin
# name, say) fails it, which stops the apply here, before the apps and the compactor, which all
# wait for it: they keep what they have.
#
# Functions never migrate the database when they start, as many start at once.
resource "azurerm_container_app_job" "migrate" {
  name                         = "${var.name}-migrate"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 0
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }
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
    for_each = local.function_secret_names
    content {
      name  = lower(replace(secret.value, "_", "-"))
      value = local.function_secret_env[secret.value]
    }
  }

  template {
    container {
      name    = "migrate"
      image   = local.image
      command = ["node", "dist/functions/migrate.js"]
      cpu     = 0.5
      memory  = "1Gi"
      env {
        name  = "BOOTSTRAP_ADMIN"
        value = local.bootstrap_admin
      }
      # What the apps are about to get, which is what the job checks.
      dynamic "env" {
        for_each = local.function_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.function_secret_names
        content {
          name        = env.value
          secret_name = lower(replace(env.value, "_", "-"))
        }
      }
    }
  }

  depends_on = [local.ready]
}

resource "terraform_data" "migrate" {
  # The last is a hash of everything the job is given, so a change to `environment` or `secrets`
  # alone starts it again, and is checked before it reaches an app.
  triggers_replace = [local.image, local.bootstrap_admin, nonsensitive(sha256(jsonencode([local.function_env, local.function_secret_env])))]
  provisioner "local-exec" {
    command = <<-EOT
      set -e
      job="--subscription ${var.subscription_id} --resource-group ${azurerm_resource_group.main.name} --name ${azurerm_container_app_job.migrate.name}"
      run=$(az containerapp job start $job --query name --output tsv)
      while :; do
        status=$(az containerapp job execution show $job --job-execution-name "$run" --query properties.status --output tsv)
        case "$status" in
          Succeeded) exit 0 ;;
          Failed | Stopped | Degraded) echo "the migration job ended as $status, so nothing else was changed: its logs say why, which may be a setting in environment or secrets that the server refuses" >&2; exit 1 ;;
        esac
        sleep 5
      done
    EOT
  }

  lifecycle {
    precondition {
      condition     = can(regex("^tu_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$", local.admin_api_key))
      error_message = "The admin API key isn't in the format the server issues and accepts (KEY_PATTERN in src/auth/apiKey.ts)."
    }
    precondition {
      condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", local.admin_user_id))
      error_message = "The admin account's id isn't a version 4 UUID, which is what the server's user ids are."
    }
    # The server refuses to start with urlhaus turned on and no Auth-Key (src/config.ts), which the
    # migrate job would find too. This one is known from the variables alone, so the plan fails,
    # before anything is changed.
    precondition {
      condition     = !contains(local.optional_plugins, "urlhaus") || trimspace(lookup(local.settings, "URLHAUS_AUTH_KEY", "")) != ""
      error_message = "TRUST_OPTIONAL_PLUGINS turns on urlhaus, which needs URLHAUS_AUTH_KEY in `secrets`: the Auth-Key of an abuse.ch account, which is free (https://auth.abuse.ch). Without it no app and no compactor would start."
    }
  }
}

# ---------------------------------------------------------------- functions

resource "azurerm_container_app" "group" {
  for_each                     = local.groups
  name                         = "${var.name}-${each.key}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

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
    for_each = local.function_secret_names
    content {
      name  = lower(replace(secret.value, "_", "-"))
      value = local.function_secret_env[secret.value]
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
    max_replicas = each.value.max_replicas
    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }
    container {
      name    = each.key
      image   = local.image
      command = ["node", "dist/functions/http.js"]
      cpu     = 0.5
      memory  = "1Gi"
      env {
        name  = "FUNCTION_GROUP"
        value = each.key
      }
      dynamic "env" {
        for_each = local.function_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.function_secret_names
        content {
          name        = env.value
          secret_name = lower(replace(env.value, "_", "-"))
        }
      }
      # A request that finds a group at no replica waits for one to be ready, so a replica is said
      # to be ready as soon as it answers: it is asked every second while it starts, and one
      # answer is enough. Left as the platform has them, a readiness probe is asked every 10
      # seconds and believed at its third answer, which kept a replica that listened within a
      # second of starting out of use for 20 to 30 more.
      startup_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/health"
        interval_seconds        = 1
        timeout                 = 1
        failure_count_threshold = 30
      }
      liveness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/health"
      }
      readiness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/health"
        success_count_threshold = 1
      }
    }
  }

  depends_on = [terraform_data.migrate, local.ready]
}

# ---------------------------------------------------------------- compactor

# The compactor is one process that stays up: pass after pass over the feed index, never two at
# once, and never more than one in COMPACT_INTERVAL_SECONDS (5 unless `environment` says otherwise).
# A scheduled job can't be that (a schedule starts one a minute at most), so it is a Container App
# with no ingress and exactly one replica, which is started again whenever it stops. While a deploy
# replaces the replica there can be two for a moment: their passes still don't overlap, since each
# takes the compactor's lease in the database and a pass that finds it held is skipped.
resource "azurerm_container_app" "compactor" {
  name                         = "${var.name}-compactor"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

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
    # SIGTERM lets the pass that is running finish.
    termination_grace_period_seconds = 120
    container {
      name    = "compactor"
      image   = local.image
      command = ["node", "dist/compact/main.js"]
      cpu     = var.compactor_cpu
      memory  = var.compactor_memory
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

  depends_on = [terraform_data.migrate, local.ready]
}

# `--rebuild` rebuilds the whole feed index from the database and blob storage, after Redis lost
# data. It is a job, started by hand (see docs/DEPLOY.md). It can run beside the compactor: the
# lease makes each wait for the other's pass.
resource "azurerm_container_app_job" "rebuild" {
  name                         = "${var.name}-rebuild"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  replica_timeout_in_seconds   = 86400
  replica_retry_limit          = 0
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }
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
    container {
      name    = "rebuild"
      image   = local.image
      command = ["node", "dist/compact/main.js", "--once", "--rebuild"]
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

  depends_on = [terraform_data.migrate, local.ready]
}

# ---------------------------------------------------------------- front door

# One address for all four apps. No health probes: with one origin per group there is nothing to
# fail over to, and probes would keep every app from scaling to none.
resource "azurerm_cdn_frontdoor_profile" "main" {
  name                     = var.name
  resource_group_name      = azurerm_resource_group.main.name
  sku_name                 = "Standard_AzureFrontDoor"
  response_timeout_seconds = var.request_timeout
}

resource "azurerm_cdn_frontdoor_endpoint" "main" {
  name                     = var.name
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id
}

resource "azurerm_cdn_frontdoor_origin_group" "group" {
  for_each                 = local.groups
  name                     = each.key
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id
  load_balancing {}
}

resource "azurerm_cdn_frontdoor_origin" "group" {
  for_each                       = local.groups
  name                           = each.key
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.group[each.key].id
  enabled                        = true
  host_name                      = azurerm_container_app.group[each.key].ingress[0].fqdn
  origin_host_header             = azurerm_container_app.group[each.key].ingress[0].fqdn
  https_port                     = 443
  certificate_name_check_enabled = true
}

# On every request: the secret that proves it came through Front Door.
resource "azurerm_cdn_frontdoor_rule_set" "edge" {
  name                     = "edge"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id
}

resource "azurerm_cdn_frontdoor_rule" "edge_secret" {
  name                      = "EdgeSecret"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.edge.id
  order                     = 1
  behavior_on_match         = "Continue"
  actions {
    request_header_action {
      header_action = "Overwrite"
      header_name   = "X-Origin-Secret"
      value         = random_password.edge.result
    }
  }
  depends_on = [azurerm_cdn_frontdoor_origin_group.group, azurerm_cdn_frontdoor_origin.group]
}

# On /content/* only: Front Door routes by path, and deleting content belongs to the api group.
resource "azurerm_cdn_frontdoor_rule_set" "content" {
  name                     = "content"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id
}

resource "azurerm_cdn_frontdoor_rule" "content_writes" {
  name                      = "ContentWrites"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.content.id
  order                     = 1
  behavior_on_match         = "Continue"
  conditions {
    request_method_condition {
      operator         = "Equal"
      negate_condition = true
      match_values     = ["GET", "HEAD", "OPTIONS"]
    }
  }
  actions {
    route_configuration_override_action {
      cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.group["api"].id
      forwarding_protocol           = "HttpsOnly"
      cache_behavior                = "Disabled"
    }
  }
  depends_on = [azurerm_cdn_frontdoor_origin_group.group, azurerm_cdn_frontdoor_origin.group]
}

resource "azurerm_cdn_frontdoor_route" "group" {
  for_each                      = local.groups
  name                          = each.key
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.main.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.group[each.key].id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.group[each.key].id]
  cdn_frontdoor_rule_set_ids = concat(
    [azurerm_cdn_frontdoor_rule_set.edge.id],
    each.key == "content" ? [azurerm_cdn_frontdoor_rule_set.content.id] : [],
  )
  patterns_to_match      = each.value.patterns
  supported_protocols    = ["Http", "Https"]
  https_redirect_enabled = true
  forwarding_protocol    = "HttpsOnly"
  link_to_default_domain = true
  depends_on             = [azurerm_cdn_frontdoor_rule.edge_secret, azurerm_cdn_frontdoor_rule.content_writes]
}
