#!/usr/bin/env node
"use strict";

/**
 * npm entry point. This is the one file in the project that runs on Node rather
 * than Bun: `npm i -g @hjawhar/og-cli` has to work for people who do not have
 * Bun, and `og` itself cannot — it uses `bun:sqlite`, `Bun.spawn` and
 * `Bun.Glob`. So the published package ships one `bun build --compile` binary
 * per platform in an optional dependency, and this launcher execs the right one.
 *
 * Keep it CommonJS with no dependencies: it must start on whatever ancient Node
 * the user happens to have, before any of og's own guarantees apply.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** npm resolves exactly one of these, gated by the `os`/`cpu` fields it declares. */
const PACKAGE_BY_TARGET = {
	"linux-x64": "@hjawhar/og-cli-linux-x64",
	"linux-arm64": "@hjawhar/og-cli-linux-arm64",
	"darwin-x64": "@hjawhar/og-cli-darwin-x64",
	"darwin-arm64": "@hjawhar/og-cli-darwin-arm64",
	"win32-x64": "@hjawhar/og-cli-win32-x64",
};

function fail(message) {
	process.stderr.write(`og: ${message}\n`);
	process.exit(1);
}

const target = `${process.platform}-${process.arch}`;
const packageName = PACKAGE_BY_TARGET[target];
if (packageName === undefined) {
	fail(
		`no prebuilt binary for ${target}. Supported: ${Object.keys(PACKAGE_BY_TARGET).join(", ")}.\n` +
			"  Build from source instead: https://github.com/hjawhar/og-cli#from-a-checkout",
	);
}

// Resolve the package's manifest rather than the binary itself: a file with no
// extension is not something every Node resolver will hand back from a subpath.
let binary;
try {
	const manifest = require.resolve(`${packageName}/package.json`);
	binary = path.join(path.dirname(manifest), process.platform === "win32" ? "og.exe" : "og");
} catch {
	fail(
		`${packageName} is not installed.\n` +
			"  It is an optional dependency, so this happens when install ran with --no-optional,\n" +
			"  --omit=optional, or an --os/--cpu override. Reinstall with optional dependencies enabled:\n" +
			"    npm i -g @hjawhar/og-cli --include=optional",
	);
}

if (!fs.existsSync(binary)) fail(`${packageName} is installed but ${binary} is missing; reinstall the package`);

// npm preserves the executable bit inside a tarball, but a few mirrors and
// zip-based caches do not. Restoring it is cheaper than a confusing EACCES.
if (process.platform !== "win32") {
	try {
		fs.accessSync(binary, fs.constants.X_OK);
	} catch {
		try {
			fs.chmodSync(binary, 0o755);
		} catch {
			fail(`${binary} is not executable and its mode could not be changed`);
		}
	}
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) fail(`could not run ${binary}: ${result.error.message}`);
// og exits 130 on SIGINT itself; this path is for a signal that killed it first.
if (result.signal !== null && result.signal !== undefined) {
	process.exit(result.signal === "SIGINT" ? 130 : 1);
}
process.exit(result.status === null ? 1 : result.status);
