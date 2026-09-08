#!/bin/sh
# nodemon forwards its TypeScript entrypoint and restarts this whole command.
set -e
node config/db/wait.js
exec ts-node -r tsconfig-paths/register "$@"
