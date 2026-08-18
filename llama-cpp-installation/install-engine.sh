#!/usr/bin/env bash
# Build + install the pinned llama.cpp CUDA server on Linux.
#
# Upstream ships no Linux CUDA release asset (only `llama-*-bin-win-cuda-*.zip`
# and CPU/Vulkan/SYCL tarballs for Ubuntu), so on Linux the CUDA backend has to
# be compiled locally. The layout produced here matches what install-engine.ps1
# produces on Windows, because `engine.binDir` is a flat directory holding
# `llama-server` next to every shared library it needs:
#
#   ~/.local/llama.cpp/<build>/llama-server, libggml-cuda.so, libcudart.so.13, ...
#   ~/.local/llama.cpp/current -> <build>
#
# Binaries are linked with RPATH=$ORIGIN, so the CUDA runtime is picked up from
# that same directory: no LD_LIBRARY_PATH, no system-wide CUDA install, and og
# can spawn the server with a bare argv.
set -euo pipefail

BUILD="${OG_LLAMA_BUILD:-b10488}"
ROOT="${OG_LLAMA_ROOT:-$HOME/.local/llama.cpp}"
SRC="${OG_LLAMA_SRC:-$HOME/.local/src/llama.cpp-$BUILD}"
CUDA_DIR="${CUDA_PATH:-${CUDA_HOME:-$HOME/.local/cuda}}"
JOBS="${OG_BUILD_JOBS:-$(nproc)}"
DEST="$ROOT/$BUILD"
STAGE="$SRC/stage"

die() { printf 'install-engine: %s\n' "$*" >&2; exit 1; }

command -v cmake >/dev/null || die 'cmake not found on PATH (>= 3.18 required)'
command -v git >/dev/null || die 'git not found on PATH'
[[ -x "$CUDA_DIR/bin/nvcc" ]] || die "no nvcc at $CUDA_DIR/bin/nvcc; set CUDA_PATH to a CUDA >= 12.8 toolkit"

# sm_120 (Blackwell) needs CUDA >= 12.8; compiling every architecture instead
# costs ~10x build time for kernels this GPU will never run.
ARCH="${OG_CUDA_ARCH:-}"
if [[ -z "$ARCH" ]]; then
	cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ')"
	[[ -n "$cap" ]] || die 'cannot read compute capability from nvidia-smi; set OG_CUDA_ARCH (e.g. 120)'
	ARCH="${cap//./}"
fi

echo "build      $BUILD"
echo "source     $SRC"
echo "cuda       $CUDA_DIR ($("$CUDA_DIR/bin/nvcc" --version | sed -n 's/^Cuda compilation tools, release \(.*\), V.*/\1/p'))"
echo "arch       sm_$ARCH"
echo "jobs       $JOBS"

if [[ ! -d "$SRC/.git" ]]; then
	echo "cloning llama.cpp $BUILD ..."
	git clone --depth 1 --branch "$BUILD" https://github.com/ggml-org/llama.cpp.git "$SRC"
fi

# LLAMA_CURL=OFF drops the libcurl dev dependency: og passes local -m paths and
# never asks llama-server to download weights.
#
# The two RPATH knobs earn their keep on a rootless CUDA install:
#  - INSTALL_RPATH=$ORIGIN makes the flat install directory self-contained;
#    BUILD_WITH_INSTALL_RPATH stays OFF so the build tree keeps real paths.
#  - -rpath-link is what makes the link succeed at all. libggml-cuda.so carries
#    DT_NEEDED on libcudart.so.13 / libcublas.so.13, and ld must find those
#    files to resolve them for every executable that links libggml. With CUDA
#    outside the default search path (and DT_RUNPATH, which ld does not follow
#    for indirect dependencies), the link fails with hundreds of
#    "undefined reference to `cudaMalloc@libcudart.so.13'" errors.
cmake -S "$SRC" -B "$SRC/build" \
	-DCMAKE_BUILD_TYPE=Release \
	-DGGML_CUDA=ON \
	-DCMAKE_CUDA_ARCHITECTURES="$ARCH" \
	-DCMAKE_CUDA_COMPILER="$CUDA_DIR/bin/nvcc" \
	-DLLAMA_CURL=OFF \
	-DLLAMA_BUILD_TESTS=OFF \
	-DLLAMA_BUILD_EXAMPLES=OFF \
	-DLLAMA_BUILD_TOOLS=ON \
	-DLLAMA_BUILD_SERVER=ON \
	-DBUILD_SHARED_LIBS=ON \
	-DCMAKE_INSTALL_PREFIX="$STAGE" \
	-DCMAKE_INSTALL_RPATH='$ORIGIN' \
	-DCMAKE_BUILD_WITH_INSTALL_RPATH=OFF \
	-DCMAKE_EXE_LINKER_FLAGS="-Wl,-rpath-link,$CUDA_DIR/lib64" \
	-DCMAKE_SHARED_LINKER_FLAGS="-Wl,-rpath-link,$CUDA_DIR/lib64"

cmake --build "$SRC/build" --target install -j "$JOBS"

[[ -x "$STAGE/bin/llama-server" ]] || die "build produced no server at $STAGE/bin/llama-server"

# Rename rather than overwrite: a running llama-server keeps its executable and
# every .so it loaded mapped, and writing into those files fails with ETXTBSY.
# A rename swaps the directory entry and leaves the live process on the old
# inode, so an engine started by a previous og run survives the upgrade and
# picks the new build up on its next start.
install_file() {
	local src=$1 dest=$2
	cp -fP "$src" "$dest.og-new"
	mv -f "$dest.og-new" "$dest"
}

mkdir -p "$DEST"
for file in "$STAGE"/bin/* "$STAGE"/lib/*.so*; do
	[[ -e "$file" ]] || continue
	install_file "$file" "$DEST/$(basename "$file")"
done

# The CUDA runtime libraries the server links against, copied in so the install
# keeps working if the toolkit is moved or removed (same trick as the Windows
# cudart zip). Only the sonames actually needed by ggml-cuda.
for lib in libcudart libcublas libcublasLt; do
	for file in "$CUDA_DIR"/lib64/$lib.so.*; do
		[[ -e "$file" ]] || die "missing $lib in $CUDA_DIR/lib64"
		install_file "$file" "$DEST/$(basename "$file")"
	done
done

ln -sfn "$DEST" "$ROOT/current"

echo '--- installed ---'
ls -1 "$DEST" | sed -n '1,12p'
"$ROOT/current/llama-server" --version 2>&1 | sed -n '1,6p'
