#!/bin/sh
set -e

# Bind-mounted data dirs are often owned by root or a host user, so fix ownership
# as root and then drop to the unprivileged node user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
