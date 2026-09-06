import stringWidth from 'string-width';

type Position = {row: number; column: number};
type Options = {
	getSize: () => {columns: number; rows: number};
	write: (text: string) => void;
	reserve: () => boolean;
	onResult: (supported: boolean) => void;
};

/** Whether pending Ink output will overwrite the one-cell probe at column 1. */
export const canOverwriteFirstCell = (text: string): boolean => {
	let remaining = text;
	while (remaining.startsWith('\u001B')) {
		// Only rendition controls are safe here. Do not treat arbitrary CSI/OSC
		// payloads as evidence that Ink will overwrite the reserved cell.
		const prefix =
			/^(?:\u001B\[[\d;:]*m|\u001B\]8;[^\u001B\u0007\r\n]*(?:\u001B\\|\u0007))/.exec(
				remaining,
			);
		if (!prefix) return false;
		remaining = remaining.slice(prefix[0].length);
	}
	if (!/^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]/u.test(remaining)) return false;
	const first = new Intl.Segmenter(undefined, {granularity: 'grapheme'})
		.segment(remaining)
		[Symbol.iterator]()
		.next().value;
	return first !== undefined && stringWidth(first.segment) > 0;
};

/** One bounded, per-instance negotiation. Ink owns pending frames and raw input. */
export class ExplicitWidthDetection {
	private phase:
		'idle' | 'waiting' | 'first' | 'second' | 'settling' | 'settled' = 'idle';
	private inputReady = false;
	private firstRow = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private deadline?: number;
	private writing = false;
	private deferredResult?: boolean;
	private readonly replies: Position[] = [];
	private readonly settlementCallbacks: Array<() => void> = [];
	private resolveFinished!: () => void;
	readonly finished = new Promise<void>(resolve => {
		this.resolveFinished = resolve;
	});

	private readonly options: Options;

	constructor(options: Options) {
		this.options = options;
	}

	get pending(): boolean {
		return this.phase !== 'idle' && this.phase !== 'settled';
	}

	get settled(): boolean {
		return this.phase === 'settled';
	}

	get publicationBlocked(): boolean {
		return this.writing || this.phase === 'settling';
	}

	onSettled(callback: () => void): void {
		if (this.settled) {
			callback();
			return;
		}
		this.settlementCallbacks.push(callback);
	}

	start(): void {
		if (this.phase !== 'idle') return;
		this.phase = 'waiting';
		this.deadline = Date.now() + 200;
		this.timer = setTimeout(() => this.cancel(), 200);
		this.queryIfReady();
	}

	setInputReady(ready: boolean): void {
		if (!ready && this.inputReady) this.cancel();
		this.inputReady = ready;
		this.queryIfReady();
	}

	accept(position: Position): void {
		if (this.writing) {
			// There are only two outstanding measurements. Keep synchronous
			// stream callbacks bounded and process them after the full write.
			if (this.replies.length < 2) this.replies.push(position);
			return;
		}
		if (this.phase !== 'first' && this.phase !== 'second') return;
		if (this.expired()) {
			this.cancel();
			return;
		}
		const {columns, rows} = this.options.getSize();
		const {row, column} = position;
		if (
			!Number.isInteger(row) ||
			!Number.isInteger(column) ||
			row < 1 ||
			row > rows ||
			column < 1 ||
			column > columns
		) {
			this.cancel();
			return;
		}
		if (this.phase === 'second') {
			this.finish(row === this.firstRow && column === 2);
			return;
		}
		if (
			column !== 1 ||
			columns < 2 ||
			!this.options.reserve() ||
			this.expired()
		) {
			this.cancel();
			return;
		}
		this.firstRow = row;
		this.phase = 'second';
		this.send('\u001B]66;w=1; \u001B\\\u001B[?6n\r');
	}

	cancel(): void {
		this.finish(false);
	}

	private expired(): boolean {
		return this.deadline !== undefined && Date.now() >= this.deadline;
	}

	private queryIfReady(): void {
		if (this.phase !== 'waiting' || !this.inputReady) return;
		if (this.expired()) {
			this.cancel();
			return;
		}
		this.phase = 'first';
		this.send('\u001B[?6n');
	}

	private send(text: string): void {
		this.writing = true;
		try {
			this.options.write(text);
		} catch {
			this.cancel();
		} finally {
			this.writing = false;
		}
		if (this.deferredResult !== undefined) {
			const result = this.deferredResult;
			this.deferredResult = undefined;
			this.publish(result);
		}
		while (this.replies.length > 0) this.accept(this.replies.shift()!);
	}

	private finish(supported: boolean): void {
		if (this.phase === 'settling' || this.settled) return;
		this.phase = 'settling';
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.writing) {
			this.deferredResult = supported;
			return;
		}
		this.publish(supported);
	}

	private publish(supported: boolean): void {
		try {
			this.options.onResult(supported);
		} finally {
			this.phase = 'settled';
			try {
				for (const callback of this.settlementCallbacks.splice(0)) callback();
			} finally {
				this.resolveFinished();
			}
		}
	}
}
