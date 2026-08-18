import type { AgentRunOptions } from "../agent/types.ts";
import { approvalPolicyFor, decideApproval, dim, formatError, formatToolEnd, formatToolStart, formatUsage } from "./render.ts";
import { EXIT_ABORTED, EXIT_ERROR, EXIT_MAX_STEPS, EXIT_OK, type HeadlessResult, type UiDeps } from "./types.ts";

/**
 * Non-interactive run of a single prompt. Assistant text goes to stdout; every
 * diagnostic goes to stderr, so `og -p "..." > out.txt` yields exactly the
 * model's answer. With `json: true` stdout is JSONL instead: one line per agent
 * event, then one `result` line.
 */
export async function runHeadless(deps: UiDeps & { prompt: string; json: boolean }): Promise<number> {
	const { config, json, verbose = false } = deps;
	const out = process.stdout;
	const err = process.stderr;

	const controller = new AbortController();
	let interrupted = false;
	const onSigint = (): void => {
		if (interrupted) return;
		interrupted = true;
		if (!json) err.write(`\n${dim("aborting…")}\n`);
		controller.abort();
	};
	process.on("SIGINT", onSigint);

	// The agent's approve() callback delegates here: no human is available, so
	// answer straight from the configured policy and say so on stderr.
	deps.setApprovalHandler?.(async (req) => {
		const approved = decideApproval(config, req);
		if (!approved) {
			err.write(`${formatError(`denied: ${req.summary}`)}\n`);
			err.write(`${dim(`  ${req.tool} needs approval (risk: ${req.risk}) but policy "${approvalPolicyFor(config, req)}" has no interactive session here`)}\n`);
		} else if (verbose) {
			err.write(`${dim(`auto-approved: ${req.summary}`)}\n`);
		}
		return approved;
	});

	let text = "";
	let steps = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	let stopReason: HeadlessResult["stopReason"] = "error";
	let fatal = false;
	let sawDone = false;

	const runOptions: AgentRunOptions = {
		prompt: deps.prompt,
		signal: controller.signal,
		...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
	};

	// Tool names by call id, so `tool-end` can be rendered with the name.
	const toolNames = new Map<string, string>();

	try {
		for await (const event of deps.agent.run(runOptions)) {
			// `resolve` is a closure and must never reach the JSONL stream.
			if (json) out.write(`${JSON.stringify(event.type === "approval" ? { type: "approval", request: event.request } : event)}\n`);
			switch (event.type) {
				case "turn-start":
					if (!json && verbose) err.write(`${dim(`— turn ${event.step} —`)}\n`);
					break;
				case "text":
					text += event.delta;
					if (!json) out.write(event.delta);
					break;
				case "reasoning":
					if (!json && verbose) err.write(dim(event.delta));
					break;
				case "tool-start":
					toolNames.set(event.call.id, event.call.name);
					if (!json) err.write(`${formatToolStart(event.call.name, event.summary)}\n`);
					break;
				case "tool-end":
					if (!json) err.write(`${formatToolEnd(toolNames.get(event.callId) ?? event.callId, event.ok, event.durationMs, event.summary)}\n`);
					break;
				case "approval":
					// Resolution is owned by the handler installed above; both paths
					// race and the loser is ignored, so do not answer twice.
					break;
				case "usage":
					promptTokens += event.promptTokens;
					completionTokens += event.completionTokens;
					if (!json) {
						err.write(
							`${formatUsage(event.promptTokens, event.completionTokens, event.contextUsedPct, event.contextTokens, event.contextWindow)}\n`,
						);
					}
					break;
				case "compaction":
					if (!json) err.write(`${dim(`compacted ${event.removedMessages} messages, freed ${event.freedTokens} tokens`)}\n`);
					break;
				case "error":
					if (event.fatal) fatal = true;
					if (!json) err.write(`${formatError(event.message)}\n`);
					break;
				case "done":
					steps = event.steps;
					stopReason = event.stopReason;
					sawDone = true;
					break;
			}
		}
		if (!sawDone) stopReason = interrupted ? "aborted" : "error";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = interrupted || (error instanceof Error && error.name === "AbortError");
		stopReason = aborted ? "aborted" : "error";
		fatal = stopReason === "error";
		if (json) out.write(`${JSON.stringify({ type: "error", message, fatal })}\n`);
		else err.write(`${formatError(message)}\n`);
		if (verbose && error instanceof Error && error.stack !== undefined) err.write(`${error.stack}\n`);
	} finally {
		process.off("SIGINT", onSigint);
		deps.setApprovalHandler?.(null);
	}

	if (json) {
		const result: HeadlessResult = {
			type: "result",
			text,
			steps,
			stopReason,
			promptTokens,
			completionTokens,
			sessionId: deps.sessionId,
		};
		out.write(`${JSON.stringify(result)}\n`);
	} else if (text !== "" && !text.endsWith("\n")) {
		out.write("\n");
	}

	// Precedence: a real failure outranks an interrupt, which outranks a step cap.
	if (fatal || stopReason === "error") return EXIT_ERROR;
	if (interrupted || stopReason === "aborted") return EXIT_ABORTED;
	if (stopReason === "max-steps") return EXIT_MAX_STEPS;
	return EXIT_OK;
}
