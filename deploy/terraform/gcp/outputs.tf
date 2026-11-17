output "url" {
  description = "HTTPS URL of the API."
  value       = local.url
}

output "try_it" {
  value = <<-EOT

    Evieverse is deployed at ${local.url}
    (The gateway can take a few minutes to start serving after the first apply.)

      curl ${local.url}/health
      curl -X POST ${local.url}/register -H 'content-type: application/json' -d '{"username":"me"}'

    The admin account is "${var.admin_username}" (${local.admin_user_id}). ${var.install_admin_profile ? "Its API key is in ${local.admin_profile_path}, where the CLI reads it:" : "Its API key is the admin_api_key output; sign the CLI in with it:"}

      curl -fsSL ${local.url}/cli/install.sh | sh        # Windows: irm ${local.url}/cli/install.ps1 | iex
      ${var.install_admin_profile ? "evieverse --profile ${local.admin_profile_name} whoami" : "evieverse login ${local.url} ${local.admin_user_id}"}
  EOT
}

output "content_bucket" {
  value = google_storage_bucket.content.name
}

output "audit_bucket" {
  description = "Where every request that added, updated or deleted something is written."
  value       = google_storage_bucket.audit.name
}

output "redis_instance" {
  value = google_redis_instance.main.name
}

output "services" {
  description = "Cloud Run service of each route group. Only the gateway may call them."
  value       = { for name, service in google_cloud_run_v2_service.group : name => service.name }
}

output "compactor" {
  description = "The compactor: the Cloud Run worker pool whose one instance is always up."
  value       = google_cloud_run_v2_worker_pool.compactor.name
}

output "rebuild_command" {
  description = "Rebuilds Redis from the database and the bucket, as a one-off job."
  value       = "gcloud run jobs execute ${google_cloud_run_v2_job.rebuild.name} --project ${var.project_id} --region ${var.region} --wait"
}

output "admin_user_id" {
  description = "userId of the admin account."
  value       = local.admin_user_id
}

output "admin_api_key" {
  description = "The API key the deployment made for the admin account: `terraform output -raw admin_api_key`. It no longer works if the account's key was replaced through the API since."
  value       = local.admin_api_key
  sensitive   = true
}

output "admin_profile" {
  description = "The CLI profile the apply wrote the admin account's key to, if it did."
  value       = var.install_admin_profile ? local.admin_profile_path : null
}
