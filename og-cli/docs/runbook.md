# og operations runbook

Written for whoever is holding the pager. `og` is a **client**: it sends OpenAI-compatible chat
completions to `endpoint` and streams the reply. It does not start, adopt, restart or stop an
inference server, it cannot see the GPU, and it has no engine state on disk. That makes this
document short and the boundary sharp — anything about weights, VRAM, offload or a `llama-server`
command line is diagnosed in the sibling [`../../og-llama-cpp`](../../og-llama-cpp) checkout, not
here (§6).

Every command below is real on the reference box, which is now Ubuntu 26.04 (RTX 5070 Ti
16303 MiB, llama.cpp b10488); the same machine ran Windows 11 Pro build 26200 before that, and the
PowerShell recipes are from that install. From a source checkout, substitute
`bun run src/index.ts` for `og`.

`og` is built, not installed from a registry: `bun run build` produces one self-contained
`dist/og` that you copy onto `PATH`. See [`../README.md`](../README.md#install).

---

## 1. Is the endpoint up?

Two questions, and `og models` answers both in one table, because either alone misleads: **what is
configured** is knobs `og` holds locally, **what is loaded** is only the endpoint's to say.

```console
$ og models
* Laguna-XS-2.1-APEX-I-Mini  serving now
                             window 32768 (og's default — no entry configured for it)
  4 more configured and not being served
og follows the endpoint while no model is pinned — og models use Laguna-XS-2.1-APEX-I-Mini to fix it in place
```

**Nothing pinned means og follows the endpoint.** With no `-m`, no `OG_MODEL` and no `model` in
either config file there is nothing to fall back on — og ships no model entries at all — and a
`llama-server` would answer a request for any name with whatever it actually loaded: the loaded
model's output, budgeted from the wrong entry, with nothing in either log saying so. So when exactly
one model is served and nothing is pinned, that one is active, with the context window the server
itself reported. Pin it and og obeys you instead, wrong or not: a typo in a config file should fail
loudly. Two models served with nothing pinned is an error naming both, because choosing between them
is not og's call.

The rows are what is **usable**: what the endpoint serves, plus the active entry. The rest of the
record is counted, and `og models --all` prints it — og's own four entries marked `shipped preset`
(measured windows and sampling recipes, not weights anyone has), and entries aimed at another host
tagged `other endpoint <url>` rather than judged, because this probe says nothing about that host.
`og` cannot list *installed* weights and must not learn how: it never starts a server, so a `.gguf` on
disk is not a fact it can act on. That inventory is `og-llama-cpp`'s, and its UI shows it.

It runs one `GET {endpoint}/v1/models` and nothing else, and it still exits **0** with nothing
listening anywhere — which is what keeps it the first command to run. Offline it names the active
entry and says nothing answered; it does not claim a model is `not loaded` when no answer proved it.
It tells you the wire model id, the effective endpoint after per-model overrides, and which
environment variable a key would come from — the three things people get wrong. A key's *value* is
never printed, only its variable name.

The tags matter more than they look. llama.cpp answers a request with whatever weights it loaded no
matter which name was asked for, so a default that is `not loaded` does not fail: it silently
returns another model's output, budgeted with the wrong context window.

Then ask the endpoint itself. `og`'s own probe hits `GET {endpoint}/v1/models` first and falls back
to `GET {endpoint}/health`, so those are the two URLs worth curling by hand:

```sh
curl -sS http://127.0.0.1:8127/health
# {"status":"ok"}

# the model the server is actually serving, and the context it actually allocated
curl -sS http://127.0.0.1:8127/v1/models | jq '.data[] | {id, n_ctx: .meta.n_ctx}'
# { "id": "qwen-smoke", "n_ctx": 8192 }

# a keyed endpoint: sending the header is what distinguishes 401 from "wrong URL"
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models
```

On Windows (PowerShell):

```powershell
(Invoke-WebRequest -SkipHttpErrorCheck http://127.0.0.1:8127/health).StatusCode
(Invoke-RestMethod http://127.0.0.1:8127/v1/models).data |
  Select-Object id, @{n = 'n_ctx'; e = { $_.meta.n_ctx } }
```

`llama-server`'s `/v1/models` carries more than the OpenAI schema requires, and the extra fields are
the useful ones: `data[].id` is the `--alias` it was started with — the id your config must send —
and `data[].meta.n_ctx` is the KV cache it really allocated, which is the number `contextWindow`
has to fit inside. `meta.n_ctx_train` beside it is the model's trained maximum, which is *not* what
is being served. `/health` answers `{"status":"ok"}` once the model is loaded, and is the readiness
signal to poll on if you are scripting a start.

### What `og` does before a run

Exactly one `provider.health()` probe, and then it either proceeds or refuses:

```console
$ og -p "hello"
error no server answering at http://127.0.0.1:8127 (Unable to connect. Is the computer able to
access the url?). Start one and retry — the og-llama-cpp project's `bun run serve.ts` runs a
local llama.cpp server — or point og elsewhere with --endpoint.
```

Two things to read off that. First, the preflight fails **only on transport failure** — connection
refused, DNS failure, TLS failure, timeout. Any HTTP response at all counts as reachable, including
`401`, `403`, `404` and `503`, and `og` proceeds so that the *server's own* error text reaches you
instead of being replaced by a guess (§5).

Second, the parenthesised detail is Bun's `fetch` message passed through verbatim, and Bun collapses
*every* transport failure into that same sentence: refused, unresolvable, TLS-rejected and timed-out
all read identically. The message tells you the endpoint `og` dialled, not why the dial failed —
`curl -v` against the same URL is what separates those cases.

`og` has no subcommand that starts a server. Bring one up yourself, in its own terminal, and leave
it there:

```sh
cd ../og-llama-cpp && bun run serve.ts --profile your-model
```

That process is the server's whole lifetime: it runs in the foreground with llama.cpp's log on your
screen, and Ctrl-C kills the pid tree and frees the card. Nothing is detached, so a second `og` run
of the day is fast only if that terminal is still open. Add `--dry-run` to see the exact argv
without launching, and `--list` for the available operating points.

## 2. Where state lives

`~/.og` (override with `OG_STATE_DIR` or `stateDir`) — three files, none of them about a server:

| File | Contents | Safe to delete? |
| --- | --- | --- |
| `config.json` | machine-level config overlay; the file `og models use <key>` writes | yes, reverts to defaults |
| `sessions.db` | `bun:sqlite` WAL database: sessions, messages, usage. `-wal` / `-shm` siblings appear while open | yes, loses all history |
| `history` | TUI prompt history, oldest first, capped; written on TUI exit | yes |

Per-workspace overlay lives at `<workspace>/.og/config.json` and beats `~/.og/config.json`.

There is no pid file, no lock file and no log file. `og` writes no log of its own: diagnostics go
to stderr during the run, `--json` emits machine-readable events, and the *server's* log belongs to
whichever terminal is running the server.

### Sessions

```console
$ og sessions list
d5a1d59d-c6fc-41e2-b0c5-7db7dd9e2033 2026-08-19 14:02 · your-model · 5158 tok · /home/you/demo
  add peek() to LruCache
```

```sh
og sessions show <id>            # the full transcript, message by message, with tool calls
og sessions rm <id>              # delete one session and its messages (cascades)
og -c -p "..."                   # continue the newest session for this directory
og -r <id> -p "..."              # resume a specific one
```

`sessions list` shows the **20 most recently updated sessions across every directory**, newest
first: id, UTC timestamp of last activity, the model it ran on, cumulative tokens, and the cwd it
was started in, with the title indented underneath once one has been derived from the first prompt.
The cwd column is the one to read — `-c` resolves to the newest session *for the current
directory*, so a `-c` in a different repo starts a fresh session rather than resuming someone
else's work, even though both appear in this list.

Inside the TUI, `/sessions` and `/resume <id>` do the same, and `/clear` starts a fresh session
without touching stored ones. A session records the model it ran on, which is why `/usage` can
report per-model throughput without mixing two models.

## 3. Changing the model

```sh
og models                            # what is configured, and where each entry's requests go
og models use your-model   # persist the default to ~/.og/config.json
og -m your-model -p "..."  # one run only
og -m gpt-4o --endpoint https://api.openai.com --context-window 128000 -p "..."
```

Inside the TUI, `/models list`, `/models info <key>` and `/models switch <key>` do the same for one
session; a switch takes effect on the next prompt.

Two things to know:

- **`og` does not reload anything.** A switch re-resolves the entry — wire id, endpoint, key and
  headers — and rebuilds the HTTP client, which is why an entry pointing at a different backend
  takes effect on the next prompt. What it never does is touch the server. If the endpoint is a
  single-model `llama-server`, switching to a name it was not started with is a *server-side*
  rejection, not an `og` failure; restart the server with the other profile (§1) if you actually
  want different weights. There is no preflight on a switch either, so a switch to an unreachable
  backend surfaces at the first request rather than at the switch.
- **`og models use` writes the `model` key**, plus a `models.<name>` entry when the name had none —
  a bare name in a config file fails validation on the next run, so the entry is written with it at
  og's default window. Machine config is the *second* layer: a `<workspace>/.og/config.json` with
  its own `model` still wins. If a `use` appears to do nothing, check for a workspace override
  first. It writes `~/.og/config.json` specifically, which is the file the layering reads — not
  `stateDir`, even when that has been moved.

`-m` accepts any name, registered or not: an unknown one is synthesised as
`{ id: <name>, contextWindow: 32768 }`, overridable with `--context-window`. That is the fast path
for "does this gateway's model work at all?" without editing config. The same is true of `OG_MODEL`.
A `model` in a **config file** gets no such pass — an unknown one there fails with
`unknown model "..."; available: ...`, which is what catches a typo you would otherwise chase into
the server's logs. `og models use <name>` takes the same view from the other side: it accepts a name
the endpoint is currently serving even with no entry configured, and refuses one that is neither
configured nor served.

## 4. Shell completion

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

The scripts embed a static vocabulary and never execute `og`, so completion works with no server
anywhere in sight. Known PowerShell 5.1 limitation: its parser does not invoke native completers
while the word being completed is a `-flag`, so flags complete after a positional word but not from
a bare `-`. Bash has no such gap. Inside the TUI, `Tab` completes slash commands, model keys and
filesystem paths.

## 5. Failure modes

All of these are client-side symptoms. Half of them have server-side causes, and each entry says
which side to fix.

### Endpoint unreachable, versus reachable and unhappy

`og` splits these deliberately, because the fixes have nothing in common.

| What you see | What happened | Fix |
| --- | --- | --- |
| `error no server answering at <endpoint> (Unable to connect. Is the computer able to access the url?)` | a transport failure of some kind — refused, unresolvable host, rejected TLS, or timeout. Bun reports all four with that one sentence | `curl -v <endpoint>/v1/models` to find out which, then start a server (§1) or fix `endpoint` |
| `error chat completion failed: HTTP 401 Unauthorized — <body>` | the endpoint answered: the key is missing, wrong, or not entitled to this model | see *Missing `apiKeyEnv`* below |
| `... HTTP 403 Forbidden — <body>` | authenticated but not permitted — wrong org, wrong project, or a model you have no access to | the body says which; fix the key or the model id |
| `... HTTP 404 Not Found — <body>` | reachable, but `POST {endpoint}/v1/chat/completions` is not there. Usually `endpoint` carries a path it should not, or the server is not OpenAI-compatible | `endpoint` is a **base URL**: `https://api.openai.com`, never `.../v1` and never `.../v1/chat/completions` |
| `... HTTP 400 Bad Request — <body naming a parameter>` | the endpoint rejected part of the request body | see *Sampling knobs the endpoint rejects* below |
| `... HTTP 429` or `5xx`, reported after retries | the server is loading, overloaded or rate-limiting. `ProviderError` treats 408, 429, 5xx and transport errors as retryable and gives up only after exhausting them | wait, or reduce concurrency on the server |

Everything after ` — ` is the server's own response body, passed through verbatim (truncated at
2000 characters). That is the part worth reading: on a `400` or `404` it usually names the exact
parameter or route it disliked, and no amount of client-side guessing improves on it. This is why
`og` proceeds on any HTTP response rather than second-guessing a non-200.

A retryable failure is announced before each attempt as a non-fatal `error` event —
`... - retrying in 500ms (attempt 2/4)` — with backoff 500 ms, 1.5 s, 4 s. Four attempts total, then
the run fails. Seeing those banners on a local server usually means it is still loading a model.

A `401` on a *loopback* endpoint means something other than the server you think is on that port.
Confirm with the port owner:

```sh
ss -ltnp 'sport = :8127'
```

```powershell
Get-NetTCPConnection -LocalPort 8127 -State Listen | Select-Object OwningProcess
```

### The model id the server does not recognise

Symptom: the request fails immediately with a server-side message naming the model, such as
llama.cpp's `model not found` or OpenAI's `The model \`...\` does not exist`.

`og` sends `spec.id ?? <record key>` verbatim and never rewrites it. So:

```sh
og models                                                # both sides at once: served vs configured
curl -sS http://127.0.0.1:8127/v1/models                 # the same list, unmediated
```

`og models` marks the mismatch itself — the served entry reads `serving now`, yours reads
`not loaded`, and a warning names the fix — so the `curl` is a second opinion rather than the
diagnosis.

- A `llama-server` serves exactly one model, under its `--alias` (which `serve.ts` defaults
  to the profile key). Either match your entry's `id` to that alias, or restart the server with the
  alias you want.
- On a gateway the id is usually namespaced (`anthropic/claude-sonnet-4`,
  `qwen/your-model-instruct`). Set `id` on the entry and keep the record key short; the key is
  only what you type.
- One config can address several endpoints at once — an entry's own `endpoint` beats the top-level
  one — so "wrong model" and "right model, wrong endpoint" look identical until you read
  `og models`.

### Missing `apiKeyEnv` variable

`apiKeyEnv` names an environment variable, not a key. An unset or empty one is a hard `ConfigError`
before any request goes out, rather than an anonymous request that comes back `401`:

```sh
og models                       # the entry's line ends with: key from $OPENAI_API_KEY
printenv OPENAI_API_KEY | wc -c # 0 means unset or empty
export OPENAI_API_KEY=sk-...
```

```powershell
if (-not $env:OPENAI_API_KEY) { "unset" }
$env:OPENAI_API_KEY = 'sk-...'
```

Watch for the two-shell trap: a key exported in one terminal does not exist in another, and a
`$PROFILE`/`.bashrc` export does not reach an already-open shell. If you would rather not manage a
variable per provider, `apiKey` / `OG_API_KEY` is the fallback used by any entry that names no
`apiKeyEnv` — but never put a key in a config file that git can see.

### Context window mismatch

The most silent client-side misconfiguration. `contextWindow` is what the agent budgets and
compacts against; it is *not* communicated to the server and is not checked against it. Get it
wrong in either direction and nothing errors:

- **Too high** (config says 32768, server started with `-c 8192`): `og` happily builds a 20k-token
  prompt and the server truncates or rejects it. Symptom is a model that has visibly forgotten the
  start of the conversation, or a `400` about context length, with the `ctx` gauge sitting at a
  comfortable 60%.
- **Too low**: compaction fires far earlier than it needs to, you see frequent `compaction` events,
  and the agent keeps dropping turns it could have kept.

Both numbers are directly readable, so this never has to be a guess:

```sh
og models                                                        # window <n> — what og budgets
curl -sS http://127.0.0.1:8127/v1/models | jq '.data[].meta.n_ctx'   # what the server allocated
```

A live example of the mismatch, from a server started for a smoke test with `-c 8192` while the
config still claimed 32768: `og models` said `window 32768`, `n_ctx` said `8192`. Nothing in either
process complained.

Fix with `--context-window <n>` for one run, or by correcting `contextWindow` in the entry — and if
the *server* is the wrong one, `serve.ts --dry-run` shows the `-c` it would use for each
profile. When a server divides its KV cache across slots (`--parallel N`), the per-client window is
`n_ctx / N`; size `contextWindow` to that, not to `n_ctx`.

`/usage` and `/context` in the TUI show the same budget from the inside: window, reserve,
compaction threshold and what is currently occupying the context.

### Tool calls arrive as prose

Symptom: the model narrates tool use in text — XML-ish tags, a JSON blob in the reply, "I will now
read the file" — and no `tool-start` event ever fires. The run does nothing useful and burns steps.

This is a **server-side chat template** problem, and it is the single most common cause of an
otherwise-healthy setup producing garbage. Tool calls have to come back as native OpenAI
`tool_calls`; that only happens if the server applies the model's own chat template.

- For llama.cpp that is `--jinja`. `og-llama-cpp/serve.ts` always passes it — confirm with
  `bun run serve.ts --dry-run` — so a server showing this symptom was almost certainly
  started by hand without it.
- For vLLM it is the equivalent tool-parser flags; for a hosted API it is the vendor's job and
  already true.
- `og` cannot compensate. It never scrapes prose for tool calls, by design: a scraper turns a
  configuration error into intermittent, silent misbehaviour.

Distinguish this from *malformed* tool-call arguments, below: prose means the template is missing,
bad JSON means the template is working and the model is sloppy.

### Model produced malformed tool-call arguments

Handled in-loop, not fatal. Non-JSON arguments or a schema violation are returned to the model
as tool output — `Error: invalid arguments for edit: ... Re-read the tool schema and call it
again with corrected JSON.` — and it retries. What to do when it happens *repeatedly*:

- Check the entry's sampling. Tool-call JSON degrades at high temperature; the shipped Qwen entries
  use `top-p 0.8 / top-k 20 / min-p 0 / repeat-penalty 1.05` with `agent.temperature` at 0.2.
- Lower-precision weights are measurably looser at structured output. If the fast Q3 operating
  point is fumbling arguments, that is the trade you accepted; serve the Q4 one instead.
- Persistent whole-request failure with a jinja template error in the *server's* log usually means
  an orphaned `role: "tool"` message reached it. File it against `og`: compaction is supposed to
  make that impossible, because it drops whole turns only.

### Sampling knobs the endpoint rejects

`topK`, `minP` and `repeatPenalty` are llama.cpp/vLLM extensions, sent as `top_k`, `min_p` and
`repeat_penalty`. OpenAI proper and strict gateways reject unknown arguments outright, so an entry
carrying them fails **every** request with a `400` naming the parameter.

Each sampling field is sent only when set, so the fix is to delete the offending fields from that
entry rather than to zero them. Keep the llama.cpp knobs on local entries and leave hosted entries
to `temperature` and `topP`.

To reproduce that class of failure without a hosted account, `test/fixtures/strict-openai-server.ts`
is a throwaway endpoint that rejects exactly what OpenAI rejects — unknown request fields, a missing
bearer token, a model id it does not serve:

```sh
bun run test/fixtures/strict-openai-server.ts 8199          # prints the token it expects
OG_API_KEY=test-token og --endpoint http://127.0.0.1:8199 -m strict-gpt -p "hello"
```

It logs the exact field set each request carried, which is the fastest way to prove what `og` is
sending before blaming the gateway.

### Generation is slow

Not a client-side problem, and not something `og` can diagnose: it cannot see the GPU, and against
a remote endpoint it is not even on the right machine.

What `og` *can* tell you is which phase is slow, which is enough to route the ticket:

```
/usage     last run  2 steps · 1.5s wall · decode 82.1 tok/s · ttft 1.2s
```

- **Low `tok/s` with a normal `ttft`** — decode is slow. Server or GPU.
- **High `ttft` that grows with the transcript** — prefill dominates. Expected; `ttft` includes
  prefilling the whole transcript, so it grows with context. A shorter session or more aggressive
  compaction helps.
- **Both collapsed together** on a local llama.cpp server — on a 16 GiB card this is very likely
  the driver spilling weights to host RAM once resident VRAM passes ~15.4 GiB. It never errors and
  never logs; throughput just drops about 8x. The measurement, the cliff and the fix ladder are in
  [`../../og-llama-cpp/docs/benchmarks.md`](../../og-llama-cpp/docs/benchmarks.md) §5, and the
  offload split that avoids it is a `serve.ts` profile, not an `og` setting.

Server-side reading, on the box that runs the server: `nvidia-smi` for who else is on the GPU, and
llama.cpp's own per-request timings, which appear directly in the terminal running
`serve.ts` (it inherits stdio):

```
slot print_timing: id  0 | task 2744 | prompt eval time = 72.25 ms / 11 tokens (6.57 ms per token, 152.24 tokens per second)
slot print_timing: id  0 | task 2744 |        eval time = 20.43 ms /  2 tokens (20.43 ms per token,  48.95 tokens per second)
```

Prompt eval is prefill, eval is generation. Very short requests look slow per-token because of
fixed overhead; judge throughput only on requests of a few hundred tokens or more.

### Context exhaustion and compaction

The agent budgets against the entry's `contextWindow`, holds back `agent.contextReservePct` (0.25)
for the next response plus tool results, and compacts once usage passes
`agent.compactThresholdPct` (0.75). Compaction drops the **oldest whole turns** — a user
message plus every assistant/tool message following it — never a partial turn, and never the
newest turn; it leaves a `[earlier context omitted: N messages, ~T tokens]` marker. `--json`
runs emit a `compaction` event with `removedMessages` and `freedTokens`.

Signs you need more room: frequent `compaction` events, or `/context` in the TUI showing tool
results dominating the window.

- Use an entry with a larger window against a server actually started with that much `-c`
  (`your-other-model` is 65536) rather than raising `contextWindow` past what the server
  serves — see *Context window mismatch* above.
- Lower `tools.maxOutputBytes` (default 65536) if giant `bash`/`grep` results are eating the
  window.
- Split the task. A single turn whose *own* content exceeds the window cannot be compacted away
  (the last turn is never dropped); it is sent as-is with an honest `removed` count and the server
  will truncate. That shows up as a suspiciously confused model, not an error.

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

## 6. Serving, installs and upgrades

Not this project's concern, and not reachable from this project's code. `og` talks HTTP to
`endpoint` and stops there; getting a pinned llama.cpp CUDA `llama-server` onto the box, running
it, bumping its build, rolling one back and building it by hand all live in the sibling
`../og-llama-cpp` directory:

| Task | Where |
| --- | --- |
| Install the pinned build (Linux and Windows) | `../../og-llama-cpp/README.md` |
| Run a server (`serve.ts`), inspect its argv, pick an operating point | `../../og-llama-cpp/README.md` |
| Bump the build, revalidate, roll back | `../../og-llama-cpp/docs/upgrading.md` |
| Build llama.cpp by hand | `../../og-llama-cpp/docs/building-by-hand.md` |
| VRAM and throughput per operating point, measured; the spill cliff and its fix ladder | `../../og-llama-cpp/docs/benchmarks.md` |
| `llama-server` flag names for the pinned build | `../../og-llama-cpp/serve.ts` — the only place in the repository that builds that argv |

Nothing stays this project's problem after a server-side change. **`contextWindow` is discovered**:
og reads `meta.n_ctx` from `GET /v1/models` and budgets against the window the server actually
allocated, so a re-measurement that moves an operating point's `-c` needs no edit here. A window
written into a config entry still wins for that entry — `og models` prints both when they disagree
(`window 8192 (as served) · configured 32768`), which is the one case worth reading.

The client-side smoke test after any server change is two commands, run with the server up:

```sh
og -p "reply with the single word ready" --max-steps 1
og --json -p "list the files in src/ and count them"   # exercises tools end to end
```

The first proves the endpoint, the key and the model id. The second proves the chat template: if
tool calls come back as prose instead of `tool-start` events, see §5.
