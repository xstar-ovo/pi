/**
 * 文件功能：异步事件流 —— 生产者 push，消费者 for await，最终值可单独 result() await。
 *
 * 一个约 135 行的类解决三件事（阶段 B 的事件传输就靠它）：
 *   1. 生产者与消费者解耦：有消费者在等就直接给，否则排队
 *   2. 最终结果通过 result() 单独 await，不用消费完全部事件
 *   3. 结束后不丢已入队事件
 *
 * 自己用 async generator 手写这个，很容易写成丢事件或死锁。
 */
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// 通用的异步迭代事件流类
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	protected done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// 有消费者在等就交给它，否则入队
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// 通知所有等待中的消费者：结束了
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/**
 * 单次 assistant 回复的事件流。它同时给这次回复计时：最终消息（`done` 或 `error` 事件，或传给 `end()` 的结果）
 * 会带上 `durationMs`，用单调时钟从流创建时开始计；但若消息已有该字段，或它的 `timestamp` 早于流的创建时间，
 * 就不计时。因此“把别处已经开始的回复转发过来”的流（例如稍后才拿到的延时结果）不会被误计入耗时。
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	readonly #startedAt = Date.now();
	readonly #startedAtMonotonic = performance.now();

	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (event.type === "done") this.#time(event.message);
		else if (event.type === "error") this.#time(event.error);
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		if (result !== undefined) this.#time(result);
		super.end(result);
	}

	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#startedAt) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.#startedAtMonotonic));
	}
}

/** AssistantMessageEventStream 的工厂函数（供扩展使用） */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
