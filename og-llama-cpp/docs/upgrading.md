# Upgrading the pinned build

Pinned build: **b10488** (commit `9d77fa172`) — compiled from the `b10488` tag by
`install-engine.sh` on Linux, unzipped from the upstream release by `install-engine.ps1` on
Windows. Upstream publishes no Linux CUDA release asset — its CUDA archives
(`llama-b10488-bin-win-cuda-13.3-x64.zip` + `cudart-llama-bin-win-cuda-13.3-x64.zip`) are
Windows-only — so on Linux bumping the build means a rebuild, not a download.

The `og` commands below assume the sibling `../../og-cli` checkout supervising this engine; with
any other client, steps 3 and 4 become that client's restart and its VRAM readout.

```sh
# 1. build and install the new tag; no file here needs editing. This clones the tag
#    into ~/.local/src/llama.cpp-bNNNNN, compiles ggml-cuda from source, installs into
#    ~/.local/llama.cpp/bNNNNN and re-points the `current` symlink at it
OG_LLAMA_BUILD=bNNNNN ./install-engine.sh

# 2. verify the symlink and the binary
ls -l ~/.local/llama.cpp/current
~/.local/llama.cpp/current/llama-server --version
~/.local/llama.cpp/current/llama-server --list-devices   # must list a CUDA device

# 3. restart under the new build and smoke test
og engine stop
og engine start
og engine status
og -p "reply with the single word ready" --max-steps 1
og --json -p "list the files in src/ and count them"   # exercises tools end to end

# 4. RE-CHECK VRAM for every profile you use
og engine status      # vram used/total, per profile
```

On Windows only step 1 differs: pass the new tag to the installer, which downloads into
`%USERPROFILE%\.local\llama.cpp\bNNNNN` and re-creates the `current` junction pointing there.
Steps 3 and 4 are plain client commands and run unchanged.

```powershell
# 1. install the new tag
powershell -ExecutionPolicy Bypass -File .\install-engine.ps1 -Build bNNNNN

# 2. verify the junction and the binary
Get-Item $env:USERPROFILE\.local\llama.cpp\current | Select-Object LinkType, Target
& $env:USERPROFILE\.local\llama.cpp\current\llama-server.exe --version
```

## Step 4 is not optional

Kernel and allocator changes between builds move the spill threshold by hundreds of MiB in either
direction, and the failure is silent: past roughly 15.4 GiB resident on a 16303 MiB card the
driver pages weights to host RAM over PCIe, the server stays healthy, and generation collapses
from 70-140 tok/s to 15-30 tok/s. Re-run at least the default profile at a realistic prefill and
compare generation tok/s against [`benchmarks.md`](benchmarks.md); a 3x-8x drop means you are over
the line and the profile's `--n-cpu-moe` needs raising for the new build.

```sh
bun run tools/profile-sweep.ts    # re-measures VRAM and throughput per case
```

## Rollback

Trivial, because builds are installed side by side under `~/.local/llama.cpp/<build>`
(`%USERPROFILE%\.local\llama.cpp\<build>` on Windows): re-point the symlink or junction and
restart. Nothing is rebuilt or re-downloaded.

```sh
ln -sfn ~/.local/llama.cpp/b10488 ~/.local/llama.cpp/current
og engine stop && og engine start
```

On Windows a junction cannot be retargeted in place, so remove and re-create it:

```powershell
Remove-Item $env:USERPROFILE\.local\llama.cpp\current -Force
New-Item -ItemType Junction -Path $env:USERPROFILE\.local\llama.cpp\current -Target $env:USERPROFILE\.local\llama.cpp\b10488
```

## Check that flag names survived

The client builds the argv, and its flag names are verified against one specific build. For `og`
that is `src/engine/args.ts` in `../../og-cli`, emitting `-ngl`, `--n-cpu-moe`, `-c`,
`--cache-type-k/v`, `--flash-attn on|off`, `--jinja`, `-t`, `-b`, `-ub`, `--parallel`,
`--no-webui`, `--metrics`, `--cont-batching`, and the sampling flags. All were verified against
b10488's `llama-server --help`. A renamed or removed flag shows up as an immediate startup failure
with the argv in the message, which is the good kind of failure — but `llama-server --help` right
after an upgrade catches it earlier and cheaper.
