/**
 * A status row pinned to the top of the terminal.
 *
 * The row is reserved with DECSTBM (`CSI top;bottom r`), which confines every
 * subsequent scroll to the rows below it. The transcript then scrolls under a row
 * that never moves, so the context gauge has exactly one home on screen instead
 * of being re-drawn wherever the cursor happens to be.
 *
 * Redraws save and restore the cursor (DECSC/DECRC) so they can happen at any
 * moment — including mid-typing — without disturbing readline's line editing.
 *
 * Teardown MUST run on every exit path: a process that dies with a scroll region
 * installed leaves the user's shell scrolling inside a sub-window.
 */

const ESC = "\u001b";
const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;
const HOME = `${ESC}[1;1H`;
const CLEAR_LINE = `${ESC}[2K`;
const RESET_REGION = `${ESC}[r`;

/** Rows below which reserving one for chrome leaves too little to work in. */
const MIN_ROWS = 6;

export class StatusBar {
	private active = false;
	private text = "";

	constructor(
		private readonly out: typeof process.stdout,
		private readonly tty: boolean,
	) {}

	get enabled(): boolean {
		return this.active;
	}

	private get rows(): number {
		return this.out.rows ?? 24;
	}

	/** Reserves row 1 and moves the cursor into the scrolling region below it. */
	enable(): void {
		if (this.active || !this.tty || this.rows < MIN_ROWS) return;
		// Make room first: on a fresh terminal the cursor sits on row 1, which is
		// about to stop being part of the scrolling region.
		this.out.write("\n");
		this.out.write(`${ESC}[2;${this.rows}r`);
		this.active = true;
		this.draw();
	}

	/** Restores the full scrolling region and clears the reserved row. */
	disable(): void {
		if (!this.active) return;
		this.active = false;
		this.out.write(`${SAVE_CURSOR}${HOME}${CLEAR_LINE}${RESTORE_CURSOR}${RESET_REGION}`);
	}

	set(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.draw();
	}

	/** Re-issues the region for the new terminal height, then repaints. */
	resize(): void {
		if (!this.active) return;
		if (this.rows < MIN_ROWS) {
			this.disable();
			return;
		}
		this.out.write(`${ESC}[2;${this.rows}r`);
		this.draw();
	}

	private draw(): void {
		if (!this.active) return;
		const width = Math.max(this.out.columns ?? 80, 8);
		this.out.write(`${SAVE_CURSOR}${HOME}${CLEAR_LINE}${this.text.slice(0, width * 8)}${RESTORE_CURSOR}`);
	}
}
