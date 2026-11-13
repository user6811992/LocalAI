#!/bin/sh
# Fix ownership of mounted volumes (created as root by Docker) then drop privileges.
chown -R aegis:aegis /app/data /app/workspace 2>/dev/null || true
exec su aegis -s /bin/sh -c "cd /app && exec node server.js"