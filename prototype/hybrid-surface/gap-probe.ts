// PROTOTYPE, throwaway. Produces transcript items that may have no session event (issue #8).
export default function (pi: any) {
	pi.registerEntryRenderer("gap-probe-card", (entry: any) => ({
		render: () => [`[gap-probe-card] ${JSON.stringify(entry.data)}`],
		invalidate() {},
	}));
	pi.registerCommand("gapprobe", {
		description: "PROTOTYPE: emit gap-probe items",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify("gap-probe info notice", "info");
			ctx.ui.notify("gap-probe warning notice", "warning");
			ctx.ui.notify("gap-probe error notice", "error");
			pi.appendEntry("gap-probe-card", { title: "probe entry", count: 1 });
			pi.sendMessage({ customType: "gap-probe-msg", content: "gap-probe custom message", display: true });
		},
	});
}
