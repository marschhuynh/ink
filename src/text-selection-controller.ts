/* eslint-disable @typescript-eslint/no-restricted-types --
   The public selection API uses null (matching React ref idioms and the
   mouse bridge in ink-input); keep it consistent throughout this file. */
import stringWidth from 'string-width';
import {
	extractTextFromRows,
	getSelectionSpans,
	type SelectionRow,
	type TextSelectionPoint,
	type TextSelectionSpan,
} from './text-selection.js';

/**
Live viewport of the selection container, in Ink output grid cells.
*/
export type SelectionViewport = {
	top: number;
	left: number;
	width: number;
	height: number;
	/** Vertical scroll offset in rendered rows: content row shown at `top`. */
	scrollY: number;
};

export type TextSelectionSnapshot = {
	/** Content coordinates (see TextSelectionPoint). */
	anchor: TextSelectionPoint | null;
	focus: TextSelectionPoint | null;
	isDragging: boolean;
	text: string;
	isEmpty: boolean;
};

export type TextSelectionActions = {
	/**
	Points passed to start/update are 0-based SCREEN cells on the Ink output
	grid; the controller converts to content space via the viewport provider.
	*/
	start: (screenPoint: {x: number; y: number}) => void;
	update: (screenPoint: {x: number; y: number}) => void;
	finish: () => void;
	clear: () => void;
	/**
	Registered by the mouse bridge. Providers stack: the most recently
	registered one is active (e.g. a modal's selection area over the main
	list's), and the returned unregister function restores the previous one.
	A provider returning null means "bounds not measurable this frame".
	*/
	registerViewportProvider: (
		provider: () => SelectionViewport | null,
	) => () => void;
	/**
	Single-slot convenience over registerViewportProvider: replaces the
	provider set by the previous call (null unregisters it). Prefer
	registerViewportProvider where mounts can overlap.
	*/
	setViewportProvider: (
		provider: (() => SelectionViewport | null) | null,
	) => void;
};

/**
Selection actions plus an imperative snapshot read. Unlike the snapshot from
`useTextSelection()`, holding this handle does NOT subscribe the component to
selection changes — use it where selection state is only needed at event time
(mouse bridges, key handlers) so drags never re-render the host component.
*/
export type TextSelectionHandle = TextSelectionActions & {
	getSnapshot: () => TextSelectionSnapshot;
};

const fullGridViewport: SelectionViewport = {
	top: 0,
	left: 0,
	width: Number.POSITIVE_INFINITY,
	height: Number.POSITIVE_INFINITY,
	scrollY: 0,
};

/**
Framework-agnostic selection state owned by an Ink instance. Selection points
live in content space (container-relative rows that survive scrolling); the
viewport provider converts screen ↔ content at event time and paint time.
*/
export class TextSelectionController {
	/** Wired by Ink to schedule a repaint when the highlight must change. */
	onInvalidate?: () => void;

	private anchor: TextSelectionPoint | null = null;
	private focus: TextSelectionPoint | null = null;
	private isDragging = false;
	private text = '';
	private readonly rowCache = new Map<number, SelectionRow>();
	// Stack of registered providers; the last entry is active. Stacking lets
	// an overlay (tool detail modal) take over selection while mounted and
	// hand coordinates back to the underlying list on unmount.
	private readonly viewportProviders: Array<() => SelectionViewport | null> =
		[];

	private legacyProviderUnregister: (() => void) | null = null;
	// Last viewport a registered provider returned. Reused for one-frame gaps
	// where the provider returns null (e.g. bounds momentarily 0 mid-re-render),
	// so the highlight doesn't flash to full-grid coordinates and the frozen
	// row cache isn't compared against a differently-sliced viewport.
	private lastViewport: SelectionViewport | null = null;

	private readonly listeners = new Set<() => void>();
	private snapshot: TextSelectionSnapshot | undefined;
	private notifyScheduled = false;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): TextSelectionSnapshot => {
		this.snapshot ??= {
			anchor: this.anchor,
			focus: this.focus,
			isDragging: this.isDragging,
			text: this.text,
			isEmpty: this.text.length === 0,
		};

		return this.snapshot;
	};

	registerViewportProvider = (
		provider: () => SelectionViewport | null,
	): (() => void) => {
		this.viewportProviders.push(provider);
		// The coordinate space changed under any live selection; drop it
		// rather than paint it through the wrong viewport, and forget the
		// previous provider's cached viewport.
		this.lastViewport = null;
		if (this.anchor !== null) {
			this.clear();
		}

		return () => {
			const index = this.viewportProviders.indexOf(provider);
			if (index === -1) {
				return;
			}

			this.viewportProviders.splice(index, 1);
			this.lastViewport = null;
			if (this.anchor !== null) {
				this.clear();
			}
		};
	};

	setViewportProvider = (
		provider: (() => SelectionViewport | null) | null,
	): void => {
		this.legacyProviderUnregister?.();
		this.legacyProviderUnregister = provider
			? this.registerViewportProvider(provider)
			: null;
	};

	start = (screenPoint: {x: number; y: number}): void => {
		const point = this.toContentPoint(screenPoint);
		this.anchor = point;
		this.focus = point;
		this.isDragging = true;
		this.recomputeText();
		this.emit();
		this.onInvalidate?.();
	};

	update = (screenPoint: {x: number; y: number}): void => {
		if (!this.anchor) {
			return;
		}

		const point = this.toContentPoint(screenPoint);
		const focusChanged = this.focus?.x !== point.x || this.focus.y !== point.y;
		this.focus = point;
		const textChanged = this.recomputeText();

		if (focusChanged || textChanged) {
			this.emit();
			this.onInvalidate?.();
		}
	};

	finish = (): void => {
		if (!this.isDragging) {
			return;
		}

		this.isDragging = false;
		this.emit();
	};

	clear = (): void => {
		const hadSelection =
			this.anchor !== null || this.text.length > 0 || this.isDragging;
		this.anchor = null;
		this.focus = null;
		this.isDragging = false;
		this.text = '';
		this.rowCache.clear();

		if (hadSelection) {
			this.emit();
			this.onInvalidate?.();
		}
	};

	/**
	Called from the renderer's paint hook on every render of the main output.
	Caches visible rows under content-row keys. Never invalidates synchronously
	— it runs during a render pass and must not schedule another render.

	While dragging, cache entries update freely (auto-scroll depends on it).
	After `finish()`, the cache is frozen: existing entries are never
	overwritten, so extracted text is immutable. If a visible row inside the
	selected range no longer matches its frozen entry (content reflowed
	underneath the selection), the selection auto-clears.
	*/
	captureRows = (
		plainRows: readonly string[],
		maskRows?: ReadonlyArray<readonly boolean[]>,
	): void => {
		const resolved = this.resolveViewport();

		// A registered provider that returns null means the container's bounds are
		// not measurable this frame (transient during a re-render). Capturing or
		// comparing against the full-grid fallback would corrupt the cache and
		// spuriously auto-clear a finished selection. Skip the frame instead.
		if (!resolved.available && this.anchor !== null) {
			return;
		}

		const {viewport} = resolved;
		const top = Math.max(0, viewport.top);
		const left = Math.max(0, viewport.left);
		const bottom = Math.min(plainRows.length, viewport.top + viewport.height);

		const hasSelection = this.anchor !== null && this.focus !== null;
		const frozen = hasSelection && !this.isDragging;

		// Without a selection there is nothing to preserve: reset the cache to
		// the currently visible rows so a subsequent start() has fresh data and
		// stale rows from earlier scroll positions don't accumulate.
		if (!hasSelection) {
			this.rowCache.clear();
		}

		let mismatch = false;
		const range = hasSelection
			? (() => {
					const [a, b] = [this.anchor!, this.focus!];
					return a.y <= b.y ? {min: a.y, max: b.y} : {min: b.y, max: a.y};
				})()
			: undefined;

		for (let y = top; y < bottom; y++) {
			const contentY = viewport.scrollY + (y - viewport.top);
			const text = sliceRow(plainRows[y] ?? '', left, viewport.width);
			const mask = maskRows
				? sliceMask(maskRows[y], left, viewport.width)
				: undefined;
			const row: SelectionRow = {text, mask};

			const existing = this.rowCache.get(contentY);

			if (frozen && existing) {
				if (
					range &&
					contentY >= range.min &&
					contentY <= range.max &&
					existing.text !== text
				) {
					mismatch = true;
					break;
				}

				continue;
			}

			this.rowCache.set(contentY, row);
		}

		if (mismatch) {
			// Content reflowed underneath a finished selection: clearing is the
			// only honest option. Defer the notification outside the render pass.
			this.anchor = null;
			this.focus = null;
			this.isDragging = false;
			this.text = '';
			this.rowCache.clear();
			this.snapshot = undefined;
			this.scheduleNotify(true);
			return;
		}

		if (hasSelection && !frozen && this.recomputeText()) {
			this.scheduleNotify(false);
		} else if (
			hasSelection &&
			frozen &&
			this.text.length === 0 && // Rows may have arrived only after the gesture ended.
			this.recomputeText()
		) {
			this.scheduleNotify(false);
		}
	};

	/**
	Convert the selection's content spans to screen spans using the current
	viewport. Rows outside the viewport or the grid are dropped (they are
	still part of the extracted text).
	*/
	getPaintSpans = (
		outputWidth: number,
		outputHeight: number,
	): TextSelectionSpan[] => {
		if (!this.anchor || !this.focus) {
			return [];
		}

		const {viewport} = this.resolveViewport();
		const spans = getSelectionSpans(this.anchor, this.focus, y =>
			this.rowCache.get(y),
		);

		const left = Math.max(0, viewport.left);
		const right = Math.min(outputWidth, viewport.left + viewport.width);
		const screenTop = Math.max(0, viewport.top);
		const screenBottom = Math.min(outputHeight, viewport.top + viewport.height);

		const result: TextSelectionSpan[] = [];

		for (const span of spans) {
			const screenY = viewport.top + (span.y - viewport.scrollY);
			if (screenY < screenTop || screenY >= screenBottom) {
				continue;
			}

			const x1 = Math.max(left, viewport.left + span.x1);
			const x2 = Math.min(right, viewport.left + span.x2);
			if (x2 <= x1) {
				continue;
			}

			result.push({y: screenY, x1, x2});
		}

		return result;
	};

	private resolveViewport(): {
		viewport: SelectionViewport;
		available: boolean;
	} {
		const provider = this.viewportProviders.at(-1);
		if (!provider) {
			// No scroll container: the whole grid is the viewport.
			return {viewport: fullGridViewport, available: true};
		}

		const current = provider();
		if (current) {
			this.lastViewport = current;
			return {viewport: current, available: true};
		}

		// Provider registered but bounds unavailable this frame. Reuse the last
		// known viewport so the highlight stays put; report unavailable so
		// captureRows skips the frame.
		return {
			viewport: this.lastViewport ?? fullGridViewport,
			available: false,
		};
	}

	private toContentPoint(screenPoint: {
		x: number;
		y: number;
	}): TextSelectionPoint {
		const {viewport} = this.resolveViewport();
		const maxX =
			viewport.width === Number.POSITIVE_INFINITY
				? Number.POSITIVE_INFINITY
				: viewport.left + viewport.width - 1;
		const maxY =
			viewport.height === Number.POSITIVE_INFINITY
				? Number.POSITIVE_INFINITY
				: viewport.top + viewport.height - 1;

		const x = Math.min(Math.max(screenPoint.x, viewport.left), maxX);
		const y = Math.min(Math.max(screenPoint.y, viewport.top), maxY);

		return {
			x: x - viewport.left,
			y: y - viewport.top + viewport.scrollY,
		};
	}

	/** Returns true when the extracted text changed. */
	private recomputeText(): boolean {
		const next =
			this.anchor && this.focus
				? extractTextFromRows(this.anchor, this.focus, y =>
						this.rowCache.get(y),
					)
				: '';

		if (next === this.text) {
			return false;
		}

		this.text = next;
		return true;
	}

	private emit(): void {
		this.snapshot = undefined;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private scheduleNotify(invalidate: boolean): void {
		this.snapshot = undefined;

		if (this.notifyScheduled) {
			return;
		}

		this.notifyScheduled = true;
		queueMicrotask(() => {
			this.notifyScheduled = false;
			for (const listener of this.listeners) {
				listener();
			}

			if (invalidate) {
				this.onInvalidate?.();
			}
		});
	}
}

// Slice a row by display cells, not string indices, so wide characters keep
// the text aligned with the cell-indexed mask. A wide glyph straddling the
// viewport edge is replaced by spaces for the cells that remain visible.
const sliceRow = (row: string, left: number, width: number): string => {
	if (left === 0 && width === Number.POSITIVE_INFINITY) {
		return row.trimEnd();
	}

	const right =
		width === Number.POSITIVE_INFINITY
			? Number.POSITIVE_INFINITY
			: left + width;
	let cell = 0;
	let result = '';

	for (const char of row) {
		const charWidth = Math.max(1, stringWidth(char));
		const start = cell;
		const end = cell + charWidth;
		cell = end;

		if (end <= left) {
			continue;
		}

		if (start >= right) {
			break;
		}

		result +=
			start >= left && end <= right
				? char
				: ' '.repeat(Math.min(end, right) - Math.max(start, left));
	}

	return result.trimEnd();
};

const sliceMask = (
	mask: readonly boolean[] | undefined,
	left: number,
	width: number,
): readonly boolean[] | undefined => {
	if (!mask) {
		return undefined;
	}

	return width === Number.POSITIVE_INFINITY
		? mask.slice(left)
		: mask.slice(left, left + width);
};
