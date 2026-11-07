import chalk from "chalk";
import type { ExtensionMode, ProjectTrustContext } from "../core/extensions/types.ts";

/**
 * Project trust context for a headless server: no UI, so extensions must
 * decide from the event result and the stored/default trust setting.
 */
export function createProjectTrustContext(options: { cwd: string; mode: ExtensionMode }): ProjectTrustContext {
	return {
		cwd: options.cwd,
		mode: options.mode,
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message, type = "info") => {
				const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
				console.error(color(message));
			},
		},
	};
}
