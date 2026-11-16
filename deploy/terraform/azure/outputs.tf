output "url" {
  description = "HTTPS URL of the API."
  value       = "https://${azurerm_container_app.app.ingress[0].fqdn}"
}

output "try_it" {
  value = <<-EOT

    theuniverse is deployed at https://${azurerm_container_app.app.ingress[0].fqdn}

      curl https://${azurerm_container_app.app.ingress[0].fqdn}/health
      curl -X POST https://${azurerm_container_app.app.ingress[0].fqdn}/register -H 'content-type: application/json' -d '{"username":"me","publisherUrl":"https://example.com"}'
  EOT
}

output "storage_account" {
  value = azurerm_storage_account.main.name
}

output "redis_hostname" {
  value = azurerm_managed_redis.main.hostname
}
