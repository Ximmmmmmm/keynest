# KeyNest 续接文档（CONTINUATION）

> 最后更新：2026-11-02 21:45 (+08:00)
> 分支：`feat/browser-bridge` · HEAD：`c3df4b7`
> main `09b870d` 未动 · Tag `v0.4.3`（`d27c0fd`）未动

---

## 1. 当前状态一句话

核心密码库已达产品级（加密、原子写入、备份轮转、模糊测试都在位），
本轮修掉 6 个真实缺陷；**浏览器扩展侧阶段 3.6 的改动尚未经过真实 Chrome 验证**。

---

## 2. 测试基线（必须保持）

| 层 | 数量 | 命令 |
| --- | --- | --- |
| Rust | **249** | `cd rust && cargo test --workspace` |
| Rust 格式/静态 | 0 问题 | `cargo fmt --all --check` + `cargo clippy --workspace --all-targets -- -D warnings` |
| 扩展单元 | **453** | `cd browser-extension && node --test tests/*.test.js` |
| 扩展装配自检 | **14** | `cd browser-extension && node scripts/selfcheck.mjs` |
| 真实 Chrome 验收 | **46** | `node test/acceptance/run.mjs`（需启动浏览器） |

Rust workspace 根是 `rust/`；Windows 上需要
`export PATH="/c/Users/XIM/.cargo/bin:$PATH"`。

---

## 3. 本轮已修的缺陷（6 个，全部有回归测试）

| 提交 | 缺陷 | 严重度 |
| --- | --- | --- |
| `e3903fe` | 写盘失败会轮转掉备份，连续失败把历史挤空 | P0 数据丢失 |
| `e3903fe` | 换主密码失败后库变成「谁都打不开」 | P0 数据丢失 |
| `216309e` | 外部改动后无任何恢复路径（只能重启或删文件） | P1 可用性 |
| `216309e` | 导入无条目上限，可造成保存失败 + 界面卡死 | P1 |
| `216309e` | 错误提示不可操作（只说「被其他程序修改」） | P1 可用性 |
| `ed66cff` | 生成器不保证包含每个选中的字符类别 | P1 可用性 |
| `c3df4b7` | 剪贴板清除失败被静默吞掉（密码留在剪贴板） | P1 安全 |

对应的回归测试名可直接 `cargo test <名字>`：

- `failed_save_does_not_rotate_backups`
- `failed_change_master_keeps_old_password_working`
- `can_reload_after_external_change` / `reload_rejects_a_different_vault`
- `import_stops_at_entry_limit` / `import_below_limit_is_unaffected`
- `generated_password_contains_every_selected_class` / `single_class_still_uses_full_length`

---

## 4. 未完成 / 待验证（按优先级）

### P0（阻塞发布）

无。本轮已清空已知 P0。

### P1：阶段 3.6 的真实浏览器验收

扩展侧的「页面加载自动应用」只做了纯代码与单测，
**从未在真实 Chrome 里跑过**。六项待验：

1. 自动应用是否真的生效（打开已记忆站点，查 `documentElement.classList`)
2. `load` + `setTimeout 0` 的时序是否合适
3. 未授权时是否真的不弹确认框
4. 阅读模式自动应用在真实文章页的表现
5. `auto.apply` 的 `content` 门禁在真实消息路径是否生效
6. `load` 事件在某些页面是否永不触发

验证方式：`KN_KEEP=1 node test/acceptance/run.mjs`，然后检查
`/article` 的自动应用。**需要启动浏览器**，应在用户机器空闲时做。

### P2：审查中观察到但未处理

| 项 | 说明 |
| --- | --- |
| SPA 路由变化 | 自动应用只在页面加载时跑一次，`pushState` 不会重新触发 |
| 阅读模式的「只关这一次」 | 用户手动关掉会同时清掉站点名单，没有临时关闭的概念 |
| `.corrupt-*` 无上限展示 | `wipe()` 会清，但设置页没有「清理留档文件」入口 |
| `random_index` 的取值区间 | 当前实现拒绝 `v >= zone`，比理论必要略保守（不影响安全，仅效率） |

### P3：产品化欠缺

- 安装包 / 升级路径未验证
- 无 CHANGELOG 的本轮条目（提交信息已可作素材）
- README 的「已知限制」未同步本轮改动

---

## 5. 绝不能做的事

- 读取、修改、覆盖、删除真实 `%APPDATA%\KeyNest\vault.dat`
- 创建真实 `bridge.key` 或 `%LOCALAPPDATA%\KeyNest`
- 注册 Chrome / Edge 的 NativeMessagingHosts（临时验收后必须复原为 False）
- 改加密算法、KDF 参数、文件格式
- Force push / 重写历史 / 删测试换取通过
- **在用户使用电脑时启动浏览器、注入键鼠、截屏**

真实库指纹（必须不变）：
`vault.dat` = 42228 字节，md5 `2bd94cde0fa7d1e1166c930324f763cf`，
mtime 2026-11-01 23:19:17。

---

## 6. 下一步具体动作

1. 读本文档 + `git log --oneline -6` + `git status`
2. 跑 `cargo test --workspace` 与 `node --test tests/*.test.js` 确认基线
3. 若机器空闲：做 §4 的六项真实浏览器验收（先问用户或确认无占用）
4. 若机器忙：继续 P2 里的一项（建议 SPA 路由，属纯代码）

---

## 7. 审查方法记录（下一轮可复用）

本轮 6 个缺陷都不是靠读代码「看」出来的，而是靠问三个问题：

1. **失败路径会怎样？** —— 写盘失败、换密码失败、清除失败。
   密码管理器的大部分严重缺陷都在这里，正常路径几乎总是对的。
2. **用户看到这句话能做什么？** —— `EXTERNAL_CHANGE` 的原文案
   技术上正确，但用户看完仍然不知道点哪里。
3. **这条承诺有测试守着吗？** —— 生成器「包含每类字符」是 README
   暗示但不保证的承诺，没有测试就没有约束。
