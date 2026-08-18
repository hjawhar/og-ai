/**
 * Resolves the configured profile into a concrete Provider instance.
 */

import { profileOf } from "../config/load.ts";
import type { OgConfig } from "../config/schema.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

const LOOPBACK_HOSTS: Record<string, true> = {
	localhost: true,
	"127.0.0.1": true,
	"0.0.0.0": true,
	"::1": true,
	"[::1]": true,
	"::": true,
};

/**
 * True when the endpoint is a llama.cpp-shaped local server, in which case the
 * model name is ignored by the backend and "local" is the honest identifier.
 */
function isLocalEndpoint(endpoint: string): boolean {
	const forced = process.env["OG_LOCAL_ENDPOINT"]?.trim().toLowerCase();
	if (forced !== undefined && forced !== "" && !["0", "false", "no", "off"].includes(forced)) return true;
	try {
		const host = new URL(endpoint).hostname.toLowerCase();
		return LOOPBACK_HOSTS[host] === true || host.endsWith(".localhost");
	} catch {
		return false;
	}
}

export function createProvider(cfg: OgConfig): Provider {
	const key = cfg.model;
	const profile = profileOf(cfg, key);
	return new OpenAIProvider({
		id: key,
		endpoint: cfg.endpoint,
		model: isLocalEndpoint(cfg.endpoint) ? "local" : key,
		contextWindow: profile.contextWindow,
		nativeToolCalls: true,
		...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
	});
}
