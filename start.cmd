@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"

if not defined NODE_EXE (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo [DeepSeek Chatbox] 未找到 Node.js。
  echo 请安装 Node.js 18.17+，或把 node.exe 加入 PATH 后重试。
  pause
  exit /b 1
)

echo [DeepSeek Chatbox] 正在启动...
echo 打开 http://127.0.0.1:3210
echo 按 Ctrl+C 停止服务。
echo.

"%NODE_EXE%" server.mjs
pause
