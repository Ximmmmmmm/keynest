# 安全策略

钥巢是一个本地密码管理器。这类软件的安全声明必须能被独立检验，所以本文只写**可验证的事实**，不写营销话术。

> **本项目没有经过第三方安全审计。**
> 下面的每一条都可以对着源码核对，但"能对照源码"不等于"被独立审计过"。
> 在拿到审计报告之前，请不要把它当成经过验证的保险箱。

---

## 报告漏洞

请**私下**报告，不要开公开 issue。

- 用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
- 或在 Issues 里开一个**不含细节**的 issue，只写「需要私下沟通安全问题」

报告里请包含：受影响版本、复现步骤、你认为的影响范围。

**响应预期**：这是个人维护的开源项目，不承诺 SLA。合理预期是 7 天内首次回复。
确认的问题会在 [CHANGELOG](CHANGELOG.md) 里记一条（不含利用细节），修好后再写细节。

### 什么样的报告最有价值

- 能让**未解锁**状态下拿到明文的东西
- 能让**错误主密码**被接受的东西（哪怕是概率性的）
- 能造成**静默数据丢失**的东西（保存后条目消失、备份覆盖好数据）
- 能绕过**单实例锁**或**外部改动检测**的东西
- 能在畸形 `vault.dat` 上触发 panic 或超大内存分配的东西

已知的形态限制（见 [THREAT_MODEL](docs/THREAT_MODEL.md)）不算漏洞，例如"同机恶意程序能读内存"。

---

## 加密设计（v3，当前默认）

```text
主密码 ──Argon2id(64 MiB, t=3, p=1, 16B 随机盐)──> KEK
                                                    │
                            XChaCha20-Poly1305（AAD 绑定格式/算法/KDF 参数/盐）
                                                    ↓
                                      包裹随机 32 字节 DEK
                                                    │
                              XChaCha20-Poly1305（每次保存换 24 字节随机 nonce）
                                                    ↓
                                                库正文
```

| 设计 | 位置 | 目的 |
| --- | --- | --- |
| 不存密码哈希 | `vault.rs::unwrap_dek` | 不额外泄露可离线爆破的校验值 |
| AAD 绑定 KDF 参数与盐 | `vault.rs::aad_dek` | 改动任意一项都会解不出 DEK，防降级 |
| DEK / KEK 分离 | `vault.rs::wrap_dek` | 换主密码只重新包裹 32 字节 |
| 每次保存换随机 nonce | `vault.rs::seal_xchacha` | 24 字节随机 nonce，碰撞可忽略 |
| KDF 参数上限 + 乘积约束 | `vault.rs::argon2_params_of` / `scrypt_params_of` | 防止畸形文件逼出超大内存分配 |
| 格式与算法成对校验 | `vault.rs::validate_header` | 改格式标签会直接解析失败 |
| 密钥页对齐 + `VirtualLock` | `keymem.rs` | 挡住换页 / 休眠 / 崩溃转储 |
| 敏感结构 `Drop` 清零 | `vault.rs`（`Entry`）、`keymem.rs` | 离开作用域即擦除 |
| `Debug` 手写脱敏 | `vault.rs`、`keymem.rs` | `{:?}` 不会打印密码或密钥 |

### 旧格式（只读）

- **v1**：scrypt(N=2^17, r=8, p=1) + AES-256-GCM，12 字节 nonce
- **v2**：Argon2id(64 MiB, t=3, p=1) + XChaCha20-Poly1305，24 字节 nonce

两者的读取路径保留，新建库一律写 v3。设置页可显式升级，升级前会留下可回滚副本。

---

## 运行期保护

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| 原子写入 | `vault.rs::write_atomic` | 临时文件 → `sync_all` → `rename` |
| 5 代备份轮转 | `vault.rs::rotate_backup` | 坏文件不会占用备份槽 |
| 外部改动检测 | `vault.rs::save_inner` | 比对 `(长度, updatedAt)`，不比对 mtime |
| 单实例锁 | `lockfile.rs` | 标准库 `File::try_lock`，进程退出即释放 |
| 剪贴板 TTL + 回读校验 | `secure.rs` | 只清自己写进去的内容 |
| 不进剪贴板历史 / 云同步 | `secure.rs` | `CanIncludeInClipboardHistory=0` 等 |
| 自动锁定 | `app.rs` | 取应用闲置与系统闲置的较小值 |

---

## 不在范围内的做法

以下做法本仓库**不会**实现，收到相关 PR 也会拒绝：

- 绕过 Chrome / Edge 的应用绑定加密（v20）或任何浏览器的凭据保护机制
- 注入、劫持或替换浏览器进程
- 伪造数字签名
- 任何形式的远程代码执行、遥测、或把密钥外传
- "找回主密码"后门

如果你需要自动化导入，本项目提供的是**浏览器官方导出 CSV → 导入**这条路径。

---

## 已知取舍

- **主密码无法找回**：不存任何恢复手段。这是设计选择，不是遗漏。
- **改主密码不会让旧备份失效**：旧备份里的包裹块仍由**旧**主密码保护。如果你怀疑密码泄露，改完密码后还要销毁旧备份。
- **明文不会立即消失**：Rust 的 `String` 在扩容时可能留下旧的堆片段，`zeroize` 只擦当前缓冲区。密钥已尽力处理，明文做不到彻底。
- **导出即明文**：CSV / JSON 导出是不加密的文件，程序只能提醒，无法保护它之后去哪。
- **面板字体的许可证**：egui 内置字体为 SIL OFL-1.1 / Ubuntu-font-1.0，随程序分发需保留许可证与署名。

---

## 支持版本

项目处于 0.x 阶段，只对最新版本修安全问题。
