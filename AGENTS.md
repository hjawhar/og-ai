# og — project context

Local-first agentic coding CLI. Bun + TypeScript, no runtime dependencies, GPU inference via a
supervised `llama-server`.

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
- `test/<area>.test.ts`; `llama-cpp-installation/` engine install (`install-engine.sh` for Linux,
  `install-engine.ps1` for Windows) — the only part of the tree that knows how llama.cpp is built;
  `tools/` og's own CLI installers (`.sh` + `.ps1`) and the PowerShell benchmark scripts; `docs/`.

## Ownership rules

One concern per module. Only `engine/args.ts` builds argv; only `sandbox.ts` resolves
model-supplied paths; only `ui/render.ts` formats output (never `console.log` from `agent/**`
or `tools/**`); only `session/store.ts` touches SQL. UI consumes `AgentEvent`, never the
provider. `src/index.ts` stays thin and lazy-`import()`s heavy modules.

## Hard rules

- **Zero runtime dependencies.** devDependencies are `typescript` and `@types/bun`, full stop.
  Reach for Bun builtins (`Bun.spawn`, `Bun.Glob`, `Bun.serve`, `bun:sqlite`), not a package.
- **Imports carry the `.ts` extension**; type-only imports use `import type`
  (`verbatimModuleSyntax`).
- **Strict TS**: `exactOptionalPropertyTypes` (omit optional fields, never assign
  `undefined`), `noUncheckedIndexedAccess` (index access is `T | undefined`),
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.
- **No stubs**: no `TODO: implement`, no placeholder returns, no fake fallbacks.

## Commands

- `bun test` — full suite; `bun test test/config.test.ts` — one file.
- `bun x tsc --noEmit` — typecheck (also `bun run typecheck`).
- `bun run src/index.ts --help`, `... models`, `... engine status` — CLI smoke checks.
- `bun run build` — `dist/og` (`dist/og.exe` when built on Windows).
- `bun run tools/release.ts` — cross-compiles all five npm targets into `dist/npm/` and verifies
  the host binary; `--publish` also publishes. `--targets linux-x64` builds a subset.

Distribution: the published package is `@hjawhar/og-cli`, exposing one bin named `og`. It carries
only `bin/og.cjs`, a Node launcher, plus `optionalDependencies` on five platform packages
(`@hjawhar/og-cli-<platform>-<arch>`) that each hold one `bun build --compile` binary. `og` cannot
run on Node — that launcher is the single exception in the tree, which is why it is `.cjs` (the
root package is `"type": "module"`) and why it has no dependencies of its own. Bumping the version
means bumping it in `optionalDependencies` too; `tools/release.ts` refuses to build otherwise.

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
- Measured numbers only: VRAM and throughput figures in `load.ts` and `docs/` come from real
  runs; do not adjust them without re-measuring.
- Comments explain *why* (a constraint, a measurement, a failure mode), not *what*.
