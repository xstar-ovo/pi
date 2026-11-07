// Registers the llama.cpp provider. Model management was a TUI command and is gone with the frontend.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { createLlamaProvider } from "./provider.ts";

export default function llamaExtension(pi: ExtensionAPI): void {
	const provider = createLlamaProvider();
	pi.registerProvider(provider.provider);
}
