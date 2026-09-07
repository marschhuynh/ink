import headless, {type Terminal as TerminalInstance} from '@xterm/headless';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const {Terminal} = headless;

export const writeTerminal = (terminal: TerminalInstance, bytes: string) =>
	new Promise<void>(resolve => {
		terminal.write(bytes, resolve);
	});

export const viewportLine = (terminal: TerminalInstance, row: number) =>
	terminal.buffer.active
		.getLine(terminal.buffer.active.baseY + row)!
		.translateToString(false);
