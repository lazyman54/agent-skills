#!/bin/sh
node "$(dirname "$0")/futu-agent-oauth.js" get-token "$@"
