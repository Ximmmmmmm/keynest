# KeyNest 续接文档（CONTINUATION）

> 最后更新：2026-11-03 21:30 (+08:00)
> 分支：`feat/browser-bridge` · HEAD：`10f4012`
> main `09b870d` 未动 · Tag `v0.4.3`（`d27c0fd`）未动

---

## 1. 当前状态一句话

核心密码库已达产品级（加密、原子写入、备份轮转、模糊测试都在位），
本轮修掉 6 个真实缺陷；**浏览器扩展侧阶段 3.6 的改动尚未经过真实 Chrome 验证**。

---

## 2. 测试基线（必须保持）

| 层 | 数量 | 命令 |
| --- | --- | --- |
| Rust | **372** | `cd rust && cargo test --workspace` |
| Rust 格式/静态 | 0 问题 | `cargo fmt --all --check` + `cargo clippy --workspace --all-targets -- -D warnings` |
| 扩展单元 | **494** | `cd browser-extension && node --test tests/*.test.js` |
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
| `07b9800` | 桥接安装缺端到端测试（各步拼起来对不对没人验） | P2 测试 |
| `08aeea8` | 扩展分不清「宿主没装」与「桌面程序没跑」 | P1 可用性 |
| `e3159bb` | 让宿主主动报告连不上的原因（启动消息机制） | P1 可用性 |
| `16668ae` | **系统空闲未知时自动锁定永久失效**（密码库一直开着） | **P1 安全** |
| `02c362e` | 删掉只改内存不落盘的死 API `replace_data` | P3 代码健康 |
| `61b890b` | **已提交的 ci.yml 是非法 YAML —— CI 静默失效数轮** | **P0 工程** |
| `3e51973` | `keynest-paths` 测试只在 Windows 跑；legacy 作业漏跑 4 个测试文件 | P2 工程 |
| `5bc3f67` | 本地 CI 复现脚本与 ci.yml 会悄悄漂移 | P2 工程 |
| `1848871` | **Firefox 的 CSV 实际导不进来**（README 声称支持） | P1 功能 |
| `61904cc` | 改主密码后不提醒「旧备份仍需旧密码」（用户以为备份废了） | P1 数据可恢复性 |
| `9f78d8c` | **看不到自己记住了哪些站点**，也没法关掉某一个 | P1 可用性 |
| `aa6b25f` | 阅读模式同样缺站点管理（与夜间模式对称） | P1 可用性 |
| `2b8fe01` | **条目列表每帧渲染全部条目**（大密码库直接卡死） | **P1 性能** |
| `7b21be0` | 搜索每个字段都 `to_lowercase()` 分配内存（慢 8.7 倍） | P1 性能 |
| `8a2cedc` | 无头 GUI 渲染测试（**新能力**：不开窗口验证渲染路径） | P2 测试能力 |
| `0524da7` | 18 种筛选×排序组合 + 空库渲染覆盖 | P2 测试 |
| `0da492e` | 设置页 5 分区 + 编辑框渲染覆盖 | P2 测试 |
| `6edd51e` | CSV 转义往返护栏；**本地 CI 脚本自己有个 bug**（`env` + shell 函数） | P1 工具 |

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

## 9. 一条让 CI 静默失效的错误（**教训**）

`ci.yml` 里有一行 `count=$(printf '%s
' "$files" | wc -l)`，
编辑时 `
` 变成了**真实换行**，引号落到行首、缩进为 0，
YAML 的块标量在那里提前结束 —— **整个 ci.yml 从此不是合法 YAML**。

后果：GitHub 连解析都过不去，**CI 从此一次都没跑过**。
而 Rust 测试、覆盖率门槛、cargo-deny、扩展测试——全都挂在它下面。

**这类错误编译器和测试都发现不了**，因为它们根本不执行 YAML。

现在 `scripts/release-check.mjs` 会自动抓它（块标量缩进 + 「结束行像不像
YAML 节点」），并接进了 CI 与 release 流程。

**教训**：CI 配置本身也是代码，也要有检查。
凡是「手工维护、错了要等到发布才暴露」的东西，都该写成一个能跑的检查。

## 9b. 一条新的测试能力：无头渲染 GUI（**重要**）

egui 的 `Context::run_ui` 可以在**没有窗口、没有 GPU** 的情况下跑完一帧，
返回 `FullOutput`——里面有这一帧画出的所有图元。

于是「渲染了多少行」「某个面板会不会崩」都变成**可以断言的数字**，
而不再只能靠「打开程序看看」。

用法见 `rust/keynest-egui/tests/gui_headless.rs`（13 条测试）。

**两个必踩的坑**

1. `FullOutput.textures_delta` 必须被消费，否则 drop 时 panic。
   无头渲染直接 `textures_delta.clear()`。

2. **必须给 `RawInput.screen_rect`**，否则 `ui.available_width()` 是 10000
   （无界），界面不会按真实尺寸布局。行内的图标阈值（`right - 40` 之类）
   会被推到「屏幕」外，任何点击都落到第一个分支上。
   这会让测试看起来通过了、其实什么都没测到；
   也会让人误以为是产品 bug（我差点就去改产品代码了）。

   ```rust
   RawInput {
       screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(1280.0, 800.0))),
       events,
       ..Default::default()
   }
   ```

**点击也能测**：`RawInput.events` 注入 `PointerMoved` + `PointerButton{pressed}`
+ `PointerButton{released}`（三帧，必须复用同一个 `Context`）。
`Response::clicked()` 在释放那一帧才为真。

**为什么这条能力重要**：在这之前，GUI 的渲染逻辑完全没有自动化保护。
虚拟滚动那种「界面看起来正常、只是变卡」的退化，
手工观察永远发现不了。

## 9c. 一个反复踩的坑：改完只跑测试、不跑 fmt/clippy

本轮跑 `bash scripts/ci-local.sh` 时抓到两处：
`cargo fmt --check` 失败（跨行字符串没格式化）、
clippy 失败（`let mut` 但没修改）。

**每次改完代码，跑完整脚本，不要只跑测试。**

## 9d. 一类反复出现的缺陷：**关闭时不问就丢**

同一类问题在本项目里出现了三次：

| 路径 | 之前 | 现在 |
| --- | --- | --- |
| 手动锁定 | 静默丢编辑框 | `pending_lock_confirm` 确认 |
| 关设置页 | **静默丢设置** | `confirm_discard` 确认 |
| 关编辑框 | **静默丢内容** | `confirm_discard` 确认 |

共同点：状态只存在于界面里、还没落盘，而关闭路径直接 `state = None`。
危险在于**没有任何提示**——用户以为改好了/存上了。

排查方法：**搜所有 `= None` 的状态清理点，逐个问「这里丢了什么」**。
本次按这个方法又找到两处（ShowWeak/ShowReused 绕过检查、重新载入无提示），
其余各点（锁定、清库、整库替换）丢弃界面状态是正确的——
库本身已经变了，残留草稿没有意义。

## 9e. 一条教训：**只藏 UI 不关逻辑 = 看不见的按钮**

回收站那次的修法分两步，第一步**不够**：

1. 隐藏图标（`show_actions && !in_trash`）
2. 关闭点击判定（`in_trash` 时整行只选中）

只做第 1 步时，图标不画了、`resp.clicked()` 的 x 判定还在——
用户点到一片空白，密码照样进剪贴板。**比原来更糟**：
原来至少看得见按钮，知道自己在点什么。

是注入指针事件的无头测试逼出了第 2 步。只读代码写「我把图标藏了」，
这个漏洞会原样留着。

**规则：把某个交互从界面上拿掉时，同时把它的判定路径也关掉。**

**补充：还要找全所有入口。** 列表行与详情面板是两个独立的渲染函数，
修了一个不等于修了另一个（这是下一轮才发现的）。

## 9f. 源码扫描测试必须自证会变红（**又踩一次**）

`include_str!("app.rs")` 把**整个文件**（含测试自己）都包含进来，
而测试的说明文字里就写着要统计的那个字符串——
于是计数永远够，断言永远绿。

第一版写完，我故意删掉一处调用验证，**测试没变红**才发现。

修法：先 `find("#[cfg(test)]")` 切掉测试模块再统计。
修完再删一次验证，报「只找到 4 处」——真的红了。

这条在本次会话里已经是第三次踩（虚拟滚动的纯函数、设置页的关窗判定、
现在的源码扫描）。**凡是"守卫"性质的测试，写完必须故意破坏一次，
确认它真的报错。**

## 9g. 一次「分析完决定不改」的记录：`reuse_counts` 每帧 53ms

5 万条实测单帧 81ms，其中 `reuse_counts()` 占 **53ms**。

试了四条优化路线，**全部失败**：

| 尝试 | 结果 |
| --- | --- |
| FxHash 风格快速哈希 | **更慢**（逐字节实现比 SipHash 还慢） |
| 排序 Vec + 二分 | **更慢**（92.8ms vs 50.7ms） |
| 先 O(n) 扫「有没有重复」 | 判断本身要 HashSet 插入 n 次，不比建表便宜 |
| 跨帧缓存 | 失效点太多，风险大于收益 |

**缓存的取舍**：`counts` 依赖全部条目的密码，失效点散布在
upsert / import / delete / restore / purge / 分类操作里。
漏一处用户就会看到过期的「重复使用 N 次」——他以为自己改了密码，
其实界面在骗他。**那比慢严重得多。**

结论写进了 `reuse_counts()` 的文档注释。真要再快，
得把 `show()` 改成「只在数据变化时重算」的架构——另一个量级。

**这条记下来是为了下一轮不再重复研究同一件事。**

## 9h. 发布流程的固有风险：只能在 CI 上验

这轮真跑了 `release.yml` 里的 PowerShell 打包脚本（用本机 PS 5.1，
比 CI 的 pwsh 7 更严格），结果**能跑通**，产出 35 个文件。

但发现一个可移植性问题：脚本若存成**无 BOM 的 UTF-8**，
5.1 会按 ANSI 读，中文注释被读坏 → `ConvertFrom-Json` 失败 →
报「扩展版本不一致：manifest  vs package.json 0.13.0」（manifest 读出来是空）。

CI 用 pwsh 7（默认 UTF-8）碰不到。**这属于「发布流程只能在 CI 上验」
的固有风险**，本地复现会得到假失败。

## 10. 审查方法记录（下一轮可复用）

本轮 6 个缺陷都不是靠读代码「看」出来的，而是靠问三个问题：

1. **失败路径会怎样？** —— 写盘失败、换密码失败、清除失败。
   密码管理器的大部分严重缺陷都在这里，正常路径几乎总是对的。
2. **用户看到这句话能做什么？** —— `EXTERNAL_CHANGE` 的原文案
   技术上正确，但用户看完仍然不知道点哪里。
3. **这条承诺有测试守着吗？** —— 生成器「包含每类字符」是 README
   暗示但不保证的承诺，没有测试就没有约束。
