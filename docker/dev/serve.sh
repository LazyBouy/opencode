#!/bin/sh
# Starts the API server from source with the package's version. A build stamps the version into
# OPENCODE_VERSION; run from source it is "local", and the User-Agent "opencode/local" is refused by
# OpenCode Zen's free tier ("OpenCode's free tier can only be used from within OpenCode"). The channel
# stays "local", so the server still behaves as a development build.
set -e
cd /opencode/packages/opencode
version=$(bun -p 'require("./package.json").version')
exec bun run --define "OPENCODE_VERSION:\"$version\"" ./src/index.ts "$@"
