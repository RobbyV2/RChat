#!/bin/sh
set -e

export HOSTNAME="${FRONTEND_HOST:-127.0.0.1}"

case "${DATABASE_URL:-}" in
    postgres:* | postgresql:* | "") ;;
    *)
        data=$(dirname "${DATABASE_URL#sqlite:}")
        if [ -d "$data" ] && [ ! -w "$data" ]; then
            echo "$data is not writable by user $(id -u). Volumes made by images before 0.3.0 belong to root; fix once with: docker run --rm -u 0 -v <volume>:$data --entrypoint chown <image> -R 10001:10001 $data" >&2
            exit 1
        fi
        ;;
esac

peer() {
    cd /app/peer && bun server.mjs
}

if [ "$1" = "peer" ]; then
    peer &
    PEER_PID=$!
    trap 'kill $PEER_PID 2>/dev/null; exit 0' TERM INT
    wait $PEER_PID
    exit
fi

roles=$(printf '%s' "${RCHAT_ROLES:-}" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
case ",$roles," in
    ,,)
        single=on
        if [ "${APP_MODE:-}" = "api-only" ]; then web=off; else web=on; fi
        ;;
    *,all,*) single=on web=on ;;
    *,web,*) single=off web=on ;;
    *) single=off web=off ;;
esac
# The server answers /peerjs itself. The separate PeerJS server runs next to it only when
# RCHAT_PEERJS says so, or when the settings of a single process ask for it (PEERJS_BUILTIN
# off, or PEERJS_PORT, PUBLIC_PEERJS_URL or the web build's NEXT_PUBLIC_PEERJS_* set).
with_peer=off
case "${RCHAT_PEERJS:-}" in
    1 | true | on | yes) with_peer=on ;;
    "")
        if [ "$single" = on ] && (cd /app/peer && bun server.mjs --wanted); then
            with_peer=on
        fi
        ;;
    *) ;;
esac

if [ "$with_peer" = off ] && [ "$web" = off ]; then
    exec ./server
fi

set --
if [ "$with_peer" = on ]; then
    peer &
    set -- "$@" "$!"
fi
if [ "$web" = on ]; then
    bun server.js &
    set -- "$@" "$!"
    sleep 1
fi
./server &
SERVER_PID=$!
trap 'kill -TERM $SERVER_PID 2>/dev/null' TERM INT
status=0
wait $SERVER_PID || status=$?
while kill -0 $SERVER_PID 2>/dev/null; do
    status=0
    wait $SERVER_PID || status=$?
done
kill "$@" 2>/dev/null || true
exit $status
