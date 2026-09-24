#!/bin/bash
# 双击这个文件就能打开本地写作台（不用先开终端）。
# 关掉终端窗口，或按 Ctrl+C，写作台就停了。
cd "$(dirname "$0")" || exit 1
echo "From BBS · 写作台"
echo "项目：$(pwd)"
echo
if [ ! -d node_modules ]; then
  echo "第一次用，先装依赖……"
  npm install || exit 1
fi
exec npm run editor
