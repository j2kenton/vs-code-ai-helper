# Shortcuts for reaching the cloud dev box from a Windows laptop.
#
#   box               list the commands
#   box ssh           shell on the VM                  (ssh ensemble-box)
#   box dev           shell inside the box             (ssh ensemble-devbox)
#   box vnc           noVNC tunnel, opens the runner's screen in the browser
#   box viewer        browser-viewer tunnel, opens the viewer in the browser
#   box tunnel        both tunnels over one connection
#   box status        one-screen status of every task on the box
#   box update [ver]  update every copy of Ensemble on the box (update-ensemble.sh)
#   box drop-viewers  end every browser-viewer session on the box (frees memory;
#                     any open viewer tab just reloads)
#
# Nothing private lives here. Host names, addresses, users and keys come from
# the two aliases in ~/.ssh/config (ensemble-box = the VM, ensemble-devbox =
# the container, reached through the VM). The viewer's token is read from the
# box each time and only printed to this terminal. This folder (deploy/) is
# excluded from the extension package by .vscodeignore.
#
# One-time setup, so "box" works in every PowerShell window: add this line to
# your profile (notepad $PROFILE), with the path to your clone:
#   function box { & 'C:\path\to\vs-code-ai-helper\deploy\devbox\box.ps1' @args }
#
# ASCII only, deliberately: Windows PowerShell 5.1 reads a UTF-8 file with no
# BOM as ANSI (see pull-ensemble-backup.ps1).

param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$VmHost     = 'ensemble-box'
$BoxHost    = 'ensemble-devbox'
$VncPort    = 6080
$ViewerPort = 8082
$Workspace  = '/workspace/vs-code-ai-helper'
$VncUrl     = "http://localhost:$VncPort/vnc.html?autoconnect=true&resize=scale"

# Fixed options for the long-lived tunnels. No ExitOnForwardFailure: while
# VS Code is connected to the box it may already forward the same port on one
# address family, and that option then made ssh quit at once, silently
# (seen 2026-10-23).
$TunnelOptions = @(
  '-N',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3'
)

function Get-ViewerUrl {
  $token = (& ssh $BoxHost 'cat ~/.serve-web-viewer.token').Trim()
  if (-not $token) { throw 'Could not read the viewer token from the box.' }
  return "http://localhost:$ViewerPort/?tkn=$token&folder=$Workspace"
}

function Start-Tunnel([string[]]$Forwards, [string[]]$Urls) {
  foreach ($url in $Urls) { Write-Host "Open: $url" }
  Write-Host 'Tunnel running. Leave this window open; Ctrl+C closes it.'
  # The browser is opened a moment after ssh starts, from a background job,
  # because ssh -N blocks this window for as long as the tunnel is up.
  $null = Start-Job -ArgumentList (,$Urls) -ScriptBlock {
    param($u)
    Start-Sleep -Seconds 8
    foreach ($x in $u) { Start-Process $x }
  }
  & ssh @TunnelOptions @Forwards $BoxHost
  Write-Host "Tunnel closed (ssh exit code $LASTEXITCODE)."
}

switch ($Command) {
  'ssh'    { & ssh $VmHost @Rest }
  'dev'    { & ssh $BoxHost @Rest }
  'vnc'    { Start-Tunnel @('-L', "${VncPort}:127.0.0.1:$VncPort") @($VncUrl) }
  'viewer' { Start-Tunnel @('-L', "${ViewerPort}:127.0.0.1:$ViewerPort") @(Get-ViewerUrl) }
  'tunnel' {
    Start-Tunnel @('-L', "${VncPort}:127.0.0.1:$VncPort", '-L', "${ViewerPort}:127.0.0.1:$ViewerPort") `
      @($VncUrl, (Get-ViewerUrl))
  }
  'status'       { & ssh $BoxHost 'sh ~/status.sh' }
  'update'       { & ssh $BoxHost "~/update-ensemble.sh $($Rest -join ' ')" }
  'drop-viewers' { & ssh $BoxHost 'sh ~/reap-viewers.sh --restart-all' }
  default {
    Get-Content -LiteralPath $PSCommandPath |
      Select-Object -Skip 2 -First 10 |
      ForEach-Object { $_ -replace '^# ?', '' }
  }
}
