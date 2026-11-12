/**
 * 文件功能：默认 streamFn 的全局槽位。
 *
 * agent 核心（本包）不依赖任何 provider 目录或兼容层，所以“用哪家的流函数”由宿主注入：
 * coding-agent 在 sdk.ts 里调 setDefaultStreamFn(streamSimple)，测试里换成 faux provider。
 */
import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;

/**
 * 配置 Agent 与底层循环在调用方未传 streamFn 时使用的回退实现。
 *
 * 提供默认模型运行时的宿主可以在这里装上它的流函数，
 * 从而不让 pi-agent-core 依赖 provider 目录或兼容层。
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
