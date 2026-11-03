# KeyNest 续接文档（CONTINUATION）

> 最后更新：2026-11-03 12:40 (+08:00)
> 分支：`feat/browser-bridge` · HEAD：`01188e5`
> main `09b870d` 未动 · Tag `v0.4.3`（`d27c0fd`）未动

---

## 1. 当前状态一句话

核心密码库已达产品级（加密、原子写入、备份轮转、模糊测试都在位），
本轮修掉 6 个真实缺陷；**浏览器扩展侧阶段 3.6 的改动尚未经过真实 Chrome 验证**。

---

## 2. 测试基线（必须保持）

| 层 | 数量 | 命令 |
| --- | --- | --- |
| Rust | **309** | `cd rust && cargo test --workspace` |
| Rust 格式/静态 | 0 问题 | `cargo fmt --all --check` + `cargo clippy --workspace --all-targets -- -D warnings` |
| 扩展单元 | **480** | `cd browser-extension && node --test tests/*.test.js` |
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
| `f035b92` | 手动锁定静默丢弃未保存的编辑 | P1 数据丢失 |
| `b701ae2` | Ctrl+L 绕过未保存确认（与按钮行为不一致） | P2 一致性 |
| `1d8c5d9` | 明文导出文件在 unix 上同机其他账号可读 | P1 安全 |
| `588f677` | 库里重复条目 id 会让「改 A 结果 B 变了」 | P1 数据正确性 |
| `7f29bc4` | 危险设置值（auto_lock=0 等）让程序解锁即锁死 | P0 可用性 |
| `7990311` | 明文导出把回收站条目一起写进文件 | P1 数据外泄 |
| `e4f82df` | 复制密码/账号用裸 String，内容留在堆上 | P1 安全 |
| `75b9ce8` | bridge 响应序列化缓冲区含明文密码未清零 | P1 安全 |
| `bb9a89a` | `Entry::drop` 漏清 TOTP 密钥与自定义字段（TOTP 泄漏=二次验证失效） | P1 安全 |
| `3cd6721` | 复用密码统计是 O(n²)，5000 条时每帧 2500 万次比较 | P2 性能 |
| `67bf0e5` | TOTP 复制 TTL 被 `.max(3)` 拉长，剪贴板留过期码 | P1 安全 |
| `f23b442` | 恢复留档（`vault.dat.corrupt-*`）界面完全不可见、无法清理 | P2 可用性 |
| `9fb4602` | 恢复失败时还原失败被 `let _ =` 吞掉，用户不知道数据在哪 | P1 数据可发现性 |
| `a1fb1c0` | 阅读模式「退出」会删掉站点记忆（想临时看一眼却永久关掉） | P1 语义 |
| `fa72b71` | SPA 换页不重新应用站点偏好（单页应用里功能时灵时不灵） | P1 可用性 |
| `6df4278` | 「清除筛选」不清搜索词，按钮名不副实 | P2 可用性 |
| `e2bbfa3` | 单条「永久删除」无确认（紧挨「恢复」，误点即丢失） | P1 误操作 |
| `e2bbfa3` | 普通删除的文案写「无法撤销」，与实际（可恢复）不符 | P2 文案 |
| `9c95a01` | 改主密码/升级格式无防重入（窗口冻结期间可连点） | P1 正确性 |
| `35d4538` | README「已知限制」三处与代码实际状态不符 | P1 文档 |
| `f1712cb` | 中文 README 缺回滚攻击这条限制（英文版有） | P2 文档 |
| `b202ac0` | **SPA 路由监听从未真正工作**（隔离世界与主世界不相通） | **P1 功能性** |
| `7f7e450` | 扩展的 475 项测试**从未进过 CI** | P1 工程 |
| `200ab9d` | 对端断开被报成 IO 错误（正常连接结束却像故障） | P1 健壮性 |
| `cbaad9f` | 导入报告不统计「解析阶段就丢掉」的条目（用户看不到漏了什么） | P1 数据可发现性 |
| `f201441` | 导出确认里的条数含回收站（说 500 实际 480） | P2 一致性 |
| `80bd423` | 25 份阶段报告淹没真正的架构文档 | P2 文档组织 |
| `28198d0` | 条目字段无长度上限（超长备注能让库再也写不进去） | **P1 数据完整性** |
| `fce4a42` | **扩展从未进过发布包**（产品一半功能没有分发方式） | P1 发布准备度 |
| `37ea621` | 上一轮的扩展打包步骤**三处会让发布直接失败** | P1 发布流程 |
| `3becd08` | release 的 verify 不跑扩展测试、也没装 Node | P1 发布流程 |
| `2b17d58` | 发布包**缺 native-host.exe**（扩展连不上的必要组件） | **P1 产品级** |
| `518121f` | **产品从未注册 native messaging host**（扩展永远连不上） | **P1 产品级** |
| `cf76106` | 扩展不显示自己的 ID（用户无法配置桥接） | P1 可用性 |
| `1d8afef` | 设置里没有浏览器桥接入口 | P1 可用性 |

对应的回归测试名可直接 `cargo test <名字>`：

- `failed_save_does_not_rotate_backups`
- `failed_change_master_keeps_old_password_working`
- `can_reload_after_external_change` / `reload_rejects_a_different_vault`
- `import_stops_at_entry_limit` / `import_below_limit_is_unaffected`
- `generated_password_contains_every_selected_class` / `single_class_still_uses_full_length`
- `views::edit::tests::*`（9 项，覆盖 `is_dirty` 判定）
- `plaintext_export_is_owner_only`（unix 专属，本机跳过）
- `plaintext_export_roundtrips`
- `entry_drop_zeroizes_sensitive_fields`（守卫：`impl Drop for Entry` 被删会红）
- `reply_body_is_zeroized`（守卫：bridge 响应缓冲区的 Zeroizing 被去掉会红）
- `entry_drop_zeroizes_sensitive_fields`（覆盖 totp / fields）
- `update_settings_clamps_dangerous_values` / `..._caps_huge_values` / `..._keeps_valid_values`
- `opening_legacy_vault_clamps_settings_in_memory`
- `duplicate_entry_ids_are_detected` / `unique_ids_report_nothing`
- `export_skips_deleted_entries`

---

## 4. 未完成 / 待验证（按优先级）

### P0（阻塞发布）

无。本轮已清空已知 P0。

### P0：验证能力的边界（**实测得出，影响所有后续验证**）

**`--headless=new` 不支持 native messaging 宿主。**

证据：注册了真实的
`HKCU\\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge`
之后，用一个会写标记文件的 .bat 当宿主，Chrome **完全没有启动它**。

项目自己的验收夹具（`run.mjs`）用的是**有头** Chrome，它跑通 46 项——
native messaging 在有头模式下是通的。

**后果**：

| 能用 headless 验 | 不能用 headless 验 |
| --- | --- |
| 扩展自身逻辑（注入、自动应用、模块、广告规则、DOM 效果） | 宿主 → 管道 → 桌面程序（解锁 → 桥接 → 填充） |

所以 `extension-headless.mjs` 覆盖的是**扩展侧**；
桥接那条链路只能靠 `run.mjs`（需要有头 Chrome + GUI 解锁）。

**别再花时间试图用 headless 验桥接了**——这条限制已经用标记文件实测确认。

### P1：阶段 3.6 的真实浏览器验收 —— **已完成（headless 部分）**

`node test/acceptance/extension-headless.mjs` 已经把下列各项在真实 Chrome 里验完，
**且不启动 GUI、不注入键鼠**，因此可以在用户用电脑时跑：

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | 内容脚本在真实页面注入（隔离世界） | PASS `isoCtx=3 marker=true` |
| 2 | 页面加载后自动应用夜间模式 | PASS `cls:true style:true` |
| 3 | 非名单站点不被注入 | PASS |
| 4 | 广告规则进浏览器（真实 dNR） | PASS `rules=46` |
| 5 | forget 语义（真实 storage） | PASS |
| 6 | 阅读模式在真实文章页提取正文 | PASS `reason:"scored:144"` |
| 7 | SPA 换路由后重新应用 | PASS `cls:true style:true` |

第 7 项在验证过程中暴露了一个**真实缺陷**：隔离世界给 history 打的补丁
对主世界的 pushState 无效。已在 `b202ac0` 修复（改为主世界注入）。

**仍未验证**（必须启动 GUI，会抢焦点与键鼠，需机器空闲时做）：

- 解锁 → 桥接 → 密码填充的完整链路（`node test/acceptance/run.mjs`，46 项）

桥接的**密码学与管道接线**已经用进程级集成测试覆盖了
（`tests/process_bridge.rs`：真实命名管道、真实握手、真实请求往返、
错误的 key 在处理任何请求之前被拒），不依赖 GUI。

### P2：审查中观察到但未处理

| 项 | 说明 |
| --- | --- |
| ~~SPA 路由变化~~ | 已在 `fa72b71` 解决：监听 popstate/hashchange + 给 history 打补丁。<br>**尚未在真实浏览器的 SPA 站点上验证** |
| ~~阅读模式的「只关这一次」~~ | 已在 `a1fb1c0` 解决：默认临时退出，`forget:true` 才移除记忆 |
| ~~`.corrupt-*` 无清理入口~~ | 已在 `f23b442` 解决：设置页可列出并清空（带二次确认） |
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

## 7. 一条反复踩到的坑：守卫测试必须先自验

「盯源码」型的守卫测试（用 `include_str!` 读自己的源文件，断言某个调用还在）
很容易写成**永远通过**的样子。本会话踩了三次：

| 写法 | 为什么失效 |
| --- | --- |
| `src.split("锚点").nth(1)` 然后直接断言 | 拿到的是从锚点到**文件末尾**，里面包含测试自己 → 永远为真 |
| `take_while(\|l\| l.trim() != "}")` | 停在函数里第一个**内层块**的右花括号，后面的检查落空 |
| `body.contains("self.totp")` | `let _ = &self.totp;` 也能通过，但它什么都没清零 |

正确做法：截取到**与锚点同缩进层级**的 `}`，加一条自检断言
（"范围里必须含某个必然存在的语句"），断言写到**关键调用**而非关键标识符。
写完必须实测一次退化：把目标代码改坏，确认测试真的红。

## 8. 一条被真实环境证伪的"设计"

阶段 3.6 以为"SPA 换路由后重新应用"已经实现——单元测试全绿、代码看着合理、
甚至还写了"两份实现一致性测试"。

**但它从来没有工作过。** 内容脚本在隔离世界，页面在主世界，
两者之间没有连接。

教训：**跨执行环境的假设必须去真实环境验一次。**
隔离世界 / 主世界 / Service Worker / 扩展页面 —— 这四个世界的边界，
在单一世界的单元测试里全都看不见。

无头 Chrome 让这次验证不再需要打扰用户——
这本身就是一条值得沉淀的方法：**先想办法把验证变得不打扰人，再去做。**

## 9. 审查方法记录（下一轮可复用）

本轮 6 个缺陷都不是靠读代码「看」出来的，而是靠问三个问题：

1. **失败路径会怎样？** —— 写盘失败、换密码失败、清除失败。
   密码管理器的大部分严重缺陷都在这里，正常路径几乎总是对的。
2. **用户看到这句话能做什么？** —— `EXTERNAL_CHANGE` 的原文案
   技术上正确，但用户看完仍然不知道点哪里。
3. **这条承诺有测试守着吗？** —— 生成器「包含每类字符」是 README
   暗示但不保证的承诺，没有测试就没有约束。
