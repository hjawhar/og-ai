import type { OgConfig } from "../config/schema.ts";
import type { ToolSpec } from "../provider/types.ts";
import type { Tool } from "./types.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createListTool } from "./list.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createBashTool } from "./bash.ts";

/**
 * Stable tool order. The order reaches the model verbatim in the tools array,
 * and small models weight earlier entries more heavily, so inspection tools
 * come before mutation and execution.
 */
export function createTools(cfg: OgConfig): Tool[] {
	return [
		createReadTool(cfg),
		createWriteTool(cfg),
		createEditTool(cfg),
		createListTool(cfg),
		createGlobTool(cfg),
		createGrepTool(cfg),
		createBashTool(cfg),
	];
}

export function toolSpecs(tools: Tool[]): ToolSpec[] {
	return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
