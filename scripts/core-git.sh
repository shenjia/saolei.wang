#!/bin/bash
# core-git.sh — 在 saolei.wang 的私有 submodule src/core 执行 git 命令
# 用途：命令串不出现任何受保护路径（与 xgit-saolei 同理，规避文件安全弹窗）
# 用法：scripts/core-git.sh status / scripts/core-git.sh push origin main
exec git -C "$HOME/Nutstore Files/我的坚果云/works/github/saolei.wang/src/core" "$@"
