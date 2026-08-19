<#
.SYNOPSIS
  Install the pinned llama.cpp CUDA server on Windows.

.DESCRIPTION
  Unzips the prebuilt CUDA release upstream publishes for Windows into
  %USERPROFILE%\.local\llama.cpp\<build> and points a `current` junction at it,
  which is the flat layout serve.ts spawns from: `<root>/current/llama-server`
  with a bare argv and no environment fixup. The Linux counterpart is
  install-engine.sh, which has to compile instead: upstream ships no Linux
  CUDA asset. Both honour the same OG_LLAMA_BUILD / OG_LLAMA_ROOT knobs.
#>
[CmdletBinding()]
param(
  [string] $Build = $(if ($env:OG_LLAMA_BUILD) { $env:OG_LLAMA_BUILD } else { 'b10488' }),
  [string] $Root = $(if ($env:OG_LLAMA_ROOT) { $env:OG_LLAMA_ROOT } else { "$env:USERPROFILE\.local\llama.cpp" })
)

$ErrorActionPreference = 'Stop'
$build = $Build
$root = $Root
$dest = Join-Path $root $build
$tmp = Join-Path $env:TEMP "llamacpp-$build"

"build      $build"
"root       $root"

New-Item -ItemType Directory -Force -Path $dest, $tmp | Out-Null

$files = @(
  @{ url = "https://github.com/ggml-org/llama.cpp/releases/download/$build/llama-$build-bin-win-cuda-13.3-x64.zip"; name = 'bin.zip' },
  @{ url = "https://github.com/ggml-org/llama.cpp/releases/download/$build/cudart-llama-bin-win-cuda-13.3-x64.zip"; name = 'cudart.zip' }
)

# Windows PowerShell 5.1's Invoke-WebRequest is the wrong tool for a 373 MB
# asset three times over: it buffers the whole body in memory before writing a
# byte (so the outfile sits at 0 until the end and a Ctrl-C loses everything),
# it repaints a progress record per read, and it can only use one connection --
# which the release CDN throttles to a fraction of the link. Fetching byte
# ranges over 8 connections with curl.exe (in-box since Windows 1803) measured
# ~4x the single-stream rate on the reference box, and every chunk lands on
# disk, so an interrupted run resumes.
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
$connections = 8

function Get-Asset {
  param([string] $Url, [string] $Out)

  if (-not $curl) {
    # No curl: at least stop paying for the progress repaint, which is most of
    # Invoke-WebRequest's wall time.
    $prev = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing } finally { $ProgressPreference = $prev }
    return
  }

  # The first hop is a 302 to the CDN with Content-Length: 0, so take the last.
  $head = & $curl.Source -sIL --fail $Url
  if ($LASTEXITCODE -ne 0) { throw "install-engine: HEAD failed for $Url" }
  $lengths = $head | Select-String -Pattern '^Content-Length:\s*(\d+)' | ForEach-Object { $_.Matches[0].Groups[1].Value }
  $total = [long]($lengths | Select-Object -Last 1)
  $ranged = [bool]($head | Select-String -Pattern '^Accept-Ranges:\s*bytes' -Quiet)

  if ((Test-Path -LiteralPath $Out) -and (Get-Item -LiteralPath $Out).Length -eq $total) { return }

  if (-not $ranged -or $total -le 0) {
    & $curl.Source -L --fail --retry 3 --retry-all-errors -o $Out $Url
    if ($LASTEXITCODE -ne 0) { throw "install-engine: download failed for $Url (curl $LASTEXITCODE)" }
    return
  }

  # Many small chunks rather than one range per connection, for two reasons: a
  # killed run only loses the chunks that were in flight (one 47 MB range per
  # connection leaves every part torn, so nothing is reusable), and curl hands
  # the next chunk to whichever connection is free, which keeps all 8 busy to
  # the end instead of leaving one straggler to finish its range alone.
  $chunk = [long]8MB
  $count = [long][math]::Ceiling($total / $chunk)
  $parts = @()
  $curlArgs = @('-Z', '--parallel-max', "$connections")
  $pending = 0
  for ($i = 0; $i -lt $count; $i++) {
    $start = $i * $chunk
    $end = [math]::Min($start + $chunk, $total) - 1
    $part = '{0}.part{1:d4}' -f $Out, $i
    $parts += $part
    if ((Test-Path -LiteralPath $part) -and (Get-Item -LiteralPath $part).Length -eq ($end - $start + 1)) { continue }
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    if ($pending -gt 0) { $curlArgs += '--next' }
    $curlArgs += @('-L', '--fail', '--retry', '3', '--retry-all-errors', '-r', "$start-$end", '-o', $part, $Url)
    $pending++
  }

  if ($pending -gt 0) {
    "  $pending of $count chunks, $connections at a time"
    & $curl.Source @curlArgs
    if ($LASTEXITCODE -ne 0) { throw "install-engine: download failed for $Url (curl $LASTEXITCODE)" }
  }

  $joined = "$Out.part"
  $sink = [System.IO.File]::Create($joined)
  try {
    foreach ($part in $parts) {
      $src = [System.IO.File]::OpenRead($part)
      try { $src.CopyTo($sink) } finally { $src.Dispose() }
    }
  }
  finally { $sink.Dispose() }

  $got = (Get-Item -LiteralPath $joined).Length
  if ($got -ne $total) { throw "install-engine: $Out is $got bytes, expected $total" }
  Move-Item -LiteralPath $joined -Destination $Out -Force
  Remove-Item -Path "$Out.part*" -Force -ErrorAction SilentlyContinue
}

foreach ($f in $files) {
  $out = Join-Path $tmp $f.name
  "downloading $($f.name) ..."
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Get-Asset -Url $f.url -Out $out
  $sw.Stop()
  '{0}: {1:N1} MB in {2:N1}s' -f $f.name, ((Get-Item $out).Length / 1MB), $sw.Elapsed.TotalSeconds
  Expand-Archive -LiteralPath $out -DestinationPath $dest -Force
}

# flatten if the archive nested a top-level dir
if (-not (Test-Path -LiteralPath (Join-Path $dest 'llama-server.exe'))) {
  Get-ChildItem -LiteralPath $dest -Directory | ForEach-Object {
    if (Test-Path -LiteralPath (Join-Path $_.FullName 'llama-server.exe')) {
      Get-ChildItem -LiteralPath $_.FullName -Force | Move-Item -Destination $dest -Force
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
  }
}

$link = Join-Path $root 'current'
if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Recurse -Force }
New-Item -ItemType Junction -Path $link -Target $dest | Out-Null

$server = Join-Path $link 'llama-server.exe'
if (-not (Test-Path -LiteralPath $server)) { throw "install-engine: no llama-server.exe under $dest (archive layout changed?)" }

# llama-server writes both banners on stderr, so merge inside cmd rather than
# with a PowerShell `2>&1`: on a native command that wraps every stderr line in
# a NativeCommandError, which ErrorActionPreference=Stop makes fatal -- the old
# tail exited 1 on its own success message.
function Invoke-Server {
  param([string] $Arguments)
  @(& cmd /c "`"$server`" $Arguments 2>&1") | Where-Object { $_ -match '\S' }
}

Write-Output '--- installed ---'
"dir        $dest"
# Grouped by extension instead of listed: all 22 executables together are ~1 MB
# (they are stubs; every one rounds to 0.0 MB), the install's weight is the DLLs
# beside them, and an alphabetical first-12 of llama-*.exe stopped just short of
# llama-server.exe -- the one file this script exists to install.
Get-ChildItem -LiteralPath $dest -File | Group-Object Extension | Sort-Object Name | ForEach-Object {
  '{0,-10} {1,3} files, {2,7:N1} MB' -f $_.Name.TrimStart('.'), $_.Count, (($_.Group | Measure-Object -Property Length -Sum).Sum / 1MB)
}

$banner = Invoke-Server '--version'
$version = ($banner | Where-Object { $_ -match 'version:' } | Select-Object -First 1) -replace '^.*version:\s*', ''
"version    $(if ($version) { $version } else { $banner | Select-Object -First 1 })"

# The check that matters, and the reason it is not left to the operator: this
# zip installs and runs on a box whose driver cannot load its CUDA backend, and
# the CPU fallback is ~100x slower rather than broken, so a silent success here
# looks like a working install for as long as it takes to wonder why generation
# crawls. The device list goes to stdout; backend load chatter on stderr is
# merged in above and filtered out here.
$devices = Invoke-Server '--list-devices'
# Every listed device, not just the CUDA ones: on a box that fell back to CPU
# the operator needs to see what it did find. Device lines are indented, which
# is what separates them from the `load_backend:` chatter merged in from stderr.
$devices | Where-Object { $_ -match '^\s+\S+:' } | ForEach-Object { "device     $($_.Trim())" }
if (-not ($devices | Select-String -Pattern '^\s*CUDA\d+:' -Quiet)) {
  throw "install-engine: llama-server lists no CUDA device. Check the NVIDIA driver supports CUDA 13.3 and that ggml-cuda.dll and the cudart DLLs are in $dest"
}
