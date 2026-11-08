# enable-autostart-cdp.ps1
# Make the local Doubao (豆包) desktop app start with its DevTools endpoint open,
# instead of having to run start-doubao-cdp.ps1 by hand after every restart.
#
# Usage (normal PowerShell window, no admin needed):
#   powershell -ExecutionPolicy Bypass -File .\enable-autostart-cdp.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File .\enable-autostart-cdp.ps1 -Apply
#   powershell -ExecutionPolicy Bypass -File .\enable-autostart-cdp.ps1 -Revert
#
# What it touches (user scope only, nothing inside the Doubao install dir, so
# Doubao's own auto-update does not undo it):
#   1. HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run  value "doubao"
#   2. %APPDATA%\Microsoft\Windows\Start Menu\Programs\豆包.lnk
#   3. %APPDATA%\Microsoft\Windows\Start Menu\Programs\豆包浏览器.lnk
#
# Limits worth knowing:
#   - Doubao is a single-instance app. If an instance WITHOUT the flag is already
#     running, launching another one just hands over to it; no port opens. Start
#     the app fresh (or run start-doubao-cdp.ps1) for the change to take effect.
#   - Protocol launches (doubao://), tray restarts and the updater relaunch the
#     app through paths this script cannot rewrite.
#   - The port listens on 127.0.0.1 only, but while it is open ANY local process
#     can drive your Doubao session. Revert when you do not want that.
#
# Exit codes: 0 = done / already in desired state, 1 = something failed.

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Revert,
    [switch]$Status,
    [int]$Port = 9225,
    [string]$BackupPath = (Join-Path $env:USERPROFILE '.dsh\doubao-cdp-autostart.json')
)

$ErrorActionPreference = 'Stop'
$RunKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$RunValue = 'doubao'
$CdpArgs = "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1"

$Shortcuts = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\豆包.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\豆包浏览器.lnk')
)

if (-not ($Apply -or $Revert)) { $Status = $true }
if (($Apply -and $Revert)) {
    Write-Host '失败：-Apply 和 -Revert 不能同时使用。' -ForegroundColor Red
    exit 1
}

function Get-RunCommand {
    $p = Get-ItemProperty -Path $RunKey -Name $RunValue -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.$RunValue }
    return $null
}

# Strip our own flags, leaving any pre-existing arguments (e.g. --launch_from).
function Remove-CdpArgs([string]$cmd) {
    if ([string]::IsNullOrWhiteSpace($cmd)) { return $cmd }
    $out = $cmd -replace '\s*--remote-debugging-port=\d+', ''
    $out = $out -replace '\s*--remote-debugging-address=[^\s"]+', ''
    return $out.TrimEnd()
}

function Add-CdpArgs([string]$cmd) {
    if ([string]::IsNullOrWhiteSpace($cmd)) { return $CdpArgs }
    if ($cmd -match '--remote-debugging-port=') { return $cmd }  # already set
    return ($cmd.TrimEnd() + ' ' + $CdpArgs)
}

function Get-LnkArgs([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $sh = New-Object -ComObject WScript.Shell
    return [string]$sh.CreateShortcut($path).Arguments
}

function Set-LnkArgs([string]$path, [string]$arguments) {
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($path)
    $s.Arguments = $arguments
    $s.Save()
}

function Test-CdpPresent([string]$cmd) {
    return [bool]($cmd -and $cmd -match "--remote-debugging-port=$Port\b")
}

# Raw TCP probe, not Get-NetTCPConnection: the cmdlet throws in restricted
# contexts (and a swallowed exception reads as "not listening", which is a lie).
function Test-Port([int]$p) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(700)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        if ($client) { try { $client.Close() } catch { } }
    }
}

function Show-State {
    Write-Host "== 豆包启动参数状态（端口 $Port）==" -ForegroundColor Cyan

    $run = Get-RunCommand
    if ($null -eq $run) {
        Write-Host '开机自启：未找到 Run 项（豆包可能没设开机自启）' -ForegroundColor DarkGray
    } elseif (Test-CdpPresent $run) {
        Write-Host "开机自启：已带调试参数" -ForegroundColor Green
    } else {
        Write-Host "开机自启：未带调试参数" -ForegroundColor Yellow
    }
    if ($run) { Write-Host "    $run" -ForegroundColor DarkGray }

    foreach ($s in $Shortcuts) {
        $name = Split-Path $s -Leaf
        if (-not (Test-Path -LiteralPath $s)) {
            Write-Host "快捷方式 $name：不存在" -ForegroundColor DarkGray
            continue
        }
        $a = Get-LnkArgs $s
        if (Test-CdpPresent $a) {
            Write-Host "快捷方式 $name：已带调试参数" -ForegroundColor Green
        } else {
            Write-Host "快捷方式 $name：未带调试参数" -ForegroundColor Yellow
        }
        Write-Host "    Arguments = '$a'" -ForegroundColor DarkGray
    }

    $listen = Test-Port $Port
    if ($listen) {
        Write-Host "当前 127.0.0.1:$Port 正在监听" -ForegroundColor Green
    } else {
        Write-Host "当前 127.0.0.1:$Port 未监听（豆包此刻没带参数运行，或没开）" -ForegroundColor Yellow
    }
}

function Save-Backup {
    $dir = Split-Path $BackupPath -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $state = [ordered]@{
        createdAt  = (Get-Date).ToString('o')
        port       = $Port
        cdpArgs    = $CdpArgs
        runValue   = (Get-RunCommand)
        shortcuts  = @{}
    }
    foreach ($s in $Shortcuts) {
        $state.shortcuts[$s] = (Get-LnkArgs $s)
    }
    ($state | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $BackupPath -Encoding UTF8
    Write-Host "原始值已备份到 $BackupPath" -ForegroundColor DarkGray
}

function Invoke-Apply {
    Write-Host "== 启用：让豆包冷启动自带调试参数（端口 $Port）==" -ForegroundColor Cyan

    $run = Get-RunCommand
    if ($null -eq $run) {
        Write-Host '跳过开机自启：没有 Run 项可改。' -ForegroundColor Yellow
    } elseif (Test-CdpPresent $run) {
        Write-Host '开机自启：已包含调试参数，跳过。' -ForegroundColor Green
    } else {
        Save-Backup
        New-ItemProperty -Path $RunKey -Name $RunValue -PropertyType String `
            -Value (Add-CdpArgs $run) -Force | Out-Null
        Write-Host '开机自启：已追加调试参数。' -ForegroundColor Green
    }

    if ($null -eq $run) { Save-Backup }  # still capture shortcuts

    $changed = 0
    foreach ($s in $Shortcuts) {
        if (-not (Test-Path -LiteralPath $s)) {
            Write-Host "快捷方式 $(Split-Path $s -Leaf)：不存在，跳过。" -ForegroundColor DarkGray
            continue
        }
        $a = Get-LnkArgs $s
        if (Test-CdpPresent $a) {
            Write-Host "快捷方式 $(Split-Path $s -Leaf)：已包含调试参数，跳过。" -ForegroundColor Green
            continue
        }
        Set-LnkArgs $s (Add-CdpArgs $a)
        Write-Host "快捷方式 $(Split-Path $s -Leaf)：已追加调试参数。" -ForegroundColor Green
        $changed++
    }

    Write-Host ''
    Write-Host '生效条件：豆包必须重新冷启动一次。' -ForegroundColor Yellow
    Write-Host '  - 现在就生效：跑 tools\start-doubao-cdp.ps1（会重启豆包，未发送草稿会丢）' -ForegroundColor DarkGray
    Write-Host '  - 或者：退出豆包后从开始菜单重新打开' -ForegroundColor DarkGray
    if ($changed -eq 0 -and (Test-CdpPresent $run)) {
        Write-Host '所有入口本来就已带参数，无需改动。' -ForegroundColor Green
    }
    return 0
}

function Invoke-Revert {
    Write-Host '== 回滚：移除调试参数 ==' -ForegroundColor Cyan

    $restoredFromBackup = $false
    if (Test-Path -LiteralPath $BackupPath) {
        try {
            $b = Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
            if ($b.runValue -ne $null) {
                New-ItemProperty -Path $RunKey -Name $RunValue -PropertyType String -Value ([string]$b.runValue) -Force | Out-Null
                Write-Host '开机自启：已恢复备份中的原始命令。' -ForegroundColor Green
            }
            foreach ($s in $Shortcuts) {
                if (-not (Test-Path -LiteralPath $s)) { continue }
                $prop = $b.shortcuts.PSObject.Properties | Where-Object { $_.Name -eq $s } | Select-Object -First 1
                if ($prop) {
                    Set-LnkArgs $s ([string]$prop.Value)
                    Write-Host "快捷方式 $(Split-Path $s -Leaf)：已恢复备份中的原始参数。" -ForegroundColor Green
                }
            }
            $restoredFromBackup = $true
        } catch {
            Write-Host "备份不可用（$($_.Exception.Message)），改为直接剥离参数。" -ForegroundColor Yellow
        }
    }

    if (-not $restoredFromBackup) {
        $run = Get-RunCommand
        if ($run -and ($run -match '--remote-debugging-port=')) {
            New-ItemProperty -Path $RunKey -Name $RunValue -PropertyType String -Value (Remove-CdpArgs $run) -Force | Out-Null
            Write-Host '开机自启：已剥离调试参数。' -ForegroundColor Green
        }
        foreach ($s in $Shortcuts) {
            if (-not (Test-Path -LiteralPath $s)) { continue }
            $a = Get-LnkArgs $s
            if ($a -match '--remote-debugging-port=') {
                Set-LnkArgs $s (Remove-CdpArgs $a)
                Write-Host "快捷方式 $(Split-Path $s -Leaf)：已剥离调试参数。" -ForegroundColor Green
            }
        }
    }

    Write-Host ''
    Write-Host '注意：当前正在运行的豆包仍带着端口，要彻底关闭需退出豆包。' -ForegroundColor Yellow
    return 0
}

try {
    if ($Apply) { exit (Invoke-Apply) }
    if ($Revert) { exit (Invoke-Revert) }
    Show-State
    exit 0
} catch {
    Write-Host "失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
