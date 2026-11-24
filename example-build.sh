#!/bin/sh

docker compose \
  -f /path/to/static-upload-server/docker-compose.yml \
  -f /path/to/static-upload-server/docker-compose.build.yml \
  --env-file /path/to/.env.static-file-server \
  build