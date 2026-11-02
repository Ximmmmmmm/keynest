# KeyNest 阶段 2.6 第二部分报告 · Chrome Native Host 隔离端到端验收

> 分支 `feat/browser-bridge` · 基线 `99356e5` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 测试环境：**真实 Chrome 156.0.8078.80**，独立临时 profile，真实 GUI + 真实 Native Host + 真实命名管道
> 日期：2026-11-02
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

**真实端到端跑通了。**

```
Chrome 扩展 → Native Messaging → keynest-native-host.exe
   → 加密命名管道 → keynest-egui（持有 DEK）→ 临时 vault.dat
   → 密码填进页面输入框
```

过程中挖出 **8 个真实缺陷**，全部在 `pipe.rs` / `native_host.rs`，
**74 项 node 测试 + 全部 Rust 单元测试一个都没抓到**——它们不碰真实管道。

---

## 1. 真实 Chrome PASS（核心 12 项）

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| T1 | 定位测试 tab | **PASS** | `tabId=990774655, url=https://127.0.0.1:9445/` |
| T2 | **Native Messaging 握手 + status** | **PASS** | `{ok:true, payload:{locked:false, protocol:1, version:"0.4.3"}}` |
| T3 | `vault.query` 返回条目（**不含密码**） | **PASS** | 返回 `id/title/url/username`，无 `password` 字段 |
| T4 | `authorize-fill` 签发授权 | **PASS** | `nonce` 32 字节 |
| T5 | **一次性 nonce 兑换并填充** | **PASS** | `{ok:true}` |
| T6 | **页面输入框实际被填充** | **PASS** | `user='phase26-test-user'`，密码 26 字符 |
| T7 | 重复兑换被拒绝 | **PASS** | `NO_PENDING`（nonce 已消费） |
| T8 | HTTP 页面拒绝 | **PASS** | `HTTP_NOT_ALLOWED` |
| T9 | 错误 entryId 拒绝 | **PASS** | `ENTRY_NOT_MATCHED` |
| T10 | 锁定后浏览器请求被拒 | **PASS** | `HOST_DISCONNECTED`；Host 连不上管道（`IO`） |
| T11 | 扩展无 storage 能力 | **PASS** | `typeof chrome.storage === 'undefined'` |
| T12 | `localStorage` / `sessionStorage` 为空 | **PASS** | `[]` / `[]` |

### 数据保护

| 项 | 结果 |
| --- | --- |
| 密码不写入 extension storage | **PASS**（manifest 无 `storage` 权限，扩展根本没有该能力） |
| 密码不写入 localStorage/sessionStorage | **PASS**（实测均为空） |
| 密码不写入日志 | **PASS**（Host stderr 只有错误码；GUI 日志只有错误描述） |
| 密码不进入剪贴板 | **PASS**（代码无剪贴板调用） |
| 密码不进 stdout 诊断 | **PASS**（stdout 只有协议帧） |
| 密码不写入本报告 | **PASS** |

---

## 2. 挖出的 8 个真实缺陷

全部集中在 `rust/keynest-bridge/src/pipe.rs` 与 `src/bin/native_host.rs`。

| # | 缺陷 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `PIPE_REJECT_REMOTE_CLIENTS` 放进 **open mode**（它属于 pipe mode） | `CreateNamedPipeW` 一直返回 `ERROR_INVALID_PARAMETER`，管道**从未建起来过** | 移入 pipe mode |
| 2 | `native_host.rs` **完全没实现握手**，只做透明转发 | 明文帧被 GUI 当握手应答 → 长度不符 → 断开 | 实现 challenge/proof/ok + 双向 AEAD |
| 3 | `connect_client` 用 `FILE_SHARE_NONE`(=0) | 命名管道客户端传 0 共享模式必然失败 | 改 `FILE_SHARE_READ\|FILE_SHARE_WRITE` |
| 4 | `FILE_FLAG_FIRST_PIPE_INSTANCE` | 只能建一次实例，连接断开后重建失败 → 服务**永久不可用** | 移除；唯一性由 `nMaxInstances=1` + 串行 accept 保证 |
| 5 | `ERROR_PIPE_CONNECTED` 判断码写成 `0x800700E7`（那是 `ERROR_MORE_DATA`） | 客户端抢先连接（竞态常态）被当失败丢弃 | 改为 `0x80070217`（535） |
| 6 | 管道用 **消息模式** + `read_frame` 分段读 | 每次握手 `ERROR_MORE_DATA(0x800700EA)` | 改字节模式（`PIPE_TYPE_BYTE\|PIPE_READMODE_BYTE`） |
| 7 | `PipeHandle::Drop` 缺 `DisconnectNamedPipe` | 首次失败后所有后续连接 `BROKEN_PIPE` | Drop 里先断开再关闭 |
| 8 | `serve_with_options` 的错误被 `let _ =` 吞掉 | 浏览器永远 TIMEOUT，**完全无法排查** | 记录错误码到 stderr + `last_error` |

> 缺陷 8 是元问题：前 7 个之所以查了 9 轮，就是因为错误被吞了。

---

## 3. 关键环境发现

**Chrome 启动 Native Host 时继承 Chrome 自身的环境变量**。
隔离测试必须给 **Chrome 进程**设 `KEYNEST_DATA_DIR`，否则 Host 找不到临时目录里的 `bridge.key`。

这不是代码缺陷，是测试环境要求，已记录在报告中。

---

## 4. 修改文件

| 文件 | 改动 |
| --- | --- |
| `rust/keynest-bridge/src/pipe.rs` | 5 处修复（缺陷 1/3/4/5/6/7） |
| `rust/keynest-bridge/src/bin/native_host.rs` | 重写：实现握手 + 双向 AEAD（缺陷 2） |
| `rust/keynest-egui/src/bridge/mod.rs` | 错误不再吞掉 + `last_error` 上报（缺陷 8） |
| `rust/keynest-egui/src/app.rs` | `logic()` 里 `request_repaint_after`（桥接运行时保持重绘） |
| `scripts/register-native-host-dev.ps1` | 新增 `-ManifestDir`（默认行为不变） |

---

## 5. 测试计数

| 类别 | 数量 |
| --- | --- |
| **真实 Chrome PASS** | **12 项核心 + 6 项数据保护** |
| Rust 测试 | 223 通过 |
| Node 扩展测试 | 75 通过 |
| `cargo fmt` | PASS |
| `cargo clippy -D warnings` | 0 问题 |
| `cargo deny check` | 四类全绿 |

---

## 6. 仍未覆盖（如实）

| 项 | 状态 |
| --- | --- |
| 100 并发兑换（真实浏览器） | **NOT TESTED**（node 层已覆盖） |
| 跨站 iframe 真实拒付 | **NOT TESTED** |
| 导航后旧授权失效（真实事件） | **NOT TESTED** |
| 授权过期（5 秒 TTL）真实触发 | **NOT TESTED** |
| tab 关闭后旧授权失效 | **NOT TESTED** |
| SW 休眠唤醒后的时序 | **NOT TESTED** |
| Edge | 未测试（本阶段只批 Chrome） |

---

## 7. 清理结果

| 项 | 结果 |
| --- | --- |
| Chrome 注册项 | **已删除**（`False`） |
| Edge 注册项 | **从未创建**（`False`） |
| 临时 manifest | **已删除** |
| 临时目录（含 vault/bridge.key/profile/logs） | **已彻底删除** |
| Chrome / GUI / Host / python 进程 | **全部为 0** |
| 真实库 | `42228` 字节、mtime 未变、md5 `2bd94cde0fa7d1e1166c930324f763c` **完全一致** |
| 真实 `bridge.key` | **不存在** |
| 真实 `%LOCALAPPDATA%\KeyNest` | **不存在** |
| main / v0.4.3 | 未动 |
| 推送 / 合并 / 发布 | 未执行 |

清理小插曲：`site/` 目录被测试用 python 进程占用，终止后删除成功。

---

## 8. 本轮教训

**8 个缺陷全部是"手写 Win32 常量/标志位/生命周期"踩的坑**：

- 把 pipe mode 位塞进 open mode
- 把 535 写成 231
- 忘了 `DisconnectNamedPipe`
- 消息模式配分段读
- 共享模式传 0

这些**单元测试永远测不到**——因为测试跑在 Linux/mac 上，或者根本不碰真实管道。

**只有真实 Chrome + 真实命名管道能暴露。**

---

## 9. Git

```
分支        feat/browser-bridge
基线        99356e5
本次提交    见 git log -1
main        09b870d（未动）
v0.4.3      2bd390e（未动）
未推送、未合并、未发布
```

---

## 10. 停止点

本阶段只验收查询与主动填充。**未实现自动保存、页面加载自动填充、浏览器内置库同步。**

真实端到端已跑通，等你审查。
