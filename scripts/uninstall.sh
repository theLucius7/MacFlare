#!/bin/bash
set -eu
umask 077

SUPPORT="$HOME/Library/Application Support/MacFlare"
PLIST="$HOME/Library/LaunchAgents/com.macflare.agent.plist"
PURGE=false
case "${1:-}" in
  '') ;;
  --purge) PURGE=true; shift ;;
  --help|-h)
    echo 'Usage: scripts/uninstall.sh [--purge]'
    echo 'Stops the LaunchAgent and removes agent files. --purge also deletes configuration, token, and last-result.json.'
    exit 0 ;;
  *) echo 'Usage: scripts/uninstall.sh [--purge]' >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo 'Usage: scripts/uninstall.sh [--purge]' >&2; exit 2; }
[ "$(/usr/bin/uname -s)" = Darwin ] || { echo 'MacFlare requires macOS.' >&2; exit 1; }
[ "$(/usr/bin/id -u)" -ne 0 ] || { echo 'Uninstall as your desktop user, without sudo.' >&2; exit 1; }
[ ! -L "$SUPPORT" ] && [ ! -L "$SUPPORT/agent" ] || {
  echo 'Refusing to modify a symbolic-link installation directory.' >&2; exit 1;
}

/bin/launchctl bootout "gui/$(/usr/bin/id -u)/com.macflare.agent" >/dev/null 2>&1 || :
/bin/rm -f -- "$PLIST" "$SUPPORT/agent/macflare.sh" "$SUPPORT/agent/runtime.js"
/bin/rmdir -- "$SUPPORT/agent" 2>/dev/null || :
if [ "$PURGE" = true ]; then
  /bin/rm -f -- "$SUPPORT/config.json" "$SUPPORT/token" "$SUPPORT/last-result.json"
  /bin/rmdir -- "$SUPPORT" 2>/dev/null || :
  echo 'MacFlare stopped; installed code, configuration, and token removed.'
else
  echo 'MacFlare stopped and agent removed. Configuration and token retained; use --purge to remove them.'
fi
echo 'The public status expires within 60 seconds of the last accepted update.'
