# Measurement record

Every serving profile in [`../serve.ts`](../serve.ts) — and every context window the
sibling `../../og-cli` checkout ships in `src/config/load.ts` — comes from this document, and this
document comes from runs on one machine. It exists so that a future engine upgrade can be
validated against real prior art instead of vibes, and so that nobody has to re-derive why the
fastest number in the table is not the default.

Reproduce with `bun run tools/bench.ts` (raw kernel ceiling) and `bun run tools/profile-sweep.ts`
(serving profiles); both are cross-platform. The numbers recorded below were produced by the
PowerShell predecessors of those two scripts, on the Windows install described in §1. Re-run both
after any llama.cpp upgrade — see [`upgrading.md`](upgrading.md).

---

## 1. Hardware and software under test

| | |
| --- | --- |
| GPU | NVIDIA GeForce RTX 5070 Ti, 16303 MiB, Blackwell, compute capability 12.0 (`sm_120`) |
| Driver | 610.88, CUDA UMD 13.3 |
| CPU | AMD Ryzen 7 9800X3D (8C/16T) |
| RAM | 64 GiB |
| OS | Windows 11 Pro, build 26200 |
| Engine | llama.cpp build **b10488**, commit `9d77fa172` |
| Binaries | prebuilt `llama-b10488-bin-win-cuda-13.3-x64.zip` + `cudart-llama-bin-win-cuda-13.3-x64.zip`, installed to `%USERPROFILE%\.local\llama.cpp\b10488` with a `current` junction (`install-engine.ps1`) |
| Idle GPU use | **968 MiB** with the desktop up and no model loaded |
| Working budget | **15200 MiB** resident (16303 total, headroom held for the desktop) |

### Weights

| File | Size | Notes |
| --- | --- | --- |
| `Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf` | 16.45 GiB | 30B MoE, ~3B active. Larger than the card — some expert layers must live on the CPU |
| `Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf` | 12.86 GiB | Same architecture, lower precision. Fits with room for KV |
| `Devstral-Small-2507-Q4_K_M.gguf` | 13.35 GiB | 24B dense. Fits, but leaves little for KV |

All three live in `%USERPROFILE%\models`.

## 2. Method

Two distinct measurements, because they answer different questions.

**A. Raw kernel ceiling — `llama-bench`, `pp2048` / `tg128`.**
2048-token prompt processing and 128-token generation with no large KV cache. Deliberately
optimistic: it excludes the KV cache that dominates VRAM in a real agent session, so it measures
what the GPU can do, not what a serving profile will do.

**B. Serving profile — `llama-server`, 6k-token prefill + 256-token generation.**
One server per case, launched with the same argv [`../serve.ts`](../serve.ts) uses:
`q8_0` K and V cache, flash attention **on**, `-b 2048 -ub 512 --parallel 1 --cont-batching`,
`--jinja`. The prompt is realistic source text (~4.2 chars/token) sized to 6000 tokens — an agent
session with a system prompt, tool schemas and a few files read is in exactly that range. VRAM is
sampled with `nvidia-smi --query-gpu=memory.used,memory.total` **while the model is loaded and
serving**, not from the GGUF size. Server is torn down between cases so each number is independent.

Prefill (prompt eval) and generation (eval) throughput are read from the server's own
`print_timing` output. "Headroom" below is `16303 - vramMiB`.

## 3. Raw kernel ceiling (`llama-bench`, pp2048/tg128)

| Weights | Offload | Prefill (tok/s) | Generation (tok/s) |
| --- | --- | --- | --- |
| Qwen3-Coder-30B Q3_K_XL | full (`-ngl 99`, all experts on GPU) | 4957 | 245.8 |
| Qwen3-Coder-30B Q4_K_XL | `--n-cpu-moe 8` | 2184 | 131.6 |
| Devstral-Small-2507 Q4_K_M | full (`-ngl 99`) | 2392 | 54.9 |

Reading: the MoE models are dramatically faster per token than the 24B dense model because only
~3B parameters are active per token. Q3 fully resident is 1.9x the generation rate of Q4 with 8
expert layers on the CPU, and 4.5x the dense 24B. **None of these numbers are achievable in a
real session** — they carry no meaningful KV cache. They are the ceiling, useful only as a
sanity reference for the serving numbers below.

## 4. Serving sweep (6k prefill + 256 generation, `q8_0` KV, flash attention on)

Verdicts are the values recorded during the sweep.

### Qwen3-Coder-30B Q4_K_XL (16.45 GiB)

| ctx | `--n-cpu-moe` | VRAM (MiB) | Headroom (MiB) | Prefill (tok/s) | Generation (tok/s) | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 32768 | 10 | 15750 | 553 | **120** | **29.2** | SPILLING |
| 32768 | 12 | 15364 | 939 | 1644 | 88.5 | marginal |
| 32768 | 14 | 14714 | 1589 | 1476 | 82.1 | **chosen: `qwen3-coder-30b`** |
| 65536 | 16 | 15730 | 573 | 1339 | 75.7 | SPILLING |
| 65536 | 18 | 15082 | 1221 | 1238 | 69.5 | **chosen: `qwen3-coder-30b-long`** |

### Qwen3-Coder-30B Q3_K_XL (12.86 GiB)

| ctx | `--n-cpu-moe` | VRAM (MiB) | Headroom (MiB) | Prefill (tok/s) | Generation (tok/s) | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 32768 | 4 | 14569 | 1734 | 2957 | 136.5 | **chosen: `qwen3-coder-30b-fast`** |
| 32768 | 6 | 14075 | 2228 | 2544 | 123.3 | safe, slower |
| 65536 | 8 | 15243 | 1060 | 2289 | 113.3 | SPILLING |
| 65536 | 10 | 14749 | 1554 | 2052 | 104.2 | safe |

### Devstral-Small-2507 Q4_K_M (13.35 GiB, dense)

| ctx | `-ngl` | VRAM (MiB) | Headroom (MiB) | Prefill (tok/s) | Generation (tok/s) | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 8192 | 99 | 15045 | 1258 | 2292 | 51.3 | **chosen: `devstral-24b`** |
| 12288 | 99 | 15388 | 915 | 2308 | 51.4 | no verdict recorded |
| 16384 | 38 | 14655 | 1648 | 1782 | 24.9 | partial offload |
| 32768 | 34 | 14409 | 1894 | 1375 | 14.1 | partial offload |

## 5. Spill-cliff analysis

### What the driver does

Once resident VRAM passes roughly **15.4 GiB** on this 16303 MiB card, the NVIDIA driver's
system-memory fallback begins paging weights to host RAM over PCIe. The server stays healthy,
`/health` stays green, answers stay correct, and throughput drops by about **8x**. There is no
error, no warning, and no log line from llama.cpp — the only signal is the number.

### The measured collapse

One row in the sweep is an unambiguous, measured collapse:

| Config | VRAM | Headroom | Prefill | Generation |
| --- | --- | --- | --- | --- |
| Q4 c32768 `--n-cpu-moe 12` | 15364 MiB | 939 MiB | 1644 tok/s | 88.5 tok/s |
| Q4 c32768 `--n-cpu-moe 10` | 15750 MiB | 553 MiB | **120 tok/s** | **29.2 tok/s** |

**386 MiB** of additional resident memory costs **13.7x prefill** (1644 -> 120) and **3.0x
generation** (88.5 -> 29.2). That is the entire story of this project in one row pair. The
degradation is not gradual — moving two expert layers back onto the GPU, which *should* have
made things faster, made prefill fourteen times slower.

### The other flagged rows

The remaining `SPILLING` verdicts (Q4 c65536 ncmoe16 at 15730 MiB, Q3 c65536 ncmoe8 at 15243
MiB) do **not** show a collapse in their own throughput numbers — 1339/75.7 and 2289/113.3 are
both faster than the safe configs one step below them. They were flagged on **headroom**, not on
observed throughput. The reasoning, which is judgement rather than measurement: the sweep ran on
an *idle* 968 MiB desktop, and 553-1060 MiB of headroom is consumed by a browser with hardware
acceleration or a video call. A config that is fast on a clean desktop and 8x slower the moment
someone opens Chrome is not a config worth shipping as a default. That is why every chosen
profile targets **>= 1.2 GiB free**, roughly 250 MiB above the idle desktop's own appetite.

The Devstral c12288 row (15388 MiB, 915 MiB headroom) was recorded without a verdict even though
its headroom is lower than the flagged Q3 row's. It was not a candidate — it buys 4k of context
for 343 MiB of headroom at identical throughput (51.4 vs 51.3 tok/s) — so the inconsistency in
the record never mattered. By the >= 1.2 GiB rule it would be rejected.

### Why the fastest raw number is not the default

`llama-bench` says Q3 fully resident reaches **245.8 tok/s** generation. `qwen3-coder-30b-fast`
is the closest shipping profile at **136.5 tok/s**, and the default `qwen3-coder-30b` runs at
**82.1 tok/s** — a third of the raw ceiling and 40% below the fastest shipping profile. Three
reasons, in order of weight:

1. **KV cache is not free.** The 245.8 figure comes from `tg128` with essentially no KV cache.
   A 32768-token `q8_0` KV cache is real VRAM that has to come from the same 16303 MiB, and its
   cost is what forces expert layers onto the CPU in the first place. Every serving number in §4
   is what remains after paying for context that an agent actually needs.
2. **Q3 is a quality trade, not a free lunch.** `qwen3-coder-30b-fast` is the same model at
   lower precision. It is measurably looser at structured output, which for an agent means
   malformed tool-call arguments — the loop recovers (it feeds the error back and the model
   retries), but a retry costs a full turn and wall-clock. A 1.7x faster model that needs an
   extra turn one time in five is not 1.7x faster.
3. **Headroom is a correctness property here, not a nicety.** The default sits at 14714 MiB /
   1589 MiB free specifically so that a normal desktop cannot push it over the cliff. Choosing
   `--n-cpu-moe 12` for its 88.5 tok/s (+8%) would leave 939 MiB and put the whole session one
   Chrome window away from 29.2 tok/s (-64%). The expected value of the extra 8% is negative.

So the default is the fastest configuration that is *robustly* fast. `qwen3-coder-30b-fast`
remains one flag away (`--profile qwen3-coder-30b-fast` when serving, `-m qwen3-coder-30b-fast` in
a client) for work where iteration speed beats precision.

### Why `devstral-24b` is capped at 8192

Full offload of the dense 24B at Q4 leaves room for only 8k of `q8_0` KV (15045 MiB, 1258 MiB
free). Buying more context requires partial offload, and the sweep prices that exactly:

| ctx | `-ngl` | Generation (tok/s) | vs 8192 |
| --- | --- | --- | --- |
| 8192 | 99 | 51.3 | — |
| 16384 | 38 | 24.9 | 0.49x |
| 32768 | 34 | 14.1 | 0.27x |

2x the context for **half** the speed, 4x for **a quarter**. Full offload with a short window is
the only sane operating point, so the profile ships `ctx: 8192` and `contextWindow: 8192` and
`og` compacts against that.

### Root cause of the original problem

The investigation started because LM Studio, running the same Q4 weights on the same card, was
roughly 8x slower than the hardware allowed. It was not a bug in LM Studio's inference — it was
the driver spill above, caused by an offload split that left too little VRAM headroom, with no
surface anywhere in the UI reporting that weights had been paged to host RAM. Everything
"worked". That is precisely why the operating points in `../serve.ts` are measured rather
than a slider, and why `tools/profile-sweep.ts` samples `nvidia-smi` while the model is actually
serving instead of trusting the GGUF size.

## 6. End-to-end agent runs

Live GPU, default profile `qwen3-coder-30b` (Q4_K_XL, ctx 32768, `--n-cpu-moe 14`), real
workspace, real tools.

| Scenario | Surface | Result | Steps / tool calls | Wall time | Notes |
| --- | --- | --- | --- | --- | --- |
| Fix an off-by-one bug in a fizzbuzz implementation so its checker passes | headless (`-p`) | **PASS** | 6 tool calls | 20 s | Read, located the bug, edited, re-ran the checker, confirmed green |
| Implement an `LruCache` class from a written spec | headless (`-p`) | **PASS** | — | 9 s | Wrote the file and verified against the spec's usage |
| Add a `peek()` method to an existing `LruCache` | interactive TUI | **PASS** | 6 steps | 18.2 s | 91.2 tok/s decode-only; context 9% of 32768 |

Two things worth reading off the third row. First, **91.2 tok/s decode-only versus the 82.1
tok/s sweep figure**: the sweep number includes the 6k prefill in its accounting window, so a
short-prompt interactive turn measures a little higher. They are consistent. Second, **context
at 9% of 32768** on a real multi-step feature addition: the default 32k window is not the
binding constraint for ordinary work, which is why the default profile spends its VRAM on
headroom and expert residency rather than on a bigger KV cache. `qwen3-coder-30b-long` exists
for the sessions that genuinely need 64k, and pays 15% throughput for it.
