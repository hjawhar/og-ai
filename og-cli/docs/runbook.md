# og operations runbook

Written for whoever is holding the pager. Every command here is real on the reference box, which
is now Ubuntu 26.04 (RTX 5070 Ti 16303 MiB, llama.cpp b10488); the same machine ran Windows 11 Pro
build 26200 before that, and the Windows recipes below are from that install. The captured VRAM
figures and `print_timing` transcripts in this document come from the Windows-era runs on this
same GPU and have not been re-measured under Linux — the card and the build are unchanged, so they
remain the right expectations, but treat them as unverified on Linux. From a source checkout,
substitute `bun run src/index.ts` for `og`.

`og` is built, not installed from a registry: `bun run build` produces one self-contained
`dist/og` that you copy onto `PATH`. See [`../README.md`](../README.md#install). Installing and
upgrading the inference engine is a separate concern in a separate repository — the sibling
checkout `../og-llama-cpp` — and its drill is
[`../../og-llama-cpp/docs/upgrading.md`](../../og-llama-cpp/docs/upgrading.md).

---

## 1. Start, stop, status

```sh
og engine start      # idempotent: adopts a healthy server, else spawns one
og engine status     # health + model + pid + VRAM
og engine status -v  # the same, plus the exact argv og would use
og engine stop       # kills the process recorded in ~/.og/engine.json
```

Healthy output:

```console
$ og engine status
running http://127.0.0.1:8127
model qwen3-coder-30b
pid 29060
vram 15333 / 16303 MiB
```

Down:

```console
$ og engine status
stopped http://127.0.0.1:8127
```

`og engine status` exits **0** when running and **1** when not, so it is directly usable as a
health gate in a script: `og engine status >/dev/null || og engine start`.

`og engine start` prints either `engine started in 12.4s at http://127.0.0.1:8127` or
`engine already running at http://127.0.0.1:8127`. A cold start of the default 16.45 GiB Q4
profile is the slow case; `engine.startupTimeoutSec` defaults to 240 s for that reason.

The child is spawned **detached**, with stdout and stderr appended to `~/.og/engine.log`. The
server therefore outlives the CLI — that is deliberate, and it is why the second `og` run of
the day starts instantly.

## 2. Where state lives

`~/.og` (override with `OG_STATE_DIR` or `stateDir`):

| File | Contents | Safe to delete? |
| --- | --- | --- |
| `config.json` | machine-level config overlay | yes, reverts to defaults |
| `sessions.db` | `bun:sqlite` WAL database: sessions, messages, usage. `-wal` / `-shm` siblings appear while open | yes, loses all history |
| `engine.json` | `{ pid, port, profile, startedAt }` for the server **og** launched | yes, but `og engine stop` then refuses to kill (see §3) |
| `engine.log` | append-only `llama-server` stdout+stderr, with an `=== og: starting ... ===` banner per launch | yes, while the engine is stopped |
| `engine.lock` | exclusive start lock; present only during a start | see §5 |
| `history` | TUI prompt history, oldest first, capped; written on TUI exit | yes |

Per-workspace overlay lives at `<workspace>/.og/config.json` and beats `~/.og/config.json`.

### Reading engine.log

```sh
# tail
tail -n 40 ~/.og/engine.log

# follow live
tail -n 20 -f ~/.og/engine.log

# the launch banners: what was started, when, with which profile
grep '=== og: starting' ~/.og/engine.log

# per-request timings — this is the line that proves or disproves a spill
grep print_timing ~/.og/engine.log | tail -n 12
```

On Windows (PowerShell):

```powershell
Get-Content -Tail 40 $env:USERPROFILE\.og\engine.log
Get-Content -Tail 20 -Wait $env:USERPROFILE\.og\engine.log            # follow live
Select-String '=== og: starting' $env:USERPROFILE\.og\engine.log      # launch banners
Select-String print_timing $env:USERPROFILE\.og\engine.log | Select-Object -Last 12
```

A healthy `print_timing` block looks like this (prompt eval = prefill, eval = generation):

```
slot print_timing: id  0 | task 2744 | prompt eval time = 72.25 ms / 11 tokens (6.57 ms per token, 152.24 tokens per second)
slot print_timing: id  0 | task 2744 |        eval time = 20.43 ms /  2 tokens (20.43 ms per token,  48.95 tokens per second)
```

Very short requests look slow per-token because of fixed overhead; judge throughput only on
requests of a few hundred tokens or more. Other lines worth knowing: `load_tensors:` reports
the CPU/GPU split (`--n-cpu-moe` at work), `llama_context: KV self size` reports the KV cache
footprint, and `main: server is listening` is the readiness line `/health` corroborates.

Startup failures are also surfaced inline: when a spawn dies or never becomes healthy, `og`
raises an error containing the full command line plus the **last 20 non-empty lines** of
`engine.log`, so you usually do not need to open the file at all.

## 3. Adopting or reclaiming a server og did not launch

The endpoint is authoritative: a healthy server at `cfg.endpoint` is always **adopted**,
whether `og` started it, an earlier `og` run started it, or you launched it by hand. `og`
never starts a second server, and `og engine status` will happily report an adopted one
(without a `pid` line, since it has no record of it).

`og engine stop` deliberately refuses to kill what it cannot identify:

```console
$ og engine stop
error A server is answering at http://127.0.0.1:8127 but og has no record of starting it (~/.og/engine.json is absent), so its process cannot be identified. Stop it wherever it was launched.
```

That is not a bug — killing an unknown PID on a shared box is worse than refusing. Reclaim it
manually:

```sh
# who owns the port?
ss -ltnp 'sport = :8127'
# State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
# LISTEN 0      4096       127.0.0.1:8127       0.0.0.0:*     users:(("llama-server",pid=29060,fd=30))

# confirm it is really llama-server, and how long it has been up, before killing anything
ps -o pid,lstart,cmd -p 29060

# stop it; -9 only if it ignores SIGTERM
kill 29060

# then let og own the next one
og engine start
```

On Windows (PowerShell):

```powershell
# who owns the port?
Get-NetTCPConnection -LocalPort 8127 -State Listen | Select-Object OwningProcess

# confirm it is really llama-server, and how long it has been up, before killing anything
Get-Process -Id 29060 | Select-Object Id, ProcessName, StartTime, Path

# stop it; -Force only if it ignores the polite close
Stop-Process -Id 29060
```

To take over an existing server *without* killing it, just point at it and disable autostart:
`og --endpoint http://127.0.0.1:8127 --no-autostart -p "..."`. `og` will use it and never
try to manage its lifecycle.

## 4. VRAM spill — the diagnostic to run first

**This is the failure mode that motivated the project.** It never throws, never logs an error,
and never stops working. It just runs about eight times slower.

### Symptom

Generation collapses from 70-140 tok/s to roughly **15-30 tok/s**. Prefill collapses harder —
from 1200-3000 tok/s to around **120 tok/s**. The pinned status row and `print_timing` in
`engine.log` both show it. Nothing errors.

### Cause

Once resident VRAM passes **~15.4 GiB** on this 16303 MiB card, the NVIDIA driver's
system-memory fallback starts paging weights to host RAM over PCIe. The measured cliff:

| Config | VRAM (MiB) | Prefill (tok/s) | Generation (tok/s) | |
| --- | --- | --- | --- | --- |
| Q4 c32768 `--n-cpu-moe 10` | 15750 | 120 | 29.2 | **spilling** |
| Q4 c32768 `--n-cpu-moe 12` | 15364 | 1644 | 88.5 | marginal |
| Q4 c32768 `--n-cpu-moe 14` | 14714 | 1476 | 82.1 | safe (default) |

386 MiB of extra resident memory between the second and first rows costs **13.7x prefill** and
**3x generation**. There is no gentle degradation: you are either under the line or ruined.

### Confirm

```sh
og engine status          # look at the vram line: used / total
nvidia-smi                 # who else is on the GPU?
nvidia-smi --query-gpu=memory.used,memory.total --format=csv
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

From inside the TUI, `/stats` reports the same GPU state plus the installed engine build, and
`/usage` reports context occupancy, decode throughput and TTFT for the active profile:

```
/stats     gpu 0  NVIDIA GeForce RTX 5070 Ti
             vram █████████░ 95% 15474 / 16303 MiB
/usage     last run  2 steps · 1.5s wall · decode 82.1 tok/s · ttft 1.2s
```

Free VRAM = total - used. Below **700 MiB free**, `og` prints a warning before the run:

```
warn only 640 MiB of VRAM free (15663/16303 MiB used). The driver may spill to host RAM and run ~8x slower. Close GPU-heavy apps, raise nCpuMoe for profile "qwen3-coder-30b", or switch to a smaller profile.
```

Idle desktop use measured **968 MiB** on this card (Windows-era run; see the header note), so the
working budget is ~15200 MiB and every shipped profile targets **>= 1.2 GiB free**.

### Fix ladder — in this order

1. **Close GPU consumers.** Browsers with hardware acceleration, Discord, OBS, another LLM
   runner. `nvidia-smi --query-compute-apps=...` names them. This is free and instant, and it
   is the most common actual cause: the profile was sized for a 968 MiB idle desktop.
2. **Raise `nCpuMoe`** by 2 for the active profile and restart the engine. Each step moves more
   MoE expert layers to the CPU. Measured cost of +2 on the Q4 32k profile: 15364 -> 14714 MiB
   for 88.5 -> 82.1 tok/s. Cheap insurance; a spilling config is 3x worse than this.
3. **Drop `ctx`.** KV cache at `q8_0` is linear in context: the Q4 profile needs
   `--n-cpu-moe 18` at 65536 versus 14 at 32768 to stay under the line. Halving `ctx` buys back
   several hundred MiB with zero throughput cost on requests that fit.
4. **Switch profile.** `qwen3-coder-30b-fast` (Q3_K_XL, 14569 MiB, 2957 / 136.5 tok/s) is the
   smallest and fastest Qwen option; `devstral-24b` (15045 MiB, 8k window) is a dense
   alternative. `og -m qwen3-coder-30b-fast ...`, or `/models switch qwen3-coder-30b-fast` in the TUI.

After any profile change: `og engine stop; og engine start; og engine status` and confirm
the VRAM line, then re-check throughput on a real request.

## 4b. Changing the model

```sh
og models                       # what is installed, and which profile is active
og models use qwen3-coder-30b-fast  # persist the default to ~/.og/config.json
og engine stop                  # required when the weights file differs
```

Inside the TUI, `/models list`, `/models info <key>` and `/models switch <key>` do the same for
one session. A switch to a profile whose weights differ from the loaded ones warns and takes
effect on the next prompt; the engine reloads then, which costs a cold model load (tens of
seconds for a 16 GiB file, near-instant once the file is in the OS page cache).

`og models use` writes only the `model` key, and machine config is the *second* layer: a
`<workspace>/.og/config.json` with its own `model` still wins. If a `use` appears to do
nothing, check for a workspace override first.

## 4c. Shell completion

```sh
eval "$(og completion bash)"                    # this session
og completion bash > ~/.og-completion.bash      # permanently
echo 'source ~/.og-completion.bash' >> ~/.bashrc
```

On a Windows install, the same vocabulary for PowerShell:

```powershell
og completion powershell | Out-String | Invoke-Expression   # this session
og completion powershell | Out-File -Append $PROFILE        # permanently
```

The scripts embed a static vocabulary and never execute `og`, so completion works even when the
engine is down. Known PowerShell 5.1 limitation: its parser does not invoke native completers
while the word being completed is a `-flag`, so flags complete after a positional word but not
from a bare `-`. Bash has no such gap. Inside the TUI, `Tab` completes slash commands, model
keys and filesystem paths.

## 5. Failure modes

### Engine will not start

`og` prints the full command line and the last 20 lines of `engine.log`. Work down this list:

```sh
og engine status -v          # prints the argv; copy it
ls -l ~/.local/llama.cpp/current                 # where does `current` actually point?
~/.local/llama.cpp/current/llama-server --version
```

On Windows (PowerShell):

```powershell
Get-Item $env:USERPROFILE\.local\llama.cpp\current | Select-Object LinkType, Target
& $env:USERPROFILE\.local\llama.cpp\current\llama-server.exe --version
```

- `llama-server not found at ...` — `engine.binDir` is wrong, or `current` no longer resolves.
  On Linux re-run `../og-llama-cpp/install-engine.sh`; it rebuilds the pinned tag from
  source and re-points the `current` symlink at the result. On Windows re-run
  `powershell -ExecutionPolicy Bypass -File ..\og-llama-cpp\install-engine.ps1`; it
  re-downloads the release zips and re-creates the `current` junction. Engine installation is a
  separate concern from the CLI and lives in its own repository (§6).
- Linux — `error while loading shared libraries: libcudart.so.13` (or `libcublas`, `libcublasLt`):
  the CUDA runtime libraries are missing from `engine.binDir`. Re-run the installer: it copies them
  in next to `llama-server` and links with `RPATH=$ORIGIN`, so the server needs no
  `LD_LIBRARY_PATH` and no system-wide CUDA.
- Windows — the process dies at once with `The code execution cannot proceed because
  cudart64_13.dll was not found` (or `cublas64_13.dll`, or a missing `ggml-cuda.dll`): the cudart
  zip never landed in `engine.binDir`. Re-run `install-engine.ps1`, which unpacks
  `cudart-llama-bin-win-cuda-13.3-x64.zip` into the same flat directory as `llama-server.exe`.
  Windows resolves DLLs beside the executable, so nothing has to go on the system `PATH`.
- `llama-server exited before becoming healthy` with a CUDA OOM in the log — the profile does
  not fit *right now*. Go to §4, step 1.
- `did not report healthy ... within 240s` while the log still shows tensor loading — the model
  is loading from cold storage. Raise `engine.startupTimeoutSec` or warm the file cache.
- Run the printed argv by hand in a terminal. That gets you the error on your screen instead of
  in a log, and it separates "og is broken" from "llama.cpp is unhappy".

### Port 8127 already in use

```sh
ss -ltnp 'sport = :8127'
ps -o pid,lstart,cmd -p <pid>
```

On Windows (PowerShell):

```powershell
Get-NetTCPConnection -LocalPort 8127 -State Listen | Select-Object OwningProcess
Get-Process -Id <pid> | Select-Object Id, ProcessName, StartTime, Path
```

- If it is a healthy `llama-server` with the model you want, do nothing: `og` adopts it.
- If it is a `llama-server` with the *wrong* model, `og engine stop` (if `engine.json` exists) or
  `kill <pid>` / `Stop-Process -Id <pid>`, then start again.
- If it is something else entirely, move `og`: set `engine.port` in `~/.og/config.json` (and
  `endpoint` to match — both must agree; `endpoint` is what the provider dials, `engine.port` is
  what the server binds).

### Model file missing

`og models` and any start attempt fail loudly, listing what is actually on disk:

```
Model file for profile "qwen3-coder-30b" not found: ~/models/Qwen3-Coder-...gguf
GGUF files present in ~/models:
  Devstral-Small-2507-Q4_K_M.gguf
  ...
```

Fix `profile.file` (relative to `engine.modelsDir`, or absolute) or `engine.modelsDir`. Run
`og models` until every profile you care about says `present`.

### Stale `~/.og/engine.lock`

The lock serialises concurrent starts across processes. A crashed starter can leave it behind.
The rules, so you know when to intervene:

- While the lock is held, other `og` processes poll; if the endpoint becomes healthy they
  simply proceed.
- A lock whose **mtime is older than 5 minutes** is considered stale and broken automatically.
- Only if waiting exceeds `startupTimeoutSec + 5 min` do you get:
  `Timed out waiting for another og process to start the engine (lock: .../engine.lock).
  Delete the lock file if no server is starting.`

So: check that nothing is legitimately starting, then delete the lock.

```sh
pgrep -a llama-server
tail -n 20 ~/.og/engine.log
rm ~/.og/engine.lock
```

On Windows (PowerShell):

```powershell
Get-Process llama-server -ErrorAction SilentlyContinue | Select-Object Id, StartTime, Path
Get-Content -Tail 20 $env:USERPROFILE\.og\engine.log
Remove-Item $env:USERPROFILE\.og\engine.lock
```

Do **not** delete it while a start is in progress; you will get two servers racing for the same
port and the same 16 GiB.

### Model produced malformed tool-call arguments

Handled in-loop, not fatal. Non-JSON arguments or a schema violation are returned to the model
as tool output — `Error: invalid arguments for edit: ... Re-read the tool schema and call it
again with corrected JSON.` — and it retries. What to do when it happens *repeatedly*:

- Confirm `--jinja` is on the server command line (`og engine status -v`). Without it the
  model's own chat template is not applied, tool calls arrive as prose, and everything
  downstream is garbage. This is the single most common cause.
- Check the profile's sampling. Tool-call JSON degrades at high temperature; the Qwen profiles
  ship the author-recommended `temp 0.7 / top-p 0.8 / top-k 20 / repeat-penalty 1.05`.
- Q3 weights are measurably looser at structured output than Q4. If `qwen3-coder-30b-fast` is
  fumbling arguments, that is the trade you accepted; switch back to `qwen3-coder-30b`.
- Persistent whole-request failure with a jinja template error in `engine.log` usually means an
  orphaned `role: "tool"` message reached the server. File it: compaction is supposed to make
  that impossible (it drops whole turns only).

### Context exhaustion and compaction

The agent budgets against `profile.contextWindow`, holds back `agent.contextReservePct` (0.25)
for the next response plus tool results, and compacts once usage passes
`agent.compactThresholdPct` (0.75). Compaction drops the **oldest whole turns** — a user
message plus every assistant/tool message following it — never a partial turn, and never the
newest turn; it leaves a `[earlier context omitted: N messages, ~T tokens]` marker. `--json`
runs emit a `compaction` event with `removedMessages` and `freedTokens`.

Signs you need more room: frequent `compaction` events, or `/context` in the TUI showing tool
results dominating the window.

- Use `qwen3-coder-30b-long` (65536) instead of raising `contextWindow` past `ctx` — the window
  must be `<= ctx`, and `ctx` is what determines the KV cache size on the GPU.
- Lower `tools.maxOutputBytes` (default 65536) if giant `bash`/`grep` results are eating the
  window.
- Split the task. A single turn whose *own* content exceeds the window cannot be compacted away
  (the last turn is never dropped); it is returned as-is with an honest `removed` count and the
  server will truncate. That shows up as a suspiciously confused model, not an error.

### Approval denials in headless mode

There is nobody to ask, so `og` answers from the configured policy and says so on stderr:

```
error denied: bash: bun test
  bash needs approval (risk: exec) but policy "always" has no interactive session here
```

The denial is returned to the model as tool output (`denied by user`), so the run continues and
usually ends with the model explaining it could not proceed. Fixes, in order of preference:

- Give CI its own overlay: `<workspace>/.og/config.json` with
  `"tools": { "bash": { "approval": "unsafe-only" } }`, or `"never"` for a fully autonomous
  runner. Policy semantics without a human: `never` -> approve, `unsafe-only` -> approve
  everything that is not `exec`-risk, `always` -> refuse.
- Do not "fix" this by widening `bash.denyPatterns` exceptions. Deny patterns are unappealable
  by design and are catastrophic-only already (drive-root deletes, `mkfs`, `dd of=`, shutdown,
  `HKLM` deletes, curl-pipe-to-shell, `git push --force main`). If a legitimate command is
  matching one, the pattern is wrong — fix the pattern in `src/config/load.ts`, do not disable
  the gate.
- Run interactively for one-offs: the TUI prompts, and `/help` lists everything else available.

## 6. Engine installs and upgrades

Not this project's concern. `og` supervises whatever OpenAI-compatible server
`cfg.endpoint` names; getting a pinned llama.cpp CUDA `llama-server` onto the box, bumping its
build, rolling one back and building it by hand all live in the sibling `../og-llama-cpp`
directory:

| Task | Where |
| --- | --- |
| Install the pinned build (Linux and Windows) | `../../og-llama-cpp/README.md` |
| Bump the build, revalidate, roll back | `../../og-llama-cpp/docs/upgrading.md` |
| Build llama.cpp by hand | `../../og-llama-cpp/docs/building-by-hand.md` |
| VRAM and throughput per profile, measured | `../../og-llama-cpp/docs/benchmarks.md` |

Two things stay this project's problem after an engine upgrade:

- **Re-check VRAM for every profile you use** — `og engine status`. Kernel and allocator changes
  move the spill threshold by hundreds of MiB, and the failure is silent (§4).
- **Re-check the flag names.** Only `src/engine/args.ts` builds the argv, and its flags were
  verified against b10488's `llama-server --help`: `-ngl`, `--n-cpu-moe`, `-c`,
  `--cache-type-k/v`, `--flash-attn on|off`, `--jinja`, `-t`, `-b`, `-ub`, `--parallel`,
  `--no-webui`, `--metrics`, `--cont-batching`, and the sampling flags. A renamed or removed flag
  shows up as an immediate startup failure with the argv in the message, which is the good kind
  of failure.

The smoke test after any engine change is three commands:

```sh
og engine stop && og engine start && og engine status
og -p "reply with the single word ready" --max-steps 1
og --json -p "list the files in src/ and count them"   # exercises tools end to end
```
