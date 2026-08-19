# og-llama-cpp

Everything needed to put a pinned llama.cpp CUDA `llama-server` on this machine and run it, and
nothing about `og`. The two concerns are separate directories on purpose: the `og` coding CLI
(sibling `../og-cli`) speaks OpenAI-compatible HTTP and does not care who serves it, and this
directory produces and runs such a server without knowing `og` exists. Point `og` at a remote
endpoint and none of this is needed.

One of the two projects in the [`og-ai`](../README.md) repository, alongside
[`og-cli`](../og-cli). Agent-facing context for both lives in one place,
[`../AGENTS.md`](../AGENTS.md).

There is no CI here and nothing is published. `bun test` covers the two pure pieces — the GGUF
reader and the fit arithmetic behind the UI's verdicts — and everything else needs a GPU and
minutes of wall time, so verification is local: `llama-server --list-devices` after an install, a
`bun run serve.ts` launch, and a sweep compared against [`docs/benchmarks.md`](docs/benchmarks.md)
after a build bump.

| Path | Platform | Method |
| --- | --- | --- |
| `install-engine.sh` | Linux | compiles the pinned tag with CUDA |
| `install-engine.ps1` | Windows | unzips the prebuilt upstream CUDA release |
| `serve.ts` | both | runs `llama-server` in the foreground on a measured serving profile |
| `ui/` | both | Angular + Tailwind page over a Bun JSON API: installed weights, downloadable weights, what fits this GPU |
| `tools/bench.ts` | both | raw kernel throughput via `llama-bench` |
| `tools/profile-sweep.ts` | both | VRAM and serving throughput per candidate profile |
| `docs/` | — | [measurement record](docs/benchmarks.md), [upgrade drill](docs/upgrading.md), [manual build](docs/building-by-hand.md) |
| `../AGENTS.md` | — | agent context for this project and `og-cli` both |

Pinned build: **b10488** (commit `9d77fa172`).

## What both installers produce

```
~/.local/llama.cpp/b10488/       llama-server + every .so/.dll it loads, flat in one directory
~/.local/llama.cpp/current  ->   b10488        (symlink on Linux, junction on Windows)
```

That flat shape is what [`serve.ts`](serve.ts) and the measurement tools expect: they
spawn `<root>/current/llama-server` with a bare argv and no environment fixup, so the server has to
find its own libraries. `current` is the indirection that lets a build bump happen without touching
any command line.

Neither installer trusts its own success: each ends by running the binary it just installed and
refuses to finish unless `llama-server --list-devices` names a CUDA device. A CPU-only install is
the failure worth catching here, because it loads a model and runs roughly two orders of magnitude
slower rather than failing:

```console
--- installed ---
dir        /home/you/.local/llama.cpp/b10488
version    0.1.2-dev (build 10488, commit 9d77fa172)
device     CUDA0: NVIDIA GeForce RTX 5070 Ti (16302 MiB, 15037 MiB free)
```

To re-check an install later:

```sh
~/.local/llama.cpp/current/llama-server --version
~/.local/llama.cpp/current/llama-server --list-devices
```

The second command is the one that matters: it must list a CUDA device.

## Linux

Upstream publishes no Linux CUDA release asset — the b10488 assets are `llama-*-bin-win-cuda-*.zip`
for Windows plus CPU/Vulkan/SYCL/OpenVINO tarballs for Ubuntu — so `ggml-cuda` is compiled here.

Required:

- `git`, and CMake >= 3.18 on `PATH`
- a CUDA toolkit >= 12.8, because `sm_120` (Blackwell) kernels need at least that. The installer
  looks for `$CUDA_PATH/bin/nvcc` and defaults to `~/.local/cuda`
- a C++ compiler for `nvcc` to drive (GCC 15.2 on the reference box; CUDA 13.0 added GCC 15 support)
- `nvidia-smi`, used only to probe the GPU's compute capability — set `OG_CUDA_ARCH` to skip it

```sh
./install-engine.sh
```

Environment knobs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OG_LLAMA_BUILD` | `b10488` | upstream tag to build |
| `OG_LLAMA_ROOT` | `~/.local/llama.cpp` | install root holding `<build>/` and `current` |
| `OG_LLAMA_SRC` | `~/.local/src/llama.cpp-<build>` | source checkout and build tree |
| `CUDA_PATH` | `~/.local/cuda` | CUDA toolkit root (`CUDA_HOME` also read) |
| `OG_CUDA_ARCH` | probed from `nvidia-smi` | CUDA architecture, e.g. `120` |
| `OG_BUILD_JOBS` | `nproc` | parallel compile jobs |

Re-running is cheap and safe: CMake reuses the build tree, so an unchanged tag relinks and
reinstalls in seconds, and the installer renames files into place rather than writing over them —
a `llama-server` that is currently running keeps its mapped inode and picks the new build up on
its next start.

### CUDA toolkit without root

Ubuntu 26.04 ships `nvidia-cuda-toolkit` 12.4, which cannot target `sm_120`. NVIDIA's own
`ubuntu2604` repository has 13.3, and its packages can be unpacked into `$HOME` without touching
the system — no `apt`, no root, nothing to uninstall later:

```sh
base=https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2604/x86_64
mkdir -p ~/.local/src/cuda-debs && cd ~/.local/src/cuda-debs
curl -sSfL "$base/Packages.gz" | gunzip > Packages

# nvcc and its backends, the runtime, cuBLAS, and the CCCL headers ggml-cuda
# compiles against. `awk -v RS=''` walks the index one stanza at a time; the
# version lives in the filename, so `sort -V | tail -1` picks the newest build.
for pkg in cuda-nvcc-13-3 cuda-crt-13-3 libnvvm-13-3 libnvptxcompiler-13-3 \
           cuda-cudart-13-3 cuda-cudart-dev-13-3 cuda-culibos-dev-13-3 \
           libcublas-13-3 libcublas-dev-13-3 cccl-13-3 \
           cuda-profiler-api-13-3 cuda-nvtx-13-3 cuda-nvrtc-13-3 cuda-nvrtc-dev-13-3 \
           cuda-toolkit-13-3-config-common cuda-toolkit-13-config-common \
           cuda-toolkit-config-common; do
  deb=$(awk -v RS='' -v p="$pkg" '$0 ~ ("(^|\n)Package: " p "\n")' Packages |
        grep '^Filename:' | awk -F/ '{print $NF}' | sort -V | tail -1)
  [ -n "$deb" ] || { echo "no such package: $pkg" >&2; exit 1; }
  curl -sSfLO "$base/$deb"
done

for deb in *.deb; do dpkg-deb -x "$deb" ~/.local/cuda-extract; done
mv ~/.local/cuda-extract/usr/local/cuda-13.3 ~/.local/cuda-13.3
rm -rf ~/.local/cuda-extract
ln -sfn ~/.local/cuda-13.3 ~/.local/cuda
~/.local/cuda/bin/nvcc --version
```

That is 17 packages and ~940 MiB of downloads; `cuda-nvcc` pulls in `cuda-crt`, `libnvvm` and
`libnvptxcompiler` as its own backends, and the two `libcublas` packages are most of the bytes.

CMake can come the same way if the distribution's is too old:

```sh
curl -sSfLO https://github.com/Kitware/CMake/releases/download/v4.4.2/cmake-4.4.2-linux-x86_64.tar.gz
mkdir -p ~/.local/cmake && tar xzf cmake-4.4.2-linux-x86_64.tar.gz -C ~/.local/cmake --strip-components=1
export PATH="$HOME/.local/cmake/bin:$PATH"
```

Footprint on the reference box: 2.1 GiB toolkit, 207 MiB CMake, 583 MiB source + build tree,
636 MiB installed engine.

### Why the CMake flags look like that

The two RPATH settings in `install-engine.sh` are not cosmetic:

- `-DCMAKE_INSTALL_RPATH='$ORIGIN'` makes the installed directory self-contained. The installer
  copies `libcudart.so.13`, `libcublas.so.13` and `libcublasLt.so.13` in beside `llama-server`, so
  the server needs neither `LD_LIBRARY_PATH` nor a system-wide CUDA, and the install survives the
  toolkit being moved or deleted. This is the same trick the Windows cudart zip plays.
- `-Wl,-rpath-link,$CUDA_PATH/lib64` is what makes the link succeed at all. `libggml-cuda.so`
  carries `DT_NEEDED` entries for `libcudart.so.13` and `libcublas.so.13`, and `ld` must be able to
  find those files to resolve them for every executable that links `libggml`. With CUDA outside the
  default search path — and with `DT_RUNPATH`, which `ld` does not follow for indirect dependencies
  — the link dies in hundreds of `undefined reference to 'cudaMalloc@libcudart.so.13'` errors.

`-DCMAKE_BUILD_WITH_INSTALL_RPATH` is deliberately **off**. Turning it on bakes `$ORIGIN` into the
build tree, where it resolves to a directory holding no CUDA libraries, and produces exactly the
link failure above.

`-DLLAMA_CURL=OFF` drops the libcurl dev dependency: `serve.ts` passes a local `-m` path and
never asks `llama-server` to download weights.

## Windows

Upstream ships prebuilt CUDA binaries for Windows, so nothing is compiled: no CUDA toolkit and no
compiler are needed, only an NVIDIA driver new enough for CUDA 13.3.

```powershell
powershell -ExecutionPolicy Bypass -File .\install-engine.ps1
```

It downloads `llama-b10488-bin-win-cuda-13.3-x64.zip` and
`cudart-llama-bin-win-cuda-13.3-x64.zip`, flattens both into
`%USERPROFILE%\.local\llama.cpp\b10488` and re-creates the `current` junction. Windows resolves
DLLs beside the executable, so the CUDA runtime never has to reach the system `PATH`.

Parameters mirror the Linux knobs: `-Build` (or `OG_LLAMA_BUILD`) and `-Root` (or
`OG_LLAMA_ROOT`).

## Serving

```sh
bun run serve.ts                                  # default profile, in the foreground
bun run serve.ts --profile qwen3-coder-30b-long   # 64k context instead of 32k
bun run serve.ts --list                           # print the profile table and exit
bun run serve.ts --dry-run                        # print the exact argv, launch nothing
```

`serve.ts` is the only place in this repository that builds a `llama-server` argv. Each
profile is a chosen row of [`docs/benchmarks.md`](docs/benchmarks.md) §4 — weights file, context
size, `-ngl`, `--n-cpu-moe`, and the model's own sampling defaults — so a profile key is shorthand
for a configuration measured to stay off the VRAM spill cliff on the reference card:

| Profile | Weights | ctx | `--n-cpu-moe` | Measured VRAM / generation |
| --- | --- | --- | --- | --- |
| `qwen3-coder-30b` (default) | Qwen3-Coder-30B Q4_K_XL | 32768 | 14 | 14714 MiB, 82.1 tok/s |
| `qwen3-coder-30b-long` | Qwen3-Coder-30B Q4_K_XL | 65536 | 18 | 15082 MiB, 69.5 tok/s |
| `qwen3-coder-30b-fast` | Qwen3-Coder-30B Q3_K_XL | 32768 | 4 | 14569 MiB, 136.5 tok/s |
| `devstral-24b` | Devstral-Small-2507 Q4_K_M | 8192 | — | 15045 MiB, 51.3 tok/s |

Every profile also gets `--cache-type-k/v q8_0`, `--flash-attn on`, `--jinja` (tool calling needs
the model's own chat template), `-b 2048 -ub 512 --parallel 1 --cont-batching`, `--no-webui` and
`--metrics`, on `127.0.0.1:8127` with half the logical cores. `--alias` is the profile key, so a
client asking for `"model": "qwen3-coder-30b"` is served by name. Sampling flags are only defaults:
a request that carries its own `temperature`/`top_p` overrides them.

One-off overrides: `--model`, `--ctx`, `--ngl`, `--n-cpu-moe`, `--threads`, `--host`, `--port`,
`--alias`, `--models-dir` (`OG_MODELS_DIR`), `--root` (`OG_LLAMA_ROOT`); everything after a bare
`--` is appended to the argv verbatim. `--help` lists them with their effective defaults.

The server runs in the **foreground** with inherited stdio, so llama.cpp's own log is the
operator's log and the process lives exactly as long as the terminal that started it. There is no
daemon, no pid file and no supervisor anywhere: Ctrl-C traps `SIGINT`/`SIGTERM` and kills the whole
pid tree (`taskkill /T /F` on Windows, `SIGTERM` then `SIGKILL` elsewhere), because a leaked
`llama-server` holds ~15 GiB of VRAM until somebody goes looking for it.

Setup mistakes are named before the GPU is touched: a missing binary reports the path it looked at
and the installer to run, and missing weights list the `.gguf` files actually present in the models
directory. `--dry-run` needs neither, so an argv can be reviewed on a box with no engine installed.

Any OpenAI-compatible client then points at `http://127.0.0.1:8127`:

```sh
curl -s http://127.0.0.1:8127/v1/models
```

The sibling [`og-cli`](../og-cli) is one such client and nothing more — it never spawns or
supervises a server, and when nothing is listening on its endpoint it says so and stops.

## Model UI

```sh
bun run ui           # http://127.0.0.1:8130 — the JSON API and the built page, one Bun process
bun run ui:build     # rebuild the Angular bundle into ui/dist/ui/browser
```

An Angular + TailwindCSS app in [`ui/`](ui/) — standalone components, SCSS component styles, its
own npm workspace — served together with its JSON API by a single Bun process on loopback. It
answers the three questions that decide whether a local setup is worth using:

- **What is installed** — every `.gguf` in the models directory, with the architecture, layer count
  and expert count read out of the file's own GGUF metadata, and a red flag when a file is shorter
  than the catalogued `content-length`, because a truncated GGUF fails minutes into loading with a
  tensor-count error.
- **What can be downloaded** — the weights this repository has measured plus a few smaller coding
  models, with live received/total bytes and MB/s while a fetch runs, and a cancel that stops it.
- **What this hardware can actually run** — per model: `fits on the GPU`, `fits with expert offload`
  (with the `--n-cpu-moe N` to use), `partial offload only` (with `-ngl N`), `CPU only`, or
  `too large for this machine`.

The verdict is the point, and it is the whole reason the page exists. Weights that do not fit still
load and still answer, while the driver pages them to host RAM at ~8x the cost
([`docs/benchmarks.md`](docs/benchmarks.md) §5). Nothing at runtime reports that — the original
investigation started from exactly this failure, an 8x slowdown with no surface anywhere saying
weights had spilled. The only signal is arithmetic done *before* launch, so the page does that
arithmetic and shows its working: weights + KV cache at the chosen context + ~900 MiB of runtime
allowance, against total VRAM minus the 1200 MiB of headroom every measured profile leaves.

Two labels, never mixed. **measured** means a row of `docs/benchmarks.md` for that exact file and
context — those win over arithmetic, and the suggested `--n-cpu-moe` is then the value
`tools/profile-sweep.ts` actually ran. **estimated** means computed from the GGUF's own metadata: KV
cache from `block_count` × `head_count_kv` × `key_length` at q8_0, per-layer expert size from the
summed `*_exps.*` tensors, plus the ~900 MiB runtime allowance, against total VRAM minus 1200 MiB.
Honest arithmetic, not a measurement — the allowance is itself derived from the one case where both
exist (Q4_K_XL at ctx 32768, `--n-cpu-moe 14`: 13839 MiB computed against 14714 MiB measured).

A third kind of number, kept away from both: the GPU card's **peak** FLOPS and TOPS —
175.8 TFLOPS dense fp16 and 351.5 TOPS dense int8 on the reference 5070 Ti. It is a ceiling, not a
measurement, and it is there so a measured 40-odd tok/s can be read for what it is: a
memory-bandwidth result on a card whose tensor cores are mostly idle. [`ui/server/compute.ts`](ui/server/compute.ts)
derives it from three inputs — dense per-SM-per-clock issue rates (256 FP32 FLOP, 1024 FP16 tensor
FLOP with FP16 accumulate, half that with FP32 accumulate, 2048 INT8 OP; identical across Ampere
GA10x, Ada and consumer Blackwell), the card's SM count, and its rated boost clock. `nvidia-smi`
supplies neither of the last two: it has no SM-count query field at all, and `clocks.max.sm` reads
3090 MHz on the reference card against a rated 2452 MHz boost, so deriving peaks from the live clock
would overstate every figure by 26%. Hence a table of 20 GeForce cards, each row cross-checked in
[`test/compute.test.ts`](test/compute.test.ts) against NVIDIA's own published FP32 TFLOPS; a card
that is not in it renders no peak line rather than a guess, and none of these figures ever enters
`docs/benchmarks.md`.

`Serve` hands the chosen file to [`serve.ts`](serve.ts) — the UI builds no argv of its own, so a
model launched from the browser runs the same command line as one launched from a terminal — with
the context from the row's input and the offload split from the verdict, and streams that process's
log into the page. `Stop server` kills the pid tree. Ctrl-C on the UI takes down anything it
started: the server it launched and any download still running.

The page talks to one small polled API on its own origin. There is no websocket, and a `POST` is an
acknowledgement rather than state — the page re-fetches after every one:

| Route | Purpose |
| --- | --- |
| `GET /api/state?ctx=<n>` | hardware, engine, reachable server, installed weights, catalogue, and a fit verdict per model at context `n` |
| `POST /api/download`, `POST /api/download/cancel` | start or cancel a catalogue download by key |
| `POST /api/serve`, `POST /api/server/stop` | spawn `serve.ts` for one file; kill what was spawned |

Flags on the Bun process (`ui/server/main.ts`): `--port`, `--host`, `--models-dir`
(`OG_MODELS_DIR`), `--root` (`OG_LLAMA_ROOT`), `--server-port` (the port it probes and launches
on, default 8127), `--open`, `--help`. It binds loopback and has **no authentication**, and it can
spawn processes and write files into the models directory — putting it on a LAN address is a
decision, not a default.

Working on the app itself: `cd ui && npm install`, then `npm start` for `ng serve` with live reload,
which proxies `/api` to `http://127.0.0.1:8130`, so `bun run ui` still has to be running to answer
it. `ui/` is the one directory in this repository with npm dependencies and a build step — Angular
CLI needs Node, so use `npm`/`npx` there, not `bun install`. Everything else here is a
dependency-free Bun script. Until `bun run ui:build` has produced `ui/dist/ui/browser`, the page
itself answers `503 The UI is not built yet.` and names the build command, while `/api/*` keeps
working — so the API is usable from `curl` on a box that has never run npm.

On a machine with no NVIDIA driver every verdict falls back to RAM-only, which is the honest answer:
a CPU-only build loads the same weights and runs roughly two orders of magnitude slower.

## Bumping the build

```sh
OG_LLAMA_BUILD=bNNNNN ./install-engine.sh                    # Linux: rebuilds from the new tag
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install-engine.ps1 -Build bNNNNN
```

Both re-point `current`, so no command line here changes and no client needs reconfiguring — but a
new build has to be revalidated before it is trusted: kernel and allocator changes move the VRAM
spill threshold by hundreds of MiB, silently. The full drill (verify, re-measure, roll back, check
for renamed `llama-server` flags) is [`docs/upgrading.md`](docs/upgrading.md).

## Measuring

```sh
bun run tools/bench.ts            # raw kernel ceiling, no KV-cache pressure
bun run tools/profile-sweep.ts    # VRAM + prefill/generation per serving profile
```

Both are self-contained Bun scripts, like `serve.ts`, that drive the installed binaries and
import nothing from any client. Recorded results, the spill-cliff analysis and the method behind
them: [`docs/benchmarks.md`](docs/benchmarks.md).

## Weights

The installers deal with the engine only; weights are separate and go in the models directory
(`~/models` by default, `--models-dir` or `OG_MODELS_DIR` to move it). The default serving profile
wants one 16.45 GiB file:

```sh
mkdir -p ~/models && cd ~/models
curl -SfL --retry 5 -C - -O \
  https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf
```

`-C -` matters: a resumed download is the difference between a hiccup and starting 16 GiB again.
Verify the size against the server's `content-length` (17665334432 bytes for that file) — a
truncated GGUF fails at load with a tensor-count error, not a checksum error.

`bun run ui` does the same check in a browser, with the fit verdict beside each file.
`bun run serve.ts --list` shows what each profile expects, and a launch that cannot find its
weights lists the `.gguf` files it did find — which is the fastest way to catch a filename typo
before anything touches the GPU. Operational failure modes of a *running* engine — VRAM spill, a
port already bound, a startup that stalls loading weights — surface in the foreground log of the
terminal you started it in.
