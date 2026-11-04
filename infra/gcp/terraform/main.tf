# ClipForge on GCP
#
#   HTTPS LB ──/api/v1/*──▶ Cloud Run: api ──▶ Cloud SQL (Postgres)
#            └──/*────────▶ Cloud Run: web          ▲
#   Browser ──signed PUT/GET──▶ GCS media bucket     │
#   Cloud Run: media-worker (always-on: download, transcribe, render, publish) ─┘
#
# All secrets live in Secret Manager. Generated: DB URL, JWT secret, app password,
# credentials key. Optional (set via variables): YouTube API key, Google OAuth client,
# OpenAI key.

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = ">= 6.0" }
    random = { source = "hashicorp/random", version = ">= 3.6" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  name     = "clipforge-${var.env}"
  registry = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
  origin   = "https://${var.domain}"
}

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "storage.googleapis.com", "compute.googleapis.com", "youtube.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = local.name
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "media" {
  name                        = "${var.project_id}-${local.name}-media"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Browsers upload/download directly with signed URLs.
  cors {
    origin          = [local.origin]
    method          = ["PUT", "GET", "HEAD"]
    response_header = ["Content-Type", "x-goog-content-length-range", "Range", "Content-Range"]
    max_age_seconds = 3600
  }

  lifecycle_rule {
    condition {
      age            = var.render_retention_days
      matches_prefix = ["renders/"]
    }
    action { type = "Delete" }
  }

  # Abandoned multipart uploads.
  lifecycle_rule {
    condition { age = 7 }
    action { type = "AbortIncompleteMultipartUpload" }
  }
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "pg" {
  name             = local.name
  database_version = "POSTGRES_16"
  region           = var.region
  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    ip_configuration { ipv4_enabled = true } # access via Cloud SQL connector only (no authorized networks)
  }
  deletion_protection = true
  depends_on          = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = "clipforge"
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "app" {
  name     = "clipforge"
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_password" "app" {
  length  = 20
  special = false
}

resource "random_id" "credentials_key" {
  byte_length = 32
}

locals {
  # Always created (values generated here).
  generated_secrets = {
    "database-url"    = "postgres://clipforge:${random_password.db.result}@/clipforge?host=/cloudsql/${google_sql_database_instance.pg.connection_name}"
    "jwt-secret"      = random_password.jwt.result
    "app-password"    = var.app_password != "" ? var.app_password : random_password.app.result
    "credentials-key" = random_id.credentials_key.b64_std
  }
  # Created only when the variable is set (Secret Manager rejects empty values).
  optional_secret_values = {
    "youtube-api-key"            = var.youtube_api_key
    "google-oauth-client-id"     = var.google_oauth_client_id
    "google-oauth-client-secret" = var.google_oauth_client_secret
    "openai-api-key"             = var.openai_api_key
  }
  optional_secrets = toset([for k, v in local.optional_secret_values : k if nonsensitive(v != "")])
  all_secrets      = setunion(toset(keys(local.generated_secrets)), local.optional_secrets)

  # env var -> secret, per service (optional ones are skipped when not configured)
  api_secret_env = { for k, v in {
    DATABASE_URL               = "database-url"
    JWT_SECRET                 = "jwt-secret"
    APP_PASSWORD               = "app-password"
    CREDENTIALS_KEY            = "credentials-key"
    YOUTUBE_API_KEY            = "youtube-api-key"
    GOOGLE_OAUTH_CLIENT_ID     = "google-oauth-client-id"
    GOOGLE_OAUTH_CLIENT_SECRET = "google-oauth-client-secret"
  } : k => v if contains(local.all_secrets, v) }
  worker_secret_env = { for k, v in {
    DATABASE_URL               = "database-url"
    CREDENTIALS_KEY            = "credentials-key"
    OPENAI_API_KEY             = "openai-api-key"
    GOOGLE_OAUTH_CLIENT_ID     = "google-oauth-client-id"
    GOOGLE_OAUTH_CLIENT_SECRET = "google-oauth-client-secret"
  } : k => v if contains(local.all_secrets, v) }
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.all_secrets
  secret_id = "${local.name}-${each.value}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = nonsensitive(toset(keys(local.generated_secrets)))
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = local.generated_secrets[each.key]
}

resource "google_secret_manager_secret_version" "optional" {
  for_each    = local.optional_secrets
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = local.optional_secret_values[each.key]
}

# ---------------------------------------------------------------------------
# Service accounts & IAM
# ---------------------------------------------------------------------------

resource "google_service_account" "sa" {
  for_each     = toset(["api", "worker", "web"])
  account_id   = "${local.name}-${each.value}"
  display_name = "ClipForge ${each.value} (${var.env})"
}

resource "google_storage_bucket_iam_member" "media_rw" {
  for_each = toset(["api", "worker"])
  bucket   = google_storage_bucket.media.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.sa[each.value].email}"
}

# Lets each runtime SA sign V4 URLs via the IAM signBlob API (no key files).
resource "google_service_account_iam_member" "self_sign" {
  for_each           = toset(["api", "worker"])
  service_account_id = google_service_account.sa[each.value].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.sa[each.value].email}"
}

resource "google_project_iam_member" "sql_client" {
  for_each = toset(["api", "worker"])
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${google_service_account.sa[each.value].email}"
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each = merge(
    { for env, s in local.api_secret_env : "api-${s}" => { sa = "api", secret = s } },
    { for env, s in local.worker_secret_env : "worker-${s}" => { sa = "worker", secret = s } },
  )
  secret_id = google_secret_manager_secret.s[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa[each.value.sa].email}"
}

# ---------------------------------------------------------------------------
# Cloud Run services
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "api" {
  name     = "${local.name}-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.sa["api"].email
    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.pg.connection_name] }
    }
    containers {
      image = "${local.registry}/api:${var.image_tag}"
      ports { container_port = 4000 }
      dynamic "env" {
        for_each = {
          NODE_ENV       = "production"
          STORAGE_DRIVER = "gcs"
          GCS_BUCKET     = google_storage_bucket.media.name
          WEB_ORIGIN     = local.origin
          PUBLIC_API_URL = local.origin
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.api_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get { path = "/healthz" }
        initial_delay_seconds = 2
        period_seconds        = 3
        failure_threshold     = 20
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.access,
    google_secret_manager_secret_version.generated,
    google_secret_manager_secret_version.optional,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  name     = "${local.name}-web"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  template {
    service_account = google_service_account.sa["web"].email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = "${local.registry}/web:${var.image_tag}"
      ports { container_port = 3000 }
    }
  }
}

# Long-running media worker: polls the job tables, downloads, transcribes, renders and
# publishes. CPU is always allocated. Scheduled posts need it running, so keep min >= 1.
resource "google_cloud_run_v2_service" "worker" {
  name     = "${local.name}-media-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account                  = google_service_account.sa["worker"].email
    timeout                          = "3600s"
    max_instance_request_concurrency = 1
    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.pg.connection_name] }
    }
    containers {
      image   = "${local.registry}/media-worker:${var.image_tag}"
      command = ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
      ports { container_port = 8080 }
      resources {
        limits = {
          cpu    = var.worker_cpu
          memory = var.worker_memory
        }
        cpu_idle          = false # CPU always allocated
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = {
          WORKER_EMBEDDED      = "true"
          STORAGE_DRIVER       = "gcs"
          GCS_BUCKET           = google_storage_bucket.media.name
          GCS_STREAM_INPUT     = "true"
          TRANSCRIBE_PROVIDER  = "faster_whisper"
          WHISPER_MODEL        = var.whisper_model
          CLIP_PLANNER         = nonsensitive(var.openai_api_key != "") ? var.clip_planner : "heuristic"
          OPENAI_MODEL         = var.openai_model
          ANALYSIS_CONCURRENCY = "1"
          RENDER_CONCURRENCY   = "2"
          PUBLISH_CONCURRENCY  = "2"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.worker_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get { path = "/healthz" }
        period_seconds    = 5
        failure_threshold = 24
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.access,
    google_secret_manager_secret_version.generated,
    google_secret_manager_secret_version.optional,
  ]
}

# The LB invokes api/web as unauthenticated public services (ingress restricted to the LB).
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = {
    api = google_cloud_run_v2_service.api.name
    web = google_cloud_run_v2_service.web.name
  }
  name     = each.value
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------
# HTTPS load balancer: one origin for web + API (same-site session cookie)
# ---------------------------------------------------------------------------

resource "google_compute_region_network_endpoint_group" "neg" {
  for_each              = { api = google_cloud_run_v2_service.api.name, web = google_cloud_run_v2_service.web.name }
  name                  = "${local.name}-${each.key}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = each.value }
}

resource "google_compute_backend_service" "be" {
  for_each              = google_compute_region_network_endpoint_group.neg
  name                  = "${local.name}-${each.key}-be"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend { group = each.value.id }
}

resource "google_compute_url_map" "lb" {
  name            = "${local.name}-lb"
  default_service = google_compute_backend_service.be["web"].id
  host_rule {
    hosts        = [var.domain]
    path_matcher = "app"
  }
  path_matcher {
    name            = "app"
    default_service = google_compute_backend_service.be["web"].id
    path_rule {
      paths   = ["/api/*", "/healthz"]
      service = google_compute_backend_service.be["api"].id
    }
  }
}

resource "google_compute_managed_ssl_certificate" "cert" {
  name = "${local.name}-cert"
  managed { domains = [var.domain] }
}

resource "google_compute_target_https_proxy" "https" {
  name             = "${local.name}-https"
  url_map          = google_compute_url_map.lb.id
  ssl_certificates = [google_compute_managed_ssl_certificate.cert.id]
}

resource "google_compute_global_address" "ip" {
  name = "${local.name}-ip"
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${local.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.https.id
  ip_address            = google_compute_global_address.ip.id
  port_range            = "443"
}
