#!/bin/zsh
# Installs the dashboard collector as a boot daemon (runs without anyone logged in).
# Run once with: sudo ~/Documents/Github/Valheim_Status/collector/install_collector.sh
set -e
[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }
U=andilar; H=/Users/$U; LBL=com.andilar.valheim-collector
DIR="$H/Documents/Github/Valheim_Status/collector"

# 1. remove the interim per-user LaunchAgent, if present
sudo -u $U launchctl bootout gui/$(id -u $U)/$LBL 2>/dev/null || true
rm -f "$H/Library/LaunchAgents/$LBL.plist"

# 2. copy the collector next to the server scripts (launchd may not read ~/Documents)
install -o $U -g staff -m 755 "$DIR/valheim_collector.py" "$H/ValheimServer/valheim_collector.py"

# 3. install and start the boot daemon
install -o root -g wheel -m 644 "$DIR/$LBL.plist" /Library/LaunchDaemons/$LBL.plist
launchctl bootout system/$LBL 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/$LBL.plist
launchctl enable system/$LBL

sleep 3
launchctl print system/$LBL | grep -E 'state|pid' | head -3
echo "Done. Log: $H/Library/Logs/ValheimServer/collector.log"
