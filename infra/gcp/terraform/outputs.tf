output "lb_ip" {
  value       = google_compute_global_address.ip.address
  description = "Create an A record for var.domain pointing here"
}

output "image_registry" {
  value = local.registry
}

output "media_bucket" {
  value = google_storage_bucket.media.name
}

output "sql_connection_name" {
  value = google_sql_database_instance.pg.connection_name
}
