#!/bin/sh

docker compose \
  -f /path/to/static-upload-server/docker-compose.yml \
  --env-file /path/to/.env.static-file-server \
  up -d --force-recreate
