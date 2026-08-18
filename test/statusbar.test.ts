/**
 * The pinned row is pure terminal protocol, so these tests assert the exact
 * escape sequences. Getting them wrong does not throw — it corrupts the user's
 * terminal, and in one case (reserving the region after printing) it silently
 * ate the first line of output.
 */

import { describe, expect, test } from "bun:test";

import { StatusBar } from "../src/ui/statusbar.ts";

interface FakeOut {
	writes: string[];
	written: string;
	columns: number;
	rows: number;
	write(chunk: string): boolean;
}

function fakeOut(rows = 30, columns = 100): FakeOut {
	const writes: string[] = [];
	return {
		writes,
		get written(): string {
			return writes.join("");
		},
		columns,
		rows,
		write(chunk: string): boolean {
			writes.push(chunk);
			return true;
		},
	};
}

/** The cast is the test seam: StatusBar only ever uses write/rows/columns. */
function bar(out: FakeOut, tty = true): StatusBar {
	return new StatusBar(out as unknown as typeof process.stdout, tty);
}

const SET_REGION = /\u001b\[2;(\d+)r/;
const RESET_REGION = "\u001b[r";

describe("enable", () => {
	test("reserves row 1 by setting a scroll region that starts at row 2", () => {
		const out = fakeOut(30);
		bar(out).enable();
		const match = SET_REGION.exec(out.written);
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("30");
	});

	test("makes room before reserving, so existing output is not overwritten", () => {
		// The newline must precede the region change: on a fresh terminal the cursor
		// sits on row 1, which is about to stop scrolling.
		const out = fakeOut();
		bar(out).enable();
		const newlineAt = out.written.indexOf("\n");
		const regionAt = out.written.search(SET_REGION);
		expect(newlineAt).toBeGreaterThanOrEqual(0);
		expect(newlineAt).toBeLessThan(regionAt);
	});

	test("is a no-op without a TTY: escapes must never reach a pipe", () => {
		const out = fakeOut();
		const b = bar(out, false);
		b.enable();
		b.set("hello");
		expect(out.written).toBe("");
		expect(b.enabled).toBe(false);
	});

	test("refuses to steal a row from a terminal too short to spare one", () => {
		const out = fakeOut(4);
		const b = bar(out);
		b.enable();
		expect(b.enabled).toBe(false);
		expect(out.written).toBe("");
	});

	test("enabling twice does not stack regions", () => {
		const out = fakeOut();
		const b = bar(out);
		b.enable();
		const first = out.writes.length;
		b.enable();
		expect(out.writes.length).toBe(first);
	});
});

describe("set", () => {
	test("paints row 1 and returns the cursor, so typing is never disturbed", () => {
		const out = fakeOut();
		const b = bar(out);
		b.enable();
		out.writes.length = 0;
		b.set("status text");

		const written = out.written;
		expect(written.startsWith("\u001b7")).toBe(true); // save cursor
		expect(written).toContain("\u001b[1;1H"); // home
		expect(written).toContain("\u001b[2K"); // clear the row
		expect(written).toContain("status text");
		expect(written.endsWith("\u001b8")).toBe(true); // restore cursor
		// Home must come after the save and before the text.
		expect(written.indexOf("\u001b[1;1H")).toBeLessThan(written.indexOf("status text"));
	});

	test("identical text is not repainted: the bar updates ten times a second", () => {
		const out = fakeOut();
		const b = bar(out);
		b.enable();
		b.set("same");
		out.writes.length = 0;
		b.set("same");
		expect(out.written).toBe("");
		b.set("different");
		expect(out.written).toContain("different");
	});

	test("does nothing before enable", () => {
		const out = fakeOut();
		bar(out).set("orphan");
		expect(out.written).toBe("");
	});
});

describe("disable", () => {
	test("clears the row and restores the full scrolling region", () => {
		const out = fakeOut();
		const b = bar(out);
		b.enable();
		b.set("status");
		out.writes.length = 0;
		b.disable();

		const written = out.written;
		expect(written).toContain("\u001b[2K");
		expect(written).toContain(RESET_REGION);
		// The region reset must come last: clearing inside a stale region is fine,
		// but leaving the region installed is what corrupts the user's shell.
		expect(written.indexOf(RESET_REGION)).toBe(written.length - RESET_REGION.length);
		expect(b.enabled).toBe(false);
	});

	test("is idempotent, because teardown runs from several exit paths", () => {
		const out = fakeOut();
		const b = bar(out);
		b.enable();
		b.disable();
		out.writes.length = 0;
		b.disable();
		expect(out.written).toBe("");
	});
});

describe("resize", () => {
	test("re-issues the region for the new height and repaints", () => {
		const out = fakeOut(30);
		const b = bar(out);
		b.enable();
		b.set("status");
		out.writes.length = 0;
		out.rows = 50;
		b.resize();
		expect(SET_REGION.exec(out.written)?.[1]).toBe("50");
		expect(out.written).toContain("status");
	});

	test("gives the row back when the terminal becomes too short", () => {
		const out = fakeOut(30);
		const b = bar(out);
		b.enable();
		out.rows = 3;
		b.resize();
		expect(b.enabled).toBe(false);
		expect(out.written).toContain(RESET_REGION);
	});

	test("does nothing while disabled", () => {
		const out = fakeOut();
		const b = bar(out);
		b.resize();
		expect(out.written).toBe("");
	});
});
