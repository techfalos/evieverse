# Evieverse on AWS:
#   CloudFront (HTTPS, default *.cloudfront.net certificate) -> API Gateway HTTP API -> one Lambda
#   function per route group (feed, content, store, api), all running the one container image.
#   The compactor is one process that is always up: a Fargate service of one task. The feed index
#   and hot summaries are in ElastiCache (Valkey), content and summaries on S3, metadata in RDS
#   PostgreSQL behind RDS Proxy.

locals {
  root        = abspath("${path.module}/../../..")
  source_hash = sha1(join("", [for f in concat(sort(fileset(local.root, "src/**")), sort(fileset(local.root, "languages/**")), ["package.json", "package-lock.json", "Dockerfile", "tsconfig.json", "tsconfig.build.json", "scripts/build-cli.mjs"]) : filesha1("${local.root}/${f}")]))
  image       = var.image != "" ? var.image : "${aws_ecr_repository.app.repository_url}:${substr(local.source_hash, 0, 12)}"
  url         = "https://${aws_cloudfront_distribution.app.domain_name}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
  secret_keys = concat(["DATABASE_URL", "REDIS_URL"], nonsensitive(keys(var.secrets)))

  # Which function serves which requests. This follows the route groups in src/functions/groups.ts:
  # change the two together. Anything not listed goes to the api function, /feed/following among it:
  # only /feed itself is the feed function's.
  routes = {
    "GET /feed"              = "feed"
    "HEAD /feed"             = "feed"
    "GET /content/{proxy+}"  = "content"
    "HEAD /content/{proxy+}" = "content"
    "POST /uploads"          = "store"
    "POST /store"            = "store"
    "$default"               = "api"
  }

  # API Gateway gives a function 30 seconds at most, so the route groups get no longer.
  functions = {
    feed    = { memory = var.function_memory, timeout = 30 }
    content = { memory = var.function_memory, timeout = 30 }
    store   = { memory = var.store_function_memory, timeout = 30 }
    api     = { memory = var.function_memory, timeout = 30 }
  }
  route_groups = toset(distinct(values(local.routes)))
}

data "aws_availability_zones" "available" {
  state = "available"
}

# ---------------------------------------------------------------- image

resource "aws_ecr_repository" "app" {
  name         = var.name
  force_delete = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository_policy" "lambda" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LambdaPull"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    }]
  })
}

resource "terraform_data" "image" {
  count            = var.image == "" ? 1 : 0
  triggers_replace = [local.image]
  provisioner "local-exec" {
    working_dir = local.root
    # --provenance=false: Lambda takes a plain image manifest, not an index with attestations.
    command = <<-EOT
      set -e
      aws ecr get-login-password --region ${var.region} | docker login --username AWS --password-stdin ${split("/", aws_ecr_repository.app.repository_url)[0]}
      docker build --platform linux/amd64 --provenance=false -t ${local.image} .
      docker push ${local.image}
    EOT
  }
}

# ---------------------------------------------------------------- network

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# The public subnets hold only the NAT gateway. Functions run in the private subnets, next to Redis
# and the database: a function in a VPC has no public address, so it reaches the internet (AI APIs)
# through the NAT gateway and S3 through the gateway endpoint, which costs nothing.
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

# One NAT gateway, in the first zone: if that zone fails, functions lose the internet (not Redis,
# the database or S3) until it returns. A second gateway and route table would remove that.
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = var.name }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}

# The functions, the compactor and the one-off rebuild task. Nothing connects to them: API Gateway
# invokes functions through the Lambda service.
resource "aws_security_group" "app" {
  name   = "${var.name}-app"
  vpc_id = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "redis" {
  name   = "${var.name}-redis"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_security_group" "proxy" {
  name   = "${var.name}-db-proxy"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}

# From the proxy for the functions, and straight from the migrate function, the compactor and the rebuild task.
resource "aws_security_group" "db" {
  name   = "${var.name}-db"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id, aws_security_group.proxy.id]
  }
}

# ---------------------------------------------------------------- storage

resource "aws_s3_bucket" "content" {
  bucket_prefix = "${var.name}-content-"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "content" {
  bucket                  = aws_s3_bucket.content.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Summaries share the content bucket, under summaries/<UTC day>/; the compactor deletes days past retention.

# Browsers send files straight to the bucket, with the link POST /uploads signs.
resource "aws_s3_bucket_cors_configuration" "content" {
  bucket = aws_s3_bucket.content.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.upload_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# POST /store moves an upload into content/ and removes it; one nobody stored goes after a day.
resource "aws_s3_bucket_lifecycle_configuration" "content" {
  bucket = aws_s3_bucket.content.id
  rule {
    id     = "expire-unstored-uploads"
    status = "Enabled"
    filter {
      prefix = "uploads/"
    }
    expiration {
      days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# ---------------------------------------------------------------- audit log

# Every request that adds, updates or deletes something is written here, whole and gzipped, one
# object each, as the response is sent (src/audit.ts); reads are not. The objects move to S3 Glacier
# Deep Archive after `audit_archive_after_days`, which is the cold storage they end in. The functions
# can put objects here and do nothing else with it: not read, overwrite or delete one. The
# application's own log group (30 days) keeps a line for each, naming its object.
resource "aws_s3_bucket" "audit" {
  bucket_prefix = "${var.name}-audit-"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  # Most records are well under 128 KB, which S3 doesn't transition by default. This setting lets it
  # transition them to the Glacier classes (the default is the same for every class).
  transition_default_minimum_object_size = "varies_by_storage_class"
  rule {
    id     = "archive"
    status = "Enabled"
    filter {}
    transition {
      days          = var.audit_archive_after_days
      storage_class = "DEEP_ARCHIVE"
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# ---------------------------------------------------------------- redis

# The feed index, hot summaries and publisher credits. Cluster mode stays off: the app uses
# multi-key commands across tags. volatile-lru only ever evicts keys with a TTL (hot summaries and
# superseded index keys), so a full cache degrades to object-store reads instead of losing the index.
resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_parameter_group" "redis" {
  name   = "${var.name}-valkey8"
  family = "valkey8"
  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }
}

resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = var.name
  description                = "${var.name} feed index and hot summaries"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.redis_replicas + 1
  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0
  port                       = 6379
  parameter_group_name       = aws_elasticache_parameter_group.redis.name
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  # A daily snapshot shortens recovery; `node dist/compact/main.js --once --rebuild` restores everything without one.
  snapshot_retention_limit = 1
}

# ---------------------------------------------------------------- database

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier                = var.name
  engine                    = "postgres"
  engine_version            = "16"
  instance_class            = var.db_instance_class
  allocated_storage         = 20
  max_allocated_storage     = 200
  storage_encrypted         = true
  db_name                   = "evieverse"
  username                  = "evieverse"
  password                  = random_password.db.result
  db_subnet_group_name      = aws_db_subnet_group.main.name
  vpc_security_group_ids    = [aws_security_group.db.id]
  publicly_accessible       = false
  backup_retention_period   = 7
  deletion_protection       = !var.force_destroy
  skip_final_snapshot       = var.force_destroy
  final_snapshot_identifier = var.force_destroy ? null : "${var.name}-final"
}

locals {
  redis_url = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  # RDS enforces TLS; its CA is not in Node's trust store, so the connection is encrypted but unverified (in-VPC).
  database_url = "postgres://evieverse:${random_password.db.result}@${aws_db_instance.main.address}:5432/evieverse?sslmode=no-verify"
  # The proxy's certificate comes from ACM, which Node trusts, so this connection is verified.
  proxy_database_url = "postgres://evieverse:${random_password.db.result}@${aws_db_proxy.main.endpoint}:5432/evieverse?sslmode=verify-full"
}

# Read by the compactor and the one-off rebuild task (the functions get these as environment variables, see below).
resource "aws_secretsmanager_secret" "app" {
  name_prefix             = "${var.name}-"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(merge(var.secrets, {
    DATABASE_URL = local.database_url
    REDIS_URL    = local.redis_url
  }))
  # The compactor reads these whenever its task starts, which ECS can do at any time. So they are
  # written only once the migrate function has checked them: a task that restarts never finds
  # secrets the server refuses.
  depends_on = [aws_lambda_invocation.migrate]
}

# ---------------------------------------------------------------- database proxy

# Every warm function instance keeps connections open, and a burst of traffic starts many
# instances at once. The proxy shares a small number of database connections among them all.
resource "aws_secretsmanager_secret" "db" {
  name_prefix             = "${var.name}-db-"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id     = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({ username = "evieverse", password = random_password.db.result })
}

data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name_prefix        = "${var.name}-proxy-"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
}

resource "aws_iam_role_policy" "proxy" {
  role = aws_iam_role.proxy.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.db.arn }]
  })
}

resource "aws_db_proxy" "main" {
  name                   = var.name
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = aws_subnet.private[*].id
  vpc_security_group_ids = [aws_security_group.proxy.id]
  require_tls            = true
  idle_client_timeout    = 300
  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db.arn
  }
  depends_on = [aws_secretsmanager_secret_version.db, aws_iam_role_policy.proxy]
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name
  connection_pool_config {
    # The rest stay free for the migrate function, the compactor, the rebuild task and an administrator.
    max_connections_percent   = 75
    connection_borrow_timeout = 10
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name          = aws_db_proxy.main.name
  target_group_name      = aws_db_proxy_default_target_group.main.name
  db_instance_identifier = aws_db_instance.main.identifier
}

# ---------------------------------------------------------------- settings

locals {
  env = merge({
    DB_DIALECT         = "postgres"
    CONTENT_SCHEME     = "s3"
    CONTENT_OPTIONS    = jsonencode({ bucket = aws_s3_bucket.content.id, region = var.region })
    PUBLIC_BASE_URL    = local.url
    SUPPORT_EMAIL      = var.support_email
    COMPACT_IN_PROCESS = "false"
    STORAGE_TMP_PATH   = "/tmp/evieverse"
    # /store checks a file sent with an upload link by reading it back from the bucket, inside API
    # Gateway's 30 seconds. An estimate of what fits, not a measurement: raise it after timing your own.
    MAX_UPLOAD_BYTES = "268435456"
  }, var.environment)

  # A Lambda function reads its settings from its configuration only, so the two URLs and
  # `var.secrets` are environment variables there: encrypted at rest, but readable by anyone allowed
  # lambda:GetFunctionConfiguration on these functions.
  function_env = merge(local.env, {
    # Only the functions answer requests, so only they write the audit log.
    AUDIT_SCHEME  = "s3"
    AUDIT_OPTIONS = jsonencode({ bucket = aws_s3_bucket.audit.id, region = var.region })
    REDIS_URL     = local.redis_url
    # The address CloudFront saw is the last one in X-Forwarded-For once the gateway's own is dropped.
    TRUST_PROXY          = "1"
    FUNCTION_EDGE_SECRET = random_password.edge.result
  }, var.secrets)

  # The migrate function is given what the functions are about to get, so that it can check that
  # they start with it before any of them is updated (src/functions/deploy.ts). It goes straight to
  # the database, where they go through the proxy.
  migrate_env = merge(local.function_env, {
    FUNCTION_GROUP  = "migrate"
    DATABASE_URL    = local.database_url
    BOOTSTRAP_ADMIN = local.bootstrap_admin
  })

  # What `environment` and `secrets` set, and the optional trust plugins they turn on, read as the
  # server reads TRUST_OPTIONAL_PLUGINS (names separated by commas or spaces): for the one mistake
  # that is caught in the plan, before the migrate function is asked (see the preconditions of
  # aws_lambda_invocation.migrate).
  settings         = merge(var.environment, var.secrets)
  optional_plugins = regexall("[^\\s,]+", lookup(local.settings, "TRUST_OPTIONAL_PLUGINS", ""))
}

# CloudFront sends this to the gateway, whose own address is public; functions refuse requests without it.
resource "random_password" "edge" {
  length  = 40
  special = false
}

# ---------------------------------------------------------------- IAM

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "content" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.content.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.content.arn}/*"]
  }
}

# The functions' own credentials: OpenDAL picks them up from the environment Lambda sets, and signs
# upload and download links with them.
resource "aws_iam_role" "function" {
  name_prefix        = "${var.name}-fn-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Logs, and the network interfaces a function in a VPC needs.
resource "aws_iam_role_policy_attachment" "function_vpc" {
  role       = aws_iam_role.function.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "function" {
  role   = aws_iam_role.function.id
  policy = data.aws_iam_policy_document.content.json
}

# The audit log is write-only to the functions: they can add records and nothing else.
resource "aws_iam_role_policy" "function_audit" {
  role = aws_iam_role.function.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.audit.arn}/*" }]
  })
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.app.arn }]
  })
}

# The compactor's and the rebuild task's own credentials: OpenDAL picks up the ECS task role automatically.
resource "aws_iam_role" "task" {
  name_prefix        = "${var.name}-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task" {
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.content.json
}

# ---------------------------------------------------------------- admin account

# The server's first admin, and its API key in the server's own format (src/auth/apiKey.ts). The
# migrate function below creates the account from the key's hash (src/moderation/bootstrap.ts), so
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
  admin_profile_path = pathexpand("~/.evieverse/profiles/${var.name}.json")
}

# The admin's profile for the CLI, on the machine that applies: `evieverse --profile ${var.name} whoami`.
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
  depends_on = [aws_lambda_invocation.migrate]
}

# ---------------------------------------------------------------- functions

resource "aws_cloudwatch_log_group" "function" {
  for_each          = toset(concat(keys(local.functions), ["migrate"]))
  name              = "/aws/lambda/${var.name}-${each.value}"
  retention_in_days = 30
}

# The step every apply that changes the image, the settings or the admin account runs first
# (src/functions/deploy.ts). With the settings the functions are about to get, it checks that they
# start with them, and only then brings the schema up to date, straight against the database, and
# sets up the admin account.
#
# The check is what keeps a mistake in `environment` or `secrets` from taking the deployment down:
# updating a function doesn't start it, so a setting the server refuses (a misspelt plugin name,
# say) would otherwise pass the apply and then fail every request. The migrate function starts each
# route group as its function would, and its failure stops the apply here, before the functions,
# the compactor and the compactor's secrets, which all wait for it: they keep what they have.
#
# Functions never migrate when they start, as many start at once.
resource "aws_lambda_function" "migrate" {
  function_name = "${var.name}-migrate"
  role          = aws_iam_role.function.arn
  package_type  = "Image"
  image_uri     = local.image
  architectures = ["x86_64"]
  # The functions' own, as it starts what they start.
  memory_size = var.function_memory
  timeout     = 300

  image_config {
    entry_point       = ["node"]
    command           = ["dist/functions/lambda.js"]
    working_directory = "/app"
  }
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.app.id]
  }
  environment {
    variables = local.migrate_env
  }
  depends_on = [
    terraform_data.image,
    aws_ecr_repository_policy.lambda,
    aws_cloudwatch_log_group.function,
    aws_iam_role_policy_attachment.function_vpc,
  ]
}

resource "aws_lambda_invocation" "migrate" {
  function_name = aws_lambda_function.migrate.function_name
  input         = jsonencode({ image = local.image })
  # `settings` is a hash of everything the function is given, so a change to `environment` or
  # `secrets` alone invokes it again, and is checked before it reaches a function.
  triggers = {
    image    = local.image
    admin    = local.bootstrap_admin
    settings = nonsensitive(sha256(jsonencode(local.migrate_env)))
  }
  depends_on = [aws_db_instance.main]

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
    # migrate function would find too. This one is known from the variables alone, so the plan
    # fails, before anything is changed.
    precondition {
      condition     = !contains(local.optional_plugins, "urlhaus") || trimspace(lookup(local.settings, "URLHAUS_AUTH_KEY", "")) != ""
      error_message = "TRUST_OPTIONAL_PLUGINS turns on urlhaus, which needs URLHAUS_AUTH_KEY in `secrets`: the Auth-Key of an abuse.ch account, which is free (https://auth.abuse.ch). Without it no function and no compactor would start."
    }
  }
}

resource "aws_lambda_function" "fn" {
  for_each      = local.functions
  function_name = "${var.name}-${each.key}"
  role          = aws_iam_role.function.arn
  package_type  = "Image"
  image_uri     = local.image
  architectures = ["x86_64"]
  memory_size   = each.value.memory
  timeout       = each.value.timeout

  image_config {
    entry_point       = ["node"]
    command           = ["dist/functions/lambda.js"]
    working_directory = "/app"
  }
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.app.id]
  }
  environment {
    variables = merge(local.function_env, {
      FUNCTION_GROUP = each.key
      DATABASE_URL   = local.proxy_database_url
    })
  }
  depends_on = [
    aws_lambda_invocation.migrate,
    aws_db_proxy_target.main,
    aws_route_table_association.private,
    aws_vpc_endpoint.s3,
    aws_cloudwatch_log_group.function,
    aws_iam_role_policy_attachment.function_vpc,
    aws_iam_role_policy.function,
    aws_iam_role_policy.function_audit,
  ]
}

# ---------------------------------------------------------------- compactor

# The compactor is one process that stays up: pass after pass over the feed index, never two at
# once, and never more than one in COMPACT_INTERVAL_SECONDS (5 unless `environment` says otherwise).
# A function can't be that: it runs when it is called, and a schedule calls once a minute at most.
# So it is a Fargate service of one task, which ECS starts again whenever it stops.
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  # The compactor's container, and the rebuild task's: the same image and settings, another command.
  # Both go straight to the database, not through the proxy: each is one process with a few connections.
  compactor_container = {
    name        = "compactor"
    image       = local.image
    essential   = true
    environment = [for k, v in local.env : { name = k, value = v }]
    secrets     = [for k in local.secret_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = var.name
      }
    }
  }
}

resource "aws_ecs_task_definition" "compactor" {
  family                   = "${var.name}-compactor"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.compactor_cpu
  memory                   = var.compactor_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge(local.compactor_container, {
    command = ["node", "dist/compact/main.js"]
    # SIGTERM lets the pass that is running finish; then ECS stops the task.
    stopTimeout = 120
  })])
  depends_on = [terraform_data.image]
}

resource "aws_ecs_service" "compactor" {
  name            = "${var.name}-compactor"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.compactor.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  # A deploy stops the task that is running before it starts the new one, so there is one compactor
  # at a time. Should there ever be two (ECS replacing a task it lost sight of), their passes still
  # don't overlap: each takes the compactor's lease in the database, and a pass that finds it held is skipped.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  depends_on = [
    aws_lambda_invocation.migrate,
    aws_route_table_association.private,
    aws_vpc_endpoint.s3,
    aws_secretsmanager_secret_version.app,
    aws_iam_role_policy_attachment.execution,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy.task,
  ]
}

# `--rebuild` rebuilds the whole feed index from the database and the bucket, after Redis lost data.
# It is a task of its own, started by hand (see docs/DEPLOY.md): no service runs it. It can run
# beside the compactor: the lease makes each wait for the other's pass.
resource "aws_ecs_task_definition" "rebuild" {
  family                   = "${var.name}-rebuild"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge(local.compactor_container, {
    command = ["node", "dist/compact/main.js", "--once", "--rebuild"]
  })])
  depends_on = [terraform_data.image]
}

# ---------------------------------------------------------------- gateway

resource "aws_apigatewayv2_api" "main" {
  name          = var.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "group" {
  for_each               = local.route_groups
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[each.value].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "route" {
  for_each  = local.routes
  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.group[each.value].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "gateway" {
  for_each      = local.route_groups
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.value].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*"
}

# ---------------------------------------------------------------- HTTPS

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "app" {
  enabled     = true
  comment     = var.name
  price_class = "PriceClass_100"

  origin {
    domain_name = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
    origin_id   = "gateway"
    custom_header {
      name  = "X-Edge-Secret"
      value = random_password.edge.result
    }
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 30
      origin_keepalive_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id         = "gateway"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
