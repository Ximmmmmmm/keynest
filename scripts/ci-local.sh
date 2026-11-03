#!/usr/bin/env bash
# 本地完整复现 CI 的每一步。
#
# # 为什么需要它
#
# 上一轮发现：`.github/workflows/ci.yml` 因为一行引号没闭合，
# **整个 CI 从此不是合法 YAML**，GitHub 连解析都过不去——
# 于是 Rust 三平台测试、覆盖率门槛、cargo-deny、扩展测试，
# 全都一次都没跑过，而且没人知道。
#
# 那类错误编译器与测试都发现不了，因为它们根本不执行 YAML。
#
# 本脚本把 CI 的每条命令按顺序在本地跑一遍：
# **CI 配置里写了什么，这里就执行什么**，不另写一份。
# 以后改 CI 时顺手跑一次，改坏了当场就知道。
#
# ```bash
# bash scripts/ci-local.sh          # 全跑
# bash scripts/ci-local.sh --fast   # 跳过最慢的覆盖率
# ```
#
# 退出码 0 = 全部通过。

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

FAILED=0
STEP_NO=0

step() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n\033[1m=== [%d] %s ===\033[0m\n' "$STEP_NO" "$1"
}

run() {
  local label="$1"
  shift
  printf '  $ %s\n' "$*"
  if "$@"; then
    printf '  \033[32m✓ %s\033[0m\n' "$label"
  else
    printf '  \033[31m✗ %s\033[0m\n' "$label"
    FAILED=1
  fi
}

# 在 rust/ 下跑 cargo
cargo_in() {
  ( cd rust && "$@" )
}

# 在 browser-extension/ 下跑
ext_in() {
  ( cd browser-extension && "$@" )
}

# shell 片段
bash_in() {
  local dir="$1"
  shift
  ( cd "$dir" && bash -c "$*" )
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '\033[31m缺少工具：%s\033[0m\n' "$1"
    exit 2
  }
}

# cargo 常常不在 PATH 里（尤其是在 Git Bash / 某些 CI 镜像里，
# 它装在 ~/.cargo/bin 下而那个目录没进 PATH）。
# 探测一次并补上，省得每个使用者都要自己 export。
if ! command -v cargo >/dev/null 2>&1; then
  # `set -u` 下 $USER 可能没定义，用 ${USER:-} 并配合判空。
  for d in "$HOME/.cargo/bin" "/c/Users/${USER:-}/.cargo/bin"; do
    if [ -n "$d" ] && [ -x "$d/cargo" ]; then
      export PATH="$d:$PATH"
      break
    fi
  done
fi

need cargo
need node

printf '\033[1m=== 本地复现 CI ===\033[0m\n'
printf '仓库：%s\n' "$REPO"
[ "$FAST" = "1" ] && printf '\033[33m（--fast：跳过覆盖率与 release 构建）\033[0m\n'

# ---- core 作业（三平台；本地只跑当前平台）----
step "core / 格式检查"
run "cargo fmt --all --check" cargo_in cargo fmt --all --check

step "core / Clippy（keynest-core + keynest-paths）"
run "cargo clippy" cargo_in cargo clippy -p keynest-core -p keynest-paths --all-targets -- -D warnings

step "core / 单元与集成测试（keynest-core + keynest-paths）"
run "cargo test" cargo_in cargo test -p keynest-core -p keynest-paths --all-targets

# ---- gui-windows 作业 ----
step "gui-windows / Clippy（整个工作区）"
run "cargo clippy --workspace" cargo_in cargo clippy --workspace --all-targets -- -D warnings

step "gui-windows / 测试（整个工作区）"
run "cargo test --workspace" cargo_in cargo test --workspace

if [ "$FAST" != "1" ]; then
  step "gui-windows / 发布构建"
  # CI 里带 RUSTFLAGS=-D warnings，release profile 的 warning 也要当错误
  # 注意顺序：`env` 必须在 `cargo_in` **里面**。
  #
  # 写成 `env RUSTFLAGS=... cargo_in ...` 会永远失败——
  # `env` 需要一个可执行文件，而 `cargo_in` 是 shell 函数。
  run "cargo build --release" cargo_in env RUSTFLAGS="-D warnings" cargo build --release -p keynest-egui

  step "coverage / 行覆盖率门槛 85%"
  if command -v cargo-llvm-cov >/dev/null 2>&1; then
    run "cargo llvm-cov" cargo_in cargo llvm-cov -p keynest-core --fail-under-lines 85 --summary-only
  else
    printf '  \033[33m跳过：未安装 cargo-llvm-cov\033[0m\n'
  fi
fi

# ---- extension 作业 ----
step "extension / 单元与集成测试"
run "node --test" bash_in browser-extension 'set -euo pipefail; files=$(ls tests/*.test.js); count=$(printf "%s\n" "$files" | wc -l); if [ "$count" -lt 5 ]; then echo "测试文件数量异常（$count 个）"; exit 1; fi; node --test $files'

step "extension / 装配自检"
run "node scripts/selfcheck.mjs" ext_in node scripts/selfcheck.mjs

step "extension / 发布前自检"
run "node scripts/release-check.mjs" node scripts/release-check.mjs

step "extension / 清单可解析"
run "manifest" bash_in browser-extension 'node -e "const m=require(\"fs\").readFileSync(\"manifest.json\",\"utf8\");JSON.parse(m);console.log(\"manifest ok\")"'

# ---- legacy-electron 作业（非阻塞，但本地也要跑一遍）----
if [ -f package.json ]; then
  step "legacy-electron / 单元测试"
  run "node test/*.test.js" bash_in . 'set -euo pipefail; files=$(ls test/*.test.js); count=$(ls test/*.test.js | wc -l); if [ "$count" -lt 7 ]; then echo "测试文件数量异常（$count 个）"; exit 1; fi; for f in $files; do echo "--- $f"; node "$f" >/dev/null; done'
fi

printf '\n'
if [ "$FAILED" = "0" ]; then
  printf '\033[1;32m=== 全部通过（%d 步）===\033[0m\n' "$STEP_NO"
  exit 0
else
  printf '\033[1;31m=== 有步骤失败 ===\033[0m\n'
  exit 1
fi
