# legacy/ — 已被取代的 Electron 实现

**不要用它新建密码库。**

## 这是什么

KeyNest 最早的实现是 Electron（Node.js）。后来整个应用重写成 Rust
（`rust/keynest-core` + `rust/keynest-egui`），功能一一对应，且加密更强。

这里保留的是那份旧实现，目的只有一个：**帮还持有 v1 库的老用户做迁移**。

## 为什么不能新建库

两代实现的加密不同：

| | legacy（此处） | 当前（`rust/`） |
| --- | --- | --- |
| KDF | scrypt N=2^17,r=8,p=1 | Argon2id 64MiB,t=3,p=1 |
| 正文加密 | AES-256-GCM（12B nonce） | XChaCha20-Poly1305（24B nonce）+ DEK/KEK 分离 |
| 格式标记 | `keynest.v1` | `keynest.v3` |

Rust 版**能读 v1**（保留兼容），并能在设置里把它升级到 v3。
但**反过来不行**——legacy 的 CLI 只写 v1，用它建的库会一直停在 v1。

## 怎么从 v1 迁过来

1. 直接用 Rust 版打开 v1 库（它会识别并正常解密）
2. 设置 → 安全 → 「升级到 v3 格式」

CLI 仍然可用，但只在需要脚本化导入 CSV 时：

```bash
node legacy/src/cli/keynest-cli.js import --csv 导出文件.csv
node legacy/src/cli/keynest-cli.js scan
node legacy/src/cli/keynest-cli.js export-template
```

## 它为什么还留在这里

`docs/AUDIT.md` 的待办里写着「若打算废弃，应尽快移除，避免用户误用旧版」。
没有直接删除，是因为 **v1 → v3 的迁移路径需要它作为最后手段**：
万一有用户的 v1 库在当前版本里打不开，这份实现还能把数据读出来。

一旦确认不再需要这个逃生通道，整个目录可以直接 `rm -rf legacy/`。
