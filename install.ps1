# Installs navvied on Windows: downloads the program, verifies its checksum, puts it on your PATH.
#   irm https://github.com/navvied/navvied-agent/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm <url>/install.ps1))) -Then web     installs, then starts navvied and opens the web page already connected
# Optional: $env:NAVVIED_VERSION = "v0.1.0"   $env:NAVVIED_INSTALL_DIR = "C:\tools"   $env:NAVVIED_BASELINE = "1" (for CPUs without AVX2)
# No param block: this text is also run through `iex`, where a param block does not work. The arguments are read by hand.
$Then = $env:NAVVIED_THEN
for ($i = 0; $i -lt $args.Count; $i++) { if ($args[$i] -eq "-Then" -and $i + 1 -lt $args.Count) { $Then = [string]$args[$i + 1] } }
$ErrorActionPreference = "Stop"

$base = if ($env:NAVVIED_RELEASE_URL) { $env:NAVVIED_RELEASE_URL } else { "https://github.com/navvied/navvied-agent/releases/latest/download" }
if ($env:NAVVIED_VERSION) {
  if ($base -like "*/releases/latest/download") { $base = $base -replace "/latest/download$", "/download/$($env:NAVVIED_VERSION)" } else { $base = "$base/$($env:NAVVIED_VERSION)" }
}
$dir = if ($env:NAVVIED_INSTALL_DIR) { $env:NAVVIED_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "navvied\bin" }
$variant = if ($env:NAVVIED_BASELINE) { "-baseline" } else { "" }
$asset = "navvied-windows-x64$variant.exe"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("navvied-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset..."
  Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS") -UseBasicParsing

  $line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { ($_ -split "\s+")[1] -eq $asset } | Select-Object -First 1
  if (-not $line) { throw "no checksum is listed for $asset" }
  $expected = ($line -split "\s+")[0]
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { throw "checksum mismatch for $asset; nothing was installed" }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $target = Join-Path $dir "navvied.exe"
  if (Test-Path $target) { Move-Item -Force $target "$target.old" -ErrorAction SilentlyContinue }
  Copy-Item (Join-Path $tmp $asset) $target -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [string][Environment]::GetEnvironmentVariable("Path", "User")
$onPath = ($userPath -split ";") -contains $dir
if (-not $onPath) { [Environment]::SetEnvironmentVariable("Path", ((($userPath.TrimEnd(";"), $dir) | Where-Object { $_ }) -join ";"), "User") }
if (-not (($env:Path -split ";") -contains $dir)) { $env:Path = "$env:Path;$dir" }

try { $version = & $target --version } catch { throw "navvied was downloaded to $target but could not start: $($_.Exception.Message)" }
Write-Host "Installed $version to $target"
Write-Host "Type: navvied   (in a terminal that is already open, it works now; new terminals pick it up too)"

if ($Then -eq "web") { Write-Host "Starting navvied..."; & $target web }
elseif ($Then) { throw "-Then must be web" }
