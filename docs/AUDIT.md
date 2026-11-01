# 钥巢 KeyNest 项目审计报告

- 审计日期：2026-11-01
- 审计对象：`G:\Scripts\keynest`（工作区当前状态，含未提交改动）
- 审计方式：逐行阅读源码 + 实际编译运行测试 + 依赖树核对
- 审计范围：`rust/keynest-core`、`rust/keynest-egui`、`src/`（Electron 遗留）、`.github/`、根目录文档
- 结论基础：**本文所有缺陷均给出文件与行号，均可对照源码复现**

> 本报告**不是**第三方独立安全审计。它由项目开发过程内的代码审查产生。
> 在获得独立审计之前，README 与官网不应出现「已通过安全审计」一类表述。

---

## 0. 执行摘要

### 0.1 实测状态

| 项目 | 结果 | 命令 |
| --- | --- | --- |
| 工具链 | rustc 1.99.1 / cargo 1.99.1 (msvc) | `rustc -V` |
| 核心库单元测试 | **26 通过 / 0 失败**，耗时 57.7s | `cargo test -p keynest-core --lib` |
| GUI 纯逻辑单元测试 | **14 通过 / 0 失败** | `cargo test -p keynest-egui --lib` |
| Clippy（`-D warnings`） | **失败**：`vault.rs:456` `manual_range_contains` | `cargo clippy --workspace --all-targets -- -D warnings` |
| CI（GitHub Actions） | **不测试 Rust**，仅跑 Node 测试 | `.github/workflows/ci.yml` |
| 网络依赖（Rust） | **零**（依赖树无 reqwest/hyper/ureq/socket） | `cargo tree -p keynest-core --depth 1` |
| 日志泄漏（库代码） | **未发现**（`src/` 无 println/dbg/log） | `grep` |

### 0.2 一句话结论

**加密内核的设计方向是对的，实现质量高于多数个人项目；但「产品级」还差三块：数据完整性保障（备份不可恢复、多实例无锁、无回滚检测）、文档与代码不一致、以及 Rust 侧功能与 CI 的完整度。**

具体地：

- v2 格式（Argon2id + XChaCha20-Poly1305 + AAD 绑定 + 零化 + 原子写）**没有发现可导致密码明文泄漏的实现缺陷**。
- 但存在 **2 个会造成用户数据丢失的真实缺陷**（`.bak` 写了却从不读；无单实例锁）、**1 个可被文件投毒触发的内存耗尽**（scrypt 参数上界乘积未约束），这些在密码管理器里属于必须优先修的类别。
- README / SECURITY.md 描述的仍是**旧的 scrypt + AES-256-GCM** 架构，与当前代码不符，且仍宣称 `contextIsolation`/CSP 等已不存在的 WebView 防护。

### 0.3 严重度分布

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| 严重安全问题（S） | 4 | 数据丢失 / 资源耗尽 / 密钥可落盘 / 恢复能力缺失 |
| 高风险问题（H） | 6 | 密钥架构、格式绑定、文档误导、CI 缺口、功能回归 |
| 一般问题（M/L） | 15 | 见第 3 节 |
| 架构优化建议 | 7 | 见第 4 节 |
| UI/UX 建议 | 10 | 见第 5 节 |

---

## 1. 项目现状（审计对象事实）

### 1.1 存在两套实现

仓库里同时躺着三代产物，这是当前最大的「项目认知负担」：

| 代 | 位置 | 状态 |
| --- | --- | --- |
| Electron / Node | `src/`、`test/*.js`、`package.json`、`dist/` | **功能最完整**（导入/导出/CLI/浏览器库解析），仍可构建 |
| Tauri | `rust/keynest-app/` | 已在工作区删除（`git status` 显示为未提交的 D 状态） |
| egui（当前主线） | `rust/keynest-core` + `rust/keynest-egui` | 最新，**功能最少** |

`git log` 显示演进路径：`Electron → Tauri → egui`。问题在于：**功能是递减的**。Electron 版有 CSV 导入、明文导出、浏览器库读取、CLI；egui 版这些**全部消失**，且没有等价替代。

### 1.2 模块划分（egui 主线）

```
rust/
├─ Cargo.toml                 workspace，release = strip+lto+opt-level=z+panic=abort
├─ keynest-core/              纯逻辑，无 UI 依赖（13 个直接依赖，全部主流维护中）
│  ├─ vault.rs     (1204)     格式 / KDF / AEAD / 原子写 / CRUD  ← 过于臃肿
│  ├─ secure.rs    (308)      Win32 剪贴板 + 系统闲置
│  ├─ password.rs  (203)      生成 + 强度估算
│  ├─ paths.rs     (76)       数据目录解析
│  ├─ error.rs     (93)       错误类型（已做脱敏）
│  └─ lib.rs       (38)
└─ keynest-egui/              eframe 0.37 应用
   ├─ app.rs       (1142)     状态机 + 意图分发
   ├─ views/*.rs   (1608)     lock / main_view / edit / settings
   └─ ui/*.rs      (1093)     theme / icons / anim / clipboard / fonts / winchrome
```

### 1.3 依赖健康度

`keynest-core` 直接依赖：`serde` `serde_json` `argon2 0.5` `scrypt 0.11` `chacha20poly1305 0.10` `aes-gcm 0.10` `getrandom 0.2` `zeroize 1` `base64 0.22` `thiserror 2` `chrono 0.4` `uuid 1` `windows 0.58`。

- 全部为 RustCrypto / dtolnay / serde 生态，**无自研算法、无小众密码学 crate**，符合要求。
- **问题**：`getrandom 0.2` 已被 0.3 取代（0.2 仍在维护但属旧线）；`windows 0.58` 已落后（当前 0.6x）。均不构成安全缺陷，属维护性债务。
- `aes-gcm` 与 `scrypt` 仅为**读取 v1 旧库**而保留，见 2.2-H3 的取舍说明。

---

## 2. 严重与高风险问题

### 严重（S）—— 必须在本轮修掉

---

#### S1. 备份文件写了却从不读取：`.bak` 是死数据

**证据**

- `vault.rs:786-792`：每次 `save()` 把当前 `vault.dat` 复制成 `vault.dat.bak`。
- `vault.rs:663-667`：`backup_path()` 生成路径。
- `vault.rs:928`：`wipe()` 删除它。
- `vault.rs:1174`：测试只断言「文件存在」。

全仓库检索 `backup_path` 只有这 4 处。**没有任何代码路径读取 `.bak`**。

**影响**

用户在 README 里看到「自动备份」（`README.md:26`），会认为库损坏时能恢复。事实上：

1. 库文件一旦损坏（磁盘坏道、同步工具截断、误编辑），应用只会报「主密码错误，或仓库文件已损坏」。
2. 用户**没有任何恢复入口**，只能手工去 `%LOCALAPPDATA%\KeyNest` 找 `.bak` 并改名——文档里没写这个操作，普通用户不可能知道。
3. 对本项目「用户完全拥有自己的数据」的定位，这是最直接的信任破坏。

**修复方案**

- 在核心层新增 `Vault::restore_from_backup() -> Result<VaultData>`：先校验 `.bak` 可解密，再原子替换主文件，替换前把当前损坏文件另存为 `vault.corrupt-<时间戳>`。
- 解锁失败且 `.bak` 存在时，UI 必须提示「检测到可用的上一版备份，是否恢复？」并展示备份时间。
- 备份轮转：保留最近 N 份（建议 5），命名 `vault.dat.bak.1..N`，避免单份备份被下一次保存覆盖。

**验收标准**

- 新测试：`backup_restore_roundtrip`、`corrupt_main_with_good_backup_recovers`、`corrupt_main_with_corrupt_backup_reports_cleanly`。
- 手工验收：删除/破坏 `vault.dat` 后，GUI 出现恢复引导，恢复后条目数与备份时刻一致。

---

#### S2. 缺少单实例锁与外部修改检测 → 并发写导致静默丢数据

**证据**

- 检索 `CreateMutex` / `LockFileEx` / `flock` / `try_lock` / `single_instance`：**零命中**。
- `save()`（`vault.rs:758-797`）无锁地执行「copy → write tmp → rename」。
- `unlock()`（`vault.rs:713-744`）直接读文件，不比对 `updated_at`、不做哈希校验。

**影响**

场景 A（多实例）：用户双击两次图标（或从「开始菜单 + 任务栏」各启动一次），两个进程各自持有整库明文副本。在 A 里改条目并保存，再在 B 里改另一条目并保存 → B 的写入基于旧快照，**A 的修改被整体覆盖且无任何提示**。这是密码管理器最不可接受的失效模式。

场景 B（外部修改）：用户用同步盘、编辑器或另一台机器上的备份覆盖 `vault.dat`；已解锁的进程感知不到，下一次保存直接覆盖回去。

场景 C（崩溃/断电窗口）：无锁时，进程被强杀在 rename 前后不会自检，下次启动读到的是「上一版或新版」，用户无从判断丢了什么。

**修复方案**

1. 应用启动时对 `vault.dat` 旁创建并独占 `vault.lock`（Windows `LockFileEx`，跨平台 `fs2`/`fd-lock`）。取不到 → 提示「钥巢已在运行」并激活已有窗口（不进入只读模式，除非明确做只读）。
2. `Vault` 记录解锁时的 `(mtime, len, sha256)`；`save()` 前重新计算，不一致则返回 `VaultError::ExternalChange`，UI 提示「文件已被其他程序修改」并提供「用内存数据覆盖 / 重新加载」二选一。
3. 退出路径保证释放锁（`Drop`）。

**验收标准**

- 新增测试 `second_instance_is_refused`、`external_modification_blocks_save`。
- 手工验收：两个实例无法同时解锁；外部改动后保存被拦截。

---

#### S3. scrypt 参数「乘积」未约束：可被投毒文件逼出 4 GiB 分配

**证据**

- `vault.rs:73-76`：`SCRYPT_LOG_N_MAX = 20`、`SCRYPT_R_MAX = 32`、`SCRYPT_P_MAX = 4`。
- `vault.rs:430-449`：`scrypt_params_of` 对 `log_n`、`r`、`p` 分别校验，**没有校验 `128 · N · r` 的总内存**。
- 计算：`128 × 2^20 × 32 = 4 GiB`（实测确认）。

对照 Argon2 侧（`vault.rs:451-466`）只有 `m_cost` 单参数，天然受 `ARGON2_M_COST_MAX = 1 GiB` 约束，反而更安全。

**影响**

攻击者只需（或借助被投放/被同步覆盖的 `vault.dat`）提供一个 v1 格式文件，即使用户输入正确主密码，进程在 `scrypt::scrypt` 里尝试分配 4 GiB → 分配失败 panic / 系统整体换页卡死。因为 `[profile.release] panic = "abort"`（`rust/Cargo.toml:10`），panic 直接终止进程，不给 UI 报错机会。

这条也能被「不小心把某个巨大文件命名为 vault.dat」触发，属于可用性事故。

**修复方案**

```rust
// 128 * N * r 必须 <= 256 MiB
const SCRYPT_MEM_LIMIT: u64 = 256 * 1024 * 1024;
let mem = 128u64 * n * r as u64;
if mem > SCRYPT_MEM_LIMIT { return Err(VaultError::Malformed("scrypt 内存超限")); }
```

同时把 `ARGON2_M_COST_MAX` 从 1 GiB 降到 256 MiB（新建库用 64 MiB，留 4 倍余量已足够）。

**验收标准**

- 新增测试：构造 `N=2^20, r=32` 的 v1 文件，`unlock` 返回 `CORRUPT`（`Malformed`），**且不分配内存**。
- Fuzz 目标：随机篡改 header 任意字段，断言永不 panic、永不超大分配。

---

#### S4. 解密密钥与明文可被写进页面文件 / 休眠文件 / 崩溃转储

**证据**

- 检索 `VirtualLock` / `mlock` / `madvise`：**零命中**。
- 密钥仅由 `Zeroizing<[u8; 32]>` 持有（`vault.rs:469-505`），`Zeroizing` 只在 **drop 时**擦除。
- 明文 `VaultData`（含全部密码 `String`）常驻堆，直到锁库。

**影响**

1. Windows 默认允许把进程工作集换出到 `pagefile.sys`；启用休眠时整份物理内存写入 `hiberfil.sys`。两者都是**明文磁盘拷贝**，`Zeroizing` 完全无效——它擦的是原地址，不是已经落到磁盘的副本。
2. 进程崩溃时 WER 可生成含内存的 dump。
3. 因此「密码只存在内存里」这句话在当前实现下**不成立**。

这不算「实现 bug」，但对「专业级」定位是必须补的一环，且修复成本低。

**修复方案**

- 新增 `keynest-core::memlock`：Windows 用 `VirtualLock`/`VirtualUnlock`，Unix 用 `mlock`/`munlock`；对存放密钥的结构做一次性锁定，并在锁库时解锁。失败不致命（记录降级原因，设置页可显示）。
- 明文 `VaultData` 无法整体锁定（堆碎片），至少锁定密钥块与 `Zeroizing` 缓冲区，并在文档里**如实说明剩余风险**。
- 建议在设置页提供「禁用休眠提示」说明，而不是替用户改系统设置。

**验收标准**

- 单元测试可断言 `lock_key_memory()` 返回 `Locked` 或 `Unsupported`（不 panic）。
- `THREAT_MODEL.md` 明确「换页/休眠/转储」为已缓解但非完全消除。

---

### 高风险（H）

---

#### H1. 无 DEK/KEK 分离：主密钥即数据密钥

**证据**：`vault.rs:701`、`vault.rs:767`——`derive_key` 的结果直接喂给 `seal()`。全文无 data-encryption-key 概念。

**影响**

- 改主密码必须整库重加密（`change_master`，`vault.rs:866-892`），库越大越慢越危险（写到一半失败就是风险窗口）。
- Argon2 参数无法独立升级：想提高 `m_cost` 必须重建密钥、重加密。
- 无法实现「同一把数据钥匙、多把解锁钥匙」（未来 Passkeys / 硬件密钥的前提）。

**修复**（属于格式 v3，必须走迁移）

```
master ──Argon2id──> KEK ──XChaCha20-Poly1305 包裹──> DEK(32B 随机)
                                                       │
                                              XChaCha20-Poly1305 加密 vault body
```

- DEK 随机生成一次，只被 KEK 包裹后落盘；改主密码只重包裹 DEK（毫秒级）。
- `header.wrapped_dek` + `header.kek{aad}` 进 AAD 链，任一改动即失败。
- 迁移必须：先写 `vault.dat.v3.tmp` 校验通过 → 备份旧文件为 `vault.dat.v2.bak` → 原子替换 → 记录迁移日志。**不可原地覆盖**。

**优先级说明**：这不是「现在有洞」，而是「不先做，后面每加一个功能都要付利息」。建议放在 S1–S4 之后、P1 功能之前。

---

#### H2. `format` 字段既未认证也不参与分发，版本契约形同虚设

**证据**

- `vault.rs:414-423`：`aad_v2` 只绑 `algo|m|t|p|salt`，不含 `format`，也不含 `cipher.algo`。
- `vault.rs:728-731`：`unlock` 接受 `FORMAT_V1` 或 `FORMAT_V2`，但之后 `open()` 是按 `cipher.algo` 分发的。
- `vault.rs:769-773`：`save()` 又从 `kdf.algo` **重算** `format`，等于承认这个字段不可信。
- `VaultData.version`（`vault.rs:283`）从未被校验，反序列化 `version: 99` 也会通过。

**影响**

把 v2 文件的 `"format"` 改成 `"keynest.v1"`，库仍能正常打开（`kdf.algo` 仍是 argon2id、`cipher.algo` 仍是 xchacha）。当前不会导致解密错误，但：

- `is_legacy()`（`vault.rs:683-685`）看的是 `kdf.algo` 而不是 `format`，两套判据并存。
- 任何未来**基于 `format` 做分支**的迁移代码都会被这个字段欺骗。
- 版本号没有单调约束，无法支撑「可升级的加密文件格式」这条要求。

**修复**

- `format` 与 `cipher.algo` 一并进 AAD。
- 增加一致性校验：`format == v2 ⇒ (kdf.algo == argon2id ∧ cipher.algo == xchacha20-poly1305)`，否则 `Malformed`。
- `VaultData.version` 与 `format` 建立显式映射，读到未知版本直接拒绝而不是「尽力解析」。
- 加 `#[serde(deny_unknown_fields)]`，让拼写错误的字段立刻暴露，而不是被静默忽略。

---

#### H3. 无 KDF 下限策略：v1 降级解锁不会触发任何强提示

**证据**：`vault.rs:713-744` 对 v1 文件一路放行；`is_legacy()` 仅用于设置页显示一个「升级」按钮（`views/settings.rs`）。

**影响**

攻击者若能替换 `vault.dat`（见 S2 场景 B），可投放一个 scrypt 版本诱导用户继续使用弱 KDF；用户看到的只是设置页一行小字。对「安全优先」的产品，降级必须是**显式且带阻断**的。

**修复**

- 定义 `KdfPolicy`：`minimum = Argon2id(m≥64MiB, t≥3)`。达不到时，解锁后**强制弹出**「此库使用了已弃用的密钥派生，是否立即升级？」且默认按钮为「升级」。
- 新库一律 v2，并禁止 `create()` 走 scrypt 分支（现在其实已经做不到，但代码保留了两条 seal 路径，属于可被误用的面）。
- v1 读取路径标注 `#[deprecated]` 并设定移除版本（例如 1.0 后删除 `scrypt`/`aes-gcm` 依赖）。

---

#### H4. 文档描述的是旧架构，与代码不符（信任问题）

**证据**

| 文档 | 现在写的 | 代码实际 |
| --- | --- | --- |
| `README.md:19,35` | scrypt + AES-256-GCM | Argon2id + XChaCha20-Poly1305（`vault.rs:49-52`） |
| `README.md:82-84` | scrypt(N=2^17,r=8,p=1) → AES-GCM | 同上 |
| `README.md:108` | 主密码「强制至少 8 位」 | `MIN_MASTER_LEN = 12`（`vault.rs:59`） |
| `SECURITY.md` 威胁模型 | 宣称 `contextIsolation` + 沙箱 + CSP `default-src 'none'` 防 XSS | **没有 WebView 了**，egui 原生渲染，这些防护不存在也不需要 |
| `SECURITY.md` 表格 | 全部指向 `src/main/vault.js` | 应对应 `rust/keynest-core/src/vault.rs` |

**影响**

开源安全项目里，文档与代码不一致比「文档写得少」危险得多：安全研究者会照着 SECURITY.md 去审一份不存在的实现。它还直接违反任务书里「不要宣称通过了安全审计」的精神——现在是宣称了一套**不存在的**安全设计。

**修复**

- 以代码为准重写 README 的「安全设计」、SECURITY.md 的「加密设计 / 威胁模型」。
- SECURITY.md 增加一节「已废弃设计（v1）」，明确 v1 只读兼容。
- 文档纳入 CI 检查：README 里出现的算法名/参数必须能在 `vault.rs` 常量里找到（可做一个简单脚本比对关键字）。

---

#### H5. CI 完全不测 Rust，且当前 Clippy 门禁是红的

**证据**

- `.github/workflows/ci.yml` 是 Electron 时代的产物：只装 Node、只跑 `node test/*.js`，**没有任何 Rust 步骤**。
- 本地执行 `cargo clippy --workspace --all-targets -- -D warnings` → 1 个 error（`vault.rs:456`）。
- 无 `cargo fmt --check`、无 `cargo audit`/`cargo deny`、无 Windows/macOS/Linux 矩阵构建、无 fuzz。

**影响**：主线的 40 个测试和「Clippy 干净」这个承诺，目前**没有任何自动保障**。

**修复**（第六阶段主体）

```yaml
jobs:
  rust:
    strategy: { matrix: { os: [windows-latest, ubuntu-latest, macos-latest] } }
    steps: [checkout, rust-toolchain(stable, components: clippy,rustfmt),
            cargo fmt --check,
            cargo clippy --workspace --all-targets -- -D warnings,
            cargo test --workspace,
            cargo build --release -p keynest-egui]
  audit: [cargo-deny check bans licenses sources]
  fuzz:  [cargo fuzz run header -- -runs=200000]   # 见 M10
```

**验收**：PR 上三个 OS 全绿；Clippy 必须零 warning；`cargo fmt --check` 通过。

---

#### H6. Rust 版功能相对 Electron 版是**倒退**的

**证据**（关键词全文检索，`rust/` 排除 target/examples）

| 功能 | Electron 版 | Rust 版 | 检索结果 |
| --- | --- | --- | --- |
| CSV / JSON 导入 | ✅ `src/main/browser-import.js` | ❌ | `Import` 0 命中 |
| 明文导出 | ✅ `src/main/export.js` | ❌ | `Export` 0 命中 |
| 浏览器密码库读取 | ✅ `login_data`/`sqlite` | ❌ | — |
| CLI | ✅ `src/cli/keynest-cli.js` | ❌ | — |
| 加密备份 / 恢复 | 部分 | ❌（且见 S1） | — |
| 引导流程 | ✅ `onboard` | ❌ | — |
| 收藏 | ❌ | ❌ | `favorite`/`收藏` 0 |
| TOTP | ❌ | ❌ | `totp` 0 |
| 自定义字段 | ❌ | ❌ | 无 |
| 密码修改时间 | ❌ | ❌ | `Entry` 无该字段 |

`Entry`（`vault.rs:238-250`）只有 9 个字段：`id/title/username/password/url/category/notes/created_at/updated_at`。

**影响**：迁移到 egui 的过程中，用户手上已有的库**无法导出到别处**。对一个「数据属于用户」的产品，导出缺失是不可接受的单点；同时任务书 P0 里的「加密备份、数据恢复」「收藏」都还没有。

**修复顺序**：先做 `S1 + 导出（CSV/JSON）+ 加密备份`，再做 TOTP 等 P1。

---

## 3. 一般问题

| ID | 问题 | 证据 | 影响 | 修复 |
| --- | --- | --- | --- | --- |
| M1 | 主密码比较非常量时间 | `vault.rs:877` `old_key != current` | 本地计时侧信道，理论性 | 用 `subtle::ConstantTimeEq` |
| M2 | 错误码可区分「坏文件」与「密码错」 | `vault.rs:735-738` → `InvalidPassword` vs `Malformed`→`CORRUPT` | 本地攻击者的小 oracle | 对外统一为一条文案，内部 code 仅日志用（且日志不落盘） |
| M3 | `save()` 每次全量重加密 + 复制备份 | `vault.rs:758-797` | 1000 条以上明显卡顿；`.bak` 每次被覆盖 | DEK（H1）后可只重写 body；备份轮转（S1） |
| M4 | `.bak` 可能复制到损坏文件 | `vault.rs:786-792` 无条件 copy | 一个坏文件污染唯一备份，放大 S1 | 复制前先校验可解密，或保留多代（S1） |
| M5 | `write_atomic` 未 fsync 目录 | `vault.rs:361-373` | 断电后 rename 的目录项可能不持久 | Windows `FlushFileBuffers` on dir handle；其他平台 `sync_all` 目录 |
| M6 | `wipe()` 用 `remove_file` 且忽略错误 | `vault.rs:925-931` 全部 `let _ =` | SSD/CoW 上数据可恢复；删除失败用户不知情 | 返回逐项结果；文档如实说明「无法保证物理擦除」 |
| M7 | 明文多副本：`Vault.data` 与 `AppState.data` 双份 | `app.rs:76-83`；`app.rs:524-527` 每次改动用 `snapshot()` 全量 clone | 峰值 ≥2 份全库明文；换页风险倍增 | 单一数据源（要么 App 只持 `Vault`，要么 `Vault` 只持加密态）；`snapshot` 改为 diff 返回 |
| M8 | `Entry::drop` 只擦 `password`/`notes` | `vault.rs:257-262` | `title/username/url` 同为敏感信息 | 一并 `zeroize`（成本极低） |
| M9 | 内存文件大小无上限 | `vault.rs:714-726` `read_to_string` + `from_str` | 巨文件 → 内存暴涨 | 读取前 `metadata().len()` 上限（如 64 MiB） |
| M10 | 无 fuzz，无「截断/翻转字节」整库测试 | `vault.rs:1101-1118` 只测了 nonce 长度 | 「损坏后不安全行为」未覆盖（任务书第三阶段第 8 条） | `cargo-fuzz`：header 解析 + payload 位翻转 + 截断 |
| M11 | Argon2 `p_cost` 允许 >1 | `vault.rs:69` | 单线程派生，`p>1` 只增延迟无收益 | 启动时把 `p_cost` 规范化为 1（或真正多线程） |
| M12 | `replace_data()` 是无校验的公共后门 | `vault.rs:838-840`，全仓库零调用 | 将来误用可绕过 `upsert` 的所有校验 | 删除，或标 `#[doc(hidden)]` + 仅测试可见 |
| M13 | `Settings.import_prompted` 是 Electron 遗留死字段 | `vault.rs:222-223` | 混淆格式演进 | 保留兼容读，v3 迁移时移除 |
| M14 | `estimate_strength` 只按「字符类是否出现」估算 | `password.rs:104-126` | 截图里 `85 bit` 对弱密码会给出虚高数字（如 `Password1!` 约 52 bit 但长相像强密码） | 标注为「粗估」并改用 zxcvbn-rs 或至少加入常见口令黑名单 |
| M15 | 示例程序把密码打到 stdout | `examples/compat.rs:25`；`examples/seed.rs:21-26` 含明文样例密码 | 示例数据是假的，但习惯危险；误用打印真实库即泄漏 | 示例改为 `<redacted>` 输出；seed 明确标注 fake |

---

## 4. 架构优化建议

**A1. 拆分 `vault.rs`（1204 行，5 种职责）**
`format.rs`（结构与 serde）/ `crypto.rs`（KDF+AEAD，纯函数）/ `store.rs`（路径、原子写、备份轮转、锁）/ `repo.rs`（CRUD+设置）/ `vault.rs`（门面）。当前它同时是「格式定义」「密码学」「文件系统」「业务 CRUD」「测试夹具」，任何改动都要重跑 58 秒的测试。

**A2. 单一数据源**
`AppState::Unlocked { vault, data }` 是双份真相。改为 `Unlocked { vault }` + `vault.view() -> &VaultData`，或 `Unlocked { data, key }` 让 `Vault` 只负责加解密。这一步同时修掉 M7。

**A3. 引入显式的 `VaultHeader` 版本枚举**
用 `enum Header { V1(V1Header), V2(V2Header), V3(..) }` 取代 `Option<u64>` 满天飞的 `KdfParams`。当前 `n/r/p` 与 `m_cost/t_cost/p_cost` 共存靠 `Option` 加运行时 `ok_or`，是「结构合法但字段非法」类错误的温床。

**A4. 迁移框架**
现在 `upgrade_to_v2` 是硬编码的一次性函数。建议 `migrations: [fn(&mut Store) -> Result<()>]` + `schema_version`，每步可单独测试，且每步强制「先备份、后替换、可回滚」（对齐任务书第八阶段第 12 条）。

**A5. `Result` 分层**
`VaultError` 目前既含 IO 又含 UI 文案（`#[error("主密码至少 {0} 位")]`）。建议核心只出 `code`，文案留在 `keynest-egui/i18n`。将来做多语言与 CLI 复用都要靠这一步。

**A6. 跨平台边界要显式**
`secure.rs:216-235` 非 Windows 直接返回「当前平台不支持安全剪贴板」，意味着 macOS/Linux 上复制密码功能整体不可用。要么实现（macOS `NSPasteboard` + `org.nspasteboard.ConcealedType`，Linux `wl-copy`/`xclip`），要么在 `Cargo.toml` 就声明 Windows-only 并让 CI 只构建 Windows。现在是「能编译但功能残废」的中间态，最差。

**A7. 恢复 Rust CLI**
Electron 的 `keynest-cli.js` 提供 scan/import/guide，是「从浏览器迁移」的关键路径。Rust 侧应有一个 `keynest-cli` crate（复用 core），并复用同一套 `VaultError::code()`。

---

## 5. UI / UX 改进建议

现有界面（`docs/ui/03-main.png`）已达到相当水准：单一强调色、胶囊式筛选、行高 46px、悬停才出操作、详情右侧 400px、浅/深双主题、标题栏同步。以下是差距项，按「用户可感知」排序。

**U1. 缺失的安全反馈（最重要）**
解锁失败时目前只有一句错误文案。应区分并给出可操作建议：密码错（提示检查 CapsLock/输入法）vs 文件损坏（提示可恢复备份，联动 S1）。**不要**泄漏判定细节给攻击者，但**要在 UI 上让用户能自救**——两者可以通过「本地日志 + 用户可见的模糊提示 + 详细帮助页」同时满足。

**U2. 主密码强度反馈缺失**
创建库（`views/lock.rs`）只校验长度 12。应加实时强度条 + 明确文案「建议 4 个以上不相干单词」，并在 `validate_new_master` 里加入常见弱口令黑名单。

**U3. 无收藏**
P0 要求。`Entry` 加 `favorite: bool`（serde default 保证旧库可读），列表置顶分组 + 筛选胶囊加「收藏」。

**U4. 无导入 / 导出 / 备份入口**
设置页现在只有：自动锁定、剪贴板、显示时长、主题、改主密码、升级格式、清空仓库。缺「导入 / 导出 / 备份 / 恢复」四件套，而这四件是用户评估「我的数据自由吗」的**唯一依据**。

**U5. 长分类名截断无提示**
截图里「这是一个特别长的分类…」被截断且无 tooltip。`on_hover_text` 一行即可。

**U6. reveal 倒计时不可见**
`reveal_seconds` 到期自动隐藏，但界面不显示剩余时间，用户以为「点了没反应」或「一直显示」。应在密码行尾显示 `12s` 倒计时条。

**U7. 删除无「最近删除」**
`delete_entry` 立即落盘（`app.rs:548-568`）。误删不可逆。建议软删除（`deleted_at: Option<String>`）+ 回收站视图，30 天后真正清除。

**U8. 无空状态引导**
新库首次进入是空白列表。应有「+ 添加第一条」+ 「从浏览器导入」两条引导（Electron 版有 onboard，Rust 版丢了）。

**U9. 设置项缺少解释**
「自动锁定 5 分钟」不说明是「应用闲置」还是「系统闲置」。实际实现是两者取小（`app.rs:52-60`），这个细节恰恰是用户信任感的来源，应写出来。

**U10. 无障碍**
egui 对屏幕阅读器支持有限，至少保证：所有图标按钮有 `on_hover_text`、Tab 键焦点顺序合理、快捷键有 discoverable 入口（设置页列出全部快捷键，现在 README 有但软件内没有）。

---

## 6. 值得保留与肯定的部分

审计不能只有问题。以下设计判断正确，改造时应保护：

1. **AAD 绑定 KDF 参数与盐**（`vault.rs:414-423`），并把原实现的 `unwrap_or_default()` 改成显式报错（`vault.rs:410`）——这个修复很关键，否则序列化失败会静默关闭参数绑定。
2. **每次保存换随机 nonce，且用 192 位 XChaCha nonce**（`vault.rs:518-521`），从根上消除 GCM 96 位 nonce 的生日问题。
3. **`Nonce::from_slice` 前显式校验长度**（`vault.rs:589-597`），把 panic 变成 `Malformed`——这类「畸形文件不得 panic」的处理在密码软件里是硬要求。
4. **手写 `Debug` 全区脱敏**（`vault.rs:157-171, 181-189, 202-212, 265-279, 306-317`），并有测试兜底（`vault.rs:1151-1165`）。这是很多同类项目栽跟头的地方。
5. **随机源统一到 `getrandom` + 自实现拒绝采样**（`password.rs:50-64`），消除取模偏差，且失败返回 `Result` 而非 panic。
6. **剪贴板：写入时标记不进历史/不上云，清除前回读校验**（`secure.rs:132-186`）——「不误删用户已复制的其他内容」这个细节做得比多数商业产品好；且有 `COPY_GENERATION` 处理新旧定时器竞争（`secure.rs:22, 252-263`）。
7. **自动锁定取「应用闲置」与「系统闲置」较小值**（`app.rs:52-60`），并在后台线程跑 Argon2 避免卡 UI（`app.rs:180-196`）——这是对的架构。
8. **意图（Intent）模式**：`views/*` 只画界面并返回 `enum XxxIntent`，状态迁移集中在 `app.rs`。这让 view 层可以无 UI 单测（现有 14 个测试即证明），应继续坚持并扩大。
9. **`paths.rs` 用 `%LOCALAPPDATA%` 而非 `%APPDATA%`**（`paths.rs:1-11`），并保留旧位置兼容——对漫游配置的理解是正确的。
10. **`.gitignore` 对 `vault.dat` / `*.csv` / 导出文件做了针对性排除**，属实战经验。

---

## 7. 升级路线图（第三阶段产出）

按「先安全、再功能、再体验」排序。每一项含：改动文件 / 原因 / 风险 / 验收。

### 阶段 A：数据完整性（P0，先做）—— ✅ 已完成

| # | 任务 | 文件 | 风险 | 验收 | 状态 |
| --- | --- | --- | --- | --- | --- |
| A1 | 备份轮转 + 校验 + 恢复 API + 界面入口 | `core/src/vault.rs`、`egui/src/views/lock.rs` | 中：误覆盖用户库 → 必须先备份再替换 | S1 三个测试 | ✅ |
| A2 | 单实例锁 + 外部修改检测 | `core/src/lockfile.rs`、`core/src/vault.rs`、`egui/src/app.rs` | 中：锁残留导致无法启动 → 用 OS 持有的锁，退出即释放 | S2 三个测试 + 跨进程实测 | ✅ |
| A3 | scrypt 内存上界 + 文件大小上限 + Argon2 上限收紧 | `core/src/vault.rs` | 低 | S3 测试 + fuzz（fuzz 留待 E） | ✅ |
| A4 | `VirtualLock` 密钥内存 | `core/src/keymem.rs` | 低：失败需降级不阻断 | S4 测试 + 本机实测 `is_locked()==true` | ✅ |
| A5 | 修 Clippy | `vault.rs:456` 等 3 处 | 无 | `cargo clippy -D warnings` 绿 | ✅ |
| A6 | `cargo fmt` 全仓库格式化 | 16 个文件 | 无（纯机械），但会淹没功能改动 | 独立提交，放在阶段 E | ⏳ |

### 阶段 B：格式与密码学（P0）—— ✅ 已完成

| # | 任务 | 风险 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | 格式 v3：DEK/KEK 分离 | 高：迁移必须可回滚、必须先备份、必须双写校验 | v2→v3 迁移测试；旧库仍可读；回滚演练 | ✅ |
| B2 | `format`/`cipher.algo` 进 AAD + 一致性校验 + `deny_unknown_fields` | 中：会拒绝历史上「字段拼错但能用」的文件 | 篡改 `format` 必须失败 | ✅（AAD 绑定见下注） |
| B3 | KDF 下限策略 + 强制升级提示 | 低 | 策略单测 | ⏳ 部分：设置页有显式升级入口，尚无「强制」策略 |
| B4 | 统一错误面（内部 code / 外部文案） | 低 | 错误文案不含秘密的测试 | ⏳ |

> **B2 的取舍**：`format` 本身没有进 AAD，而是靠 `deny_unknown_fields` + 格式/算法配对校验
> 达到同样的目的——把 v3 文件的格式标签改成 v2 会让 `dek` 字段变成非法成员，解析直接失败。
> 这样做的原因是正文 AAD 必须保持稳定（否则「只换包裹」无法实现），
> 而 KEK 的 AAD 已经绑定了格式串、算法与全部 KDF 参数。
> 换句话说：**改格式标签能让你打不开，但拿不到任何明文**。

### 阶段 C：功能补齐（P0 → P1）

C1 导出 CSV/JSON（含明文风险二次确认） → C2 加密备份（整库副本，独立口令可选） → C3 导入（Chrome/Edge CSV、KeyNest JSON） → C4 收藏 → C5 回收站 → C6 TOTP + 二维码 → C7 自定义字段 / 安全笔记 / 信用卡 / 身份 → C8 安全审计视图（弱/重复/过期） → C9 密码修改时间。

**进度**：C1 ✅ 明文导出（CSV 走 Bitwarden 通用列 / JSON 保真，二次确认弹窗）
· C2 ✅ 加密备份导出（读回逐字节校验）· C3 ✅ 导入（CSV 表头自适应 + JSON 三形态，只新增不覆盖）
· C4 ✅ 收藏 · C5 ✅ 回收站（软删除 + 恢复 + 永久删除）
· C6 ✅ TOTP（RFC 6238，含官方测试向量；二维码扫描待做）
· C7 ✅ 条目类型（账号/笔记/信用卡/身份）+ 自定义字段
· C8 ✅ 安全概览 · C9 ✅ 密码修改时间

**原则**：每加一个 `Entry` 字段，必须同时提供 `serde(default)`、旧库兼容测试、导出映射。绝不允许「加了字段导致旧库打不开」。

### 阶段 D：UI/UX

U1–U10，配合阶段 C 的功能入口一起做，避免「先做UI再补功能」造成返工。

**进度**：
- D0 ✅ 截图回归工具（`examples/shots.rs` → `docs/shots/*.png`，9 个场景）
- D1 ✅ 首轮视觉修复：清空回收站二次确认 / 设置窗口被切掉 / 标题栏灰板 / 删除时间
- D2 ✅ 设置页四分区（外观·安全·数据·危险）+ U2 主密码强度反馈；U6 显示倒计时已确认可用
- U1 ✅ 解锁错误面（按错误码给可执行建议）
- U3 ✅ 空状态引导（含"从浏览器导入"的入口提示）
- U4 ✅ 长分类名 tooltip
- U5 ✅ 快捷键清单页（只列真实绑定了的键）
- U7–U10 ✅（删除二次确认、清空回收站确认、设置项解释、关键按钮 hover 文案）

**阶段 D 完成。**

### 阶段 E：测试与 CI

单元 → 集成 → fuzz → 三平台矩阵 → `cargo-deny` → 覆盖率门槛（建议 core ≥ 80%）。

**进度**：E1 ✅ CI 三平台矩阵 + clippy 门禁 + fmt 全仓库格式化 + `cargo-deny` 四类检查
+ 健壮性测试（随机垃圾 / 截断 / 字节翻转 / 篡改密文 / 超大输入）。
E2 ✅ 覆盖率门槛（`cargo llvm-cov`，keynest-core 行覆盖实测 87.14%，门槛 85%）；
libFuzzer 目标 ⏳（需 nightly，见下）。
**关于 fuzz 的取舍**：libFuzzer 需要 nightly 工具链，本机只有 stable，无法在提测前验证。
因此先落地了**确定性**的变异测试（固定种子、可复现、能进 CI 的 stable 任务），
覆盖的失效模式与 fuzz 相同；覆盖导向的 libFuzzer 目标留到 E2，届时连同 nightly 任务一起加。

### 阶段 F：开源文档 —— ✅ 已完成

- README 全篇按实际实现重写（旧版描述的是 Electron 时代的 scrypt + AES-GCM 与 WebView 防护）
- SECURITY.md 重写：加密设计逐条指到源码，明确声明未经第三方审计
- 新增 `docs/THREAT_MODEL.md`（13 个场景 + 防得住/防不住对照表）
- 新增 `docs/ARCHITECTURE.md`（分层、数据流、格式规范、扩展点）
- CONTRIBUTING.md 重写为 Rust 工作流；新增 CODE_OF_CONDUCT.md
- 双许可证：`LICENSE-MIT` + `LICENSE-APACHE`，`license = "MIT OR Apache-2.0"`
- 文档链接自检 0 处失效

---

## 8. 本轮审计未覆盖的部分（诚实声明）

1. **未做动态分析**：没有在解锁状态下抓取进程内存、没有验证 `Zeroizing` 是否真的阻止了编译器优化消除（`zeroize` 有 `volatile` 屏障，理论上可靠，但未实测）。
2. **未审计 Electron 遗留代码的安全性**：`src/main/*.js` 仍在仓库中且 `package.json` 仍指向它。若打算保留，需要单独审计（尤其是 `browser-import.js` 读取浏览器 SQLite 的部分）；若打算废弃，应尽快移除，避免用户误用旧版。
3. **未做依赖 CVE 核查**：环境无 `cargo-audit` 离线库，未逐条比对 RUSTSEC。**这是阶段 E 的必做项**，不能以「本报告未发现问题」代替。
4. **未做第三方密码学审计**：本报告对 Argon2id/XChaCha20-Poly1305 的判断基于「使用了 RustCrypto 的正确 API」，不构成对算法实现本身的评估。
5. **未验证 Windows 剪贴板标记的实际效果**：`CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` 的行为随 Windows 版本与策略（组策略可忽略）变化，需在真实机器上验证「Win+V 里确实看不到」。
6. **未测性能基线**：未测 1000/10000 条目下的解锁与保存耗时，M3 的影响是推断而非实测。

---

## 9. 下一步

按用户要求「先审计、后修改」，**本轮未改动任何源码**。建议从 **阶段 A** 开始，因为：

- A1（备份可恢复）与 A2（不丢数据）直接决定用户敢不敢把真实密码放进来；
- A3/A4 是低成本高收益；
- A5 让后续每一次提交都有自动化门禁。

阶段 A 完成后即可交付一个「可以给真实用户试用」的版本，再进入 B/C。
