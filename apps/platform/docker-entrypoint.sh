#!/bin/sh
# Apply pending database migrations, then start the web server.
set -eu
node scripts/migrate.mjs
exec node server.js
