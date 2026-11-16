output "url" {
  description = "HTTPS URL of the API."
  value       = local.url
}

output "try_it" {
  value = <<-EOT

    Evieverse is deployed at ${local.url}
    (CloudFront can take a few minutes to start serving after the first apply.)

      curl ${local.url}/health
      curl -X POST ${local.url}/register -H 'content-type: application/json' -d '{"username":"me"}'

    The admin account is "${var.admin_username}" (${local.admin_user_id}). ${var.install_admin_profile ? "Its API key is in ${local.admin_profile_path}, where the CLI reads it:" : "Its API key is the admin_api_key output; sign the CLI in with it:"}

      curl -fsSL ${local.url}/cli/install.sh | sh        # Windows: irm ${local.url}/cli/install.ps1 | iex
      ${var.install_admin_profile ? "evieverse --profile ${var.name} whoami" : "evieverse login ${local.url} ${local.admin_user_id}"}
  EOT
}

output "content_bucket" {
  value = aws_s3_bucket.content.id
}

output "audit_bucket" {
  description = "Where every request that added, updated or deleted something is written."
  value       = aws_s3_bucket.audit.id
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "functions" {
  description = "Lambda function of each route group."
  value       = { for name, fn in aws_lambda_function.fn : name => fn.function_name }
}

output "compactor" {
  description = "The compactor: the ECS service whose one task is always up, and where it logs."
  value       = { cluster = aws_ecs_cluster.main.name, service = aws_ecs_service.compactor.name, log_group = aws_cloudwatch_log_group.app.name }
}

output "rebuild_command" {
  description = "Rebuilds Redis from the database and the bucket, as a one-off task."
  value       = "aws ecs run-task --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --task-definition ${aws_ecs_task_definition.rebuild.family} --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.app.id}],assignPublicIp=DISABLED}'"
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
