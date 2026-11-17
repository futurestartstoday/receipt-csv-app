@echo off
chcp 65001 >nul
rem ダブルクリックでローカルサーバーを起動し、ブラウザでアプリを開く
cd /d "%~dp0"

rem 使えるPythonを探す（PATHに無くても、標準のインストール先を探す）
set "PY="
for %%V in (315 314 313 312 311) do (
  if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
)
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Launcher\py.exe"
if not defined PY where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Pythonが見つかりません。https://www.python.org/ からインストールしてください。
  pause
  exit /b 1
)

rem サーバーが起動するのを待ってからブラウザを開く（先に開くと「接続できません」になる）
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8000/"
echo アプリを起動しました: http://localhost:8000/
echo 終了するときはこのウィンドウを閉じてください。
"%PY%" -m http.server 8000
pause
