# 架构说明

面向要读代码或改代码的人。目标：看完这篇能知道「一个密码从输入到落盘经过了哪些层」。

---

## 1. 分层

```text
┌──────────────────────────────────────────────┐
│ keynest-egui   界面：状态机 + 视图              │
│   app.rs       状态迁移、意图分发、后台任务      │
│   views/       只画界面，返回「意图」枚举        │
│   ui/          主题、图标、动画、剪贴板封装      │
└───────────────────────┬──────────────────────┘
                        │ 只依赖公开 API
┌───────────────────────▼──────────────────────┐
│ keynest-core   纯逻辑，无 UI / 无 WebView       │
│   vault.rs     格式 + KDF + AEAD + 原子写 + CRUD│
│   portable.rs  明文导入导出 + 加密备份           │
│   keymem.rs    密钥内存锁定                      │
│   lockfile.rs  单实例锁                          │
│   password.rs  生成与强度估算                    │
│   secure.rs    剪贴板与系统闲置（Win32）          │
│   paths.rs     数据目录解析                      │
│   error.rs     错误类型（脱敏）                   │
└──────────────────────────────────────────────┘
```

**为什么要分成两层**：`keynest-core` 能在 Linux / macOS 上编译运行全部测试，
不需要图形环境。GUI 只负责"把状态画出来 / 把用户操作翻译成调用"。

---

## 2. 一次解锁发生了什么

```text
用户输入主密码
   │
   ▼
app.rs::submit_unlock()            ← UI 线程不阻塞，起工作线程
   │
   ▼
Vault::unlock(master)
   ├─ read_vault_bytes()           读文件 + 64 MiB 上限
   ├─ AnyFile::parse()             按 format 字段分发到 v1/v2/v3
   ├─ AnyFile::validate()          不依赖密钥的自洽性校验
   │     · 格式 ↔ KDF ↔ 算法 必须配对
   │     · 参数范围、salt/nonce/tag 长度、base64 合法性
   ├─ derive_key(master) ───────── Argon2id(64 MiB...) → KEK（放进 SecretKey）
   ├─ unwrap_dek(kek) ──────────── XChaCha20-Poly1305 解出 DEK
   │     · AAD = "keynest.v3|dek|算法|m=|t=|p=|salt="
   └─ open_body(dek) ───────────── 解出正文 JSON
         · AAD = "keynest.v3|body|xchacha20-poly1305"
   │
   ▼
AppState::Unlocked { vault, data, .. }
```

任何一步失败都不会留下"半解锁"状态（有测试断言 `is_unlocked() == false`）。

---

## 3. 一次保存发生了什么

```text
Vault::upsert_entry / delete_entry / add_category / update_settings
   │
   ├─ 先 clone 一份「变更前」的快照（失败时回滚用）
   ├─ 改内存
   └─ commit(before)
        ├─ save()
        │   ├─ snapshot_current()      读盘
        │   ├─ 指纹比对               不一致 → ExternalChange，拒绝写
        │   ├─ rotate_backup()        当前文件结构完好才占用 .bak.1 槽位
        │   └─ save_v3()
        │         ├─ 序列化明文（Zeroizing）
        │         ├─ seal_body(DEK)   新 nonce
        │         ├─ 组装 VaultFileV3
        │         └─ write_atomic     tmp → fsync → rename
        └─ 失败 → self.data = before
```

**关键设计**：`save()` 里"读盘 + 指纹比对 + 备份轮转 + 写盘"这四步是固定的，
所有变更入口都走同一条路。新增一个变更方法时，只要调 `self.commit(before)` 就自动获得
回滚 + 外部改动检测 + 备份轮转。

---

## 4. 磁盘格式

### v3（新建默认）

```json
{
  "format": "keynest.v3",
  "kdf":    { "algo": "argon2id", "m_cost": 65536, "t_cost": 3, "p_cost": 1, "salt": "…16B b64…" },
  "dek":    { "algo": "xchacha20-poly1305", "iv": "…24B…", "tag": "…16B…", "wrapped": "…32B 密文…" },
  "cipher": { "algo": "xchacha20-poly1305", "iv": "…24B…", "tag": "…16B…" },
  "updatedAt": "2026-11-01T05:42:49.123Z",
  "payload": "…base64(正文密文)…"
}
```

- `kdf` 描述 **KEK** 的派生参数，与正文无关
- `dek` 是被 KEK 包裹的数据密钥
- `cipher` + `payload` 是正文

**换主密码时只重写 `kdf` 与 `dek`**，`cipher`/`payload` 逐字节不变（有测试比对）。

### v2 / v1（只读）

结构相同但没有 `dek` 层，`kdf` 派生的密钥直接加密正文。
v1 用 `scrypt` + `aes-256-gcm`，v2 用 `argon2id` + `xchacha20-poly1305`。
`VaultFile` 带 `deny_unknown_fields`，所以把 v3 文件改成 v2 标签会直接解析失败。

### 正文

`payload` 解出来是一段 JSON：

```json
{ "version": 2, "createdAt": "…", "updatedAt": "…", "settings": {…}, "categories": ["网站", …],
  "entries": [ { "id": "…", "title": "…", "username": "…", "password": "…", "url": "…",
                 "category": "…", "notes": "…", "favorite": false, "createdAt": "…", "updatedAt": "…" } ] }
```

新增字段一律带 `#[serde(default)]`，且必须配一条"缺字段仍可解析"的测试。

---

## 5. 状态机

```rust
enum AppState {
    NoVault,                                    // 首次启动
    AlreadyRunning,                             // 另一个实例持有锁
    Locked { password, error, busy, restore },  // 锁屏（restore 是备份恢复入口）
    Unlocked { vault, data, last_activity, reveal, copy_banner },
}
```

迁移只发生在 `app.rs`。`views/*` 不直接改状态，只返回 `MainIntent` / `SettingsIntent` /
`EditIntent` / `LockIntent`，由 `apply_*_intent` 统一处理。

**好处**：视图层可以脱离 egui 单测（现有 16 项 GUI 测试都是纯逻辑），
状态迁移也只有一个地方需要读。

---

## 6. 意图（Intent）模式

```rust
// views/main_view.rs
pub enum MainIntent {
    None, Lock, OpenSettings, NewEntry, Edit(String), AskDelete(String),
    CopyPassword(String), CopyUsername(String), Reveal(String), HideReveal,
    SetFilter(Filter), SetSort(SortBy), NewCategory(String), Select(String),
    ToggleFavorite(String), Restore(String), Purge(String), EmptyTrash,
}
```

视图画完界面后返回一个值，`app.rs` 拿着它去改状态。视图里没有 `&mut App`，也没法偷改。

**新增交互的固定套路**：
1. 在对应 `*Intent` 里加一个变体
2. 视图里在点击时赋值
3. `app.rs` 的 `apply_*_intent` 加分支
4. 如果涉及持久化，走 `Vault` 的公开方法（不要直接改 `data`）

---

## 7. 错误模型

`VaultError` 的两个约束：

1. **`Display` 不含任何秘密**。所有变体要么是静态字符串，要么是"至少 N 位"这种参数化提示。
   底层库的错误只保留类型，不拼接原始数据。
2. **稳定的 `code()`**。`INVALID_PASSWORD` / `CORRUPT` / `EXTERNAL_CHANGE` … 供界面统一处理。
   内部文案可以改，code 不能随便改。

**错误语义**：解密失败统一是 `InvalidPassword`（不区分"密码错"与"密文被改"），
但**结构**损坏（长度、配对、base64）会在解密之前被识别为 `CORRUPT`——
这样"文件坏了"不会被伪装成"你密码打错了"。

---

## 8. 测试策略

| 层次 | 位置 | 数量 | 特点 |
| --- | --- | --- | --- |
| 单元 | `src/**` 内嵌 `mod tests` | 79 | 可访问私有函数 |
| 集成 | `tests/v3_lifecycle.rs` | 6 | 只走公开 API |
| 健壮性 | `tests/robustness.rs` | 6 | 随机垃圾 / 截断 / 字节翻转 |
| GUI 逻辑 | `app.rs` 等 | 16 | 不依赖 egui 渲染 |
| 截图 | `examples/shots.rs` | 9 张 PNG | 真实渲染，肉眼比对 |

CI 在 Windows / Ubuntu / macOS 三平台跑前三类；GUI 与发布构建只在 Windows。

---

## 9. 想加功能时改哪里

| 想加的东西 | 落点 |
| --- | --- |
| 新的条目字段（如 TOTP） | `Entry` + `serde(default)` + 兼容测试 + 导出映射 |
| 新的筛选 | `Filter` 枚举 + `main_view` 过滤闭包 + 胶囊 |
| 新的设置项 | `Settings` + 设置页对应分区 + `update_settings` |
| 新的加密格式 | 新 `VaultFileVN` + `AnyFile` 分支 + `validate_header_vN` + 迁移函数 |
| 新的导入格式 | `portable.rs` 加解析函数，接到 `detect_and_import` |
| 新的界面 | `views/` 加文件 + `*Intent` + `app.rs` 分支 |

---

## 10. 刻意没做的事

- **没有 trait 抽象存储后端**：目前只有一个本地文件，过早抽象只会增加阅读成本。
- **没有引入异步运行时**：Argon2 用一条工作线程 + `mpsc` 就够，`tokio` 的复杂度不值。
- **没有全局可变状态**：所有状态都在 `App` 里，测试可以直接构造。
- **没有自研密码学**：全部走 RustCrypto，一行都没自己实现。
