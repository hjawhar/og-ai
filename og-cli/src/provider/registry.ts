/**
 * Resolves the active model spec into a concrete Provider instance.
 */

import { modelSpecOf } from "../config/load.ts";
import { ConfigError, type OgConfig } from "../config/schema.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

export function createProvider(cfg: OgConfig): Provider {
	const key = cfg.model;
	const spec = modelSpecOf(cfg, key);

	// A named env var is an explicit statement that this model needs a key, so an
	// unset one is a configuration error, not a reason to send an anonymous request
	// and read a 401 back from the server.
	let apiKey = cfg.apiKey;
	if (spec.apiKeyEnv !== undefined) {
		const fromEnv = process.env[spec.apiKeyEnv];
		if (fromEnv === undefined || fromEnv === "") {
			throw new ConfigError(
				`model "${key}" sets apiKeyEnv "${spec.apiKeyEnv}" but that environment variable is empty or unset`,
			);
		}
		apiKey = fromEnv;
	}

	return new OpenAIProvider({
		id: key,
		endpoint: spec.endpoint ?? cfg.endpoint,
		model: spec.id ?? key,
		contextWindow: spec.contextWindow,
		nativeToolCalls: true,
		...(apiKey ? { apiKey } : {}),
		...(spec.headers ? { headers: spec.headers } : {}),
	});
}
