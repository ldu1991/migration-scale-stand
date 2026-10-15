$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
docker compose build
docker compose up -d postgres pgbouncer-session pgbouncer-transaction toxiproxy
docker compose run --rm runner node src/run.js --smoke --out results/smoke.jsonl
