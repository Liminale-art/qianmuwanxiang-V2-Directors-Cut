#!/bin/bash
# 千幕分镜重构 - 紧急回退脚本
# 使用方法: bash scripts/rollback.sh [选项]

set -e

echo "========================================="
echo "  千幕 - 紧急回退脚本"
echo "========================================="
echo ""

# 显示当前状态
echo "当前分支: $(git branch --show-current)"
echo "当前提交: $(git log -1 --oneline)"
echo ""

# 检查是否有未提交的更改
if [[ -n $(git status -s) ]]; then
    echo "⚠️  警告: 检测到未提交的更改"
    git status -s
    echo ""
    read -p "是否继续回退？未保存的更改将丢失 (y/N): " confirm
    if [[ $confirm != [yY] ]]; then
        echo "已取消回退"
        exit 0
    fi
fi

echo ""
echo "请选择回退方式:"
echo "1. 回退到 v1.55.0-backup 标签 (完全回退)"
echo "2. 回退上一个提交"
echo "3. 只回退 index.js 文件"
echo "4. 取消"
echo ""
read -p "请输入选项 (1-4): " option

case $option in
    1)
        echo ""
        echo "正在回退到 v1.55.0-backup..."
        git reset --hard v1.55.0-backup
        echo "✅ 完全回退成功！"
        ;;
    2)
        echo ""
        echo "正在回退上一个提交..."
        git reset --hard HEAD~1
        echo "✅ 回退一个提交成功！"
        ;;
    3)
        echo ""
        echo "正在回退 index.js 文件..."
        git checkout v1.55.0-backup -- index.js
        echo "✅ index.js 文件回退成功！"
        ;;
    4)
        echo "已取消回退"
        exit 0
        ;;
    *)
        echo "❌ 无效选项"
        exit 1
        ;;
esac

echo ""
echo "当前状态:"
git status
echo ""
echo "========================================="
echo "  回退完成"
echo "========================================="
