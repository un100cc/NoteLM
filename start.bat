@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem KLAUD — one-click run
rem มี Node: รัน server.js เต็มรูปแบบ (รวม TradingView MCP ถ้ามี)
rem ไม่มี Node: เปิด index.html ตรง ๆ ได้เลย เพราะ api-client.js ดึง Binance จาก browser

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ไม่พบ Node.js — เปิดหน้าเว็บแบบ static แทน
  start "" "%~dp0index.html"
  exit /b 0
)

if not exist node_modules (
  echo ติดตั้ง dependencies ครั้งแรก...
  call npm install
)

start "" http://localhost:3000
node server.js
