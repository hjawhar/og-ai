/**
 * Builds the publishable npm packages: one root package that people install and
 * five platform packages that carry the actual binary.
 *
 * Why this shape: `og` runs on Bun APIs (`bun:sqlite`, `Bun.spawn`, `Bun.Glob`)
 * and can never run on Node, but `npm i -g` has to work for people who do not
 * have Bun. So the root package ships only the Node launcher (`bin/og.js`) and
 * declares the five platform packages as optionalDependencies; npm installs
 * exactly the one whose `os`/`cpu` match, and the launcher execs it.
 *
 * Usage:
 *   bun run tools/release.ts              build + assemble + verify, publish nothing
 *   bun run tools/release.ts --publish    the above, then npm publish all six
 *   bun run tools/release.ts --targets linux-x64,win32-x64
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

interface Target {
	/** npm platform-package suffix, also `${process.platform}-${process.arch}`. */
	id: string;
	/** `bun build --compile --target` value. */
	bunTarget: string;
	npmOs: string;
	npmCpu: string;
}

const TARGETS: readonly Target[] = [
	{ id: "linux-x64", bunTarget: "bun-linux-x64", npmOs: "linux", npmCpu: "x64" },
	{ id: "linux-arm64", bunTarget: "bun-linux-arm64", npmOs: "linux", npmCpu: "arm64" },
	{ id: "darwin-x64", bunTarget: "bun-darwin-x64", npmOs: "darwin", npmCpu: "x64" },
	{ id: "darwin-arm64", bunTarget: "bun-darwin-arm64", npmOs: "darwin", npmCpu: "arm64" },
	{ id: "win32-x64", bunTarget: "bun-windows-x64", npmOs: "win32", npmCpu: "x64" },
];

const repoRoot = path.resolve(import.meta.dir, "..");
const outDir = path.join(repoRoot, "dist", "npm");

function die(message: string): never {
	process.stderr.write(`release: ${message}\n`);
	process.exit(1);
}

function run(cmd: readonly string[], cwd: string): void {
	const proc = Bun.spawnSync([...cmd], { cwd, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
	if (!proc.success) die(`${cmd.join(" ")} failed with exit code ${proc.exitCode}`);
}

interface RootManifest {
	name: string;
	version: string;
	description: string;
	license: string;
	optionalDependencies: Record<string, string>;
}

async function readRootManifest(): Promise<RootManifest> {
	const raw = (await Bun.file(path.join(repoRoot, "package.json")).json()) as Partial<RootManifest>;
	const { name, version, description, license, optionalDependencies } = raw;
	if (
		typeof name !== "string" ||
		typeof version !== "string" ||
		typeof description !== "string" ||
		typeof license !== "string" ||
		optionalDependencies === undefined
	) {
		die("package.json is missing name, version, description, license or optionalDependencies");
	}
	return { name, version, description, license, optionalDependencies };
}

/**
 * The root manifest is tracked in git, so this checks rather than rewrites: a
 * version bump that forgets the optionalDependencies would publish a root
 * package that can never resolve a binary, and that is worth failing loudly for.
 */
function checkVersionsAgree(root: RootManifest, selected: readonly Target[]): void {
	const problems: string[] = [];
	for (const target of selected) {
		const pkg = `${root.name}-${target.id}`;
		const declared = root.optionalDependencies[pkg];
		if (declared === undefined) problems.push(`package.json declares no optionalDependency ${pkg}`);
		else if (declared !== root.version) {
			problems.push(`optionalDependencies["${pkg}"] is ${declared}, expected ${root.version}`);
		}
	}
	if (problems.length > 0) die(problems.join("\n         "));
}

function platformManifest(root: RootManifest, target: Target): string {
	return `${JSON.stringify(
		{
			name: `${root.name}-${target.id}`,
			version: root.version,
			description: `${root.description} — prebuilt binary for ${target.id}`,
			license: root.license,
			repository: { type: "git", url: "git+https://github.com/hjawhar/og-cli.git" },
			os: [target.npmOs],
			cpu: [target.npmCpu],
			files: [target.npmOs === "win32" ? "og.exe" : "og"],
			publishConfig: { access: "public" },
		},
		null,
		2,
	)}\n`;
}

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const only = ((): readonly Target[] => {
	const flag = args.indexOf("--targets");
	if (flag === -1) return TARGETS;
	const list = args[flag + 1];
	if (list === undefined) die("--targets needs a comma-separated list of target ids");
	const wanted = list.split(",").map((id) => id.trim());
	const selected = TARGETS.filter((target) => wanted.includes(target.id));
	const unknown = wanted.filter((id) => !TARGETS.some((target) => target.id === id));
	if (unknown.length > 0) die(`unknown target(s): ${unknown.join(", ")}`);
	return selected;
})();

const root = await readRootManifest();
checkVersionsAgree(root, only);

// A partial target list can still be assembled for a smoke test, but it must
// never be published: the root package would promise binaries that do not exist.
if (publish && only.length !== TARGETS.length) die("--publish requires all targets; drop --targets");

// Publishing a package whose license field and LICENSE file disagree — or whose
// license nobody set — is the kind of thing that is only ever noticed later.
const licenseText = await Bun.file(path.join(repoRoot, "LICENSE")).text();
if (licenseText.trim() === "") die("LICENSE is missing or empty");
if (root.license === "UNLICENSED") die('package.json license is still "UNLICENSED"');
if (!licenseText.includes(root.license)) {
	die(`LICENSE does not mention "${root.license}" from package.json; one of the two is stale`);
}

process.stdout.write(`${root.name} ${root.version}\n`);
rmSync(outDir, { recursive: true, force: true });

for (const target of only) {
	const pkgDir = path.join(outDir, `${root.name}-${target.id}`.replace("/", path.sep));
	mkdirSync(pkgDir, { recursive: true });
	const binary = path.join(pkgDir, target.npmOs === "win32" ? "og.exe" : "og");
	process.stdout.write(`  building ${target.id} ...\n`);
	run(
		[
			"bun",
			"build",
			"--compile",
			"--minify",
			`--target=${target.bunTarget}`,
			`--outfile=${binary}`,
			path.join("src", "index.ts"),
		],
		repoRoot,
	);
	if (!existsSync(binary)) die(`bun produced no binary at ${binary}`);
	await Bun.write(path.join(pkgDir, "package.json"), platformManifest(root, target));
	// npm only auto-includes a LICENSE that sits in the package directory, and
	// each platform package is published on its own, so each needs its own copy.
	await Bun.write(path.join(pkgDir, "LICENSE"), licenseText);
}

// The launcher lives in the root package; verify the host binary actually runs
// and reports the version being released, which is the cheapest end-to-end
// check that the compile step produced something usable rather than merely big.
const hostTarget = `${process.platform}-${process.arch}`;
const host = only.find((target) => target.id === hostTarget);
if (host === undefined) {
	process.stdout.write(`  skipping run check: no ${hostTarget} target in this build\n`);
} else {
	const binary = path.join(
		outDir,
		`${root.name}-${host.id}`.replace("/", path.sep),
		host.npmOs === "win32" ? "og.exe" : "og",
	);
	const proc = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const reported = new TextDecoder().decode(proc.stdout).trim();
	if (!proc.success || reported !== root.version) {
		die(`${binary} --version printed "${reported}", expected "${root.version}"`);
	}
	process.stdout.write(`  ${host.id} binary reports ${reported}\n`);
}

process.stdout.write(`  assembled ${only.length} platform package(s) in ${path.relative(repoRoot, outDir)}\n`);

if (!publish) {
	process.stdout.write("  nothing published (pass --publish to release)\n");
	process.exit(0);
}

// Platform packages first: the root package's optionalDependencies must be
// resolvable the moment it appears in the registry.
for (const target of only) {
	const pkgDir = path.join(outDir, `${root.name}-${target.id}`.replace("/", path.sep));
	process.stdout.write(`  publishing ${root.name}-${target.id} ...\n`);
	run(["npm", "publish", "--access", "public"], pkgDir);
}
process.stdout.write(`  publishing ${root.name} ...\n`);
run(["npm", "publish", "--access", "public"], repoRoot);
process.stdout.write(`\npublished ${root.name}@${root.version} for ${only.length} platforms\n`);
process.stdout.write(`install with: npm i -g ${root.name}\n`);
