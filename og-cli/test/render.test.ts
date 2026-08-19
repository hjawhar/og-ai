/**
 * Pure formatting, but load-bearing: the percentage semantics of `formatUsage`
 * and the width guarantee of `wrap` are what the TUI status line depends on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	elapsed,
	formatContext,
	formatTokenCount,
	formatToolEnd,
	formatToolStart,
	formatUsage,
	progressBar,
	red,
	setColor,
	supportsColor,
	visibleWidth,
	wrap,
} from "../src/ui/render.ts";

const ANSI = /\u001b\[/;

beforeEach(() => {
	// Colour state is a module-level toggle; pin it so assertions are exact.
	setColor(false);
});

afterEach(() => {
	setColor(false);
});

describe("formatUsage", () => {
	test("renders its third argument as a percentage, not a fraction", () => {
		// The agent loop emits contextUsedPct as 0-100. Treating it as a fraction
		// was a real bug: a 9%-full context rendered as "context 0%".
		expect(formatUsage(1234, 56, 9)).toBe("tokens 1234\u2191 56\u2193 \u00b7 context 9%");
		expect(formatUsage(0, 0, 0)).toContain("context 0%");
		expect(formatUsage(10, 2, 100)).toContain("context 100%");
		expect(formatUsage(10, 2, 91.2)).toContain("context 91%");
		// A fraction-shaped input rounds to 0%, which is exactly why the unit matters.
		expect(formatUsage(10, 2, 0.09)).toContain("context 0%");
	});

	test("a non-finite percentage degrades to ? instead of NaN", () => {
		expect(formatUsage(1, 1, Number.NaN)).toContain("context ?");
		expect(formatUsage(1, 1, Number.POSITIVE_INFINITY)).toContain("context ?");
	});
});

describe("progressBar", () => {
	test("fills proportionally and always spans the requested width", () => {
		expect(progressBar(0, 10)).toBe("\u2591".repeat(10));
		expect(progressBar(1, 10)).toBe("\u2588".repeat(10));
		expect(progressBar(0.5, 10)).toBe(`${"\u2588".repeat(5)}${"\u2591".repeat(5)}`);
		for (const fraction of [0, 0.01, 0.33, 0.5, 0.99, 1]) {
			expect(visibleWidth(progressBar(fraction, 12))).toBe(12);
		}
	});

	test("never lies at the boundaries", () => {
		// A started-but-tiny value must not read as empty, and 99% must not read as full:
		// the gauge is how the operator sees a context about to trigger compaction.
		expect(progressBar(0.001, 10)).toBe(`\u2588${"\u2591".repeat(9)}`);
		expect(progressBar(0.999, 10)).toBe(`${"\u2588".repeat(9)}\u2591`);
	});

	test("out-of-range and non-finite inputs clamp instead of throwing", () => {
		expect(progressBar(-5, 8)).toBe("\u2591".repeat(8));
		expect(progressBar(42, 8)).toBe("\u2588".repeat(8));
		expect(visibleWidth(progressBar(Number.NaN, 8))).toBe(8);
		expect(visibleWidth(progressBar(0.5, 0))).toBe(1);
	});
});

describe("formatTokenCount", () => {
	test("switches to thousands without losing meaningful precision", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(812)).toBe("812");
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1000)).toBe("1.0k");
		expect(formatTokenCount(3149)).toBe("3.1k");
		expect(formatTokenCount(32768)).toBe("32.8k");
		expect(formatTokenCount(131072)).toBe("131k");
		expect(formatTokenCount(-1)).toBe("?");
		expect(formatTokenCount(Number.NaN)).toBe("?");
	});
});

describe("formatContext", () => {
	test("shows the gauge, the percentage and both absolute counts", () => {
		const out = formatContext(8900, 32768);
		expect(out).toContain("ctx");
		expect(out).toContain("27%");
		expect(out).toContain("8.9k/32.8k");
		expect(visibleWidth(out)).toBeGreaterThan(10);
	});

	test("a full or overfull context reads as 100%, never above", () => {
		expect(formatContext(32768, 32768)).toContain("100%");
		expect(formatContext(40000, 32768)).toContain("100%");
	});

	test("an unknown window degrades instead of dividing by zero", () => {
		expect(formatContext(100, 0)).toBe("ctx ?");
		expect(formatContext(100, Number.NaN)).toBe("ctx ?");
	});
});

describe("tool line formatters", () => {
	test("the tool name appears exactly once when the summary omits it", () => {
		const start = formatToolStart("read", '{"path":"src/index.ts"}');
		expect(start).toBe("\u2022 read {\"path\":\"src/index.ts\"}");
		expect(start.split("read")).toHaveLength(2);

		const end = formatToolEnd("read", true, 840, "src/index.ts: 120 lines (complete)");
		expect(end.split("read")).toHaveLength(2);
	});

	test("an empty summary leaves no dangling separator", () => {
		expect(formatToolStart("ls", "")).toBe("\u2022 ls");
		expect(formatToolEnd("ls", true, 12, "")).toBe("\u2713 ls (12ms)");
	});

	test("formatToolEnd always reports the duration and the outcome mark", () => {
		expect(formatToolEnd("bash", true, 840, "exit code: 0")).toBe(
			"\u2713 bash exit code: 0 (840ms)",
		);
		expect(formatToolEnd("bash", false, 3210, "failed")).toBe("\u2717 bash failed (3.2s)");
		expect(formatToolEnd("bash", false, 64_000, "failed")).toContain(`(${elapsed(64_000)})`);
		expect(formatToolEnd("bash", true, 0, "")).toContain("(0ms)");
	});
});

describe("wrap", () => {
	test("never exceeds the requested width for plain text", () => {
		const text =
			"The provider streams server-sent events from an OpenAI-compatible endpoint and the agent budgets every request against the active model spec's context window before it sends the first token.";
		for (const width of [20, 32, 40, 72]) {
			for (const line of wrap(text, width).split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("splits words longer than the width and preserves blank lines and indentation", () => {
		const wrapped = wrap(`short\n\n    ${"x".repeat(90)} tail`, 40);
		for (const line of wrapped.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
		expect(wrapped.split("\n")[0]).toBe("short");
		expect(wrapped.split("\n")[1]).toBe("");
		expect(wrapped.split("\n")[2]?.startsWith("    x")).toBe(true);
		expect(wrapped).toContain("tail");
	});

	test("does not count ANSI escapes toward the width", () => {
		const coloured = Array.from({ length: 12 }, (_, i) => `\u001b[36mword${i}\u001b[0m`).join(" ");
		const wrapped = wrap(coloured, 30);
		let sawEscapeHeavyLine = false;
		for (const line of wrapped.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(30);
			if (line.length > 30) sawEscapeHeavyLine = true;
		}
		// Proof the escapes were actually carried through, not stripped.
		expect(sawEscapeHeavyLine).toBe(true);
		expect(ANSI.test(wrapped)).toBe(true);
		// No visible characters were lost.
		expect(wrapped.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim()).toBe(
			Array.from({ length: 12 }, (_, i) => `word${i}`).join(" "),
		);
	});

	test("a degenerate width returns the text unchanged", () => {
		expect(wrap("some text", 1)).toBe("some text");
		expect(wrap("some text", Number.NaN)).toBe("some text");
	});
});

describe("colour", () => {
	test("NO_COLOR disables every escape code", () => {
		const previous = process.env.NO_COLOR;
		try {
			process.env.NO_COLOR = "1";
			expect(supportsColor(process.env, true)).toBe(false);
			setColor(supportsColor(process.env, true));
			expect(red("danger")).toBe("danger");
			expect(formatUsage(1, 2, 3)).toBe("tokens 1\u2191 2\u2193 \u00b7 context 3%");
			expect(ANSI.test(formatToolEnd("bash", false, 100, "failed"))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previous;
		}
		// The env var is restored for anything else in this process.
		expect(process.env.NO_COLOR).toBe(previous);
	});

	test("supportsColor precedence: NO_COLOR beats FORCE_COLOR beats TTY", () => {
		expect(supportsColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
		expect(supportsColor({ FORCE_COLOR: "1" }, false)).toBe(true);
		expect(supportsColor({ FORCE_COLOR: "0" }, false)).toBe(false);
		expect(supportsColor({ TERM: "dumb" }, true)).toBe(false);
		expect(supportsColor({}, true)).toBe(true);
		expect(supportsColor({}, false)).toBe(false);
		// An empty NO_COLOR is not a NO_COLOR.
		expect(supportsColor({ NO_COLOR: "" }, true)).toBe(true);
	});

	test("with colour on, helpers emit escapes and visibleWidth ignores them", () => {
		setColor(true);
		const painted = red("danger");
		expect(ANSI.test(painted)).toBe(true);
		expect(visibleWidth(painted)).toBe(6);
		expect(painted.length).toBeGreaterThan(6);
		// Empty strings are never painted: an escape pair around nothing is noise.
		expect(red("")).toBe("");
	});
});
