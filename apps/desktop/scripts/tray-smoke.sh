#!/usr/bin/env bash
# Tray smoke run on Linux: starts the app with --tray-smoke on a virtual display and a session bus
# with a small StatusNotifierWatcher, which reads the tray's menu and clicks it. A second run
# starts the app first and the watcher after it.
# Usage: apps/desktop/scripts/tray-smoke.sh <path to the rchat binary>
# Needs xvfb-run, dbus-run-session, python3-dbus and python3-gi.
set -euo pipefail

app=$(realpath "${1:?usage: tray-smoke.sh <rchat binary>}")
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

inner=$work/inner.sh
cat > "$inner" <<'INNER'
#!/usr/bin/env bash
set -u
watch() {
  python3 -I "$HERE/sni_watcher.py" > "$1" 2>&1 &
  watcher=$!
  for _ in $(seq 300); do
    grep -q '^ready' "$1" && break
    sleep 0.1
  done
}
# The watcher's last click is Quit, which ends the app before the hold runs out.
export RCHAT_TRAY_SMOKE_HOLD=30

watch "$WORK/watcher.log"
"$APP" --tray-smoke > "$WORK/app.log" 2>&1
echo $? > "$WORK/code"
kill "$watcher"
wait "$watcher" 2> /dev/null

RCHAT_TRAY_SMOKE_WAIT=30 "$APP" --tray-smoke > "$WORK/late-app.log" 2>&1 &
late=$!
for _ in $(seq 300); do
  grep -q '^TRAY SMOKE' "$WORK/late-app.log" && break
  sleep 0.1
done
watch "$WORK/late-watcher.log"
wait "$late"
echo $? > "$WORK/late-code"
kill "$watcher"
INNER
chmod +x "$inner"
export APP=$app HERE=$here WORK=$work
timeout 240 xvfb-run -a dbus-run-session -- "$inner" || true

for log in app watcher late-app late-watcher; do
  echo "--- $log"
  cat "$work/$log.log" 2> /dev/null || true
done
code=$(cat "$work/code" 2> /dev/null || echo 1)
late=$(cat "$work/late-code" 2> /dev/null || echo 1)

fail() {
  echo "Tray smoke: $1" >&2
  code=1
}
grep -q '^TRAY SMOKE PASS' "$work/app.log" || fail "no pass line"
grep -q '^registered ' "$work/watcher.log" || fail "the tray never registered"
grep -q '^title RChat$' "$work/watcher.log" || fail "the tray has no title"
grep -q '^tooltip .*| RChat (3)$' "$work/watcher.log" || fail "the tooltip has no unread count"
grep -q '^menu Open RChat standard on' "$work/watcher.log" || fail "no Open RChat item"
grep -q '^menu Mute notifications standard on 1$' "$work/watcher.log" || fail "Mute is not checked"
grep -q '^menu   Appear offline standard on 1$' "$work/watcher.log" || fail "Appear offline is not picked"
grep -q '^TRAY SMOKE CLICK left$' "$work/app.log" || fail "a left click did not reach the app"
grep -q '^TRAY SMOKE MENU tray-mute$' "$work/app.log" || fail "a menu click did not reach the app"
grep -q '^menu Mute notifications standard on 0$' "$work/watcher.log" || fail "Mute did not turn off"
grep -q '^TRAY SMOKE MENU tray-quit$' "$work/app.log" || fail "Quit did not reach the app"

[ "$late" = 0 ] || fail "the app that started before the tray host exited with $late"
grep -q '^TRAY SMOKE WAIT' "$work/late-app.log" || fail "the second app found a tray host at its start"
grep -q '^TRAY SMOKE PASS' "$work/late-app.log" || fail "no tray after the tray host came up"
grep -q '^registered ' "$work/late-watcher.log" || fail "the tray never registered with the late host"
echo "Tray smoke exit code: $code"
exit "$code"
