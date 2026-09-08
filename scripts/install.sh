#!/bin/bash
set -eu
umask 077

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SUPPORT="$HOME/Library/Application Support/MacFlare"
PLIST="$HOME/Library/LaunchAgents/com.macflare.agent.plist"
RUNTIME="$REPO_ROOT/agent/runtime.js"
ENDPOINT=
TOKEN_SOURCE=
PROFILE=
START=true

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--endpoint HTTPS_ORIGIN] [--token-file PATH] [--profile buffered|eco|realtime] [--no-start]
  --endpoint    Deployed Worker origin, without /api or /api/update. Existing value is reused if omitted.
  --token-file  Read the secret from a file. Otherwise reuse the installed token or prompt securely.
  --profile     buffered: continuous native capture; upload the last 15 minutes every 5 minutes.
                eco: every 120 seconds, Worker STATUS_TTL_SECONDS=180.
                realtime: every 30 seconds, Worker STATUS_TTL_SECONDS=60.
  --no-start    Install files without loading the LaunchAgent (useful for inspection).

Installs to ~/Library/Application Support/MacFlare. Existing privacy settings
and custom blocked_apps are preserved. New installations default to buffered; existing
profiles are retained, and legacy configurations without profile retain realtime.
Set the Worker's STATUS_TTL_SECONDS to match the selected profile before installing.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --endpoint|--token-file)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      if [ "$1" = --endpoint ]; then ENDPOINT=$2; else TOKEN_SOURCE=$2; fi
      shift 2 ;;
    --profile)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$2" in
        buffered|eco|realtime) PROFILE=$2 ;;
        *) echo '--profile must be buffered, eco or realtime.' >&2; exit 2 ;;
      esac
      shift 2 ;;
    --no-start) START=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[ "$(/usr/bin/uname -s)" = Darwin ] || { echo 'MacFlare requires macOS.' >&2; exit 1; }
[ "$(/usr/bin/id -u)" -ne 0 ] || { echo 'Install as your desktop user, without sudo.' >&2; exit 1; }
[ ! -L "$SUPPORT" ] || { echo 'The MacFlare support directory must not be a symbolic link.' >&2; exit 1; }
[ ! -L "$SUPPORT/agent" ] || { echo 'The MacFlare agent directory must not be a symbolic link.' >&2; exit 1; }
/bin/mkdir -p -- "$SUPPORT"
/bin/chmod 700 "$SUPPORT"
INSTALL_LOCK="$SUPPORT/.install.lock"
/bin/mkdir -- "$INSTALL_LOCK" 2>/dev/null || {
  echo 'Another installation holds .install.lock. Wait for it to finish, or remove the stale lock after verifying no installer is running.' >&2
  exit 1
}
trap '/bin/rmdir -- "$INSTALL_LOCK" 2>/dev/null || :' EXIT
TASK_TEMP=$(/usr/bin/mktemp -d "$SUPPORT/.install.XXXXXX")
trap '/bin/rm -rf -- "$TASK_TEMP"; /bin/rmdir -- "$INSTALL_LOCK" 2>/dev/null || :' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/osascript -l JavaScript "$RUNTIME" configure "$SUPPORT/config.json" "$ENDPOINT" "$PROFILE" >"$TASK_TEMP/config.json" 2>/dev/null || {
  echo 'A valid --endpoint HTTPS origin and valid JSON configuration (profile: buffered, eco or realtime) are required.' >&2; exit 1;
}
if [ -n "$TOKEN_SOURCE" ]; then
  [ -f "$TOKEN_SOURCE" ] || { echo 'Token file does not exist.' >&2; exit 1; }
  /bin/cat -- "$TOKEN_SOURCE" >"$TASK_TEMP/token"
elif [ -f "$SUPPORT/token" ]; then
  /bin/cat -- "$SUPPORT/token" >"$TASK_TEMP/token"
elif [ -t 0 ]; then
  printf 'Worker ingestion token (hidden): ' >&2
  IFS= read -r -s INGEST_SECRET
  printf '\n' >&2
  printf '%s\n' "$INGEST_SECRET" >"$TASK_TEMP/token"
  unset INGEST_SECRET
else
  echo 'Use --token-file PATH for a noninteractive install.' >&2
  exit 1
fi
/usr/bin/osascript -l JavaScript "$RUNTIME" validate "$TASK_TEMP/config.json" "$TASK_TEMP/token" >/dev/null 2>&1 || {
  echo 'Invalid endpoint or token; use a token of at least 32 Bearer-token characters.' >&2; exit 1;
}
/usr/bin/osascript -l JavaScript "$RUNTIME" plist "$SUPPORT/agent/macflare.sh" "$SUPPORT/config.json" "$TASK_TEMP/config.json" >"$TASK_TEMP/agent.plist"
/usr/bin/plutil -lint "$TASK_TEMP/agent.plist" >/dev/null
SCHEDULE_MESSAGE=$(/usr/bin/osascript -l JavaScript "$RUNTIME" schedule-message "$TASK_TEMP/config.json")

# Stop an existing installation before replacing its files, including --no-start.
if [ "$START" = true ] || [ -f "$PLIST" ]; then
  /bin/launchctl bootout "gui/$(/usr/bin/id -u)/com.macflare.agent" >/dev/null 2>&1 || :
fi
/bin/mkdir -p -- "$SUPPORT/agent" "$HOME/Library/LaunchAgents"
/bin/chmod 700 "$SUPPORT/agent"
/bin/cp -- "$REPO_ROOT/agent/macflare.sh" "$SUPPORT/agent/macflare.sh"
/bin/cp -- "$RUNTIME" "$SUPPORT/agent/runtime.js"
/bin/cp -- "$REPO_ROOT/agent/window-runtime.js" "$SUPPORT/agent/window-runtime.js"
/bin/chmod 700 "$SUPPORT/agent/macflare.sh"
/bin/chmod 600 "$SUPPORT/agent/runtime.js"
/bin/chmod 600 "$SUPPORT/agent/window-runtime.js"
/bin/mv -f -- "$TASK_TEMP/config.json" "$SUPPORT/config.json"
/bin/mv -f -- "$TASK_TEMP/token" "$SUPPORT/token"
/bin/mv -f -- "$TASK_TEMP/agent.plist" "$PLIST"
/bin/chmod 600 "$SUPPORT/config.json" "$SUPPORT/token" "$PLIST"

if [ "$START" = true ]; then
  /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$PLIST" || {
    echo 'Files are installed, but launchd could not start the agent. Run from your logged-in desktop session.' >&2
    exit 1
  }
  echo 'MacFlare installed and started.'
else
  echo 'MacFlare files installed; LaunchAgent was not loaded.'
fi
echo "$SCHEDULE_MESSAGE"
echo 'Use agent/macflare.sh --print to inspect shared fields and grant Music Automation access if prompted.'
