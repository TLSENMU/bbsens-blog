@echo off
REM 先把控制台切到 UTF-8，不然中文 Windows（GBK 代码页）会把下面这些中文读成乱码，
REM 严重的时候多字节字符会吞掉换行，把两行命令粘成一行。
chcp 65001 >nul
REM 双击这个文件就能打开本地写作台（Windows）。
REM 关掉这个窗口，写作台就停了。
cd /d "%~dp0"
echo From BBS . 写作台
echo 项目：%cd%
echo.
if not exist node_modules (
  echo 第一次用，先装依赖……
  call npm install || goto :err
)
call npm run editor
goto :eof
:err
echo.
echo 出错了。确认这台电脑装了 Node 22.12 以上：node -v
pause
