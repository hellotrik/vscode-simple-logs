#!/usr/bin/env bash
# 古月方源·大爱仙尊｜心志篇（其一）
# 因为困难多壮志，不教红尘惑坚心。
# 今身暂且栖草头，它日狂歌踏山河。
# 来源：蛊真人 · 《蛊真人》全诗词整理（完整版） · kairos-dao-header
# 打包 vscode-simple-logs → dist/<name>-<version>.vsix
# 参考：凝冰工作日记 jnl-3C91E7A2 · VS Code 扩展自动升版打包安装
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/dist"
BUMP="patch"
NO_BUMP=0
FORCE_INSTALL=0

bump_package_version() {
  local level="$1"
  node -e "
const fs = require('fs');
const path = 'package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
const level = process.argv[1];
const parts = String(pkg.version).trim().split('.');
while (parts.length < 3) parts.push('0');
const major = parseInt(parts[0], 10) || 0;
const minor = parseInt(parts[1], 10) || 0;
const patch = parseInt(parts[2], 10) || 0;
let next;
if (level === 'patch') {
  next = [major, minor, patch + 1];
} else if (level === 'minor') {
  next = [major, minor + 1, 0];
} else if (level === 'major') {
  next = [major + 1, 0, 0];
} else {
  console.error('invalid level');
  process.exit(1);
}
pkg.version = next.join('.');
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
console.log(pkg.version);
" "$level"
}

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

  产出: dist/<name>-<version>.vsix（name/version 来自 package.json）
  默认打包前修订号（第三位）+1，不打 git tag。

选项:
  --no-bump         不改动版本号，按当前 package.json 打包
  --bump LEVEL      自增级别：patch（默认）| minor | major
  --force-install   强制 yarn install（默认：已有 node_modules/@vscode/vsce 则跳过）
  -h, --help        显示此帮助

示例:
  $(basename "$0")              # patch +1 后打包
  $(basename "$0") --no-bump    # 保持当前版本
  $(basename "$0") --bump minor
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-bump) NO_BUMP=1; shift ;;
    --force-install) FORCE_INSTALL=1; shift ;;
    --bump)
      BUMP="${2:?--bump 需要 patch|minor|major}"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知选项: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "无效 --bump: $BUMP（仅 patch | minor | major）" >&2
    exit 1
    ;;
esac

if ! command -v yarn >/dev/null; then
  echo "需要 yarn" >&2
  exit 1
fi

cd "$ROOT"

ensure_deps() {
  local vsce_bin="$ROOT/node_modules/.bin/vsce"
  if [[ "$FORCE_INSTALL" -eq 0 && -x "$vsce_bin" ]]; then
    echo "→ 跳过 yarn install（已有 vsce；需要重装请加 --force-install）"
    return 0
  fi
  echo "→ yarn install（无 lockfile 时可能较慢，尤其在网络盘）"
  # 本仓 .gitignore 忽略了 *.lock，frozen 通常会失败；prefer-offline 减轻卡住感
  if [[ -f "$ROOT/yarn.lock" ]]; then
    yarn install --frozen-lockfile --prefer-offline
  else
    yarn install --prefer-offline
  fi
  if [[ ! -x "$vsce_bin" ]]; then
    echo "未找到 @vscode/vsce，请确认已写入 package.json devDependencies" >&2
    exit 1
  fi
}

PKG_NAME="$(node -p "require('./package.json').name")"
OLD_VERSION="$(node -p "require('./package.json').version")"

# 先装依赖再升版，避免 install 卡住时版本已改
ensure_deps

if [[ "$NO_BUMP" -eq 0 ]]; then
  if [[ "$BUMP" == "patch" ]]; then
    echo "→ 版本 $OLD_VERSION → 修订号（第三位）+1"
  else
    echo "→ 版本 $OLD_VERSION → $BUMP +1"
  fi
  NEW_VERSION="$(bump_package_version "$BUMP")"
  echo "→ 新版本 $NEW_VERSION"
else
  echo "→ 版本保持 $OLD_VERSION（--no-bump）"
fi

VERSION="$(node -p "require('./package.json').version")"
VSIX="$OUT_DIR/${PKG_NAME}-${VERSION}.vsix"

mkdir -p "$OUT_DIR"
echo "→ webpack production（vscode:prepublish）"
# 直接调 vsce，避免 yarn 再包一层；CI=1 禁止交互提示
# --no-dependencies：无 runtime deps
CI=1 "$ROOT/node_modules/.bin/vsce" package --no-dependencies -o "$VSIX"

SIZE="$(du -h "$VSIX" | awk '{print $1}')"
echo "→ $VSIX ($SIZE)"
echo ""
echo "安装："
echo "  abs/sh/install-simple-logs.sh"
echo "  # 或 cursor --install-extension \"$VSIX\" --force"
