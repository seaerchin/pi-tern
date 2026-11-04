#!/bin/sh
# Starts an isolated headless Tern, opens an agent block running the native
# launcher, and prints the scratch dir. Parallel runs need distinct RC_LAST files.
#   render-check.sh start [extra pi args...]   -> prints W, also in $RC_LAST (default /tmp/pi-tern-rc.last)
# Don't call start inside $(...): serve keeps the pipe open.
#   render-check.sh ctl W <tern ctl args...>
#   render-check.sh stop W
set -eu
TERN=/Applications/Tern.app/Contents/MacOS/tern
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
LAST=${RC_LAST:-/tmp/pi-tern-rc.last}

case "$1" in
start)
	shift
	W=$(mktemp -d /tmp/pi-tern-rc.XXXX)
	mkdir -p "$W/cfg" "$W/shots" "$W/work"
	{
		echo '#!/bin/sh'
		echo "export PI_TERN_NATIVE_BLOCK=force PI_TERN_TSP_RECORD=$W/tsp.jsonl PI_TERN_TREE_LOG=$W/tree.log PI_TERN_GAP_LOG=$W/gap.log"
		[ -n "${PI_TERN_SEMANTIC:-}" ] && echo "export PI_TERN_SEMANTIC=$PI_TERN_SEMANTIC"
		printf 'exec node %s/native/pi-tern.mjs' "$ROOT"
		for a in "$@"; do printf " '%s'" "$a"; done
		echo " 2>>$W/launcher.err"
	} >"$W/launch.sh"
	chmod +x "$W/launch.sh"
	(cd "$W/work" && TERN_CONFIG_DIR=$W/cfg TERN_DAEMON_SOCKET=$W/daemon.sock nohup "$TERN" serve --control "$W/ctl.sock" --out "$W/shots" </dev/null >"$W/serve.log" 2>&1 &)
	i=0
	until "$TERN" ctl --control "$W/ctl.sock" stats >/dev/null 2>&1; do
		i=$((i + 1)); [ $i -gt 60 ] && { echo "serve did not start" >&2; exit 1; }
		sleep 0.5
	done
	"$TERN" ctl --control "$W/ctl.sock" agent-command "$W/launch.sh" >/dev/null 2>&1
	"$TERN" ctl --control "$W/ctl.sock" block agent >/dev/null 2>&1 || true
	echo "$W" >"$LAST"
	echo "$W"
	;;
ctl)
	W=$2; shift 2
	"$TERN" ctl --control "$W/ctl.sock" "$@" 2>&1 | grep '^<\|^{' | tail -1
	;;
stop)
	W=$2
	"$TERN" ctl --control "$W/ctl.sock" quit >/dev/null 2>&1 || true
	sleep 1
	pkill -f "$W" 2>/dev/null || true
	;;
esac
