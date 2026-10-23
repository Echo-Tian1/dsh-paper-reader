#!/usr/bin/env bash
# 文献阅读坞 — 本地安装 / 卸载脚本（幂等）
#
# 做的事：把本目录软链进 DSH profile 的 node_modules，并在 profile 的 package.json
# 里登记 dependency + bundle，然后提示重启。
#
#   ./install.sh              # 安装到 desktop profile
#   ./install.sh --remove     # 从 profile 移除（不动数据目录）
#   PROFILE=web ./install.sh  # 指定 profile 名
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="@local/paper-reader"
PROFILE="${PROFILE:-desktop}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PROFILE_PKG="$PROFILE_DIR/package.json"
LINK_DIR="$PROFILE_DIR/node_modules/@local"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --remove|--uninstall) MODE="remove" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$PROFILE_DIR" ]; then
  echo "找不到 profile：$PROFILE_DIR" >&2
  echo "现有 profile：$(ls "$DSH_HOME/profiles" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
fi
if [ ! -f "$PROFILE_PKG" ]; then
  echo "profile 里没有 package.json：$PROFILE_PKG" >&2
  exit 1
fi

python3 - "$PROFILE_PKG" "$PLUGIN_NAME" "$PLUGIN_DIR" "$MODE" <<'PY'
import json, sys, os

pkg_path, name, plugin_dir, mode = sys.argv[1:5]
with open(pkg_path, encoding="utf-8") as fh:
    pkg = json.load(fh)

deps = pkg.setdefault("dependencies", {})
bundles = pkg.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
link = "link:" + plugin_dir

if mode == "install":
    deps[name] = link
    if name not in bundles:
        bundles.append(name)
    action = "installed"
else:
    deps.pop(name, None)
    while name in bundles:
        bundles.remove(name)
    action = "removed"

backup = pkg_path + ".bak"
with open(backup, "w", encoding="utf-8") as fh:
    json.dump(pkg, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
with open(pkg_path, "w", encoding="utf-8") as fh:
    json.dump(pkg, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print(action)
PY

if [ "$MODE" = "install" ]; then
  mkdir -p "$LINK_DIR"
  ln -sfn "$PLUGIN_DIR" "$LINK_DIR/paper-reader"
  echo "✓ 已登记到 profile: $PROFILE"
  echo "  依赖: $PLUGIN_NAME -> link:$PLUGIN_DIR"
  echo "  软链: $LINK_DIR/paper-reader"
  echo ""
  echo "下一步：Q 一次 DSH（Cmd+Q）再打开。装好后输入框工具行会出现「文献」按钮。"
else
  rm -f "$LINK_DIR/paper-reader"
  echo "✓ 已从 profile: $PROFILE 移除"
  echo "  数据目录保留在：$DSH_HOME/plugin-data/paper-reader"
  echo ""
  echo "Q 一次 DSH 生效。"
fi
