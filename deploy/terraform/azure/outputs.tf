output "url" {
  description = "HTTPS URL of the API."
  value       = local.url
}

output "try_it" {
  value = <<-EOT

    Evieverse is deployed at ${local.url}
    (Front Door can take several minutes to start serving after the first apply.)

      curl ${local.url}/health
      curl -X POST ${local.url}/register -H 'content-type: application/json' -d '{"username":"me"}'

    The admin account is "${var.admin_username}" (${local.admin_user_id}). ${var.install_admin_profile ? "Its API key is in ${local.admin_profile_path}, where the CLI reads it:" : "Its API key is the admin_api_key output; sign the CLI in with it:"}

      curl -fsSL ${local.url}/cli/install.sh | sh        # Windows: irm ${local.url}/cli/install.ps1 | iex
      ${var.install_admin_profile ? "evieverse --profile ${var.name} whoami" : "evieverse login ${local.url} ${local.admin_user_id}"}
  EOT
}

output "storage_account" {
  value = azurerm_storage_account.main.name
}

output "redis_hostname" {
  value = azurerm_managed_redis.main.hostname
}

output "apps" {
  description = "Container App of each route group. They refuse requests that don't come through Front Door."
  value       = { for name, app in azurerm_container_app.group : name => app.name }
}

output "compactor" {
  description = "The compactor: the Container App whose one replica is always up."
  value       = azurerm_container_app.compactor.name
}

output "rebuild_command" {
  description = "Rebuilds Redis from the database and blob storage, as a one-off job."
  value       = "az containerapp job start --subscription ${var.subscription_id} --resource-group ${azurerm_resource_group.main.name} --name ${azurerm_container_app_job.rebuild.name}"
}

output "admin_user_id" {
  description = "userId of the admin account."
  value       = local.admin_user_id
}

output "admin_api_key" {
  description = "API key of the admin account: `terraform output -raw admin_api_key`."
  value       = local.admin_api_key
  sensitive   = true
}

output "admin_profile" {
  description = "The CLI profile the apply wrote the admin account's key to, if it did."
  value       = var.install_admin_profile ? local.admin_profile_path : null
}
