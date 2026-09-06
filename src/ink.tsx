import process from 'node:process';
import React, {type ReactNode} from 'react';
import {throttle, type DebouncedFunc} from 'es-toolkit/compat';
import ansiEscapes from 'ansi-escapes';
import isInCi from 'is-in-ci';
import autoBind from 'auto-bind';
import signalExit from 'signal-exit';
import patchConsole from 'patch-console';
import {LegacyRoot, ConcurrentRoot} from 'react-reconciler/constants.js';
import {type FiberRoot} from 'react-reconciler';
import Yoga from 'yoga-layout';
import wrapAnsi from 'wrap-ansi';
import widestLine from 'widest-line';
import {getWindowSize} from './utils.js';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import {hideCursorEscape, showCursorEscape} from './cursor-helpers.js';
import logUpdate, {type LogUpdate, type CursorPosition} from './log-update.js';
import {createExplicitWidthEncoder} from './explicit-width.js';
import {
	ExplicitWidthDetection,
	canOverwriteFirstCell,
} from './explicit-width-detection.js';
import {type TerminalResponse} from './input-parser.js';
import {bsu, esu, shouldSynchronize} from './write-synchronized.js';
import instances from './instances.js';
import {TextSelectionController} from './text-selection-controller.js';
import App from './components/App.js';
import {accessibilityContext as AccessibilityContext} from './components/AccessibilityContext.js';
import {
	type KittyKeyboardOptions,
	type KittyFlagName,
	resolveFlags,
} from './kitty-keyboard.js';

const noop = () => {};

const yieldImmediate = async () =>
	new Promise<void>(resolve => {
		setImmediate(resolve);
	});

const shouldClearTerminalForFrame = ({
	isTty,
	viewportRows,
	previousViewportRows,
	previousOutputHeight,
	nextOutputHeight,
	isUnmounting,
}: {
	isTty: boolean;
	viewportRows: number;
	previousViewportRows: number;
	previousOutputHeight: number;
	nextOutputHeight: number;
	isUnmounting: boolean;
}): boolean => {
	if (!isTty) {
		return false;
	}

	const hadPreviousFrame = previousOutputHeight > 0;
	const viewportChanged = previousViewportRows !== viewportRows;
	const wasFullscreen = previousOutputHeight >= previousViewportRows;
	const wasOverflowing = previousOutputHeight > previousViewportRows;
	const isOverflowing = nextOutputHeight > viewportRows;
	const isLeavingFullscreenFromContent =
		wasFullscreen &&
		nextOutputHeight < viewportRows &&
		(!viewportChanged || nextOutputHeight < previousOutputHeight);
	const shouldClearPreviousOverflow = wasOverflowing && !viewportChanged;
	const shouldClearOnUnmount = isUnmounting && wasFullscreen;

	return (
		shouldClearPreviousOverflow ||
		(isOverflowing && hadPreviousFrame) ||
		isLeavingFullscreenFromContent ||
		shouldClearOnUnmount
	);
};

const shouldRepaintForViewportTransition = ({
	isTty,
	previousViewportRows,
	viewportRows,
	previousOutputHeight,
	nextOutputHeight,
}: {
	isTty: boolean;
	previousViewportRows: number;
	viewportRows: number;
	previousOutputHeight: number;
	nextOutputHeight: number;
}): boolean =>
	isTty &&
	previousOutputHeight > 0 &&
	viewportRows < previousViewportRows &&
	previousOutputHeight < previousViewportRows &&
	nextOutputHeight === viewportRows;

const getReflowedLineCount = (output: string, columns: number): number => {
	if (output === '') {
		return 0;
	}

	return wrapAnsi(output, columns, {
		trim: false,
		hard: true,
		wordWrap: false,
	}).split('\n').length;
};

const isOutputSoftWrapped = (
	output: string,
	columns: number,
	maxVisualWidth?: number,
): boolean => {
	if (output === '') {
		return false;
	}

	if (maxVisualWidth !== undefined) {
		return maxVisualWidth > columns;
	}

	return widestLine(output) > columns;
};

const isErrorInput = (value: unknown): value is Error => {
	return (
		value instanceof Error ||
		Object.prototype.toString.call(value) === '[object Error]'
	);
};

type MaybeWritableStream = NodeJS.WriteStream & {
	writable?: boolean;
	writableEnded?: boolean;
	destroyed?: boolean;
	writableLength?: number;
	_writableState?: unknown;
};

const getWritableStreamState = (stdout: MaybeWritableStream) => {
	const canWriteToStdout =
		!stdout.destroyed && !stdout.writableEnded && (stdout.writable ?? true);
	const hasWritableState =
		stdout._writableState !== undefined || stdout.writableLength !== undefined;

	return {
		canWriteToStdout,
		hasWritableState,
	};
};

const settleThrottle = (
	throttled: unknown,
	canWriteToStdout: boolean,
): void => {
	if (
		!throttled ||
		typeof (throttled as {flush?: unknown}).flush !== 'function'
	) {
		return;
	}

	const throttledValue = throttled as {
		flush: () => void;
		cancel?: () => void;
	};

	if (canWriteToStdout) {
		throttledValue.flush();
	} else if (typeof throttledValue.cancel === 'function') {
		throttledValue.cancel();
	}
};

/**
Performance metrics for a render operation.
*/
export type RenderMetrics = {
	/**
	Number of terminal rows in the rendered frame.
	*/
	outputHeight: number;

	/**
	Number of UTF-16 code units in the rendered frame string.
	*/
	outputLength: number;

	/**
	Time spent rendering in milliseconds.
	*/
	renderTime: number;
};

type PendingFrame = {
	output: string;
	outputHeight: number;
	staticOutput: string;
	maxVisualWidth?: number;
};

export type Options = {
	stdout: NodeJS.WriteStream;
	stdin: NodeJS.ReadStream;
	stderr: NodeJS.WriteStream;
	debug: boolean;
	exitOnCtrlC: boolean;
	patchConsole: boolean;
	onRender?: (metrics: RenderMetrics) => void;
	isScreenReaderEnabled?: boolean;
	waitUntilExit?: () => Promise<unknown>;
	maxFps?: number;
	incrementalRendering?: boolean;

	/**
	Enable React Concurrent Rendering mode.

	When enabled:
	- Suspense boundaries work correctly with async data
	- `useTransition` and `useDeferredValue` are fully functional
	- Updates can be interrupted for higher priority work

	Note: Concurrent mode changes the timing of renders. Some tests may need to use `act()` to properly await updates. Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change the rendering mode or create a fresh instance.

	@default false
	@experimental
	*/
	concurrent?: boolean;
	kittyKeyboard?: KittyKeyboardOptions;
	explicitWidth?: 'auto' | 'disabled';

	/**
	Override automatic interactive mode detection.

	By default, Ink detects whether the environment is interactive based on CI detection (via [`is-in-ci`](https://github.com/sindresorhus/is-in-ci)) and `stdout.isTTY`. Most users should not need to set this.

	When non-interactive, Ink disables ANSI erase sequences, cursor manipulation, synchronized output, resize handling, and kitty keyboard auto-detection, writing only the final frame at unmount.

	Set to `false` to force non-interactive mode or `true` to force interactive mode when the automatic detection doesn't suit your use case.

	Note: Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change this option or create a fresh instance.

	@default true (false if in CI or `stdout.isTTY` is falsy)

	@see {@link RenderOptions.interactive}
	*/
	interactive?: boolean;

	/**
	Render the app in the terminal's alternate screen buffer. When enabled, the app renders on a separate screen, and the original terminal content is restored when the app exits. This is the same mechanism used by programs like vim, htop, and less.

	Note: The terminal's scrollback buffer is not available while in the alternate screen. This is standard terminal behavior; programs like vim use the alternate screen specifically to avoid polluting the user's scrollback history.

	Note: Ink intentionally treats alternate-screen teardown output as disposable. It does not preserve or replay teardown-time frames, hook writes, or `console.*` output after restoring the primary screen.

	Only works in interactive mode. Ignored when `interactive` is `false` or in a non-interactive environment (CI, piped stdout).

	Note: Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change this option or create a fresh instance.

	@default false

	@see {@link RenderOptions.alternateScreen}
	*/
	alternateScreen?: boolean;
};

export default class Ink {
	/**
	Whether this instance is using concurrent rendering mode.
	*/
	readonly isConcurrent: boolean;

	private readonly options: Options;
	private readonly log: LogUpdate;
	private cursorPosition: CursorPosition | undefined;
	private readonly throttledLog:
		LogUpdate | DebouncedFunc<(output: string) => void>;

	private readonly isScreenReaderEnabled: boolean;
	private readonly interactive: boolean;
	private readonly renderThrottleMs: number;
	private alternateScreen: boolean;

	// Ignore last render after unmounting a tree to prevent empty output before exit
	private isUnmounted: boolean;
	private isUnmounting: boolean;
	private lastOutput: string;
	private lastOutputToRender: string;
	private lastOutputHeight: number;
	private lastViewportRows: number;
	private lastTerminalWidth: number;
	private hasPhysicalFrame: boolean;
	private lastPhysicalFrameWasSoftWrapped: boolean;
	private readonly container: FiberRoot;
	private readonly rootNode: dom.DOMElement;
	// This variable is used only in debug mode to store full static output
	// so that it's rerendered every time, not just new static parts, like in non-debug mode
	private fullStaticOutput: string;
	private readonly exitPromise!: Promise<unknown>;
	private exitResult: unknown;
	private beforeExitHandler?: () => void;
	private restoreConsole?: () => void;
	private readonly unsubscribeResize?: () => void;
	private readonly throttledOnRender?: DebouncedFunc<() => void>;
	private hasPendingThrottledRender = false;
	private kittyProtocolEnabled = false;
	private cancelKittyDetection?: () => void;
	private nextRenderCommit?: {promise: Promise<void>; resolve: () => void};
	private readonly textSelection: TextSelectionController;
	private lastLayoutWidth?: number;
	private transformOutput?: (output: string) => string;
	private readonly widthDetection?: ExplicitWidthDetection;
	private pendingFrame?: PendingFrame;
	private reservedFrame?: PendingFrame;
	private readonly deferredWidthRenders: ReactNode[] = [];
	private readonly deferredWidthLifecycleActions: Array<() => void> = [];
	private rawInputReady = false;
	private resumePendingInput?: () => void;
	private kittyAutoFlags?: KittyFlagName[];
	private kittyQuerySent = false;

	constructor(options: Options) {
		autoBind(this);

		this.options = options;
		this.textSelection = new TextSelectionController();
		// Selection changes repaint through the same (throttled) path as React
		// renders; layout is unchanged, so no calculateLayout is needed.
		this.textSelection.onInvalidate = () => {
			this.rootNode.onRender?.();
		};

		this.rootNode = dom.createNode('ink-root');
		this.rootNode.onComputeLayout = this.calculateLayout;

		this.isScreenReaderEnabled =
			options.isScreenReaderEnabled ??
			process.env['INK_SCREEN_READER'] === 'true';

		// CI detection takes precedence: even a TTY stdout in CI defaults to non-interactive.
		// Using Boolean(isTTY) (rather than an 'in' guard) correctly handles piped streams
		// where the property is absent (e.g. `node app.js | cat`).
		this.interactive = this.resolveInteractiveOption(options.interactive);

		const explicitWidth = process.env['INK_EXPLICIT_WIDTH'];
		const canUseExplicitWidth =
			options.explicitWidth !== 'disabled' &&
			this.interactive &&
			Boolean(options.stdout.isTTY) &&
			!options.debug &&
			!this.isScreenReaderEnabled;
		if (canUseExplicitWidth && explicitWidth === '1') {
			this.transformOutput = createExplicitWidthEncoder();
		} else if (
			canUseExplicitWidth &&
			explicitWidth !== '0' &&
			options.stdin.isTTY &&
			options.stdin.readable &&
			typeof options.stdin.setRawMode === 'function' &&
			typeof options.stdin.ref === 'function' &&
			typeof options.stdin.unref === 'function'
		) {
			this.widthDetection = new ExplicitWidthDetection({
				getSize: () => getWindowSize(this.options.stdout),
				write: text => {
					if (
						!getWritableStreamState(this.options.stdout as MaybeWritableStream)
							.canWriteToStdout
					) {
						throw new Error('Terminal output is unavailable');
					}
					this.options.stdout.write(text);
				},
				reserve: this.reserveExplicitWidthFrame,
				onResult: this.settleExplicitWidth,
			});
			this.widthDetection.onSettled(this.finishExplicitWidthSettlement);
		}

		this.alternateScreen = false;

		const unthrottled = options.debug || this.isScreenReaderEnabled;
		const maxFps = options.maxFps ?? 30;
		// Treat non-positive maxFps as an internal fallback case, not a supported
		// "disable throttling" mode. Keep animation scheduling on a normal cadence
		// so future changes don't accidentally reintroduce zero-delay loops.
		const renderThrottleMs =
			maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0;
		this.renderThrottleMs = unthrottled ? 0 : renderThrottleMs;

		if (unthrottled) {
			this.rootNode.onRender = this.onRender;
			this.throttledOnRender = undefined;
		} else {
			const throttled = throttle(this.onRender, renderThrottleMs, {
				leading: true,
				trailing: true,
			});
			this.rootNode.onRender = () => {
				this.hasPendingThrottledRender = true;
				throttled();
			};

			this.throttledOnRender = throttled;
		}

		this.rootNode.onImmediateRender = this.onRender;
		this.log = logUpdate.create(options.stdout, {
			incremental: options.incrementalRendering,
			transformOutput: this.widthDetection
				? this.encodeTerminalOutput
				: this.transformOutput,
		});
		this.cursorPosition = undefined;
		this.throttledLog = unthrottled
			? this.log
			: throttle(
					(output: string) => {
						const shouldWrite = this.log.willRender(output);
						const sync = this.shouldSync();
						if (sync && shouldWrite) {
							this.options.stdout.write(bsu);
						}

						this.log(output);

						if (sync && shouldWrite) {
							this.options.stdout.write(esu);
						}
					},
					undefined,
					{
						leading: true,
						trailing: true,
					},
				);

		// Ignore last render after unmounting a tree to prevent empty output before exit
		this.isUnmounted = false;
		this.isUnmounting = false;

		// Store concurrent mode setting
		this.isConcurrent = options.concurrent ?? false;

		// Store last output to only rerender when needed
		this.lastOutput = '';
		this.lastOutputToRender = '';
		this.lastOutputHeight = 0;
		this.hasPhysicalFrame = false;
		this.lastPhysicalFrameWasSoftWrapped = false;
		this.lastViewportRows = getWindowSize(this.options.stdout).rows;
		this.lastTerminalWidth = getWindowSize(this.options.stdout).columns;

		// This variable is used only in debug mode to store full static output
		// so that it's rerendered every time, not just new static parts, like in non-debug mode
		this.fullStaticOutput = '';

		// Use ConcurrentRoot for concurrent mode, LegacyRoot for legacy mode
		const rootTag = options.concurrent ? ConcurrentRoot : LegacyRoot;

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.container = reconciler.createContainer(
			this.rootNode,
			rootTag,
			null,
			false,
			null,
			'id',
			() => {},
			() => {},
			() => {},
			() => {},
		);

		// Unmount when process exits
		this.unsubscribeExit = signalExit(this.unmount, {alwaysLast: false});

		this.setAlternateScreen(Boolean(options.alternateScreen));

		if (process.env['DEV'] === 'true') {
			// @ts-expect-error outdated types
			reconciler.injectIntoDevTools();
		}

		if (options.patchConsole) {
			this.patchConsole();
		}

		if (this.interactive) {
			options.stdout.on('resize', this.resized);

			this.unsubscribeResize = () => {
				options.stdout.off('resize', this.resized);
			};
		}

		this.initKittyKeyboard();

		this.exitPromise = new Promise((resolve, reject) => {
			this.resolveExitPromise = resolve;
			this.rejectExitPromise = reject;
		});
		// Prevent global unhandled-rejection crashes when app code exits with an
		// error but consumers never call waitUntilExit().

		void this.exitPromise.catch(noop);
	}

	resized = () => {
		if (this.deferUntilExplicitWidthSettlement(this.resized)) return;

		const currentWidth = getWindowSize(this.options.stdout).columns;
		this.calculateLayout();
		this.onRender();

		this.lastTerminalWidth = currentWidth;
	};

	resolveExitPromise: (result?: unknown) => void = () => {};
	rejectExitPromise: (reason?: Error) => void = () => {};
	unsubscribeExit: () => void = () => {};

	handleAppExit = (errorOrResult?: unknown): void => {
		if (this.isUnmounted || this.isUnmounting) {
			return;
		}

		if (isErrorInput(errorOrResult)) {
			this.unmount(errorOrResult);
			return;
		}

		this.exitResult = errorOrResult;
		this.unmount();
	};

	setCursorPosition = (position: CursorPosition | undefined): void => {
		this.cursorPosition = position;
		this.log.setCursorPosition(position);
	};

	restoreLastOutput = (): void => {
		if (!this.interactive) {
			return;
		}

		// Clear() resets log-update's cursor state, so replay the latest cursor intent
		// before restoring output after external stdout/stderr writes.
		this.log.setCursorPosition(this.cursorPosition);
		const outputToRestore = this.lastOutputToRender || this.lastOutput + '\n';
		this.log(outputToRestore);
		this.hasPhysicalFrame = true;
		this.lastPhysicalFrameWasSoftWrapped =
			Boolean(this.options.stdout.isTTY) &&
			isOutputSoftWrapped(
				outputToRestore,
				getWindowSize(this.options.stdout).columns,
			);
	};

	calculateLayout = () => {
		const terminalWidth = getWindowSize(this.options.stdout).columns;
		const yoga = this.rootNode.yogaNode!;
		const widthChanged = this.lastLayoutWidth !== terminalWidth;
		if (widthChanged) {
			yoga.setWidth(terminalWidth);
			this.lastLayoutWidth = terminalWidth;
		}

		if (!widthChanged && !yoga.isDirty()) return;
		yoga.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
		dom.incrementLayoutEpoch(this.rootNode);
	};

	onRender: () => void = () => {
		this.hasPendingThrottledRender = false;

		if (this.isUnmounted) {
			return;
		}

		if (this.nextRenderCommit) {
			this.nextRenderCommit.resolve();
			this.nextRenderCommit = undefined;
		}

		const startTime = performance.now();
		const {output, outputHeight, staticOutput, maxVisualWidth} = render(
			this.rootNode,
			this.isScreenReaderEnabled,
			// Screen-reader rendering bypasses Output, so selection is skipped.
			this.isScreenReaderEnabled ? undefined : this.textSelection,
		);

		this.options.onRender?.({
			outputHeight,
			outputLength: output.length,
			renderTime: performance.now() - startTime,
		});

		// If <Static> output isn't empty, it means new children have been added to it
		const hasStaticOutput = staticOutput && staticOutput !== '\n';

		if (this.options.debug) {
			if (hasStaticOutput) {
				this.fullStaticOutput += staticOutput;
			}

			this.lastOutput = output;
			this.lastOutputToRender = output;
			this.lastOutputHeight = outputHeight;
			this.options.stdout.write(this.fullStaticOutput + output);
			return;
		}

		if (!this.interactive) {
			if (hasStaticOutput) {
				this.options.stdout.write(staticOutput);
			}

			this.lastOutput = output;
			this.lastOutputToRender = output + '\n';
			this.lastOutputHeight = outputHeight;
			return;
		}

		if (this.isScreenReaderEnabled) {
			const sync = this.shouldSync();
			if (sync) {
				this.options.stdout.write(bsu);
			}

			if (hasStaticOutput) {
				// We need to erase the main output before writing new static output
				const erase =
					this.lastOutputHeight > 0
						? ansiEscapes.eraseLines(this.lastOutputHeight)
						: '';
				this.options.stdout.write(erase + staticOutput);
				// After erasing, the last output is gone, so we should reset its height
				this.lastOutputHeight = 0;
			}

			if (output === this.lastOutput && !hasStaticOutput) {
				if (sync) {
					this.options.stdout.write(esu);
				}

				return;
			}

			const terminalWidth = getWindowSize(this.options.stdout).columns;

			const wrappedOutput = wrapAnsi(output, terminalWidth, {
				trim: false,
				hard: true,
			});

			// If we haven't erased yet, do it now.
			if (hasStaticOutput) {
				this.options.stdout.write(wrappedOutput);
			} else {
				const erase =
					this.lastOutputHeight > 0
						? ansiEscapes.eraseLines(this.lastOutputHeight)
						: '';
				this.options.stdout.write(erase + wrappedOutput);
			}

			this.lastOutput = output;
			this.lastOutputToRender = wrappedOutput;
			this.lastOutputHeight =
				wrappedOutput === '' ? 0 : wrappedOutput.split('\n').length;

			if (sync) {
				this.options.stdout.write(esu);
			}

			return;
		}

		const frame: PendingFrame = {
			output,
			outputHeight,
			staticOutput: hasStaticOutput ? staticOutput : '',
			maxVisualWidth,
		};
		if (this.widthDetection && !this.widthDetection.settled) {
			this.pendingFrame = {
				...frame,
				staticOutput:
					(this.pendingFrame?.staticOutput ?? '') + frame.staticOutput,
			};
			if (
				!this.widthDetection.pending &&
				!frame.output &&
				!frame.staticOutput
			) {
				// No physical frame exists yet; keep the first nonempty frame eligible.
				return;
			} else {
				this.widthDetection.start();
			}
			return;
		}
		this.commitInteractiveFrame(frame);
	};

	render(node: ReactNode): void {
		if (this.widthDetection?.publicationBlocked) {
			this.deferredWidthRenders.push(node);
			this.widthDetection.cancel();
			return;
		}

		const tree = (
			<AccessibilityContext.Provider
				value={{isScreenReaderEnabled: this.isScreenReaderEnabled}}
			>
				<App
					stdin={this.options.stdin}
					stdout={this.options.stdout}
					stderr={this.options.stderr}
					exitOnCtrlC={this.options.exitOnCtrlC}
					interactive={this.interactive}
					renderThrottleMs={this.renderThrottleMs}
					writeToStdout={this.writeToStdout}
					writeToStderr={this.writeToStderr}
					setCursorPosition={this.setCursorPosition}
					textSelection={this.textSelection}
					onExit={this.handleAppExit}
					onWaitUntilRenderFlush={this.waitUntilRenderFlush}
					onTerminalResponse={
						this.widthDetection || this.kittyAutoFlags
							? this.handleTerminalResponse
							: undefined
					}
					isTerminalResponsePending={
						this.widthDetection || this.kittyAutoFlags
							? this.isTerminalResponsePending
							: undefined
					}
					onInputReady={
						this.widthDetection || this.kittyAutoFlags
							? this.handleInputReady
							: undefined
					}
				>
					{node}
				</App>
			</AccessibilityContext.Provider>
		);

		if (this.options.concurrent) {
			// Concurrent mode: use updateContainer (async scheduling)
			reconciler.updateContainer(tree, this.container, null, noop);
		} else {
			// Legacy mode: use updateContainerSync + flushSyncWork (sync)
			reconciler.updateContainerSync(tree, this.container, null, noop);
			reconciler.flushSyncWork();
		}
	}

	writeToStdout(data: string): void {
		if (this.isUnmounted) {
			return;
		}
		if (this.deferUntilExplicitWidthSettlement(() => this.writeToStdout(data)))
			return;

		if (this.options.debug) {
			this.options.stdout.write(data + this.fullStaticOutput + this.lastOutput);
			return;
		}

		if (!this.interactive) {
			this.options.stdout.write(data);
			return;
		}

		const sync = this.shouldSync();
		if (sync) {
			this.options.stdout.write(bsu);
		}

		this.log.clear(this.getPhysicalEraseOptions());
		this.options.stdout.write(data);
		this.restoreLastOutput();

		if (sync) {
			this.options.stdout.write(esu);
		}
	}

	writeToStderr(data: string): void {
		if (this.isUnmounted) {
			return;
		}
		if (this.deferUntilExplicitWidthSettlement(() => this.writeToStderr(data)))
			return;

		if (this.options.debug) {
			this.options.stderr.write(data);
			this.options.stdout.write(this.fullStaticOutput + this.lastOutput);
			return;
		}

		if (!this.interactive) {
			this.options.stderr.write(data);
			return;
		}

		const sync = this.shouldSync();
		if (sync) {
			this.options.stdout.write(bsu);
		}

		this.log.clear(this.getPhysicalEraseOptions());
		this.options.stderr.write(data);
		this.restoreLastOutput();

		if (sync) {
			this.options.stdout.write(esu);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-restricted-types
	unmount(error?: Error | number | null): void {
		if (this.isUnmounted || this.isUnmounting) {
			return;
		}

		if (this.deferUntilExplicitWidthSettlement(() => this.unmount(error)))
			return;
		this.isUnmounting = true;

		if (this.beforeExitHandler) {
			process.off('beforeExit', this.beforeExitHandler);
			this.beforeExitHandler = undefined;
		}

		const stdout = this.options.stdout as MaybeWritableStream;
		const {canWriteToStdout, hasWritableState} = getWritableStreamState(stdout);

		// Clear any pending throttled render timer on unmount. When stdout is writable,
		// flush so the final frame is emitted; otherwise cancel to avoid delayed callbacks.
		settleThrottle(this.throttledOnRender, canWriteToStdout);

		if (canWriteToStdout) {
			// If throttling is enabled and there is already a pending render, flushing above
			// is sufficient. Also avoid calling onRender() again when static output already
			// exists, as that can duplicate <Static> children output on exit (see issue #397).
			const shouldRenderFinalFrame =
				!this.throttledOnRender ||
				(!this.hasPendingThrottledRender && this.fullStaticOutput === '');

			if (shouldRenderFinalFrame) {
				this.calculateLayout();
				this.onRender();
			}
		}

		// Mark as unmounted after the final render but before stdout writes
		// that could re-enter exit() via synchronous write callbacks.
		this.isUnmounted = true;

		this.unsubscribeExit();

		// Flush any pending throttled log writes if possible, otherwise cancel to
		// prevent delayed callbacks from writing to a closed stream.
		settleThrottle(this.throttledLog, canWriteToStdout);
		if (typeof this.restoreConsole === 'function') {
			// Once unmount starts, Ink stops trying to manage teardown-time
			// console output. Restoring the native console before React cleanup keeps
			// unmount behavior simple and avoids special-case handling for custom
			// streams, fullscreen frames, and alternate-screen teardown.
			this.restoreConsole();
		}

		const finishUnmount = (): void => {
			if (typeof this.unsubscribeResize === 'function') {
				this.unsubscribeResize();
			}

			// Cancel any in-progress auto-detection before checking protocol state
			if (this.cancelKittyDetection) {
				this.cancelKittyDetection();
			}

			if (canWriteToStdout) {
				if (this.kittyProtocolEnabled) {
					this.writeBestEffort(this.options.stdout, '\u001B[<u');
				}

				// Alternate-screen content is disposable by design. We intentionally
				// leave it active until React cleanup finishes, then restore the
				// primary buffer without replaying prior frames, hook writes, or
				// diagnostics onto it. Trying to preserve teardown output across the
				// buffer switch adds fragile lifecycle-specific behavior, so Ink keeps
				// alternate-screen teardown intentionally simple and best-effort.
				if (this.alternateScreen) {
					this.writeBestEffort(
						this.options.stdout,
						ansiEscapes.exitAlternativeScreen,
					);
					this.writeBestEffort(this.options.stdout, showCursorEscape);
					this.alternateScreen = false;
				}

				if (!this.interactive) {
					// Non-interactive environments don't handle erasing ansi escapes well.
					// In debug mode, each render already writes to stdout, so only a trailing
					// newline is needed. In non-debug mode, write the last frame now (it was
					// deferred during rendering).
					this.options.stdout.write(
						this.options.debug ? '\n' : this.lastOutput + '\n',
					);
				} else if (!this.options.debug) {
					this.log.done();
				}
			}

			this.kittyProtocolEnabled = false;

			instances.delete(this.options.stdout);

			// Ensure all queued writes have been processed before resolving the
			// exit promise. For real writable streams, queue an empty write as a
			// barrier — its callback fires only after all prior writes complete.
			// For non-stream objects (e.g. test spies), resolve on next tick.
			//
			// When called from signal-exit during process shutdown (error is a
			// number or null rather than undefined/Error), resolve synchronously
			// because the event loop is draining and async callbacks won't fire.
			const {exitResult} = this;

			const resolveOrReject = () => {
				if (isErrorInput(error)) {
					this.rejectExitPromise(error);
				} else {
					this.resolveExitPromise(exitResult);
				}
			};

			const isProcessExiting = error !== undefined && !isErrorInput(error);

			if (isProcessExiting) {
				resolveOrReject();
			} else if (canWriteToStdout && hasWritableState) {
				this.options.stdout.write('', resolveOrReject);
			} else {
				setImmediate(resolveOrReject);
			}
		};

		const concurrentReconciler = reconciler as {
			flushPassiveEffects?: () => boolean;
		};

		if (this.options.concurrent) {
			reconciler.updateContainerSync(null, this.container, null, noop);
			reconciler.flushSyncWork();
			concurrentReconciler.flushPassiveEffects?.();
			finishUnmount();
		} else {
			// Legacy mode: use updateContainerSync + flushSyncWork (sync)
			reconciler.updateContainerSync(null, this.container, null, noop);
			reconciler.flushSyncWork();
			finishUnmount();
		}
	}

	async waitUntilExit(): Promise<unknown> {
		if (!this.beforeExitHandler) {
			this.beforeExitHandler = () => {
				this.unmount();
			};

			process.once('beforeExit', this.beforeExitHandler);
		}

		return this.exitPromise;
	}

	async waitUntilRenderFlush(): Promise<void> {
		if (this.isUnmounted || this.isUnmounting) {
			await this.awaitExit();
			return;
		}

		// Yield to the macrotask queue so that React's scheduler has a chance to
		// fire passive effects and process any work they enqueued.
		await yieldImmediate();

		if (this.isUnmounted || this.isUnmounting) {
			await this.awaitExit();
			return;
		}

		// In concurrent mode, React's scheduler may still be mid-render after
		// the yield. Wait for the next render commit instead of polling.
		if (this.isConcurrent && this.hasPendingConcurrentWork()) {
			await Promise.race([this.awaitNextRender(), this.awaitExit()]);

			if (this.isUnmounted || this.isUnmounting) {
				this.nextRenderCommit = undefined;
				await this.awaitExit();
				return;
			}
		}

		reconciler.flushSyncWork();
		settleThrottle(
			this.throttledOnRender,
			getWritableStreamState(this.options.stdout as MaybeWritableStream)
				.canWriteToStdout,
		);
		if (this.widthDetection?.pending) await this.widthDetection.finished;
		if (this.isUnmounted || this.isUnmounting) {
			await this.awaitExit();
			return;
		}

		const stdout = this.options.stdout as MaybeWritableStream;
		const {canWriteToStdout, hasWritableState} = getWritableStreamState(stdout);

		// Flush pending throttled render/log timers so their output is included in this wait.
		settleThrottle(this.throttledOnRender, canWriteToStdout);
		settleThrottle(this.throttledLog, canWriteToStdout);

		if (canWriteToStdout && hasWritableState) {
			await new Promise<void>(resolve => {
				this.options.stdout.write('', () => {
					resolve();
				});
			});
			return;
		}

		await yieldImmediate();
	}

	clear(): void {
		if (this.deferUntilExplicitWidthSettlement(this.clear)) return;
		if (this.interactive && !this.options.debug) {
			this.log.clear(this.getPhysicalEraseOptions());
			this.hasPhysicalFrame = false;
			this.lastPhysicalFrameWasSoftWrapped = false;
		}
	}

	patchConsole(): void {
		if (this.options.debug) {
			return;
		}

		this.restoreConsole = patchConsole((stream, data) => {
			if (stream === 'stdout') {
				this.writeToStdout(data);
			}

			if (stream === 'stderr') {
				const isReactMessage = data.startsWith('The above error occurred');

				if (!isReactMessage) {
					this.writeToStderr(data);
				}
			}
		});
	}

	private getPhysicalEraseOptions(): {eraseLineCount: number} | undefined {
		if (
			!this.options.stdout.isTTY ||
			!this.hasPhysicalFrame ||
			this.lastOutputToRender === ''
		) {
			return undefined;
		}

		const terminalWidth = getWindowSize(this.options.stdout).columns;
		if (!isOutputSoftWrapped(this.lastOutputToRender, terminalWidth)) {
			return undefined;
		}

		return {
			eraseLineCount: getReflowedLineCount(
				this.lastOutputToRender,
				terminalWidth,
			),
		};
	}

	private setAlternateScreen(enabled: boolean): void {
		this.alternateScreen = this.resolveAlternateScreenOption(
			enabled,
			this.interactive,
		);

		if (this.alternateScreen) {
			this.writeBestEffort(
				this.options.stdout,
				ansiEscapes.enterAlternativeScreen,
			);
			this.writeBestEffort(this.options.stdout, hideCursorEscape);
		}
	}

	private resolveInteractiveOption(interactive: boolean | undefined): boolean {
		return interactive ?? (!isInCi && Boolean(this.options.stdout.isTTY));
	}

	private resolveAlternateScreenOption(
		alternateScreen: boolean | undefined,
		interactive: boolean,
	): boolean {
		return (
			Boolean(alternateScreen) &&
			interactive &&
			Boolean(this.options.stdout.isTTY)
		);
	}

	private shouldSync(): boolean {
		return shouldSynchronize(this.options.stdout, this.interactive);
	}

	// Best-effort write: streams may already be destroyed during shutdown.
	private writeBestEffort(stream: NodeJS.WriteStream, data: string): void {
		try {
			stream.write(data);
		} catch {}
	}

	// Waits for the exit promise to settle, suppressing any rejection.
	// Errors are surfaced via waitUntilExit() instead.
	private async awaitExit(): Promise<void> {
		try {
			await this.exitPromise;
		} catch {}
	}

	private hasPendingConcurrentWork(): boolean {
		const concurrentContainer = this.container as {
			pendingLanes?: number;
			callbackNode?: unknown;
		};
		return (
			(concurrentContainer.pendingLanes ?? 0) !== 0 &&
			concurrentContainer.callbackNode !== undefined &&
			concurrentContainer.callbackNode !== null
		);
	}

	private async awaitNextRender(): Promise<void> {
		if (!this.nextRenderCommit) {
			let resolveRender!: () => void;
			const promise = new Promise<void>(resolve => {
				resolveRender = resolve;
			});
			this.nextRenderCommit = {promise, resolve: resolveRender};
		}

		return this.nextRenderCommit.promise;
	}

	private renderInteractiveFrame(
		output: string,
		outputHeight: number,
		staticOutput: string,
		maxVisualWidth?: number,
	): void {
		const hasStaticOutput = staticOutput !== '';
		const isTty = this.options.stdout.isTTY;

		const {columns: terminalWidth, rows: terminalRows} = getWindowSize(
			this.options.stdout,
		);

		// Detect fullscreen: output fills or exceeds terminal height.
		// Only apply when writing to a real TTY — piped output always gets trailing newlines.
		const viewportRows = isTty ? terminalRows : 24;
		const isFullscreen = isTty && outputHeight >= viewportRows;
		const outputToRender = isFullscreen ? output : output + '\n';
		const hadPhysicalFrame = this.hasPhysicalFrame;
		const previousOutputHeight = hadPhysicalFrame ? this.lastOutputHeight : 0;
		const hasCachedPhysicalOutput =
			hadPhysicalFrame && this.lastOutputToRender !== '';
		const columnsDecreased =
			Boolean(isTty) && terminalWidth < this.lastTerminalWidth;
		const outputWillRender =
			hasStaticOutput || this.log.willRender(outputToRender);
		const shouldClassifyNextFrame =
			Boolean(isTty) && (columnsDecreased || outputWillRender);
		const nextFrameIsSoftWrapped =
			shouldClassifyNextFrame &&
			isOutputSoftWrapped(outputToRender, terminalWidth, maxVisualWidth);
		const shouldRepairReflow =
			Boolean(isTty) &&
			hasCachedPhysicalOutput &&
			(columnsDecreased ||
				((this.lastPhysicalFrameWasSoftWrapped || nextFrameIsSoftWrapped) &&
					outputWillRender));
		const reflowedLineCount = shouldRepairReflow
			? getReflowedLineCount(this.lastOutputToRender, terminalWidth)
			: 0;
		const reflowEraseOptions = shouldRepairReflow
			? {eraseLineCount: reflowedLineCount}
			: undefined;

		const shouldClearTerminal = shouldClearTerminalForFrame({
			isTty,
			viewportRows,
			previousViewportRows: this.lastViewportRows,
			previousOutputHeight,
			nextOutputHeight: outputHeight,
			isUnmounting: this.isUnmounting,
		});
		const shouldRepaint = shouldRepaintForViewportTransition({
			isTty,
			previousViewportRows: this.lastViewportRows,
			viewportRows,
			previousOutputHeight,
			nextOutputHeight: outputHeight,
		});

		if (shouldClearTerminal) {
			const sync = this.shouldSync();
			if (sync) {
				this.options.stdout.write(bsu);
			}

			const content = this.fullStaticOutput + outputToRender;
			this.options.stdout.write(
				ansiEscapes.clearTerminal +
					(this.transformOutput?.(content) ?? content),
			);
			this.lastOutput = output;
			this.lastOutputToRender = outputToRender;
			this.lastOutputHeight = outputHeight;
			this.lastViewportRows = viewportRows;
			this.lastTerminalWidth = terminalWidth;
			this.log.sync(outputToRender);
			this.hasPhysicalFrame = true;
			this.lastPhysicalFrameWasSoftWrapped = shouldClassifyNextFrame
				? nextFrameIsSoftWrapped
				: Boolean(isTty) &&
					isOutputSoftWrapped(outputToRender, terminalWidth, maxVisualWidth);

			if (sync) {
				this.options.stdout.write(esu);
			}

			return;
		}

		let didWriteFrame = false;

		// To ensure static output is cleanly rendered before main output, clear main output first
		if (hasStaticOutput) {
			const sync = this.shouldSync();
			if (sync) {
				this.options.stdout.write(bsu);
			}

			this.log.clear(reflowEraseOptions);
			this.options.stdout.write(
				this.transformOutput?.(staticOutput) ?? staticOutput,
			);
			this.log(outputToRender);
			didWriteFrame = true;

			if (sync) {
				this.options.stdout.write(esu);
			}
		} else if (shouldRepaint || reflowEraseOptions !== undefined) {
			const sync = this.shouldSync();
			if (sync) {
				this.options.stdout.write(bsu);
			}

			this.log.repaint(outputToRender, reflowEraseOptions);
			didWriteFrame = true;

			if (sync) {
				this.options.stdout.write(esu);
			}
		} else if (
			outputToRender !== this.lastOutputToRender ||
			this.log.isCursorDirty()
		) {
			// ThrottledLog manages its own bsu/esu at actual write time
			this.throttledLog(outputToRender);
			didWriteFrame = true;
		}

		this.lastOutput = output;
		this.lastOutputToRender = outputToRender;
		this.lastOutputHeight = outputHeight;
		this.hasPhysicalFrame = hadPhysicalFrame || didWriteFrame;
		if (didWriteFrame) {
			this.lastPhysicalFrameWasSoftWrapped = shouldClassifyNextFrame
				? nextFrameIsSoftWrapped
				: Boolean(isTty) &&
					isOutputSoftWrapped(outputToRender, terminalWidth, maxVisualWidth);
		}

		this.lastViewportRows = viewportRows;
		this.lastTerminalWidth = terminalWidth;
	}

	private encodeTerminalOutput(output: string): string {
		return this.transformOutput?.(output) ?? output;
	}

	private commitInteractiveFrame(frame: PendingFrame): void {
		// Pending Static deltas must not leak into an earlier frame's replay.
		this.fullStaticOutput += frame.staticOutput;
		this.renderInteractiveFrame(
			frame.output,
			frame.outputHeight,
			frame.staticOutput,
			frame.maxVisualWidth,
		);
	}

	private reserveExplicitWidthFrame(): boolean {
		const frame = this.pendingFrame;
		if (!frame || !canOverwriteFirstCell(frame.staticOutput || frame.output))
			return false;
		this.reservedFrame = frame;
		this.pendingFrame = undefined;
		return true;
	}

	private settleExplicitWidth(supported: boolean): void {
		const reserved = this.reservedFrame;
		this.reservedFrame = undefined;
		if (supported) this.transformOutput = createExplicitWidthEncoder();
		try {
			if (
				this.isUnmounted ||
				!getWritableStreamState(this.options.stdout as MaybeWritableStream)
					.canWriteToStdout
			)
				return;
			if (reserved) this.commitInteractiveFrame(reserved);
			while (true) {
				settleThrottle(this.throttledOnRender, true);
				if (!this.pendingFrame) break;
				const pending = this.pendingFrame;
				this.pendingFrame = undefined;
				this.commitInteractiveFrame(pending);
			}
		} finally {
			this.pendingFrame = undefined;
		}
	}

	private deferUntilExplicitWidthSettlement(action: () => void): boolean {
		const detection = this.widthDetection;
		if (!detection || detection.settled) return false;
		this.deferredWidthLifecycleActions.push(action);
		detection.cancel();
		return true;
	}

	private finishExplicitWidthSettlement(): void {
		this.resumePendingInput?.();
		for (const node of this.deferredWidthRenders.splice(0)) this.render(node);
		const canWriteToStdout = getWritableStreamState(
			this.options.stdout as MaybeWritableStream,
		).canWriteToStdout;
		settleThrottle(this.throttledOnRender, canWriteToStdout);
		settleThrottle(this.throttledLog, canWriteToStdout);
		for (const action of this.deferredWidthLifecycleActions.splice(0)) {
			settleThrottle(this.throttledLog, canWriteToStdout);
			action();
		}
	}

	private isTerminalResponsePending(): boolean {
		return Boolean(this.widthDetection?.pending || this.cancelKittyDetection);
	}

	private handleInputReady(
		ready: boolean,
		resumePendingInput?: () => void,
		afterSettlement?: () => void,
	): void {
		this.rawInputReady = ready;
		if (!ready) {
			const finishInputRelease = () => {
				this.cancelKittyDetection?.();
				this.resumePendingInput = undefined;
				afterSettlement?.();
			};
			if (this.deferUntilExplicitWidthSettlement(finishInputRelease)) return;
			finishInputRelease();
			return;
		}
		if (this.isUnmounted || this.isUnmounting) return;
		this.resumePendingInput = resumePendingInput;
		this.widthDetection?.setInputReady(true);
		if (
			this.kittyAutoFlags &&
			!this.kittyQuerySent &&
			this.cancelKittyDetection
		) {
			this.kittyQuerySent = true;
			try {
				this.options.stdout.write('\u001B[?u');
			} catch {
				this.cancelKittyDetection?.();
			}
		}
	}

	private handleTerminalResponse(response: TerminalResponse): void {
		if (response.type === 'cursor-position') {
			this.widthDetection?.accept(response);
			return;
		}
		if (
			this.kittyQuerySent &&
			this.kittyAutoFlags &&
			this.cancelKittyDetection
		) {
			const flags = this.kittyAutoFlags;
			this.cancelKittyDetection();
			if (!this.isUnmounted && !this.isUnmounting)
				this.enableKittyProtocol(flags);
		}
	}

	private initKittyKeyboard(): void {
		// Protocol is opt-in: if kittyKeyboard is not specified, do nothing
		if (!this.options.kittyKeyboard) {
			return;
		}

		const opts = this.options.kittyKeyboard;
		const mode = opts.mode ?? 'auto';

		if (mode === 'disabled') {
			return;
		}

		const flags: KittyFlagName[] = opts.flags ?? ['disambiguateEscapeCodes'];

		// 'enabled' force-enables the protocol as long as both streams are TTYs,
		// regardless of the interactive setting (e.g. even in CI).
		if (mode === 'enabled') {
			if (this.options.stdin.isTTY && this.options.stdout.isTTY) {
				this.enableKittyProtocol(flags);
			}

			return;
		}

		// Auto mode: require interactive + TTY
		if (
			!this.interactive ||
			!this.options.stdin.isTTY ||
			!this.options.stdout.isTTY
		) {
			return;
		}

		if (this.options.debug || this.isScreenReaderEnabled) return;
		// Replies flow through App's one readable parser, without input replay.
		this.kittyAutoFlags = flags;
		const cleanup = (): void => {
			clearTimeout(timer);
			this.cancelKittyDetection = undefined;
			this.kittyAutoFlags = undefined;
			this.resumePendingInput?.();
		};
		const timer = setTimeout(cleanup, 200);
		this.cancelKittyDetection = cleanup;
		if (this.rawInputReady)
			this.handleInputReady(true, this.resumePendingInput);
	}

	private enableKittyProtocol(flags: KittyFlagName[]): void {
		this.options.stdout.write(`\u001B[>${resolveFlags(flags)}u`);
		this.kittyProtocolEnabled = true;
	}
}
