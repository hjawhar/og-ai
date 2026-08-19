/**
 * Pure formatting, but load-bearing: the percentage semantics of `formatUsage`
 * and the width guarantee of `wrap` are what the TUI status line depends on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	elapsed,
	formatContext,
	formatModels,
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
	type ModelsView,
} from "../src/ui/render.ts";
import { DEFAULT_CONFIG } from "../src/config/load.ts";
import type { OgConfig } from "../src/config/schema.ts";
import type { EndpointHealth } from "../src/provider/types.ts";

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

/**
 * `og models` is the only place that tells an operator which model a request will
 * actually reach. og ships no model entries and never starts a server, so the
 * table is assembled from three discovered sources — what the endpoint serves,
 * what is on disk, and what an operator configured — and llama.cpp answers with
 * whatever it loaded no matter which name was asked for.
 */
describe("formatModels", () => {
	const endpoint = "http://127.0.0.1:8127";

	function config(overrides: Partial<OgConfig> = {}): OgConfig {
		return { ...structuredClone(DEFAULT_CONFIG), endpoint, ...overrides };
	}

	/** The active model is passed in, not read from config: the TUI can switch it per session. */
	function models(view: Partial<ModelsView> & { config: OgConfig; health: EndpointHealth }): string {
		return formatModels({ endpoint, active: view.config.model, ...view });
	}

	const serving = (...ids: string[]): EndpointHealth => ({ reachable: true, status: 200, models: ids.map((id) => ({ id })) });

	test("a served model with no configured entry is listed, with the fallback window named", () => {
		const out = models({ config: config(), health: serving("served-a") });
		expect(out).toContain("served-a");
		expect(out).toContain("serving now");
		// og carries no window for it, and says so rather than inventing one.
		expect(out).toMatch(/window 32768 \(og's fallback/);
	});

	test("the window the server reported wins, and is labelled as served", () => {
		const health: EndpointHealth = { reachable: true, status: 200, models: [{ id: "served-a", contextWindow: 8192 }] };
		const out = models({ config: config(), health });
		expect(out).toContain("window 8192 (as served)");
		expect(out).not.toContain("fallback");
	});

	test("a configured window that disagrees with the served one shows both", () => {
		// The disagreement that makes a server truncate a prompt silently.
		const cfg = config({ model: "local", models: { local: { contextWindow: 32768 } } });
		const health: EndpointHealth = { reachable: true, status: 200, models: [{ id: "local", contextWindow: 8192 }] };
		const out = models({ config: cfg, health });
		expect(out).toContain("window 8192 (as served)");
		expect(out).toContain("configured 32768");
	});

	test("weights on disk are listed, plainly marked as not loaded", () => {
		const out = models({ config: config(), health: serving("served-a"), installed: ["Some-Model-Q4_K_M.gguf", "served-a.gguf"] });
		// The file, without its extension, which is the name a server would give it.
		expect(out).toContain("Some-Model-Q4_K_M");
		expect(out).toContain("on disk, not loaded");
		// The served one is not listed twice just because its file is also there.
		expect(out.match(/served-a/g)?.length).toBe(1);
	});

	test("an active model the endpoint is not serving is called out with the fix", () => {
		const cfg = config({ model: "pinned", models: { pinned: { contextWindow: 4096 } } });
		const out = models({ config: cfg, health: serving("served-a") });
		expect(out).toContain("the active model pinned is not what");
		expect(out).toContain("og models use served-a");
	});

	test("nothing discovered yet is not reported as a mismatch", () => {
		// `model: ""` is the shipped state; there is no wrong name to warn about.
		const out = models({ config: config(), health: serving("served-a") });
		expect(out).not.toContain("is not what");
	});

	test("the mismatch is judged against the session's model, not the config default", () => {
		const cfg = config({ model: "one", models: { one: { contextWindow: 4096 }, two: { contextWindow: 4096 } } });
		expect(models({ config: cfg, health: serving("two"), active: "two" })).not.toContain("is not what");
		expect(models({ config: cfg, health: serving("two"), active: "one" })).toContain("the active model one");
	});

	test("a served id is matched through a spec's `id` override, not just its key", () => {
		const cfg = config({ model: "local", models: { local: { contextWindow: 16384, id: "served-under-another-name" } } });
		const out = models({ config: cfg, health: serving("served-under-another-name") });
		expect(out).toContain("local");
		expect(out).toContain("window 16384");
		expect(out).not.toContain("is not what");
	});

	test("an unreachable endpoint claims nothing about what is loaded", () => {
		const cfg = config({ model: "pinned", models: { pinned: { contextWindow: 4096 } } });
		const out = models({ config: cfg, health: { reachable: false, detail: "ECONNREFUSED" } });
		expect(out).toContain("nothing answered at http://127.0.0.1:8127");
		expect(out).toContain("ECONNREFUSED");
		// "not loaded" would be a claim this probe cannot make.
		expect(out).not.toContain("not loaded");
		expect(out).toContain("pinned");
	});

	test("weights on disk still list with the endpoint down: that is a filesystem fact", () => {
		const out = models({ config: config(), health: { reachable: false, detail: "ECONNREFUSED" }, installed: ["Some-Model-Q4_K_M.gguf"] });
		expect(out).toContain("Some-Model-Q4_K_M");
		expect(out).toContain("on disk, not loaded");
	});

	test("answering while naming no model reads as loading, not as empty", () => {
		const out = models({ config: config(), health: { reachable: true, status: 200, models: [] } });
		expect(out).toContain("named no model");
		expect(out).toContain("still loading");
	});

	test("a model on another endpoint is not reported as unloaded by this probe", () => {
		const cfg = config({ models: { remote: { contextWindow: 8192, endpoint: "https://api.example.com" } } });
		// Not served and not active, so it only appears in the full listing.
		const out = models({ config: cfg, health: serving("served-a"), all: true });
		expect(out).toContain("other endpoint https://api.example.com");
	});

	test("configured entries beyond the active one are counted, and --all prints them", () => {
		const cfg = config({
			model: "one",
			models: { one: { contextWindow: 4096 }, two: { contextWindow: 4096 }, three: { contextWindow: 4096 } },
		});
		const short = models({ config: cfg, health: serving("served-a") });
		expect(short).toContain("2 more configured and not being served");
		expect(short).not.toContain("three");
		const long = models({ config: cfg, health: serving("served-a"), all: true });
		expect(long).toContain("three");
		expect(long).not.toContain("more configured");
	});
});
