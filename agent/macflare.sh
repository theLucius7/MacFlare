#!/bin/bash
# macOS ships Bash 3.2, osascript, pmset, sysctl, curl, and launchd.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME="$SCRIPT_DIR/runtime.js"
CONFIG="$HOME/Library/Application Support/MacFlare/config.json"
MODE=push

usage() {
  cat <<'EOF'
Usage: macflare.sh [--once | --print] [--config PATH]
  --once         Collect and push one update (the default).
  --print        Print local JSON without sending it; missing config uses defaults.
  --config PATH  Read JSON configuration; the token is in its sibling file "token".
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --once) MODE=push; shift ;;
    --print) MODE=print; shift ;;
    --config)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      CONFIG=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[ "$(/usr/bin/uname -s)" = Darwin ] || { echo 'MacFlare requires macOS.' >&2; exit 1; }
CONFIG_DIR=$(dirname -- "$CONFIG")
TOKEN="$CONFIG_DIR/token"

private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  local permission owner
  permission=$(/usr/bin/stat -f '%Lp' "$1")
  owner=$(/usr/bin/stat -f '%u' "$1")
  [ "$owner" = "$(/usr/bin/id -u)" ] && [ "$permission" = 600 ]
}

if [ "$MODE" = push ]; then
  if ! private_file "$CONFIG" || ! private_file "$TOKEN"; then
    echo 'Configuration and token must be regular files owned by you with mode 600. Run scripts/install.sh.' >&2
    exit 1
  fi
  /usr/bin/osascript -l JavaScript "$RUNTIME" validate "$CONFIG" "$TOKEN" >/dev/null 2>&1 || {
    echo 'Invalid MacFlare configuration or token. Check config.json and token.' >&2; exit 1;
  }
fi

TASK_TEMP=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/macflare.XXXXXX")
WATCHDOG_PID=
CHILD_PID=
cleanup() {
  [ -z "$WATCHDOG_PID" ] || kill "$WATCHDOG_PID" 2>/dev/null || :
  [ -z "$CHILD_PID" ] || kill "$CHILD_PID" 2>/dev/null || :
  /bin/rm -rf -- "$TASK_TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Music automation can wait on a macOS consent dialog. Bound the subprocess so
# a denied or unanswered prompt cannot stall the launchd job indefinitely.
run_bounded() {
  local duration=$1 outcome=0
  shift
  "$@" &
  CHILD_PID=$!
  (
    /bin/sleep "$duration"
    kill -TERM "$CHILD_PID" 2>/dev/null || exit 0
    /bin/sleep 1
    kill -KILL "$CHILD_PID" 2>/dev/null || :
  ) &
  WATCHDOG_PID=$!
  wait "$CHILD_PID" 2>/dev/null || outcome=$?
  kill "$WATCHDOG_PID" 2>/dev/null || :
  wait "$WATCHDOG_PID" 2>/dev/null || :
  WATCHDOG_PID=
  CHILD_PID=
  return "$outcome"
}

if ! run_bounded 6 /usr/bin/osascript -l JavaScript "$RUNTIME" collect "$CONFIG" >"$TASK_TEMP/base.json" 2>/dev/null; then
  echo 'Could not collect MacFlare status. Check config.json and run again in your logged-in desktop session.' >&2
  exit 1
fi
if ! run_bounded 5 /usr/bin/osascript -l JavaScript "$RUNTIME" music "$CONFIG" >"$TASK_TEMP/music.json" 2>/dev/null; then
  printf '%s\n' '{"state":"unavailable","track":null,"artist":null}' >"$TASK_TEMP/music.json"
fi
/usr/bin/osascript -l JavaScript "$RUNTIME" merge "$TASK_TEMP/base.json" "$TASK_TEMP/music.json" >"$TASK_TEMP/payload.json"

if [ "$MODE" = print ]; then
  /bin/cat "$TASK_TEMP/payload.json"
  exit 0
fi

# curl receives its Authorization header from a private temporary configuration,
# never from its process arguments. curl -q ignores user .curlrc overrides.
/usr/bin/osascript -l JavaScript "$RUNTIME" curl-config "$CONFIG" "$TOKEN" "$TASK_TEMP/payload.json" >"$TASK_TEMP/curl.conf" 2>/dev/null
CURL_EXIT=0
HTTP_STATUS=$(/usr/bin/curl -q --config "$TASK_TEMP/curl.conf" 2>/dev/null) || CURL_EXIT=$?
/usr/bin/osascript -l JavaScript "$RUNTIME" result "$CURL_EXIT" "$HTTP_STATUS" >"$TASK_TEMP/last-result.json"
/bin/mv -f -- "$TASK_TEMP/last-result.json" "$CONFIG_DIR/last-result.json"
if [ "$CURL_EXIT" -ne 0 ] || [[ ! "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]; then
  echo "MacFlare update failed (curl $CURL_EXIT, HTTP ${HTTP_STATUS:-unknown})." >&2
  exit 1
fi
