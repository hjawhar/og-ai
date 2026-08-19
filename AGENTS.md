# og-ai — repository context

Two projects, one concern each, side by side. This file is the **only** `AGENTS.md` in the
repository: it covers both, and neither subdirectory carries its own.

```
og-ai/
  og-cli/         the coding CLI — agent loop, tools, sessions, TUI. An HTTP client, nothing more
  og-llama-cpp/   the inference server — installers, launcher, browser UI, benchmarks, the pinned llama.cpp build
```

One git repository — [`hjawhar/og-ai`](https://github.com/hjawhar/og-ai) — holding two projects,
with no workspace-level build, lockfile or package. `bun install`, `bun test` and
`bun x tsc --noEmit` are run **inside** one subdirectory or the other, never from here.

The boundary is HTTP, and it is the entire relationship. `og-cli` is a *client*: it POSTs
OpenAI-compatible chat completions to whatever `endpoint` names and streams the reply. It does not
start, adopt, restart or stop an inference server, and it has no concept of weights, VRAM or
offload split. `og-llama-cpp` produces such a server — installs it, builds its argv, runs it,
measures it — and does not know `og` exists. Nothing in either tree imports from the other. The one
surviving coupling is documentary and is described under "Cross-project rules" below — keep it that
way. A change that makes one project need the other's source to build is wrong, and so is a change
that puts server lifecycle back in the client. Living in one repository is a packaging convenience,
not permission to couple them.

## Shared hard rules

Both trees are Bun + TypeScript and obey these identically. The single departure — the Angular
workspace under `og-llama-cpp/ui/` — is named in the second bullet rather than left implicit:

- **Zero runtime dependencies in every Bun file.** `og-cli/src/**`, `og-llama-cpp/serve.ts`,
  `og-llama-cpp/tools/**` and `og-llama-cpp/ui/server/**` import `node:*` and Bun builtins
  (`Bun.spawn`, `Bun.Glob`, `Bun.serve`, `Bun.file`, `bun:sqlite`) and nothing else; the only
  devDependencies are `typescript` and `@types/bun`, full stop.
- **One exception, and exactly one: `og-llama-cpp/ui/`.** The browser app is an Angular +
  TailwindCSS workspace with its own `package.json`, its own npm devDependencies (Angular CLI,
  `tailwindcss`, SCSS) and a real build step — `npm run build` into `ui/dist/ui/browser`, which
  the Bun server under `ui/server/**` then serves as static files. Angular CLI needs Node, so
  that directory is driven with `npm`/`npx`, never `bun install`. Nowhere else in the repository
  has a dependency, a bundler or a build step, and nothing outside `ui/src/` imports from it.
- **Imports carry the `.ts` extension** in every Bun file; type-only imports use `import type`
  (`verbatimModuleSyntax`). Inside `og-llama-cpp/ui/src/` the Angular compiler resolves modules,
  so imports there are extensionless — the one place that differs.
- **Strict TS**: `exactOptionalPropertyTypes` (omit optional fields, never assign `undefined`),
  `noUncheckedIndexedAccess` (index access is `T | undefined`), `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.
- **No stubs**: no `TODO: implement`, no placeholder returns, no fake fallbacks.
- **No CI.** There are no GitHub Actions workflows and nothing is published to any registry.
  Verification is local and manual — the commands below are the whole contract.
- **Measured numbers only.** Every VRAM and throughput figure in either tree comes from a real run
  on the reference box, recorded in `og-llama-cpp/docs/benchmarks.md`. Do not adjust one without
  re-measuring and saying on what. One carve-out, in one file: `og-llama-cpp/ui/server/compute.ts`
  holds vendor-published SM counts and boost clocks so the UI can show a card's **peak** FLOPS and
  TOPS. Those are labelled "peak" wherever they surface, every row is cross-checked against
  NVIDIA's own published FP32 figure in `og-llama-cpp/test/compute.test.ts`, an unlisted card gets
  no peak instead of a guess, and none of it is ever copied into `docs/benchmarks.md`.
- Comments explain *why* (a constraint, a measurement, a failure mode), not *what*.

---

# og-cli

Agentic coding CLI for any OpenAI-compatible endpoint — local-first by default, and a client only.
Something else runs the server; `og` dials it and streams.

## Layout

- `src/config/` — `schema.ts` (types + `ConfigError`), `load.ts` (`DEFAULT_CONFIG`,
  `loadConfig`, `modelSpecOf`). Layering: defaults <- `~/.og/config.json` <-
  `<ws>/.og/config.json` <- `OG_*` env <- CLI overrides. Objects merge, arrays replace. A `model`
  that is not a key of `models` is synthesised into one, so `-m <any-name>` works with no config
  file at all.
- `src/provider/` — **the only code in the tree that opens a socket.** `openai.ts` streaming SSE
  client plus the `health()` preflight (`ProviderError`: retryable on 408/429/5xx + transport);
  `registry.ts` `createProvider` resolves wire model id, endpoint, bearer token and extra headers
  from the active `ModelSpec`.
- `src/tools/` — `read write edit ls glob grep bash`; `sandbox.ts` confinement;
  `state.ts` read-before-overwrite gate.
- `src/agent/` — `loop.ts` turn loop, `prompt.ts` system prompt, `context.ts` tokens +
  compaction. `src/session/store.ts` — `bun:sqlite`, WAL.
- `src/ui/` — `render.ts` pure formatters, `chrome.ts` pinned-row content, `statusbar.ts`
  DECSTBM row reservation, `sysinfo.ts` `/stats` collection, `completion.ts` Tab + shell
  completion, `tui.ts`, `headless.ts`; `src/index.ts` the CLI.
- `test/<area>.test.ts`; `docs/runbook.md` operations.

The only `Bun.spawn` in this tree is in `src/tools/bash.ts`. `og` starts no other child process —
not an engine, not a helper, not `nvidia-smi`.

## Ownership rules

One concern per module. Only `sandbox.ts` resolves model-supplied paths; only `ui/render.ts`
formats output (never `console.log` from `agent/**` or `tools/**`); only `session/store.ts` touches
SQL; only `provider/**` performs network I/O. UI consumes `AgentEvent`, never the provider.
`src/index.ts` stays thin and lazy-`import()`s heavy modules.

**`og-cli` never spawns or supervises an inference server.** No autostart, no adopt, no pid file,
no log file it tails, no VRAM probe. One `provider.health()` call before a run is the whole extent
of its interest in the endpoint's liveness: reachable, or a `ConfigError` naming the endpoint. The
only place in this repository that builds a `llama-server` argv is `og-llama-cpp/serve.ts`.

## Commands

Run from `og-cli/`:

- `bun test` — full suite; `bun test test/config.test.ts` — one file.
- `bun x tsc --noEmit` — typecheck (also `bun run typecheck`).
- `bun run src/index.ts --help`, `... models`, `... sessions list` — CLI smoke checks; none of
  these need a server. Anything that runs a turn (`... -p "reply with the single word ready"`)
  needs an OpenAI-compatible server **already listening** at `endpoint` — bring one up with
  `bun run serve.ts` in `og-llama-cpp/`, or point `--endpoint` at a hosted API.
- `bun run build` — `dist/og` (`dist/og.exe` when built on Windows).
- `./install.sh` — build plus install onto `PATH`; `--dest DIR` / `OG_INSTALL_DIR` override
  `~/.local/bin`, `--add-to-path` writes the shell rc file (and the Windows registry user `Path`)
  idempotently. Ubuntu, macOS and Windows Git Bash/MSYS2 in one script; it is the only place that
  knows the platform `.exe` suffix, which rc file a login shell reads (`~/.bash_profile` on
  Windows, never `~/.bashrc`), and the per-platform PATH edit.

Distribution: none. `og` is built from source — `bun build --compile` emits a self-contained
`dist/og` that embeds its runtime, and `install.sh` copies it onto `PATH`. It cannot run on Node
(`bun:sqlite`, `Bun.spawn`, `Bun.Glob`), and there is no package to publish, no launcher shim and
no version to keep in sync anywhere but `package.json`.

Tests are deterministic and isolated: temp dirs via `fs.mkdtempSync(path.join(os.tmpdir(),
...))` cleaned up after; no real inference server, no `~/.og`, no network beyond a test-owned
`Bun.serve` on port 0.

## Conventions

- **Tool result summaries never repeat the tool name** — `render.ts` prints it. Use
  `src/foo.ts: 42 lines (complete)`, not `read src/foo.ts: ...`. Approval summaries stand
  alone, so those do lead with the tool (`bash: rm -rf build`).
- **`contextUsedPct` is a percentage (0-100)**, never a 0-1 fraction. The same `usage` event
  also carries absolute `contextTokens` / `contextWindow`; UIs draw gauges from those rather
  than recomputing history. `progressBar(fraction, width)` is the one place that takes a 0-1
  fraction, and it clamps.
- **The pinned row is the only place run state is drawn.** `statusbar.ts` reserves terminal row 1
  with a scroll region; nothing else prints a context gauge, and the region is released on every
  exit path. Transcript writers never repaint a row they do not own. The row carries model,
  workspace, phase and context occupancy — never engine or VRAM state, which a client cannot
  observe and no longer pretends to.
- **Slash vocabulary lives in `COMMAND_NAMES` / `COMMAND_SUBCOMMANDS`** in `tui.ts`; `/help`,
  the dispatcher and Tab completion all read them, so a command cannot be half-registered.
  The CLI vocabulary mirrored into shell scripts lives in `completion.ts`.
- **Paths surfaced to the model are workspace-relative with forward slashes** (`relative()` /
  `toPosix()`), never absolute Windows paths with backslashes.
- Errors are typed: `ConfigError`, `ProviderError`, `SandboxError`, `ToolValidationError`.
  Never throw bare `Error` from a module that has one.

---

# og-llama-cpp

Installs, runs and measures a pinned llama.cpp CUDA `llama-server`. Knows nothing about any client:
it produces a server that speaks OpenAI-compatible HTTP from a flat, self-contained install
directory. Server lifecycle lives here and only here.

## Layout

- `install-engine.sh` — Linux. Compiles the pinned tag with CUDA; upstream ships no Linux CUDA
  release asset, so this is the only way to get one.
- `install-engine.ps1` — Windows. Unzips the prebuilt upstream CUDA release plus the cudart zip.
- `serve.ts` — builds the `llama-server` argv for a named operating point and runs it in the
  foreground. This is how an operator brings a server up; Ctrl-C stops it and frees the card.
- `ui/` — the browser front door, and the one npm workspace in the repository. `ui/src/` is an
  Angular + TailwindCSS app (SCSS component styles); `ui/server/main.ts` is the Bun process that
  serves the built bundle from `ui/dist/ui/browser` on `127.0.0.1:8130` alongside a polled JSON API
  (`GET /api/state?ctx=`, `POST /api/download`, `POST /api/download/cancel`, `POST /api/serve`,
  `POST /api/server/stop`). An unbuilt UI answers `503` on the page and keeps `/api/*` working.
  It reports hardware, installed weights, the download catalogue and a fit verdict per model,
  reads GGUF metadata directly to size a KV cache, and launches models by spawning `serve.ts`
  rather than composing an argv. `ui/server/compute.ts` is the peak FLOPS/TOPS table — the one
  place holding numbers nobody measured here, and the only file allowed to.
- `tools/bench.ts` — raw kernel ceiling via `llama-bench` (pp/tg, no KV-cache pressure).
- `tools/profile-sweep.ts` — starts `llama-server` per case, samples VRAM, measures prefill and
  generation throughput, tears it down.
- `docs/benchmarks.md` — the measurement record. `docs/upgrading.md` — the build-bump drill.
  `docs/building-by-hand.md` — the manual CMake path.

## Ownership rules

Both installers must produce the identical shape: `<root>/<build>/` holding `llama-server` next
to every `.so`/`.dll` it loads, plus a `current` symlink (junction on Windows) pointing at it.
That flatness is the contract — `serve.ts` spawns `<binDir>/llama-server` with a bare argv,
no `LD_LIBRARY_PATH` and no environment fixup, so the server must find its own libraries. Only the
installers write under `$OG_LLAMA_ROOT`; `serve.ts`, `tools/**` and `ui/server/**` only read from
it. The one other writer is the UI's downloader, and it writes weights into the models directory,
never the engine root.

**The serving argv is built in exactly one place: `serve.ts`.** Its flags are verified
against the pinned build's `llama-server --help`, and it is the only file in the repository an
operator's server configuration lives in. `ui/server/**` starts servers by spawning it, not
by assembling flags. `profile-sweep.ts` composes its own argv per case — that is the deliberate
self-containment rule below, not a second source of truth — and nothing outside this directory
knows that a `llama-server` flag exists at all.

**Measured and estimated are labelled separately, never averaged.** `docs/benchmarks.md` holds the
measurements; `ui/server/**` may compute an estimate for a model nobody has benchmarked, but it says
`estimated`, shows the arithmetic, and defers to a measured row whenever one exists for that file
and context.

`serve.ts` and the two `tools/` scripts are operator tooling: **self-contained by design**, one
file each, no shared helper module, no imports outside `node:*` and Bun builtins. Duplication
between them is accepted so any one of them can be copied to another box on its own. `ui/` is an
app rather than a script and cannot be one file, but `ui/server/**` keeps the same import
discipline; only `ui/src/` has dependencies.

**Every script that starts a server must tear the GPU down.** `serve.ts` stays in the foreground,
`profile-sweep.ts` kills the whole pid tree, and `ui/server/**` kills whatever it launched (plus any
download in flight); all three trap `SIGINT`/`SIGTERM`. A Ctrl-C that leaks a `llama-server` holding
15 GiB is a bug.

## Commands

Run from `og-llama-cpp/`:

- `bun run serve.ts --list` — the profile table; `bun run serve.ts` serves the default
  operating point in the foreground and is the prerequisite for any local `og` run (Ctrl-C frees
  the card). `--dry-run` prints the exact argv and launches nothing.
- `bun run ui` — the model page on `http://127.0.0.1:8130`: what is installed, what can be
  downloaded, what fits this card, served with its JSON API from one Bun process. Loopback-only
  and unauthenticated by design; it can spawn processes and write files.
- `bun run ui:build` — rebuild the Angular bundle into `ui/dist/ui/browser`. Inside `ui/`:
  `npm install` once, `npm start` for `ng serve` with live reload proxying `/api` to 8130,
  `npm run typecheck`. That directory is driven with Node and npm, not Bun.
- `bun run tools/bench.ts --help`, `bun run tools/profile-sweep.ts --help` — usage.
- `bun x tsc --noEmit` — typecheck (also `bun run typecheck`).
- `./install-engine.sh` — Linux install; `OG_LLAMA_BUILD=bNNNNN` bumps the tag.
- `powershell -ExecutionPolicy Bypass -File .\install-engine.ps1` — Windows install.
- `~/.local/llama.cpp/current/llama-server --list-devices` — the one check that matters after an
  install: it must name a CUDA device. A CPU-only build loads models and runs ~100x slower. Both
  installers run it themselves and fail if no `CUDA<n>:` device is listed, so this is a re-check,
  not the primary gate.

`bun test` covers only what is pure: the GGUF reader and the fit arithmetic behind the UI's
verdicts (`test/gguf.test.ts`, `test/fit.test.ts`), which need neither a GPU nor weights — the
`bunfig.toml` test root keeps it off the Angular specs in `ui/`. Everything else here needs a GPU
and minutes of wall time, so its verification stays manual: `--list-devices`, a `serve.ts` launch,
and a re-run of the sweep compared against `docs/benchmarks.md`.

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

`og-cli` works against **any** OpenAI-compatible endpoint: a local `llama-server`, a hosted API, a
gateway, someone else's GPU box. `og-llama-cpp` is one *optional* way to provide one — the good way
on an NVIDIA box, and the one every measured number in this repository comes from — not a
dependency. Delete either directory and the other still builds and runs.

One coupling survives. It is documentary, and it has exactly one direction:

**Context windows.** `contextWindow` is the only per-model number `og-cli` carries, and each value
in `og-cli/src/config/load.ts` is copied from `og-llama-cpp/docs/benchmarks.md` — a window the
reference server was actually measured serving at a safe VRAM headroom. Changing one in `og-cli`
without a re-run in `og-llama-cpp` makes the record a lie. Nothing else about the model crosses the
line: `og-cli` has no idea what a GGUF, an offload split or a KV cache quantisation is.

Two former couplings are now purely `og-llama-cpp` concerns, with no counterpart in `og-cli`:

- **`llama-server` flag names.** `serve.ts` builds the argv; bumping the pinned build means
  re-checking those flags there — see `og-llama-cpp/docs/upgrading.md`.
- **The install-directory shape.** The flat `<root>/<build>/` layout is a contract between the two
  installers and `serve.ts`, all three inside `og-llama-cpp`.

Working on both at once: make the engine-side change and re-measure first, then update `og-cli`'s
context windows against the new record. Never the other way round.
