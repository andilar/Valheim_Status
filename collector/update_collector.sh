#!/bin/zsh
# After changing valheim_collector.py in the repo: copy it into place and restart the collector.
# launchd (KeepAlive) starts it again right away, so no sudo is needed.
set -e
cp "$(dirname "$0")/valheim_collector.py" ~/ValheimServer/valheim_collector.py
pkill -f "ValheimServer/valheim_collector.py run" || true
echo "Collector restarted. Log: ~/Library/Logs/ValheimServer/collector.log"
