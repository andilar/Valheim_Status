#!/bin/zsh
# After changing valheim_collector.py in the repo: copy it into place and restart the collector.
set -e
cp "$(dirname "$0")/valheim_collector.py" ~/ValheimServer/valheim_collector.py
if launchctl print system/com.andilar.valheim-collector >/dev/null 2>&1; then
  sudo launchctl kickstart -k system/com.andilar.valheim-collector
else
  launchctl kickstart -k gui/$(id -u)/com.andilar.valheim-collector
fi
echo "Collector restarted. Log: ~/Library/Logs/ValheimServer/collector.log"
