# Building llama.cpp by hand

[`install-engine.sh`](../install-engine.sh) already does this — on Linux a CUDA `llama-server` can
only come from a local build, because upstream ships no Linux CUDA asset. That script is the
maintained install path, and [`../README.md`](../README.md) documents it end to end, including the
rootless CUDA toolkit setup the reference box below assumes. Do it by hand only when you need
something the script does not pin: a patched llama.cpp, a different CUDA architecture list, or a
debug build. (There is no Windows counterpart to this page: `install-engine.ps1` unzips the
upstream CUDA release, so nothing is compiled there.)

**Required, and what the reference box has:**

- **CUDA Toolkit >= 12.8** for `nvcc` — `sm_120` needs at least 12.8. This box unpacks CUDA
  13.3 under `~/.local/cuda-13.3` with a `~/.local/cuda` symlink, so no part of the toolchain
  is installed as root.
- **A host C++ compiler** for `nvcc` to drive — GCC 15.2 here, which CUDA 13.3 accepts.
- **CMake** >= 3.18 (kept under `~/.local/cmake` on this box) and **git**.

```sh
git clone --depth 1 --branch b10488 https://github.com/ggml-org/llama.cpp.git
cd llama.cpp

# staging install, so the copy step below has a predictable layout
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=120 \
  -DCMAKE_CUDA_COMPILER="$HOME/.local/cuda/bin/nvcc" \
  -DLLAMA_CURL=OFF \
  -DBUILD_SHARED_LIBS=ON \
  -DCMAKE_INSTALL_PREFIX="$PWD/stage" \
  -DCMAKE_INSTALL_RPATH='$ORIGIN' \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
cmake --build build --target install -j"$(nproc)"

# install alongside the other builds as one flat directory, and re-point `current`
dest=~/.local/llama.cpp/src-9d77fa172
mkdir -p "$dest"
cp -f stage/bin/* "$dest"/
cp -f stage/lib/*.so* "$dest"/
cp -fP ~/.local/cuda/lib64/libcudart.so.* ~/.local/cuda/lib64/libcublas.so.* \
       ~/.local/cuda/lib64/libcublasLt.so.* "$dest"/
ln -sfn "$dest" ~/.local/llama.cpp/current
```

`LLAMA_CURL=OFF` drops the libcurl dev dependency: clients pass a local `-m` path and never ask
`llama-server` to download weights. `RPATH=$ORIGIN` plus those copied CUDA runtime libraries are
what make the install directory self-contained — the server is spawned with a bare argv, no
`LD_LIBRARY_PATH`, and the install survives moving or deleting the toolkit.

`nvcc --version` and `cmake --version` must both answer before the configure step.
`install-engine.sh` checks for them up front and refuses with `no nvcc at <path>/bin/nvcc`; by
hand you get CMake's compiler-detection failure instead, which is noisier and later.

## Why `-DCMAKE_CUDA_ARCHITECTURES=120`

The RTX 5070 Ti is Blackwell with **compute capability 12.0**, and CUDA architecture numbers
are the capability with the dot removed: 12.0 -> `120` (`sm_120`). Building only `120` produces
native SASS for exactly this GPU — smallest binary, fastest build, no JIT warm-up on first
kernel launch. The defaults compile a fat binary for many architectures, which takes far longer
and gains nothing on a single-GPU box.

If you build for a machine with a different card, set the architecture to match that card's
capability (Ada = `89`, Ampere = `86`/`80`, Hopper = `90`), or list several:
`-DCMAKE_CUDA_ARCHITECTURES="86;89;120"` — `OG_CUDA_ARCH` is the same dial for
`install-engine.sh`, which otherwise reads the capability from `nvidia-smi` itself. Confirm the
target's capability with:

```sh
nvidia-smi --query-gpu=name,compute_cap --format=csv
```

Building for the wrong architecture is another silent-performance failure: the driver JITs from
PTX if it can, and the kernels are slower than native.
