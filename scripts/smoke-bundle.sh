#!/bin/bash
# Smoke test of a built Applyant.app, the way launchd runs it: the bundle's launcher starts
# the bundled daemon with launchd's bare environment (no shell PATH, no SHELL), on a
# throwaway data dir, and the bundled CLI checks GetSetupStatus, ListPostings and a
# Keychain round trip through applyant-native.
#
#   scripts/smoke-bundle.sh [path/to/Applyant.app]     (default /Applications/Applyant.app)
set -euo pipefail

APP="${1:-/Applications/Applyant.app}"
C="$APP/Contents"
NODE="$C/Resources/node/bin/node"
CLI="$C/Resources/bin/applyant"
[ -x "$C/MacOS/applyantd" ] || { echo "no bundle at $APP" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/applyant-smoke.XXXXXX")"
HOME_DIR="$WORK/home"
LOG="$WORK/applyantd.log"
DAEMON_PID=""
cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  echo "--- daemon log (last 40 lines) ---" >&2
  tail -40 "$LOG" >&2 || true
  exit 1
}

# What launchd gives an agent: HOME, USER, LOGNAME and a minimal PATH; no SHELL.
bare() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    APPLYANT_HOME="$HOME_DIR" "$@"
}

echo "==> starting the bundled daemon (launchd environment, APPLYANT_HOME=$HOME_DIR)"
# The reader browser is shared with the real data dir, so the smoke doesn't fetch it again.
# Not through bare(): a function would run in a subshell, and $! would be the subshell's pid.
# env execs the launcher, which execs Node, so $! is the daemon itself.
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  APPLYANT_HOME="$HOME_DIR" APPLYANT_EMBEDDER=hash APPLYANT_LOG_FILE="$LOG" \
  PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Application Support/Applyant/browsers" \
  "$C/MacOS/applyantd" </dev/null >/dev/null 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 100); do
  [ -f "$HOME_DIR/endpoint.json" ] && break
  kill -0 "$DAEMON_PID" 2>/dev/null || fail "the daemon exited during start"
  sleep 0.2
done
[ -f "$HOME_DIR/endpoint.json" ] || fail "no endpoint.json after 20 s"

check() { # check <description> <json> <js expression over `s`>
  "$NODE" -e "const s = JSON.parse(process.argv[1]); if (!($3)) process.exit(1);" "$2" \
    || fail "$1"
  echo "ok: $1"
}

echo "==> applyant status"
STATUS="$(bare "$CLI" status --json)" || fail "applyant status failed"
bare "$CLI" status
check "claude found and signed in" "$STATUS" 's.claude.found && s.claude.signedIn'
check "applyant-native answers" "$STATUS" 's.nativeHelper === true'
check "secrets in the keychain" "$STATUS" "s.secretsBackend === 'keychain'"
check "the daemon is the one we started" "$STATUS" "s.daemon.home === '$HOME_DIR' && s.daemon.pid === $DAEMON_PID"
"$NODE" -e 'const s = JSON.parse(process.argv[1]); console.log(s.codex.found ? `codex: ${s.codex.path} (${s.codex.foundVia})` : `codex: not found (${s.codex.error})`)' "$STATUS"

echo "==> applyant jobs list"
POSTINGS="$(bare "$CLI" jobs list --json)" || fail "applyant jobs list failed"
check "ListPostings answers (empty on a new data dir)" "$POSTINGS" 'Array.isArray(s) && s.length === 0'

echo "==> Keychain round trip (secret smoke-check, deleted again)"
printf 'smoke-value-%s\n' "$$" | bare "$CLI" secrets set smoke-check >/dev/null || fail "secrets set"
NAMES="$(bare "$CLI" secrets list --json)" || fail "secrets list"
bare "$CLI" secrets delete smoke-check >/dev/null || fail "secrets delete"
check "the secret was listed from the keychain" "$NAMES" "s.includes('smoke-check')"
[ ! -e "$HOME_DIR/secrets.json" ] || fail "a secrets.json was written next to the keychain"

echo "==> stopping"
kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID" && code=0 || code=$?
DAEMON_PID=""
[ "$code" = 0 ] || fail "the daemon exited with $code on SIGTERM"
grep -q '"applyantd stopped"' "$LOG" || fail "no clean stop in the log"
echo "PASS: bundle smoke test"
