# og-ai — repository context

Two projects, one concern each, side by side. This file is the **only** `AGENTS.md` in the
repository: it covers both, and neither subdirectory carries its own.

```
og-ai/
  og-cli/         the coding CLI — agent loop, tools, sessions, TUI
  og-llama-cpp/   the inference engine — installers, benchmarks, the pinned llama.cpp build
```

One git repository — [`hjawhar/og-ai`](https://github.com/hjawhar/og-ai) — holding two projects,
with no workspace-level build, lockfile or package. `bun install`, `bun test` and
`bun x tsc --noEmit` are run **inside** one subdirectory or the other, never from here.

The boundary is HTTP. `og-cli` spawns and supervises whatever OpenAI-compatible server its
`endpoint` names; `og-llama-cpp` produces such a server and does not know `og` exists. Nothing in
either tree imports from the other. The only couplings are documentary and are listed under
"Cross-project rules" below — keep it that way. A change that makes one project need the
other's source to build is wrong. Living in one repository is a packaging convenience, not
permission to couple them.

## Shared hard rules

Both trees are Bun + TypeScript and obey these identically:

- **Zero runtime dependencies.** devDependencies are `typescript` and `@types/bun`, full stop.
  Reach for Bun builtins (`Bun.spawn`, `Bun.Glob`, `Bun.serve`, `Bun.file`, `bun:sqlite`), not a
  package.
- **Imports carry the `.ts` extension**; type-only imports use `import type`
  (`verbatimModuleSyntax`).
- **Strict TS**: `exactOptionalPropertyTypes` (omit optional fields, never assign `undefined`),
  `noUncheckedIndexedAccess` (index access is `T | undefined`), `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.
- **No stubs**: no `TODO: implement`, no placeholder returns, no fake fallbacks.
- **No CI.** There are no GitHub Actions workflows and nothing is published to any registry.
  Verification is local and manual — the commands below are the whole contract.
- **Measured numbers only.** Every VRAM and throughput figure in either tree comes from a real run
  on the reference box, recorded in `og-llama-cpp/docs/benchmarks.md`. Do not adjust one without
  re-measuring and saying on what.
- Comments explain *why* (a constraint, a measurement, a failure mode), not *what*.

---

# og-cli

Local-first agentic coding CLI. GPU inference via a supervised `llama-server`.

## Layout

- `src/config/` — `schema.ts` (types + `ConfigError`), `load.ts` (`DEFAULT_CONFIG`,
  `loadConfig`, `profileOf`). Layering: defaults <- `~/.og/config.json` <-
  `<ws>/.og/config.json` <- `OG_*` env <- CLI overrides. Objects merge, arrays replace.
- `src/provider/` — `openai.ts` streaming SSE client (`ProviderError`: retryable on
  408/429/5xx + transport); `registry.ts` `createProvider`.
- `src/engine/` — `args.ts` pure argv (`buildServerArgs`, `resolveModelPath`);
  `supervisor.ts` start/adopt/status/stop.
- `src/tools/` — `read write edit ls glob grep bash`; `sandbox.ts` confinement;
  `state.ts` read-before-overwrite gate.
- `src/agent/` — `loop.ts` turn loop, `prompt.ts` system prompt, `context.ts` tokens +
  compaction. `src/session/store.ts` — `bun:sqlite`, WAL.
- `src/ui/` — `render.ts` pure formatters, `chrome.ts` pinned-row content, `statusbar.ts`
  DECSTBM row reservation, `sysinfo.ts` `/stats` collection, `completion.ts` Tab + shell
  completion, `tui.ts`, `headless.ts`; `src/index.ts` the CLI.
- `test/<area>.test.ts`; `docs/runbook.md` operations.

## Ownership rules

One concern per module. Only `engine/args.ts` builds argv; only `sandbox.ts` resolves
model-supplied paths; only `ui/render.ts` formats output (never `console.log` from `agent/**`
or `tools/**`); only `session/store.ts` touches SQL. UI consumes `AgentEvent`, never the
provider. `src/index.ts` stays thin and lazy-`import()`s heavy modules.

## Commands

Run from `og-cli/`:

- `bun test` — full suite; `bun test test/config.test.ts` — one file.
- `bun x tsc --noEmit` — typecheck (also `bun run typecheck`).
- `bun run src/index.ts --help`, `... models`, `... engine status` — CLI smoke checks.
- `bun run build` — `dist/og` (`dist/og.exe` when built on Windows).

Distribution: none. `og` is built from source — `bun build --compile` emits a self-contained
`dist/og` that embeds its runtime, and you copy it onto `PATH`. It cannot run on Node
(`bun:sqlite`, `Bun.spawn`, `Bun.Glob`), and there is no package to publish, no launcher shim and
no version to keep in sync anywhere but `package.json`.

Tests are deterministic and isolated: temp dirs via `fs.mkdtempSync(path.join(os.tmpdir(),
...))` cleaned up after; no real `llama-server`, no `~/.og`, no network beyond a test-owned
`Bun.serve` on port 0.

## Conventions

- **Tool result summaries never repeat the tool name** — `render.ts` prints it. Use
  `src/foo.ts: 42 lines (complete)`, not `read src/foo.ts: ...`. Approval summaries stand
  alone, so those do lead with the tool (`bash: rm -rf build`).
- **`contextUsedPct` is a percentage (0-100)**, never a 0-1 fraction. The same `usage` event
  also carries absolute `contextTokens` / `contextWindow`; UIs draw gauges from those rather
  than recomputing history. `progressBar(fraction, width)` is the one place that takes a 0-1
  fraction, and it clamps.
- **The pinned row is the only place run state is drawn.** `statusbar.ts` reserves terminal
  row 1 with a scroll region; nothing else prints a context gauge, and the region is released
  on every exit path. Transcript writers never repaint a row they do not own.
- **Slash vocabulary lives in `COMMAND_NAMES` / `COMMAND_SUBCOMMANDS`** in `tui.ts`; `/help`,
  the dispatcher and Tab completion all read them, so a command cannot be half-registered.
  The CLI vocabulary mirrored into shell scripts lives in `completion.ts`.
- **Paths surfaced to the model are workspace-relative with forward slashes** (`relative()` /
  `toPosix()`), never absolute Windows paths with backslashes.
- Errors are typed: `ConfigError`, `ProviderError`, `SandboxError`, `ToolValidationError`.
  Never throw bare `Error` from a module that has one.

---

# og-llama-cpp

Installs and measures a pinned llama.cpp CUDA `llama-server`. Knows nothing about any client: it
produces a server that speaks OpenAI-compatible HTTP from a flat, self-contained install
directory.

## Layout

- `install-engine.sh` — Linux. Compiles the pinned tag with CUDA; upstream ships no Linux CUDA
  release asset, so this is the only way to get one.
- `install-engine.ps1` — Windows. Unzips the prebuilt upstream CUDA release plus the cudart zip.
- `tools/bench.ts` — raw kernel ceiling via `llama-bench` (pp/tg, no KV-cache pressure).
- `tools/profile-sweep.ts` — starts `llama-server` per case, samples VRAM, measures prefill and
  generation throughput, tears it down.
- `docs/benchmarks.md` — the measurement record. `docs/upgrading.md` — the build-bump drill.
  `docs/building-by-hand.md` — the manual CMake path.

## Ownership rules

Both installers must produce the identical shape: `<root>/<build>/` holding `llama-server` next
to every `.so`/`.dll` it loads, plus a `current` symlink (junction on Windows) pointing at it.
That flatness is the contract — clients spawn `<binDir>/llama-server` with a bare argv, no
`LD_LIBRARY_PATH` and no environment fixup, so the server must find its own libraries. Only the
installers write under `$OG_LLAMA_ROOT`; the measurement tools only read from it.

The measurement tools are operator tooling: **self-contained by design**, one file each, no
shared helper module, no imports outside `node:*` and Bun builtins. Duplication between them is
accepted so either can be copied to another box on its own.

**Both scripts must tear the GPU down.** `profile-sweep.ts` kills the whole pid tree and traps
`SIGINT`/`SIGTERM`; a Ctrl-C that leaks a `llama-server` holding 15 GiB is a bug.

## Commands

Run from `og-llama-cpp/`:

- `bun run tools/bench.ts --help`, `bun run tools/profile-sweep.ts --help` — usage.
- `bun x tsc --noEmit` — typecheck (also `bun run typecheck`).
- `./install-engine.sh` — Linux install; `OG_LLAMA_BUILD=bNNNNN` bumps the tag.
- `powershell -ExecutionPolicy Bypass -File .\install-engine.ps1` — Windows install.
- `~/.local/llama.cpp/current/llama-server --list-devices` — the one check that matters after an
  install: it must name a CUDA device. A CPU-only build loads models and runs ~100x slower.

There is no test suite. Everything here needs a GPU and minutes of wall time; the verification is
`--list-devices` plus a re-run of the sweep, compared against `docs/benchmarks.md`.

## Conventions

- Pinned build lives in exactly two places — `$build` in `install-engine.ps1` and the
  `OG_LLAMA_BUILD` default in `install-engine.sh`. Docs quote it; they do not define it.
- Env knobs are shared and identically named across both installers: `OG_LLAMA_BUILD`,
  `OG_LLAMA_ROOT`, plus the Linux-only `OG_LLAMA_SRC`, `CUDA_PATH`, `OG_CUDA_ARCH`,
  `OG_BUILD_JOBS`. PowerShell mirrors the first two as `-Build` / `-Root`.
- Re-running an installer is cheap and safe: CMake reuses the build tree and files are renamed
  into place, so a running server keeps its mapped inode until its next start.

---

## Cross-project rules

Three couplings exist. All three are documentary, and each has exactly one direction:

1. **Profile numbers.** Every operating point in `og-cli/src/config/load.ts` — context size,
   `nCpuMoe`, `ngl`, the VRAM figures quoted in its README — is copied from
   `og-llama-cpp/docs/benchmarks.md`. Changing one in `og-cli` without a re-run in
   `og-llama-cpp` makes the record a lie.
2. **`llama-server` flag names.** Only `og-cli/src/engine/args.ts` builds the argv, and its flags
   were verified against b10488's `llama-server --help`. Bumping the pinned build in
   `og-llama-cpp` means re-checking them — see `og-llama-cpp/docs/upgrading.md`.
3. **The install-directory shape.** `og-cli`'s `engine.binDir` assumes the flat layout both
   installers produce. Either installer changing that layout breaks the supervisor.

Working on both at once: make the engine-side change and re-measure first, then update `og-cli`
against the new record. Never the other way round.
