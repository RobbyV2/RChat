#!/bin/sh
set -e

export HOSTNAME="${FRONTEND_HOST:-127.0.0.1}"

peer() {
    cd /app/peer && bunx peer --port "${PEERJS_PORT:-9001}" --path /peerjs 2>&1 | {
        case "${RUST_LOG:-info}" in
            *debug* | *trace*) cat ;;
            *) grep --line-buffered -vE "Client (dis)?connected:" ;;
        esac
    }
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
        peer_default=on
        if [ "$APP_MODE" = "api-only" ]; then web=off; else web=on; fi
        ;;
    *,all,*) peer_default=on web=on ;;
    *,web,*) peer_default=off web=on ;;
    *) peer_default=off web=off ;;
esac
case "${RCHAT_PEERJS:-$peer_default}" in
    1 | true | on | yes) with_peer=on ;;
    *) with_peer=off ;;
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
