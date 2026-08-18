/**
 * The pinned row occupies exactly one line. Every test here defends that: a bar
 * that wraps breaks the reserved scroll region and the transcript starts eating
 * its own status.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { type BarState, PROMPT_MARKER, collapseHome, renderBar, renderPrompt } from "../src/ui/chrome.ts";
import { setColor, visibleWidth } from "../src/ui/render.ts";

beforeEach(() => {
	setColor(false);
});

function state(patch: Partial<BarState> = {}): BarState {
	return {
		model: "qwen3-coder-30b",
		cwd: "~/Documents/Workspace/agentic-coding-ai",
		contextTokens: 1600,
		contextWindow: 32768,
		sessionTokens: 12400,
		engineRunning: true,
		title: "add peek() to lru",
		...patch,
	};
}

const RUNNING: NonNullable<BarState["run"]> = {
	tick: 3,
	phase: "generating",
	wallMs: 4200,
	tokensPerSec: 82.1,
	ttftMs: 380,
};
describe("renderBar idle", () => {
	test("never exceeds the terminal width, at any width", () => {
		for (const width of [20, 24, 40, 60, 80, 100, 120, 200]) {
			expect(visibleWidth(renderBar(state(), width))).toBeLessThanOrEqual(width);
		}
	});

	test("width is respected with colour enabled: escapes are not visible cells", () => {
		setColor(true);
		try {
			for (const width of [40, 80, 120]) {
				expect(visibleWidth(renderBar(state(), width))).toBeLessThanOrEqual(width);
			}
		} finally {
			setColor(false);
		}
	});

	test("carries the fields the operator watches at a normal width", () => {
		const line = renderBar(state({ vramFreeMiB: 1257 }), 140);
		expect(line).toContain("qwen3-coder-30b");
		expect(line).toContain("agentic-coding-ai");
		expect(line).toContain("5%"); // 1600 / 32768
		expect(line).toContain("1.6k/32.8k");
		expect(line).toContain("12.4k tok");
		expect(line).toContain("1257 MiB free");
		expect(line).toContain("add peek() to lru");
	});

	test("sheds the least useful segments first as width shrinks", () => {
		const wide = renderBar(state({ vramFreeMiB: 1257 }), 140);
		const narrow = renderBar(state({ vramFreeMiB: 1257 }), 46);
		expect(wide).toContain("1257 MiB free");
		expect(narrow).not.toContain("MiB free");
		// Model identity and context occupancy survive every width.
		expect(narrow).toContain("qwen3-coder-30b");
		expect(narrow).toContain("5%");
	});

	test("elides the path from the left, keeping the project directory", () => {
		const line = renderBar(state({ cwd: "~/a/very/deeply/nested/place/my-project" }), 100);
		expect(line).toContain("my-project");
		expect(visibleWidth(line)).toBeLessThanOrEqual(100);
	});

	test("engine reachability is visually distinct", () => {
		expect(renderBar(state({ engineRunning: true }), 100)).toContain("\u25cf");
		expect(renderBar(state({ engineRunning: false }), 100)).toContain("\u25cb");
	});

	test("a long title is clipped, not wrapped", () => {
		const line = renderBar(state({ title: "x".repeat(300) }), 100);
		expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(line).toContain("\u2026");
	});

	test("degenerate inputs do not throw or produce a zero-width line", () => {
		for (const patch of [
			{ contextWindow: 0 },
			{ contextWindow: Number.NaN },
			{ contextTokens: 999_999 },
			{ cwd: "" },
			{ model: "" },
			{ sessionTokens: 0 },
			{ title: "" },
		]) {
			const line = renderBar(state(patch), 60);
			expect(visibleWidth(line)).toBeGreaterThan(4);
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
		expect(() => renderBar(state(), 1)).not.toThrow();
		expect(() => renderBar(state(), 0)).not.toThrow();
	});

	test("an overfull context reads as 100%, never more", () => {
		expect(renderBar(state({ contextTokens: 40000, contextWindow: 32768 }), 120)).toContain("100%");
	});
});

describe("renderBar running", () => {
	test("shows phase, elapsed, decode rate and ttft, and drops the title", () => {
		const line = renderBar(state({ run: RUNNING }), 140);
		expect(line).toContain("generating");
		expect(line).toContain("4.2s");
		expect(line).toContain("82.1 tok/s");
		expect(line).toContain("ttft 380ms");
		// A run needs the width for live numbers; the title is idle-only context.
		expect(line).not.toContain("add peek()");
	});

	test("withholds the rate until there is a sample, and ttft until first token", () => {
		const line = renderBar(state({ run: { tick: 0, phase: "reading context", wallMs: 900, tokensPerSec: 0 } }), 140);
		expect(line).toContain("reading context");
		expect(line).toContain("\u2013 tok/s");
		expect(line).not.toContain("ttft");
	});

	test("stays one row at every width while running", () => {
		for (const width of [20, 30, 40, 60, 80, 120, 200]) {
			expect(visibleWidth(renderBar(state({ run: RUNNING }), width))).toBeLessThanOrEqual(width);
		}
	});

	test("the context gauge survives even at the narrowest width", () => {
		expect(renderBar(state({ run: RUNNING }), 28)).toContain("5%");
	});
});

describe("renderPrompt", () => {
	test("is a bare marker: state belongs in the pinned row", () => {
		const prompt = renderPrompt(false);
		expect(prompt).toContain(PROMPT_MARKER);
		expect(prompt.endsWith(" ")).toBe(true);
		expect(visibleWidth(prompt)).toBe(2);
	});

	test("busy and idle prompts have identical width so the cursor never jumps", () => {
		expect(visibleWidth(renderPrompt(true))).toBe(visibleWidth(renderPrompt(false)));
	});
});


describe("collapseHome", () => {
	test("replaces the home prefix and normalises separators", () => {
		expect(collapseHome("C:\\Users\\me\\code\\app", "C:\\Users\\me")).toBe("~/code/app");
		expect(collapseHome("C:/Users/me", "C:/Users/me")).toBe("~");
		expect(collapseHome("C:/Users/me/", "C:/Users/me")).toBe("~");
	});

	test("case-insensitive on Windows-shaped paths", () => {
		expect(collapseHome("c:/users/ME/code", "C:/Users/me")).toBe("~/code");
	});

	test("leaves unrelated paths alone, including near-misses", () => {
		expect(collapseHome("D:/work/app", "C:/Users/me")).toBe("D:/work/app");
		// "meadow" must not match the "me" home directory.
		expect(collapseHome("C:/Users/meadow/app", "C:/Users/me")).toBe("C:/Users/meadow/app");
	});
});
