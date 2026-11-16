output "url" {
  description = "HTTPS URL of the API."
  value       = google_cloud_run_v2_service.app.uri
}

output "try_it" {
  value = <<-EOT

    theuniverse is deployed at ${google_cloud_run_v2_service.app.uri}

      curl ${google_cloud_run_v2_service.app.uri}/health
      curl -X POST ${google_cloud_run_v2_service.app.uri}/register -H 'content-type: application/json' -d '{"username":"me","publisherUrl":"https://example.com"}'
  EOT
}

output "content_bucket" {
  value = google_storage_bucket.content.name
}

output "redis_instance" {
  value = google_redis_instance.main.name
}
