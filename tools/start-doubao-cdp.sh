#!/usr/bin/env bash
# start-doubao-cdp.sh
# Start the local Doubao (豆包) desktop app with its DevTools endpoint open,
# so dsh-doubao-bridge can drive it.
#
# Usage (macOS / Linux, no admin needed):
#   chmod +x tools/start-doubao-cdp.sh
#   ./tools/start-doubao-cdp.sh
#
# Notes:
#  - The port binds 127.0.0.1 only and is never exposed to the LAN.
#  - This restarts Doubao once. Unsent drafts in the app are lost.
#  - If the port is already listening, the script does nothing.
#  - Set DOUBAO_EXE to an explicit binary path to bypass auto-detection.

set -euo pipefail

PORT="${DOUBAO_CDP_PORT:-9225}"

port_open() {
  # lsof is present on macOS; fall back to a bash TCP probe elsewhere.
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

find_doubao() {
  # 1) explicit override wins
  if [ -n "${DOUBAO_EXE:-}" ] && [ -x "$DOUBAO_EXE" ]; then
    printf '%s\n' "$DOUBAO_EXE"
    return 0
  fi

  # 2) macOS app bundles (Homebrew cask installs "Doubao.app" into /Applications)
  for app in \
    "/Applications/Doubao.app/Contents/MacOS/Doubao" \
    "/Applications/Doubao Browser.app/Contents/MacOS/Doubao" \
    "$HOME/Applications/Doubao.app/Contents/MacOS/Doubao" \
    "$HOME/Applications/Doubao Browser.app/Contents/MacOS/Doubao"
  do
    if [ -x "$app" ]; then
      printf '%s\n' "$app"
      return 0
    fi
  done

  # 3) Homebrew cask / generic POSIX locations
  for p in \
    "/opt/homebrew/Caskroom/doubao/*/Doubao.app/Contents/MacOS/Doubao" \
    "/usr/local/Caskroom/doubao/*/Doubao.app/Contents/MacOS/Doubao" \
    "/opt/homebrew/bin/doubao" \
    "/usr/local/bin/doubao" \
    "/opt/doubao/doubao" \
    "/usr/bin/doubao"
  do
    # shellcheck disable=SC2086
    for hit in $p; do
      if [ -x "$hit" ]; then
        printf '%s\n' "$hit"
        return 0
      fi
    done
  done

  return 1
}

echo "== 豆包 CDP 启动器 =="

if port_open "$PORT"; then
  echo "端口 $PORT 已在监听，豆包无需重启。"
  exit 0
fi

if ! EXE="$(find_doubao)"; then
  echo "失败：找不到豆包可执行文件。" >&2
  echo "  macOS: brew install --cask doubao" >&2
  echo "  或用 DOUBAO_EXE 环境变量指定完整路径。" >&2
  exit 1
fi

WORKDIR="$(cd "$(dirname "$EXE")/../.." 2>/dev/null && pwd || dirname "$EXE")"
echo "豆包：$EXE"

# 1) Close existing instances.
if pgrep -f "Doubao" >/dev/null 2>&1; then
  echo "关闭正在运行的豆包进程（未发送的草稿会丢失）..."
  pkill -f "Doubao" 2>/dev/null || true
  sleep 3
  pkill -9 -f "Doubao" 2>/dev/null || true
  sleep 1
fi

# 2) Launch with the DevTools endpoint open.
echo "以 --remote-debugging-port=$PORT 启动..."
if command -v open >/dev/null 2>&1; then
  # macOS: `open -a` would drop the flags, so exec the binary directly.
  nohup "$EXE" --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1 \
    >/dev/null 2>&1 &
else
  nohup "$EXE" --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1 \
    >/dev/null 2>&1 &
fi

# 3) Wait for the port.
for i in $(seq 1 30); do
  sleep 1
  if port_open "$PORT"; then
    echo "成功：127.0.0.1:$PORT 已就绪（约 ${i}s）。"
    if command -v curl >/dev/null 2>&1; then
      curl -s "http://127.0.0.1:$PORT/json/version" 2>/dev/null | head -c 300 || true
      echo
    fi
    exit 0
  fi
done

echo "失败：30 秒内端口 $PORT 未就绪。" >&2
exit 1
