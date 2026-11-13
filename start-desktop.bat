@echo off
setlocal EnableExtensions
chcp 936 >nul 2>&1
title DeepAutoCode x DeepSeek Harness
cd /d "%~dp0"

set "CHECK_ONLY="
if /i "%~1"=="--check" set "CHECK_ONLY=1"

echo ============================================================
echo   DeepAutoCode - DeepSeek Harness 内核
echo   工作目录: %CD%
echo ============================================================
echo.

echo [1/3] 检查构建产物...
if not exist "dist\src\main.js" goto build
if not exist "dist\webview\index.html" goto build
echo       构建产物已存在，跳过构建。
goto deps

:build
echo       未找到构建产物，开始构建，首次可能需要几分钟...
call npm run build
if errorlevel 1 goto buildfail

:deps
echo.
echo [2/3] 检查桌面运行时...
if exist "node_modules\electron\dist\electron.exe" goto depsok
echo       未找到 Electron 运行时，安装依赖...
call npm install --ignore-scripts
if errorlevel 1 goto depfail

:depsok
echo       桌面运行时已就绪。
if defined CHECK_ONLY goto checkdone

echo.
echo [3/3] 启动桌面端...
echo       关闭本窗口或应用窗口都会结束应用。
echo       首次启动需要几秒预热内核。
echo.
call npm run desktop
set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" goto runfail
goto done

:buildfail
echo.
echo [错误] 构建失败，请查看上面的错误信息。
pause
exit /b 1

:depfail
echo.
echo [错误] 依赖安装失败，请检查网络或 npm 配置。
pause
exit /b 1

:runfail
echo.
echo [错误] 桌面端异常退出，错误码 %EXITCODE%。
echo 可在终端执行 npm run desktop 查看完整日志。
pause
goto done

:checkdone
echo.
echo [检查通过] 双击本文件即可启动桌面版。
exit /b 0

:done
endlocal