#!/usr/bin/env bash
# 古月方源·大爱仙尊｜心志篇（其二）
# 浮海无常命戏弄，避浪顺流懦如虫。
# 大好男儿莫太聪，纵然身碎不悔痛。
# 来源：蛊真人 · 《蛊真人》全诗词整理（完整版） · kairos-dao-header
# 安装 vscode-simple-logs：dist/<name>-<version>.vsix → cursor/code
# 参考：凝冰工作日记 jnl-3C91E7A2 · 装完删旧目录
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/dist"
PACK=0
VSIX_OVERRIDE=""

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

  默认：优先 dist/<name>-<package.json.version>.vsix；
        否则取 dist/ 里 semver 最大的 <name>-*.vsix；
        若无 vsix 则先打包再安装。

选项:
  --pack          强制先执行 pack-simple-logs.sh 再安装
  --vsix PATH     指定 vsix 路径（跳过自动查找）
  -h, --help      显示此帮助

示例:
  $(basename "$0")
  $(basename "$0") --pack
  $(basename "$0") --vsix dist/<name>-<version>.vsix

安装后: Developer: Reload Window
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pack) PACK=1; shift ;;
    --vsix) VSIX_OVERRIDE="${2:?--vsix 需要路径}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知选项: $1" >&2; usage >&2; exit 1 ;;
  esac
done

PKG_NAME="$(node -p "require('$ROOT/package.json').name")"

pick_vsix() {
  if [[ -n "$VSIX_OVERRIDE" ]]; then
    echo "$VSIX_OVERRIDE"
    return
  fi
  local version expected
  version="$(node -p "require('$ROOT/package.json').version")"
  expected="$OUT_DIR/${PKG_NAME}-${version}.vsix"
  if [[ -f "$expected" ]]; then
    echo "$expected"
    return
  fi
  local latest=""
  shopt -s nullglob
  local files=("$OUT_DIR"/"${PKG_NAME}"-*.vsix)
  shopt -u nullglob
  if [[ ${#files[@]} -eq 0 ]]; then
    echo ""
    return
  fi
  latest="$(printf '%s\n' "${files[@]##*/}" | sed "s/^${PKG_NAME}-//;s/\\.vsix\$//" | sort -V | tail -1)"
  echo "$OUT_DIR/${PKG_NAME}-${latest}.vsix"
}

install_cli() {
  if command -v cursor >/dev/null 2>&1; then
    echo "cursor"
  elif command -v code >/dev/null 2>&1; then
    echo "code"
  else
    echo ""
  fi
}

cleanup_old_extension_dirs() {
  local version keep_dir ext_root publisher name
  publisher="$(node -p "require('$ROOT/package.json').publisher")"
  name="$(node -p "require('$ROOT/package.json').name")"
  version="$(node -p "require('$ROOT/package.json').version")"
  keep_dir="${publisher}.${name}-${version}"
  for ext_root in "${HOME}/.cursor/extensions" "${HOME}/.vscode/extensions"; do
    if [[ ! -d "$ext_root" ]]; then
      continue
    fi
    shopt -s nullglob
    for dir in "$ext_root"/"${publisher}.${name}-"*; do
      if [[ "$(basename "$dir")" != "$keep_dir" ]]; then
        echo "→ 移除旧扩展目录 $(basename "$dir")"
        rm -rf "$dir"
      fi
    done
    shopt -u nullglob
  done
}

if [[ "$PACK" -eq 1 ]]; then
  bash "$ROOT/abs/sh/pack-simple-logs.sh"
fi

VSIX="$(pick_vsix)"
if [[ -z "$VSIX" || ! -f "$VSIX" ]]; then
  echo "→ 未找到 vsix，先打包…" >&2
  bash "$ROOT/abs/sh/pack-simple-logs.sh"
  VSIX="$(pick_vsix)"
fi

if [[ -z "$VSIX" || ! -f "$VSIX" ]]; then
  echo "找不到可安装的 vsix（期望 $OUT_DIR/${PKG_NAME}-*.vsix）" >&2
  exit 1
fi

CLI="$(install_cli)"
if [[ -z "$CLI" ]]; then
  echo "未找到 cursor 或 code CLI；请手动安装：" >&2
  echo "  cursor --install-extension \"$VSIX\" --force" >&2
  exit 1
fi

echo "→ 安装 $VSIX"
"$CLI" --install-extension "$VSIX" --force
cleanup_old_extension_dirs
echo "→ 完成（$CLI --install-extension）"
echo "  Developer: Reload Window 后生效"
