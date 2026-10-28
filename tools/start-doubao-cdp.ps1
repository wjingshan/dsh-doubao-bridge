# start-doubao-cdp.ps1
# Restart the local Doubao (豆包) desktop app with its DevTools endpoint open,
# so dsh-doubao-bridge can drive it.
#
# Usage (a normal PowerShell window; no admin needed):
#   powershell -ExecutionPolicy Bypass -File .\start-doubao-cdp.ps1
#
# On macOS / Linux prefer the Node launcher, which needs no PowerShell at all:
#   node tools/start-doubao-cdp.mjs
#
# Notes:
#  - The port binds 127.0.0.1 only and is never exposed to the LAN.
#  - This restarts Doubao once. Unsent drafts in the app are lost.
#  - If the port is already listening, the script does nothing.
#  - DOUBAO_EXE overrides auto-detection.

$ErrorActionPreference = 'Stop'
$Port = 9225

function Test-Port([int]$p) {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Find-Doubao {
    # An explicit override always wins.
    if ($env:DOUBAO_EXE -and (Test-Path $env:DOUBAO_EXE)) { return [string]$env:DOUBAO_EXE }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Doubao\Application\Doubao.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Doubao\Doubao.exe'),
        (Join-Path $env:PROGRAMFILES 'Doubao\Doubao.exe'),
        (Join-Path ${env:PROGRAMFILES(X86)} 'Doubao\Doubao.exe')
    ) | Where-Object { $_ -and (Test-Path $_) }

    # NOTE: a single match collapses the pipeline to a STRING, so $candidates[0]
    # would return its first character. Always go through Select-Object.
    $first = @($candidates) | Select-Object -First 1
    if ($first) { return [string]$first }

    # Fall back to the uninstall registry, which records the real install root.
    $roots = @(
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($r in $roots) {
        $hit = Get-ItemProperty $r -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match '豆包|Doubao' -and $_.InstallLocation } |
            Select-Object -First 1
        if ($hit) {
            foreach ($rel in @('Doubao.exe', 'Application\Doubao.exe', 'Application\app\Doubao.exe')) {
                $p = Join-Path $hit.InstallLocation $rel
                if (Test-Path $p) { return $p }
            }
        }
    }
    return $null
}

Write-Host "== 豆包 CDP 启动器 ==" -ForegroundColor Cyan

if (Test-Port $Port) {
    Write-Host "端口 $Port 已在监听，豆包无需重启。" -ForegroundColor Green
    exit 0
}

$exe = Find-Doubao
if (-not $exe) {
    Write-Host "失败：找不到豆包可执行文件。请确认已安装豆包 PC 版。" -ForegroundColor Red
    Write-Host "可以用 DOUBAO_EXE 环境变量指定完整路径。" -ForegroundColor DarkGray
    exit 1
}

$workDir = Split-Path $exe -Parent
Write-Host "豆包：$exe"

# 1) Close existing instances (including helpers/children).
$procs = @(Get-Process Doubao -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
    Write-Host "关闭 $($procs.Count) 个豆包进程（未发送的草稿会丢失）..." -ForegroundColor Yellow
    & taskkill /IM Doubao.exe /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 4
}

# 2) Windows may auto-restart the app once; clear that instance too.
$left = @(Get-Process Doubao -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
    Write-Host "处理自动重启的残留实例..." -ForegroundColor Yellow
    & taskkill /IM Doubao.exe /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 3
}

# 3) Launch with the DevTools endpoint open.
Write-Host "以 --remote-debugging-port=$Port 启动..." -ForegroundColor Cyan
Start-Process -FilePath $exe `
    -ArgumentList "--remote-debugging-port=$Port", "--remote-debugging-address=127.0.0.1" `
    -WorkingDirectory $workDir

# 4) Wait for the port.
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Milliseconds 1000
    if (Test-Port $Port) {
        Write-Host "成功：127.0.0.1:$Port 已就绪（约 ${i}s）。" -ForegroundColor Green
        try {
            $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
            Write-Host "CDP: $($v.'Browser')" -ForegroundColor DarkGray
        } catch { }
        exit 0
    }
}

Write-Host "失败：30 秒内端口 $Port 未就绪。" -ForegroundColor Red
exit 1
