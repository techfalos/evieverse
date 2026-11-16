output "url" {
  description = "HTTPS URL of the API."
  value       = local.url
}

output "try_it" {
  value = <<-EOT

    theuniverse is deployed at ${local.url}
    (CloudFront can take a few minutes to start serving after the first apply.)

      curl ${local.url}/health
      curl -X POST ${local.url}/register -H 'content-type: application/json' -d '{"username":"me","publisherUrl":"https://example.com"}'
  EOT
}

output "content_bucket" {
  value = aws_s3_bucket.content.id
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}
