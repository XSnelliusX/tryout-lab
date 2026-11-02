#!/usr/bin/env bash
# Two-terminal demo for the Redis-like server.
#
# Start the same script in both redis-cli windows, one per role:
#   ./demo/redis-demo.sh a 1     # upper right terminal
#   ./demo/redis-demo.sh b 1     # lower right terminal
#
# The two sessions synchronize through the server itself: each step waits
# until the other session has written a specific key.
#
# Step 5 sends BURST (default 200) SET commands per session at a common start time.
#
# The server has no DEL command, so keys from an earlier run stay in memory.
# Use a new run id (second argument) for every repeated run, or restart the pod.
#
# Optional environment variables:
#   HOST (127.0.0.1)   PORT (6379)
#   PAUSE (seconds between steps, default 2)
#   POLL  (seconds between checks while waiting for the other session, default 1)
#
# The server logs every request, so each check appears in the server log.
# A larger POLL keeps the live log in the recording calmer.

set -euo pipefail

ROLE="${1:-}"
RUN="${2:-1}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-6379}"
PAUSE="${PAUSE:-2}"
POLL="${POLL:-1}"
TIMEOUT="${TIMEOUT:-300}"

case "$ROLE" in
a | A) ME=a; OTHER=b; NAME=A; OTHER_NAME=B; COLOR=$'\033[36m' ;;
b | B) ME=b; OTHER=a; NAME=B; OTHER_NAME=A; COLOR=$'\033[33m' ;;
*)
  echo "usage: $0 <a|b> [run-id]" >&2
  exit 1
  ;;
esac

BOLD=$'\033[1m'
DIM=$'\033[2m'
RESET=$'\033[0m'

# -2: RESP2, the protocol version the server implements
# --no-raw: always print replies in the typed form ("value", "", (nil))
rc() { redis-cli -2 --no-raw -h "$HOST" -p "$PORT" "$@"; }

key() { printf 'demo:%s:%s' "$RUN" "$1"; }

say() { printf '\n%s%s== %s ==%s\n' "$BOLD" "$COLOR" "$*" "$RESET"; }
note() { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
pause() { sleep "$PAUSE"; }

# Show a command the way it would be typed: arguments that are empty or
# contain spaces are quoted, so the argument count is visible.
show() {
  local out="" arg
  for arg in "$@"; do
    if [ -z "$arg" ] || [[ "$arg" == *" "* ]]; then
      out+=" \"$arg\""
    else
      out+=" $arg"
    fi
  done
  printf '%s>%s%s\n' "$COLOR" "$out" "$RESET"
}

# Show a command, run it, and print the reply.
cmd() {
  show "$@"
  rc "$@"
}

# Poll a key quietly until it holds the expected value.
# expected is the plain value; the quotes of the typed form are added here.
wait_for() {
  local k="$1" expected="$2" got start=$SECONDS
  printf '%swaiting for %s to become "%s" ...%s\n' "$DIM" "$k" "$expected" "$RESET"
  while true; do
    got="$(rc GET "$k")"
    [ "$got" = "\"$expected\"" ] && return 0
    sleep "$POLL"
    if [ $((SECONDS - start)) -gt "$TIMEOUT" ]; then
      echo "timeout waiting for $k (is the other session running with run id $RUN?)" >&2
      exit 1
    fi
  done
}

now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }

# Sleep until an absolute time (seconds since the epoch, fractions allowed).
sleep_until() { perl -MTime::HiRes=time,sleep -e '$d = $ARGV[0] - time; sleep($d) if $d > 0' "$1"; }

# Wait until a key exists and print its plain value.
wait_value() {
  local k="$1" got start=$SECONDS
  while true; do
    got="$(rc GET "$k")"
    if [ "$got" != "(nil)" ]; then
      got="${got#\"}"
      printf '%s' "${got%\"}"
      return 0
    fi
    sleep "$POLL"
    if [ $((SECONDS - start)) -gt "$TIMEOUT" ]; then
      echo "timeout waiting for $k (is the other session running with run id $RUN?)" >&2
      exit 1
    fi
  done
}

# Both sessions leave this function at the same moment.
# Polling alone is not precise enough: a session that arrives first would notice
# the other one up to POLL seconds late. Instead, session A picks a start time a
# little in the future, publishes it through the server, and both sleep until
# then. This assumes both terminals run on the same machine (same clock).
barrier() {
  local name="$1" target
  if [ "$ME" = a ]; then
    rc SET "$(key "sync:$name:a")" "ready" >/dev/null
    wait_for "$(key "sync:$name:b")" "ready" >/dev/null
    target="$(perl -MTime::HiRes=time -e 'printf "%.3f", time + $ARGV[0] + 1' "$POLL")"
    rc SET "$(key "sync:$name:go")" "$target" >/dev/null
  else
    rc SET "$(key "sync:$name:b")" "ready" >/dev/null
    target="$(wait_value "$(key "sync:$name:go")")"
  fi
  sleep_until "$target"
}

# Send many SET commands over one connection, as fast as possible.
# Prints how many replies were OK.
burst_set() {
  local k="$1" prefix="$2" count="$3" i ok
  ok="$(
    for i in $(seq 1 "$count"); do
      printf 'SET %s %s-%s\n' "$k" "$prefix" "$i"
    done | rc | grep -c '^OK$' || true
  )"
  printf '%s of %s replies were OK\n' "$ok" "$count"
}

if ! rc SET "$(key "sync:hello:$ME")" "ready" | grep -q OK; then
  echo "cannot reach the server on $HOST:$PORT" >&2
  exit 1
fi

clear
printf '%sSession %s%s  (run %s, server %s:%s)\n' "$BOLD" "$NAME" "$RESET" "$RUN" "$HOST" "$PORT"
note "waiting for session $OTHER_NAME ..."
wait_for "$(key "sync:hello:$OTHER")" "ready" >/dev/null
note "session $OTHER_NAME is connected"
pause

# ---------------------------------------------------------------- 1
say "1. A writes, B reads"
if [ "$ME" = a ]; then
  cmd SET "$(key greeting)" "hello from A"
else
  wait_for "$(key greeting)" "hello from A"
  cmd GET "$(key greeting)"
fi
pause

# ---------------------------------------------------------------- 2
say "2. B overwrites, A reads the new value"
if [ "$ME" = b ]; then
  cmd SET "$(key greeting)" "overwritten by B"
else
  wait_for "$(key greeting)" "overwritten by B"
  cmd GET "$(key greeting)"
fi
pause

# ---------------------------------------------------------------- 3
say "3. Empty value versus missing key"
if [ "$ME" = a ]; then
  cmd SET "$(key empty)" ""
  note "A stored an empty string"
else
  wait_for "$(key empty)" ""
  cmd GET "$(key empty)"
  note "the key exists and holds an empty string"
  cmd GET "$(key never-set)"
  note "the key does not exist (null bulk string)"
fi
pause

# ---------------------------------------------------------------- 4
say "4. Ping-pong over one shared key"
for i in 1 2 3; do
  if [ "$ME" = a ]; then
    cmd SET "$(key ball)" "ping-$i"
    wait_for "$(key ball)" "pong-$i"
    cmd GET "$(key ball)"
  else
    wait_for "$(key ball)" "ping-$i"
    cmd GET "$(key ball)"
    cmd SET "$(key ball)" "pong-$i"
  fi
  pause
done

# ---------------------------------------------------------------- 5
say "5. Both sessions write the same key at the same time"
BURST="${BURST:-200}"
note "both sessions agree on a start time, then each sends $BURST SET commands on its own connection"
barrier race-start
show SET "$(key winner)" "$NAME-<n>"
printf '%s(%s commands, n = 1..%s)%s\n' "$DIM" "$BURST" "$BURST" "$RESET"
burst_set "$(key winner)" "$NAME" "$BURST"
barrier race-end
cmd GET "$(key winner)"
note "both sessions read the same value: the last write wins and the store is intact"
note "the server log shows the requests of both connections interleaved"
pause

# ---------------------------------------------------------------- 6
say "6. Case-insensitive commands and error handling"
if [ "$ME" = a ]; then
  cmd set "$(key lower)" "lowercase works"
else
  wait_for "$(key lower)" "lowercase works"
  cmd get "$(key lower)"
  cmd GET
  cmd FLUSHALL
fi

say "done - session $NAME finished"
note "the store keeps these keys until the pod restarts; use a new run id for another take"
