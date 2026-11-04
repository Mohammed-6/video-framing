variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "domain" {
  type        = string
  description = "Public hostname (e.g. app.clipforge.example). Point its A record at the `lb_ip` output."
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Tag of the api/web/media-worker images in Artifact Registry"
}

variable "db_tier" {
  type    = string
  default = "db-g1-small" # personal tool: small shared-core instance is enough
}

variable "worker_cpu" {
  type    = string
  default = "4"
}

variable "worker_memory" {
  type    = string
  default = "8Gi"
}

variable "worker_min_instances" {
  type    = number
  default = 1
}

variable "worker_max_instances" {
  type    = number
  default = 5
}

variable "whisper_model" {
  type    = string
  default = "small"
}

variable "clip_planner" {
  type        = string
  default     = "llm"
  description = "llm | heuristic"
}

variable "openai_model" {
  type    = string
  default = "gpt-4o-mini"
}

variable "render_retention_days" {
  type        = number
  default     = 30
  description = "Rendered clips are deleted from the bucket after this many days"
}

variable "app_password" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Login password. Empty = generate one (read it: gcloud secrets versions access latest --secret=clipforge-<env>-app-password)"
}

variable "youtube_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "YouTube Data API v3 key for search"
}

variable "google_oauth_client_id" {
  type        = string
  default     = ""
  sensitive   = true
  description = "OAuth client for publishing to YouTube (or enter it in Settings > Platforms)"
}

variable "google_oauth_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "openai_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Enables the LLM clip planner (otherwise the heuristic planner is used)"
}
