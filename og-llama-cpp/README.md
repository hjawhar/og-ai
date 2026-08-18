# og-llama-cpp

Everything needed to put a pinned llama.cpp CUDA `llama-server` on this machine, and nothing
about `og`. The two concerns are separate directories on purpose: the `og` coding CLI (sibling
`../og-cli`) speaks OpenAI-compatible HTTP and does not care who serves it, and this
directory produces a server that does not know `og` exists. Point `og` at a remote endpoint and
none of this is needed.

One of the two projects in the [`og-ai`](../README.md) repository, alongside
[`og-cli`](../og-cli). Agent-facing context for both lives in one place,
[`../AGENTS.md`](../AGENTS.md).

There is no CI here and nothing is published: everything in this directory needs a GPU and
minutes of wall time, so verification is local — `llama-server --list-devices` after an install,
and a sweep compared against [`docs/benchmarks.md`](docs/benchmarks.md) after a build bump.

| Path | Platform | Method |
| --- | --- | --- |
| `install-engine.sh` | Linux | compiles the pinned tag with CUDA |
| `install-engine.ps1` | Windows | unzips the prebuilt upstream CUDA release |
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

That flat shape is what `og`'s `engine.binDir` expects: it spawns `<binDir>/llama-server` with a
bare argv and no environment fixup, so the server has to find its own libraries. `current` is the
indirection that lets a build bump happen without touching config.

Verify an install:

```sh
~/.local/llama.cpp/current/llama-server --version
~/.local/llama.cpp/current/llama-server --list-devices
```

The second command is the one that matters: it must list a CUDA device. A build that reports only
a CPU backend will load a model and run roughly two orders of magnitude slower.

```console
Available devices:
  CUDA0: NVIDIA GeForce RTX 5070 Ti (15838 MiB, 14575 MiB free)
```

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

`-DLLAMA_CURL=OFF` drops the libcurl dev dependency: `og` passes local `-m` paths and never asks
`llama-server` to download weights.

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

## Bumping the build

```sh
OG_LLAMA_BUILD=bNNNNN ./install-engine.sh                    # Linux: rebuilds from the new tag
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install-engine.ps1 -Build bNNNNN
```

Both re-point `current`, so a client needs no config change — but a new build has to be
revalidated before it is trusted: kernel and allocator changes move the VRAM spill threshold by
hundreds of MiB, silently. The full drill (verify, re-measure, roll back, check for renamed
`llama-server` flags) is [`docs/upgrading.md`](docs/upgrading.md).

## Measuring

```sh
bun run tools/bench.ts            # raw kernel ceiling, no KV-cache pressure
bun run tools/profile-sweep.ts    # VRAM + prefill/generation per serving profile
```

Both are self-contained Bun scripts that drive the installed binaries and import nothing from any
client. Recorded results, the spill-cliff analysis and the method behind them:
[`docs/benchmarks.md`](docs/benchmarks.md).

## Weights

The installers deal with the engine only; weights are separate and go in `engine.modelsDir`
(`~/models` by default). The profile `og` ships as default wants one 16.45 GiB file:

```sh
mkdir -p ~/models && cd ~/models
curl -SfL --retry 5 -C - -O \
  https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf
```

`-C -` matters: a resumed download is the difference between a hiccup and starting 16 GiB again.
Verify the size against the server's `content-length` (17665334432 bytes for that file) — a
truncated GGUF fails at load with a tensor-count error, not a checksum error.

A client's own model listing (`og models`, for the sibling `../og-cli` checkout) is the fastest
way to catch a filename typo before anything touches the GPU. Operational failure modes of a
*running* engine — VRAM spill, port conflicts, stale locks, startup timeouts — belong to whoever
supervises the server; for `og` they are in `../og-cli/docs/runbook.md`.
