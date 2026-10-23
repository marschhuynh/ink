import {Readable} from 'node:stream';

/** A real readable/UTF-8 pipeline with the TTY ownership methods used by App. */
export default class ReadableStdin extends Readable {
	// eslint-disable-next-line @typescript-eslint/naming-convention -- Match the Node TTY stream property.
	isTTY = true;
	isRaw = false;
	override _read() {}
	setRawMode(raw: boolean) {
		this.isRaw = raw;
		return this;
	}

	ref() {
		return this;
	}

	unref() {
		return this;
	}
}
