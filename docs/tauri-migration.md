# Tauri 迁移设计

把 Electron 主进程迁到 Rust，界面（`src/renderer/` 4300 行）**完全不改**。

## 为什么要换

| | Electron | Tauri |
| --- | --- | --- |
| 安装包 | 98 MB | 约 10 MB |
| 内存 | 324 MB（实测） | 约 70 MB |
| 启动 | 0.36 s（实测） | 约 0.3 s |
| 运行时 | 自带 Chromium | 系统 WebView2 |

WebView2 本机已装（149.0.4022.69），用户侧零额外依赖。

## 模块映射

Electron 侧 `src/main/` 的 5 个文件，对应 Rust 侧的模块：

| Electron | Rust | 职责 |
| --- | --- | --- |
| `vault.js` (437 行) | `vault/mod.rs` | 加密仓库：scrypt + AES-256-GCM |
| `password.js` (126 行) | `password.rs` | 生成器与强度评估 |
| `browser-import.js` (442 行) | `browser/import.rs` | 读浏览器 Login Data、CSV 解析、去重 |
| `csv-discovery.js` (153 行) | `browser/discovery.rs` | 自动发现最近导出的 CSV |
| `export.js` (91 行) | `export.rs` | CSV / JSON 明文导出 |
| `main.js` (664 行) | `main.rs` + `commands.rs` | 窗口、IPC、自动锁定、剪贴板 |

## 关键依赖

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# 加密：与 Node crypto 同等成熟度
scrypt = "0.11"                    # 或 ring::pbkdf2
aes-gcm = "0.10"                   # RustCrypto，审计过的 AEAD
rand = "0.8"
base64 = "0.22"
zeroize = "1"                      # 密钥擦除，比 JS 的 fill(0) 更可靠

# Windows 系统集成（这是换 Rust 的主要收益之一）
windows = { version = "0.58", features = [
    "Win32_Security_Cryptography",   # DPAPI
    "Win32_Foundation",
    "Win32_UI_WindowsAndMessaging",
] }

# SQLite 读浏览器库
rusqlite = { version = "0.32", features = ["bundled"] }

# 其他
chrono = "0.4"
thiserror = "2"
```

## 加密实现要点

Node 版用 `crypto.scrypt` + `createCipheriv('aes-256-gcm')`。Rust 对应：

```rust
// 派生
scrypt::scrypt(password.as_bytes(), &salt, &Params::new(17, 8, 1, 32)?, &mut key)?;

// 加密（AAD 绑定格式与 KDF 参数，防降级）
let cipher = Aes256Gcm::new_from_slice(&key)?;
let msg = Payload {
    msg: plaintext.as_bytes(),
    aad: aad.as_bytes(),        // 与 JS 版 aadOf() 完全一致
};
let ciphertext = cipher.encrypt(&nonce, msg)?;
```

**格式必须字节级兼容**，否则老用户的 `vault.dat` 打不开。验证手段：用同一份 v1 文件，Node 版和 Rust 版都要能解开，且解出的 JSON 完全一致。

`zeroize` 比 JS 的 `key.fill(0)` 更彻底：JS 的字符串不可变、GC 前无法擦除，Rust 能保证密钥在 drop 时清零。

## 浏览器导入：换 Rust 的真实收益

现在 `browser-import.js` 的 DPAPI 调用靠 PowerShell：

```
Node → execFileSync('powershell.exe', [...]) → DPAPI → base64 → 回传
```

每次调用要起一个 PowerShell 进程，约 300ms，而且密钥以 base64 字符串形式穿过进程边界。

Rust 里直接调 API：

```rust
use windows::Win32::Security::Cryptography::{CryptUnprotectData, DATA_BLOB};

unsafe fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>> {
    // 进程内完成，无子进程、无字符串中转
}
```

这一处能省掉整个 `powershell.exe` 依赖。

## 迁移顺序（每步都可独立验证）

1. **`vault` 模块** + 格式兼容测试
   - 用现有 `vault.dat` 作为 fixture，Node 版和 Rust 版都解一遍，比对 JSON
   - 这是风险最高的一步，必须先做且必须通过

2. **`password` + `export`**（纯逻辑，容易）

3. **`browser/discovery` + CSV 解析**（纯逻辑）

4. **`browser/import` 的 DPAPI 部分**（换掉 PowerShell）

5. **`main.rs` 窗口与 IPC**
   - Tauri 的 `invoke` 对应 Electron 的 `ipcMain.handle`
   - 前端 `preload.js` 换成 Tauri 的 `@tauri-apps/api`

6. **打包**：`tauri build` → MSI + 便携版

## 前端改动量

`preload.js` 的 29 个方法要换成 Tauri 的调用方式：

```js
// 现在
contextBridge.exposeInMainWorld('vaultApi', {
  unlock: (password) => ipcRenderer.invoke('vault:unlock', { password }),
});

// Tauri
import { invoke } from '@tauri-apps/api/core';
window.vaultApi = {
  unlock: (password) => invoke('vault_unlock', { password }),
};
```

`app.js` 里所有 `api.xxx(...)` 调用**不用改**，因为接口形状保持一样。

## 风险

- **格式兼容**：最容易出错，必须有 fixture 对比测试
- **WebView2 版本**：老系统可能没有，需要引导安装
- **构建时间**：Rust 首次编译 Tauri 约 5-10 分钟，增量 30 秒
- **代码签名**：Tauri 打包也需要签名证书，否则同样触发 SmartScreen
