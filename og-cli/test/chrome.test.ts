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
		endpoint: "http://127.0.0.1:8127",
		contextTokens: 1600,
		contextWindow: 32768,
		sessionTokens: 12400,
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

/** Widths chosen from the shedding ladder, not at random; see the tests below. */
const WIDE = 160;
const NO_ENDPOINT = 90;
const NO_TOKENS = 80;
const NARROWEST = 46;

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
		const line = renderBar(state(), WIDE);
		expect(line).toContain("qwen3-coder-30b");
		expect(line).toContain("agentic-coding-ai");
		expect(line).toContain("127.0.0.1:8127");
		expect(line).toContain("5%"); // 1600 / 32768
		expect(line).toContain("1.6k/32.8k");
		expect(line).toContain("12.4k tok");
		expect(line).toContain("add peek() to lru");
	});

	test("sheds the least useful segments first as width shrinks", () => {
		// The endpoint is configuration set once; the gauge and the session total
		// change every turn, so the endpoint goes first and the model identity and
		// occupancy survive to the narrowest row.
		const wide = renderBar(state(), WIDE);
		expect(wide).toContain("127.0.0.1:8127");
		expect(wide).toContain("12.4k tok");

		const noEndpoint = renderBar(state(), NO_ENDPOINT);
		expect(noEndpoint).not.toContain("8127");
		expect(noEndpoint).toContain("12.4k tok");
		expect(noEndpoint).toContain("agentic-coding-ai");
		expect(noEndpoint).toContain("1.6k/32.8k");

		const noTokens = renderBar(state(), NO_TOKENS);
		expect(noTokens).not.toContain("8127");
		expect(noTokens).not.toContain("12.4k tok");
		expect(noTokens).toContain("1.6k/32.8k");

		const narrow = renderBar(state(), NARROWEST);
		expect(narrow).not.toContain("8127");
		expect(narrow).toContain("qwen3-coder-30b");
		expect(narrow).toContain("5%");
	});

	test("the endpoint segment is host[:port] only: no scheme, no route prefix", () => {
		const line = renderBar(
			state({ endpoint: "https://api.openai.com/v1", cwd: "~/w" }),
			WIDE,
		);
		expect(line).toContain("api.openai.com");
		expect(line).not.toContain("https");
		expect(line).not.toContain("://");
		expect(line).not.toContain("/v1");

		// A non-default port is the whole point of showing the port at all.
		expect(renderBar(state({ endpoint: "http://10.0.0.4:9001", cwd: "~/w" }), WIDE)).toContain(
			"10.0.0.4:9001",
		);
	});

	test("an endpoint URL cannot parse is shown verbatim rather than blanked", () => {
		for (const endpoint of ["not a url", "127.0.0.1:8127"]) {
			const line = renderBar(state({ endpoint, cwd: "~/w" }), WIDE);
			expect(line, endpoint).toContain(endpoint);
		}
	});

	test("an empty endpoint leaves no dangling separator", () => {
		const line = renderBar(state({ endpoint: "" }), WIDE);
		expect(line).not.toContain("\u00b7 \u00b7");
		expect(line).toContain("qwen3-coder-30b");
		expect(visibleWidth(line)).toBeLessThanOrEqual(WIDE);
	});

	test("elides the path from the left, keeping the project directory", () => {
		const line = renderBar(state({ cwd: "~/a/very/deeply/nested/place/my-project" }), 100);
		expect(line).toContain("my-project");
		expect(visibleWidth(line)).toBeLessThanOrEqual(100);
	});

	test("a long title is clipped, not wrapped", () => {
		// A short cwd leaves enough room that the title is genuinely clipped rather
		// than dropped outright, which is the case that used to wrap the row.
		const line = renderBar(state({ title: "x".repeat(300), cwd: "~/w" }), WIDE);
		expect(visibleWidth(line)).toBeLessThanOrEqual(WIDE);
		expect(line).toContain("x");
		expect(line).toContain("\u2026");
		expect(line).not.toContain("x".repeat(120));

		// And at a width with no room at all the title simply disappears.
		const tight = renderBar(state({ title: "x".repeat(300) }), 100);
		expect(visibleWidth(tight)).toBeLessThanOrEqual(100);
		expect(tight).not.toContain("xx");
	});

	test("degenerate inputs do not throw or produce a zero-width line", () => {
		for (const patch of [
			{ contextWindow: 0 },
			{ contextWindow: Number.NaN },
			{ contextTokens: 999_999 },
			{ cwd: "" },
			{ model: "" },
			{ endpoint: "" },
			{ endpoint: "http://" },
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

	test("an unknown context window degrades instead of dividing by zero", () => {
		for (const contextWindow of [0, Number.NaN]) {
			expect(renderBar(state({ contextWindow }), 120)).toContain("ctx ?");
		}
	});

	test("an overfull context reads as 100%, never more", () => {
		expect(renderBar(state({ contextTokens: 40000, contextWindow: 32768 }), 120)).toContain("100%");
	});
});

describe("renderBar running", () => {
	test("shows phase, elapsed, decode rate and ttft, and drops the title", () => {
		const line = renderBar(state({ run: RUNNING }), WIDE);
		expect(line).toContain("generating");
		expect(line).toContain("4.2s");
		expect(line).toContain("82.1 tok/s");
		expect(line).toContain("ttft 380ms");
		// A run needs the width for live numbers; the title is idle-only context.
		expect(line).not.toContain("add peek()");
	});

	test("the endpoint never competes with live run numbers", () => {
		// Where og streams from cannot change mid-run, so it is idle-only context.
		for (const width of [80, 120, WIDE, 200]) {
			expect(renderBar(state({ run: RUNNING }), width), String(width)).not.toContain("8127");
		}
	});

	test("withholds the rate until there is a sample, and ttft until first token", () => {
		const line = renderBar(
			state({ run: { tick: 0, phase: "reading context", wallMs: 900, tokensPerSec: 0 } }),
			WIDE,
		);
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
