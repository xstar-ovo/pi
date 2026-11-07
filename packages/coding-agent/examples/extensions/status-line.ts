/**
 * Status Line Extension
 *
 * Demonstrates ctx.ui.setStatus() for displaying persistent status text in the footer.
 * Shows turn progress in the status slot.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnCount = 0;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("status-demo", "Ready");
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		ctx.ui.setStatus("status-demo", `● Turn ${turnCount}...`);
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("status-demo", `✓ Turn ${turnCount} complete`);
	});
}
