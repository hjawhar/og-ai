<#
.SYNOPSIS
  Install the pinned llama.cpp CUDA server on Windows.

.DESCRIPTION
  Unzips the prebuilt CUDA release upstream publishes for Windows into
  %USERPROFILE%\.local\llama.cpp\<build> and points a `current` junction at it,
  which is the flat layout `engine.binDir` expects. The Linux counterpart is
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

foreach ($f in $files) {
  $out = Join-Path $tmp $f.name
  if (-not (Test-Path -LiteralPath $out)) {
    "downloading $($f.name) ..."
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri $f.url -OutFile $out -UseBasicParsing
    $sw.Stop()
    '{0}: {1:N1} MB in {2:N1}s' -f $f.name, ((Get-Item $out).Length / 1MB), $sw.Elapsed.TotalSeconds
  }
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

Write-Output '--- installed ---'
Get-ChildItem -LiteralPath $dest -Filter 'llama-*.exe' | Select-Object -First 12 Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
"version:"
& (Join-Path $link 'llama-server.exe') --version 2>&1 | Select-Object -First 6
