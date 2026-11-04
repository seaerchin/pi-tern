#!/bin/sh
# Starts an isolated headless Tern, opens an agent block running the native
# launcher, and prints the scratch dir. Parallel runs need distinct RC_LAST files.
#   render-check.sh start [extra pi args...]   -> prints W, also in $RC_LAST (default /tmp/pi-tern-rc.last)
# The agent block runs native/pi-tern-agent.mjs, as Tern's agent_command would, so no force variable.
# $W/shell.sh runs the plain launcher. Type it into the shell block to check Pi's terminal interface there.
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
	mkdir -p "$W/cfg" "$W/shots" "$W/work" "$W/bridge"
	# pi-bridge goes into this config and mailbox only, so a pane.kind ask never reaches the user's
	# real window. serve on 0.9.10 loads no plugin window entries, so the ask goes unanswered.
	node --experimental-strip-types --input-type=module -e '
		import { writeFileSync } from "node:fs";
		const { BRIDGE_PLUGIN_TOML, BRIDGE_WINDOW_LUAU } = await import(process.argv[1]);
		writeFileSync(`${process.argv[2]}/plugin.toml`, BRIDGE_PLUGIN_TOML);
		writeFileSync(`${process.argv[2]}/window.luau`, BRIDGE_WINDOW_LUAU);
	' "$ROOT/lib/bridge-plugin.ts" "$W/bridge"
	TERN_CONFIG_DIR=$W/cfg TERN_DAEMON_SOCKET=$W/daemon.sock "$TERN" plugin link "$W/bridge" >/dev/null
	{
		echo '#!/bin/sh'
		echo "export PI_TERN_BRIDGE_DIR=$W/bridge PI_TERN_TSP_RECORD=$W/tsp.jsonl PI_TERN_TREE_LOG=$W/tree.log PI_TERN_GAP_LOG=$W/gap.log"
		[ -n "${PI_TERN_SEMANTIC:-}" ] && echo "export PI_TERN_SEMANTIC=$PI_TERN_SEMANTIC"
		printf 'exec node %s/native/pi-tern-agent.mjs' "$ROOT"
		for a in "$@"; do printf " '%s'" "$a"; done
		echo " 2>>$W/launcher.err"
	} >"$W/launch.sh"
	{
		echo '#!/bin/sh'
		echo "export PI_TERN_BRIDGE_DIR=$W/bridge PI_TERN_TSP_RECORD=$W/tsp-shell.jsonl"
		printf 'exec node %s/native/pi-tern.mjs' "$ROOT"
		for a in "$@"; do printf " '%s'" "$a"; done
		echo " 2>>$W/launcher-shell.err"
	} >"$W/shell.sh"
	chmod +x "$W/launch.sh" "$W/shell.sh"
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
