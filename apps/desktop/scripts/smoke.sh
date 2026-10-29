#!/usr/bin/env bash
# Smoke run of the Linux desktop app: builds a debug app with the smoke hook, runs it on a virtual
# display against a running instance, opened through an rchat:// link, and exits with its
# verdict. Saves go to a temp folder and are checked afterwards.
# Usage: apps/desktop/scripts/smoke.sh http://localhost:3000 [screenshot.png]
# Needs xvfb-run (and ImageMagick `import` for the screenshot), or a KDE kwin_wayland (and
# spectacle for the screenshot).
set -euo pipefail

instance=${1:?usage: smoke.sh <instance-url> [screenshot.png]}
shot=${2:-}
if ! [[ $instance =~ ^https?://[A-Za-z0-9.:-]+/?$ ]]; then
  echo "Instance must be a plain http(s) origin, got: $instance" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
app=$root/target/debug/rchat
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ "${SMOKE_SKIP_BUILD:-}" != 1 ]; then
  (cd "$here/../src-tauri" && cargo tauri build --debug --no-bundle --features smoke)
fi

{
  printf "var SMOKE_INSTANCE = '%s';\nvar SMOKE_HOLD = %s;\n" "$instance" "${SMOKE_HOLD:-3}"
  cat "$here/smoke.js"
} > "$work/smoke.js"

export RCHAT_SMOKE=$work/smoke.js
export XDG_CONFIG_HOME=$work/config XDG_DATA_HOME=$work/data XDG_CACHE_HOME=$work/cache
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export RCHAT_SMOKE_SAVE=$work/saves
mkdir "$RCHAT_SMOKE_SAVE"
host=${instance#*://}
link=rchat://${host%/}/

inner=$work/inner.sh
cat > "$inner" <<'INNER'
#!/usr/bin/env bash
set -u
"$APP" "$LINK" &
pid=$!
if [ -n "$SHOT" ]; then
  sleep "${SMOKE_SHOT_AT:-12}"
  $GRAB "$SHOT" || echo "screenshot failed" >&2
fi
wait $pid
code=$?
echo $code > "$WORK/code"
exit $code
INNER
chmod +x "$inner"
export APP=$app LINK=$link SHOT=$shot WORK=$work

if command -v xvfb-run > /dev/null; then
  export GDK_BACKEND=x11 GRAB="import -window root"
  timeout 120 xvfb-run -a -s "-screen 0 1280x860x24" dbus-run-session -- "$inner" || true
elif command -v kwin_wayland > /dev/null; then
  export XDG_RUNTIME_DIR=$work/runtime GDK_BACKEND=wayland GRAB="spectacle -b -n -f -o"
  mkdir -m 700 "$XDG_RUNTIME_DIR"
  unset DISPLAY
  kwin="kwin_wayland --virtual --width 1280 --height 860 --socket rchat-smoke --no-lockscreen --no-global-shortcuts"
  timeout 120 dbus-run-session -- bash -c "$kwin --exit-with-session '$inner' 2> '$work/kwin.log'" < /dev/null || true
else
  echo "Need xvfb-run or kwin_wayland for a virtual display" >&2
  exit 2
fi

code=$(cat "$work/code" 2> /dev/null || echo 1)
saved=$(cd "$RCHAT_SMOKE_SAVE" && ls -A)
if [ "$code" = 0 ] && { [ "$saved" != smoke.txt ] || [ "$(cat "$RCHAT_SMOKE_SAVE/smoke.txt")" != "hello world" ]; }; then
  echo "Saves left: $saved" >&2
  code=1
fi
echo "Smoke run exit code: $code"
exit "$code"
