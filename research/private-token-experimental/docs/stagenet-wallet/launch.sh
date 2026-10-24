#!/bin/sh
# Opens "XMR20 Stagenet — Test funds only" in its own browser profile (see launch.mjs for what happens). Test funds only.
cd "$(dirname "$0")" && exec node launch.mjs "$@"
