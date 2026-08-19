#!/usr/bin/env bash
# Build og from source and put it on PATH — Linux, macOS and Windows (Git Bash /
# MSYS2), one code path.
#
#   ./install.sh                        -> ~/.local/bin/og   (og.exe on Windows)
#   ./install.sh --dest /usr/local/bin
#   OG_INSTALL_DIR=~/bin ./install.sh
#
# `bun build --compile` emits a self-contained executable that embeds its
# runtime, so the only real platform differences are the `.exe` suffix and how
# PATH is edited. Bun is a build-time requirement only: the installed binary
# needs neither Bun nor Node, and copies to another box of the same platform.
set -euo pipefail

die() { printf 'install: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
usage: ./install.sh [--dest DIR] [--add-to-path]

  --dest DIR      where to install the binary (default: $OG_INSTALL_DIR, else ~/.local/bin)
  --add-to-path   put the install directory on PATH permanently: append an export to the
                  shell's rc file, and on Windows also add it to the user Path in the
                  registry. Idempotent. Without this the script only prints what to run.
  -h, --help      this text

Builds dist/og from this checkout and installs it as <DIR>/og. Requires bun >= 1.3
at build time only.
EOF
}

DEST="${OG_INSTALL_DIR:-$HOME/.local/bin}"
add_path=0
while (($#)); do
	case "$1" in
	--dest)
		[[ ${2:-} ]] || die '--dest needs a directory'
		DEST="$2"
		shift 2
		;;
	--dest=*)
		DEST="${1#*=}"
		shift
		;;
	--add-to-path)
		add_path=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage >&2
		die "unknown argument: $1"
		;;
	esac
done
DEST="${DEST%/}"

# Run from the script's own directory so `bash /path/to/og-cli/install.sh` works
# from anywhere, then refuse to build something that is not this project.
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -f package.json && -f src/index.ts ]] || die "not an og-cli checkout: $PWD"

case "$(uname -s)" in
Linux) os=linux exe='' ;;
Darwin) os=macos exe='' ;;
MINGW* | MSYS* | CYGWIN*) os=windows exe='.exe' ;;
*) die "unsupported platform $(uname -s); this script covers Linux, macOS and Windows Git Bash/MSYS2" ;;
esac

case "$os" in
windows) bun_hint='powershell -c "irm bun.sh/install.ps1 | iex"' ;;
*) bun_hint='curl -fsSL https://bun.sh/install | bash' ;;
esac

command -v bun >/dev/null || die "bun not found on PATH. Install it: $bun_hint"
bun_version="$(bun --version)"
IFS=. read -r bun_major bun_minor _ <<<"$bun_version"
# 1.3 is the floor in package.json's engines field; older Bun miss APIs used here.
((bun_major > 1 || (bun_major == 1 && bun_minor >= 3))) ||
	die "bun $bun_version is too old, >= 1.3 required. Upgrade: bun upgrade"

target="$DEST/og$exe"
printf '%-10s %s\n' \
	'platform' "$os" \
	'bun' "$bun_version" \
	'source' "$PWD" \
	'dest' "$target"

bun install # devDependencies only: typescript + @types/bun
bun run build

built="dist/og$exe"
[[ -f $built ]] || die "build produced no binary at $PWD/$built"

mkdir -p "$DEST" || die "cannot create $DEST"
[[ -w $DEST ]] || die "$DEST is not writable; pick another with --dest, or re-run under sudo"

# Rename into place rather than write over the target: a running og keeps its
# executable image mapped, and overwriting it fails (ETXTBSY on Linux, a sharing
# violation on Windows). Swapping the directory entry leaves any live process on
# the old file, which it releases when it exits.
staged="$DEST/.og.new$exe"
old="$DEST/.og.old$exe"
rm -f "$staged"
cp "$built" "$staged"
chmod 755 "$staged"
if [[ -e $target ]]; then
	mv -f "$target" "$old" || die "cannot replace $target (in use and not renameable?)"
fi
mv -f "$staged" "$target"
# A still-running instance holds the old file open on Windows; leaving it is
# harmless, the next install replaces it.
rm -f "$old" 2>/dev/null || true

# The check that matters: a binary that built but cannot start looks like a
# successful install until the first invocation.
version="$("$target" --version)" || die "installed binary does not run: $target"

echo '--- installed ---'
printf '%-10s %s\n' \
	'binary' "$target" \
	'size' "$(du -h "$target" | cut -f1)" \
	'version' "$version"

# Which file a *new interactive shell* actually reads. On Windows this is not
# ~/.bashrc: Git Bash starts as a login shell (`bash --login -i`) and Git for
# Windows' /etc/bash.bashrc does not source ~/.bashrc, so a line put there is
# never read. ~/.bash_profile is.
if [[ $os == windows ]]; then
	rc="$HOME/.bash_profile"
elif [[ ${SHELL##*/} == zsh ]]; then
	rc="$HOME/.zshrc"
else
	rc="$HOME/.bashrc"
fi
export_line="export PATH=\"$DEST:\$PATH\""

if ((add_path)); then
	if [[ -f $rc ]] && grep -Fqx "$export_line" "$rc"; then
		printf '%-10s already in %s\n' 'path' "$rc"
	else
		printf '\n# added by og-cli/install.sh\n%s\n' "$export_line" >>"$rc"
		printf '%-10s appended to %s\n' 'path' "$rc"
	fi
	if [[ $os == windows ]]; then
		# The registry user Path is what cmd, PowerShell and every GUI-launched
		# process read. Only the user value is rewritten: rebuilding the whole
		# Path would bake the machine entries into it.
		win_dest="$(cygpath -w "$DEST")"
		printf '%-10s %s\n' 'path' "$(
			powershell -NoProfile -Command "
				\$dir = '${win_dest//\'/\'\'}'
				\$user = [Environment]::GetEnvironmentVariable('Path', 'User')
				if ((\$user -split ';') -contains \$dir) { \"already in the user Path: \$dir\" }
				else {
					[Environment]::SetEnvironmentVariable('Path', (\$user.TrimEnd(';') + ';' + \$dir), 'User')
					\"added to the user Path: \$dir\"
				}" | tr -d '\r'
		)"
	fi
fi

case ":$PATH:" in
*":$DEST:"*)
	resolved="$(command -v "og$exe" 2>/dev/null || true)"
	if [[ -n $resolved && $resolved != "$target" ]]; then
		printf '%-10s another og precedes this one on PATH: %s\n' 'warning' "$resolved"
	fi
	;;
*)
	# This shell cannot be fixed from here — a child process cannot edit its
	# parent's environment — so the export is printed for pasting either way.
	printf '%-10s %s is not on this shell'\''s PATH:\n\n' 'note' "$DEST"
	printf '  %s\n\n' "$export_line"
	if ((add_path)); then
		printf '%-10s every new shell has it now; this one needs the line above\n' ''
	else
		printf '%-10s to make it permanent: ./install.sh --add-to-path\n' ''
	fi
	if [[ $os == windows ]]; then
		# Two Windows-specific traps, both of which look like "the installer
		# lied": a terminal application caches the environment it was started
		# with, so a new *tab* inherits the old Path and only restarting the
		# application re-reads the registry. And Git Bash exports ORIGINAL_PATH,
		# which /etc/profile prefers over the current PATH (`${ORIGINAL_PATH:-$PATH}`),
		# so any shell descended from an older Git Bash keeps that older Path
		# no matter what the registry says.
		printf '%-10s on Windows, restart the terminal application itself, not just the tab\n' ''
		printf '%-10s a shell descended from an older Git Bash reuses its exported ORIGINAL_PATH\n' ''
	fi
	;;
esac

printf '%-10s og models        # resolve config, opens no socket\n' 'next'
printf '%-10s og -p "hi"       # needs an endpoint answering at 127.0.0.1:8127\n' ''
