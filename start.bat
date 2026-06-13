@echo off
echo ========================================
echo Vision Pro AR - HTTPS 服务器启动脚本
echo ========================================
echo.

REM 检查证书是否存在
if not exist "cert\key.pem" (
    echo 证书不存在，正在生成...
    call npm run cert
    if errorlevel 1 (
        echo.
        echo 证书生成失败，请检查错误信息
        pause
        exit /b 1
    )
)

echo 启动 HTTPS 服务器...
npm start

pause
