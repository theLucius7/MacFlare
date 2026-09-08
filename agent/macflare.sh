#!/bin/bash
# macOS ships Bash 3.2, osascript, pmset, sysctl, curl, and launchd.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME="$SCRIPT_DIR/runtime.js"
CONFIG="$HOME/Library/Application Support/MacFlare/config.json"
MODE=push
OBSERVE_SECONDS=

usage() {
  cat <<'EOF'
Usage: macflare.sh [--once | --print | --watch | --observe SECONDS] [--config PATH]
  --once         Collect and push one snapshot (eco/realtime only; the default).
  --print        Print JSON without pushing to the Worker. Enabled Music may query
                 Apple for artwork; missing config uses defaults and temporary cache.
  --config PATH  Read JSON configuration; the token is in its sibling file "token".
  --watch        Collect native events continuously and upload a sliding window
                 every five minutes. Used by the buffered LaunchAgent.
  --observe SEC  Inspect the buffered collector for 1–300 seconds without uploads.
                 Prints counts only; its temporary history is deleted on exit.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --once) MODE=push; shift ;;
    --print) MODE=print; shift ;;
    --watch) MODE=watch; shift ;;
    --observe)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$2" in ''|*[!0-9]*) usage >&2; exit 2 ;; esac
      [ "$2" -ge 1 ] && [ "$2" -le 300 ] || { usage >&2; exit 2; }
      MODE=observe; OBSERVE_SECONDS=$2; shift 2 ;;
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

if [ "$MODE" = push ] || [ "$MODE" = watch ]; then
  if ! private_file "$CONFIG" || ! private_file "$TOKEN"; then
    echo 'Configuration and token must be regular files owned by you with mode 600. Run scripts/install.sh.' >&2
    exit 1
  fi
  /usr/bin/osascript -l JavaScript "$RUNTIME" validate "$CONFIG" "$TOKEN" >/dev/null 2>&1 || {
    echo 'Invalid MacFlare configuration or token. Check config.json and token.' >&2; exit 1;
  }
  SELECTED_PROFILE=$(/usr/bin/osascript -l JavaScript "$RUNTIME" profile "$CONFIG")
  if [ "$MODE" = push ] && [ "$SELECTED_PROFILE" = buffered ]; then
    echo 'The buffered profile uses --watch. Use --print for a snapshot without replacing the public timeline.' >&2
    exit 1
  fi
  if [ "$MODE" = watch ] && [ "$SELECTED_PROFILE" != buffered ]; then
    echo 'Install with --profile buffered before using --watch.' >&2
    exit 1
  fi
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

if [ "$MODE" = watch ] || [ "$MODE" = observe ]; then
  if [ "$MODE" = watch ]; then
    [ ! -L "$CONFIG_DIR" ] && [ "$(/usr/bin/stat -f '%Lp' "$CONFIG_DIR")" = 700 ] &&
      [ "$(/usr/bin/stat -f '%u' "$CONFIG_DIR")" = "$(/usr/bin/id -u)" ] || {
      echo 'Buffered collection requires a private configuration directory with mode 700.' >&2; exit 1;
    }
    # launchd serializes its job, and this OS advisory lock also excludes manual copies.
    # The lock file is not a stale-PID sentinel; the kernel releases it on process exit.
  fi
  /usr/bin/osascript -l JavaScript "$SCRIPT_DIR/window-runtime.js" "$RUNTIME" "$CONFIG" "$TOKEN" "$TASK_TEMP" "$MODE" "$OBSERVE_SECONDS" &
  CHILD_PID=$!
  OUTCOME=0
  wait "$CHILD_PID" || OUTCOME=$?
  CHILD_PID=
  exit "$OUTCOME"
fi

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
# Persist only one current-song lookup, beside an existing private configuration.
# A config-less --print uses the temporary directory and creates no installation.
ARTWORK_CACHE="$TASK_TEMP/artwork-cache.json"
if private_file "$CONFIG" && [ ! -L "$CONFIG_DIR" ] &&
  [ "$(/usr/bin/stat -f '%Lp' "$CONFIG_DIR")" = 700 ] &&
  [ "$(/usr/bin/stat -f '%u' "$CONFIG_DIR")" = "$(/usr/bin/id -u)" ]; then
  if [ ! -e "$CONFIG_DIR/artwork-cache.json" ] && [ ! -L "$CONFIG_DIR/artwork-cache.json" ] ||
    private_file "$CONFIG_DIR/artwork-cache.json"; then
    ARTWORK_CACHE="$CONFIG_DIR/artwork-cache.json"
  fi
fi
# Apple's request has its own five-second timeout; bound native parsing as well.
if run_bounded 8 /usr/bin/osascript -l JavaScript "$RUNTIME" artwork "$TASK_TEMP/music.json" "$ARTWORK_CACHE" "$TASK_TEMP" "$CONFIG" >"$TASK_TEMP/enriched-music.json" 2>/dev/null; then
  /bin/mv -f -- "$TASK_TEMP/enriched-music.json" "$TASK_TEMP/music.json"
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
