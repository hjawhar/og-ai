/**
 * Tab completion. Two audiences, one vocabulary:
 *
 *  - `completeLine` backs the TUI's readline completer, so it obeys readline's
 *    contract to the letter: `[matches, substring]` where `substring` is the
 *    trailing slice of the line each match replaces wholesale. Getting that
 *    wrong garbles the buffer rather than failing loudly, hence the invariant
 *    that `substring` is always a suffix of `line`.
 *  - `powershellCompletion` / `bashCompletion` emit static scripts for the `og`
 *    binary. They are deliberately self-contained: a completer that shells out
 *    to the tool it completes is a hang waiting to happen.
 *
 * Everything here is total. Absurd input yields no completions; unreadable
 * directories yield no completions. Nothing throws.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CompletionContext {
	/** Slash command names WITHOUT the leading slash, e.g. ["help", "models", "usage"]. */
	commands: readonly string[];
	/** Subcommands per slash command, e.g. { models: ["list", "switch", "info"] }. */
	subcommands: Readonly<Record<string, readonly string[]>>;
	/** Model profile keys. */
	modelKeys: readonly string[];
	/** Absolute directory that bare relative paths complete against. */
	cwd: string;
}

const WIN = process.platform === "win32";

/** Sub-subcommands offered by the shell scripts, and by nothing else. */
const CLI_COMMANDS: readonly string[] = ["engine", "sessions", "models", "completion"];

const CLI_SUBCOMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
	["engine", ["start", "stop", "status"]],
	["sessions", ["list", "show", "rm"]],
	["models", ["list", "use"]],
	["completion", ["powershell", "bash"]],
];

const CLI_FLAGS: readonly string[] = [
	"-p",
	"--print",
	"--json",
	"-m",
	"--model",
	"-c",
	"--continue",
	"-r",
	"--resume",
	"--cwd",
	"--endpoint",
	"--no-autostart",
	"--max-steps",
	"-v",
	"--verbose",
	"--version",
	"-h",
	"--help",
];

/**
 * Complete `line` as typed at the TUI prompt. `line` is the text left of the
 * cursor; the caller passes readline's `line` argument unchanged.
 */
export function completeLine(line: string, ctx: CompletionContext): [string[], string] {
	if (typeof line !== "string" || line.length === 0) return [[], typeof line === "string" ? line : ""];

	// 1. A bare slash token: the command name itself, slash included.
	if (line.startsWith("/") && !/\s/.test(line)) {
		const typed = line.slice(1);
		return [pick(ctx.commands, typed).map((name) => `/${name}`), line];
	}

	const token = /\S*$/.exec(line)?.[0] ?? "";

	if (line.startsWith("/")) {
		const words = line.match(/\S+/g) ?? [];
		const head = words[0];
		// Index of the token under the cursor among the command's arguments.
		const argIndex = (/\s$/.test(line) ? words.length : words.length - 1) - 1;
		if (head !== undefined && argIndex >= 0) {
			const cmd = head.slice(1);

			// 2. First argument of a command that declares subcommands.
			const subs = argIndex === 0 ? ctx.subcommands[cmd] : undefined;
			if (subs !== undefined) return [pick(subs, token), token];

			// 3. Places where a model profile key is expected.
			if (wantsModelKey(cmd, words, argIndex)) return [pick(ctx.modelKeys, token), token];
		}
	}

	// 4. A filesystem path, but only for tokens that actually look like one.
	if (!looksLikePath(token)) return [[], line];
	return completePath(token, ctx.cwd);
}

function wantsModelKey(cmd: string, words: readonly string[], argIndex: number): boolean {
	if (cmd === "model") return argIndex === 0;
	if (cmd !== "models" || argIndex !== 1) return false;
	const sub = words[1];
	return sub === "switch" || sub === "info";
}

/** Case-sensitive prefix filter, caller order preserved, duplicates dropped. */
function pick(candidates: readonly string[], typed: string): string[] {
	const out: string[] = [];
	for (const candidate of candidates) {
		if (candidate.startsWith(typed) && !out.includes(candidate)) out.push(candidate);
	}
	return out;
}

function looksLikePath(token: string): boolean {
	if (token.length === 0) return false;
	if (/^[A-Za-z]:/.test(token)) return true;
	if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/")) return true;
	if (token.includes("/")) return true;
	if (!WIN) return false;
	return token.includes("\\");
}

function completePath(token: string, cwd: string): [string[], string] {
	let cut = token.lastIndexOf("/");
	if (WIN) cut = Math.max(cut, token.lastIndexOf("\\"));

	let prefix = cut >= 0 ? token.slice(0, cut + 1) : "";
	let base = cut >= 0 ? token.slice(cut + 1) : token;
	// A bare drive letter is a directory reference with the separator elided.
	if (cut < 0 && /^[A-Za-z]:$/.test(token)) {
		prefix = `${token}/`;
		base = "";
	}

	const dir = resolveDir(prefix, cwd);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [[], token];
	}

	const wantHidden = base.startsWith(".");
	const fold = WIN;
	const needle = fold ? base.toLowerCase() : base;
	// Completed directories keep whichever separator style the token already uses.
	const sep = prefix.endsWith("\\") ? "\\" : "/";

	const hits: Array<{ name: string; dir: boolean }> = [];
	for (const entry of entries) {
		const { name } = entry;
		if (!wantHidden && name.startsWith(".")) continue;
		const candidate = fold ? name.toLowerCase() : name;
		if (!candidate.startsWith(needle)) continue;
		hits.push({ name, dir: isDirEntry(dir, entry) });
	}

	hits.sort((a, b) => {
		if (a.dir !== b.dir) return a.dir ? -1 : 1;
		const al = a.name.toLowerCase();
		const bl = b.name.toLowerCase();
		if (al !== bl) return al < bl ? -1 : 1;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});

	return [hits.map((hit) => `${prefix}${hit.name}${hit.dir ? sep : ""}`), token];
}

function resolveDir(prefix: string, cwd: string): string {
	if (prefix === "~/" || prefix === "~\\") return os.homedir();
	if (prefix.startsWith("~/") || prefix.startsWith("~\\")) return path.resolve(os.homedir(), prefix.slice(2));
	return path.resolve(cwd, prefix);
}

function isDirEntry(dir: string, entry: fs.Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return fs.statSync(path.join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

/** A PowerShell-safe identifier fragment derived from an arbitrary binary name. */
function identifier(binary: string): string {
	const cleaned = binary.replace(/[^A-Za-z0-9_]/g, "_");
	return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** A single-quoted PowerShell / bash literal. */
function quote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function list(values: readonly string[]): string {
	return values.map(quote).join(",");
}

/**
 * PowerShell 5.1-compatible argument completer. Source it from a profile:
 * `og completion powershell | Out-String | Invoke-Expression`.
 */
export function powershellCompletion(binary = "og"): string {
	const name = identifier(binary);
	const subs = CLI_SUBCOMMANDS.map(([cmd, values]) => `        ${quote(cmd)} = @(${list(values)})`).join("\n");
	return `# ${binary} completion for PowerShell 5.1 and later.
# Static vocabulary: nothing is executed at completion time.
$${name}Completer = {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(${list(CLI_COMMANDS)})
    $subcommands = @{
${subs}
    }
    $flags = @(${list(CLI_FLAGS)})

    $seen = @()
    if ($commandAst -ne $null) {
        for ($i = 1; $i -lt $commandAst.CommandElements.Count; $i++) {
            $seen += $commandAst.CommandElements[$i].Extent.Text
        }
    }
    if ($wordToComplete -ne '' -and $seen.Count -gt 0 -and $seen[$seen.Count - 1] -eq $wordToComplete) {
        if ($seen.Count -gt 1) { $seen = $seen[0..($seen.Count - 2)] } else { $seen = @() }
    }

    $positional = @()
    foreach ($word in $seen) {
        if (-not $word.StartsWith('-')) { $positional += $word }
    }

    $candidates = @()
    if ($wordToComplete.StartsWith('-')) {
        $candidates = $flags
    } elseif ($positional.Count -eq 0) {
        $candidates = $commands + $flags
    } elseif ($positional.Count -eq 1 -and $subcommands.ContainsKey($positional[0])) {
        $candidates = $subcommands[$positional[0]]
    } else {
        $candidates = $flags
    }

    $candidates | Where-Object { $_.StartsWith($wordToComplete) } | Sort-Object -Unique | ForEach-Object {
        New-Object System.Management.Automation.CompletionResult $_, $_, 'ParameterValue', $_
    }
}

Register-ArgumentCompleter -Native -CommandName ${quote(binary)} -ScriptBlock $${name}Completer
Register-ArgumentCompleter -Native -CommandName ${quote(`${binary}.exe`)} -ScriptBlock $${name}Completer
`;
}

/**
 * Bash completion covering the same vocabulary. Source it from `~/.bashrc`:
 * `eval "$(og completion bash)"`.
 */
export function bashCompletion(binary = "og"): string {
	const fn = `_${identifier(binary)}_complete`;
	const cases = CLI_SUBCOMMANDS.map(([cmd, values]) => `                ${cmd}) candidates=${quote(values.join(" "))} ;;`).join("\n");
	return `# ${binary} completion for bash.
# Static vocabulary: nothing is executed at completion time.
${fn}() {
    COMPREPLY=()
    local cur="\${COMP_WORDS[COMP_CWORD]:-}"
    local commands=${quote(CLI_COMMANDS.join(" "))}
    local flags=${quote(CLI_FLAGS.join(" "))}
    local candidates=''
    local first='' count=0 i word

    for ((i = 1; i < COMP_CWORD; i++)); do
        word="\${COMP_WORDS[i]:-}"
        case "$word" in
            -*) continue ;;
        esac
        count=$((count + 1))
        if [ "$count" -eq 1 ]; then first="$word"; fi
    done

    case "$cur" in
        -*) candidates="$flags" ;;
        *)
            if [ "$count" -eq 0 ]; then
                candidates="$commands $flags"
            elif [ "$count" -eq 1 ]; then
                case "$first" in
${cases}
                    *) candidates="$flags" ;;
                esac
            else
                candidates="$flags"
            fi
            ;;
    esac

    COMPREPLY=( $(compgen -W "$candidates" -- "$cur") )
    return 0
}

complete -F ${fn} ${binary}
complete -F ${fn} ${binary}.exe
`;
}
