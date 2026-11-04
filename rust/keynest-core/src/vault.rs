//! 加密仓库核心。
//!
//! # 格式
//!
//! 存在两代格式，读取都支持，**新建一律写 v2**：
//!
//! | 版本 | KDF | AEAD | nonce | 说明 |
//! |---|---|---|---|---|
//! | `keynest.v1` | scrypt(N=2^17,r=8,p=1) | AES-256-GCM | 12B | 旧版，仅为兼容读取保留 |
//! | `keynest.v2` | Argon2id(64MiB,t=3,p=1) | XChaCha20-Poly1305 | 24B | 新建默认 |
//!
//! # 相对 v1 实现的安全改动（逐条对应审查清单）
//!
//! * **随机数**：不再经由 `rand`，salt/nonce 直接调用 `getrandom`（OS CSPRNG）。
//! * **KDF**：Argon2id 64 MiB / t=3 / p=1，高于 OWASP 19 MiB / t=2 / p=1 下限。
//! * **AEAD**：XChaCha20-Poly1305，24 字节随机 nonce，消除了 GCM 96 位 nonce
//!   在大量保存时的碰撞顾虑；仍每次保存重新生成。
//! * **AAD**：v2 用规范的定长拼接串，不再依赖 JSON 序列化的键顺序；
//!   v1 的 AAD 保持原样以兼容旧文件，但序列化失败不再静默返回空 AAD。
//! * **密钥与明文**：派生密钥、序列化后的明文、旧密钥、剪贴板期望值全部用
//!   `Zeroizing` 包裹；`Entry` 实现 `Drop` 主动清零 password/notes。
//! * **Debug 泄漏**：`Entry`/`VaultData`/`VaultFile` 改手写 `Debug`，密码与
//!   payload 一律打码，避免 `{:?}` 或 `dbg!` 把密码打到日志。
//! * **文件写入**：临时文件 → `sync_all()`（fsync）→ `rename`；`.bak` 同样落盘。
//! * **畸形文件**：nonce/iv 长度、KDF 参数全部显式校验，杜绝 `from_slice` panic。

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{Result, VaultError};
use crate::keymem::SecretKey;

pub const FORMAT_V1: &str = "keynest.v1";
pub const FORMAT_V2: &str = "keynest.v2";
/// 第三代格式：主密码派生 KEK，KEK 包裹随机 DEK，DEK 加密正文。
pub const FORMAT_V3: &str = "keynest.v3";

/// 新建仓库时使用的格式。
pub const FORMAT: &str = FORMAT_V3;

pub const ALGO_ARGON2ID: &str = "argon2id";
pub const ALGO_SCRYPT: &str = "scrypt";
pub const CIPHER_XCHACHA: &str = "xchacha20-poly1305";
pub const CIPHER_AES_GCM: &str = "aes-256-gcm";

pub const KEY_LEN: usize = 32;
pub const TAG_LEN: usize = 16;

// 密钥长度在 `keymem` 里也有一份定义（那里是页对齐容器的字段长度）。
// 两处必须一致，否则 `SecretKey::new` 会在编译期以外的地方悄悄截断。
const _: () = assert!(KEY_LEN == crate::keymem::KEY_LEN);

/// 主密码最小长度从 8 提高到 12：
/// 8 位纯小写只有约 37 bit 熵，配合 Argon2id 仍不足以抵抗离线爆破。
pub const MIN_MASTER_LEN: usize = 12;

// 编译期守住下限：谁把 12 改成 8，这里直接编不过，而不是等到用户被爆破才发现。
const _: () = assert!(MIN_MASTER_LEN >= 12);

// --- Argon2id 默认参数（KiB / 迭代 / 并行）---
pub const ARGON2_M_COST_DEFAULT: u32 = 64 * 1024; // 64 MiB
pub const ARGON2_T_COST_DEFAULT: u32 = 3;
pub const ARGON2_P_COST_DEFAULT: u32 = 1;

// --- 读取时允许的上限，防止恶意文件用超大参数耗尽内存 ---
//
// 上限取 256 MiB：新建库只有 64 MiB，留 4 倍余量足够未来调参，
// 又不至于让一个投毒文件把进程的地址空间拖垮。
const ARGON2_M_COST_MAX: u32 = 256 * 1024; // 256 MiB
const ARGON2_T_COST_MAX: u32 = 16;
const ARGON2_P_COST_MAX: u32 = 8;
const ARGON2_SALT_MIN: usize = 8;

// --- v1（scrypt）读取上限，同样用于防 DoS ---
const SCRYPT_LOG_N_MAX: u8 = 20;
const SCRYPT_R_MAX: u32 = 32;
const SCRYPT_P_MAX: u32 = 4;
const SCRYPT_SALT_MIN: usize = 8;

/// scrypt 的内存占用是 `128 · N · r` 字节。
///
/// 只对 log_n、r 分别设上限是不够的：`N = 2^20` 配上 `r = 32` 就是 4 GiB，
/// 一个伪造的 v1 文件即可让解锁过程把内存吃光。所以必须约束**乘积**。
const SCRYPT_MEM_LIMIT: u64 = 256 * 1024 * 1024;

/// 单个库文件的大小上限。库是纯 JSON + base64，64 MiB 对应约 5 万条条目。
pub const MAX_VAULT_BYTES: u64 = 64 * 1024 * 1024;

/// 单个库的条目数上限。
///
/// # 为什么必须在**导入**时也挡住
///
/// `MAX_VAULT_BYTES` 只在**读盘**时检查，管不到"内存里刚导入进来的一大批条目"。
/// 一个 32 MiB 的 CSV 可以轻松造出上百万条记录，随后：
///
/// * 每次保存都要序列化全部条目再加密 → 界面卡死
/// * 加密后的文件远超 64 MiB → 保存失败，库从此写不进去
/// * 用户已经看到的条目却存不下去 → 实际的数据丢失
///
/// 5 万条与 `MAX_VAULT_BYTES` 的估算一致（64 MiB ≈ 5 万条）。
pub const MAX_ENTRIES: usize = 50_000;

/// 供上层（导出/备份前做预检查）读取的大小上限。
pub fn max_vault_bytes() -> u64 {
    MAX_VAULT_BYTES
}

/// 保留的备份代数。`.bak.1` 最新，`.bak.{N}` 最旧。
pub const BACKUP_GENERATIONS: usize = 5;

/// 恢复备份时，把当前（可能已损坏的）文件挪到一边而不删除。
const CORRUPT_PREFIX: &str = "corrupt-";

pub const DEFAULT_CATEGORIES: [&str; 5] = ["网站", "邮箱", "应用", "金融", "其他"];

/* ------------------------------------------------------------------ */
/* 数据结构                                                            */
/* ------------------------------------------------------------------ */

/// KDF 参数。兼容 v1（scrypt）与 v2（Argon2id）两种形态。
///
/// 用同一结构承载是为了让 `vault.dat` 的 JSON 能直接反序列化，
/// 但读写时都会先做参数校验，不会因为字段缺失就默默用默认值跑。
#[derive(Clone, Serialize, Deserialize)]
pub struct KdfParams {
    pub algo: String,

    // --- v1: scrypt ---
    #[serde(rename = "N", default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p: Option<u32>,

    // --- v2: Argon2id ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub m_cost: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t_cost: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p_cost: Option<u32>,

    pub salt: String,
}

impl KdfParams {
    /// 参数是否达到推荐下限。
    ///
    /// **这不是"能不能打开"的门槛**——低于推荐值的库照样能解锁。
    /// 拒绝打开用户的真实数据是不可接受的；正确做法是打开它，然后明确提示该升级。
    pub fn meets_floor(&self) -> bool {
        match self.algo.as_str() {
            ALGO_ARGON2ID => {
                self.m_cost.unwrap_or(0) >= RECOMMENDED_ARGON2_M_COST
                    && self.t_cost.unwrap_or(0) >= RECOMMENDED_ARGON2_T_COST
                    && self.p_cost.unwrap_or(0) >= 1
            }
            ALGO_SCRYPT => {
                // 存的是 N 本身（2 的幂），比较下限用 log2 更直观
                let n = self.n.unwrap_or(0);
                let log_n = if n >= 2 {
                    63 - u64::leading_zeros(n) as u8
                } else {
                    0
                };
                log_n >= RECOMMENDED_SCRYPT_LOG_N
                    && self.r.unwrap_or(0) >= RECOMMENDED_SCRYPT_R
                    && self.p.unwrap_or(0) >= 1
            }
            _ => false,
        }
    }

    /// 默认 Argon2id 参数（不带 salt，创建时再填）。
    pub fn argon2_default() -> Self {
        Self {
            algo: ALGO_ARGON2ID.into(),
            n: None,
            r: None,
            p: None,
            m_cost: Some(ARGON2_M_COST_DEFAULT),
            t_cost: Some(ARGON2_T_COST_DEFAULT),
            p_cost: Some(ARGON2_P_COST_DEFAULT),
            salt: String::new(),
        }
    }

    /// 指定参数的 Argon2id，仅供测试与后续可调参数使用。
    pub fn argon2_with(m_cost: u32, t_cost: u32, p_cost: u32) -> Self {
        Self {
            m_cost: Some(m_cost),
            t_cost: Some(t_cost),
            p_cost: Some(p_cost),
            ..Self::argon2_default()
        }
    }

    /// v1 的 scrypt 参数（仅在兼容读取/构造旧库时使用）。
    pub fn scrypt_default() -> Self {
        Self {
            algo: ALGO_SCRYPT.into(),
            n: Some(1 << 17),
            r: Some(8),
            p: Some(1),
            m_cost: None,
            t_cost: None,
            p_cost: None,
            salt: String::new(),
        }
    }
}

impl Default for KdfParams {
    fn default() -> Self {
        Self::argon2_default()
    }
}

// 手写 Debug：只暴露算法与参数，salt 打码。
impl fmt::Debug for KdfParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KdfParams")
            .field("algo", &self.algo)
            .field("n", &self.n)
            .field("r", &self.r)
            .field("p", &self.p)
            .field("m_cost", &self.m_cost)
            .field("t_cost", &self.t_cost)
            .field("p_cost", &self.p_cost)
            .field("salt", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CipherParams {
    pub algo: String,
    /// nonce/iv 的 base64。AES-256-GCM 时是 12 字节，XChaCha 时是 24 字节。
    pub iv: String,
    pub tag: String,
}

impl fmt::Debug for CipherParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CipherParams")
            .field("algo", &self.algo)
            .field("iv", &"<redacted>")
            .field("tag", &"<redacted>")
            .finish()
    }
}

/* ------------------------------------------------------------------ */
/* v3：DEK / KEK 分离                                                   */
/* ------------------------------------------------------------------ */

/// 被 KEK 包裹后的数据加密密钥。
///
/// 三个字段都是公开数据（密文），但 `wrapped` 一旦被改动就会解认证失败。
#[derive(Clone, Serialize, Deserialize)]
pub struct DekWrap {
    pub algo: String,
    /// 包裹用的 24 字节随机 nonce。
    pub iv: String,
    pub tag: String,
    /// base64(加密后的 32 字节 DEK)。
    pub wrapped: String,
}

impl fmt::Debug for DekWrap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DekWrap")
            .field("algo", &self.algo)
            .field("iv", &"<redacted>")
            .field("tag", &"<redacted>")
            .field("wrapped", &"<redacted>")
            .finish()
    }
}

/// v3 磁盘结构。
///
/// ```text
/// 主密码 ─Argon2id(salt)─> KEK ─XChaCha20-Poly1305(AAD=dek 串)─> 包裹 DEK
///                                                                  │
///                                             DEK ─XChaCha20-Poly1305(AAD=body 串)─> payload
/// ```
///
/// 分离之后：换主密码只需重新包裹 32 字节，正文密文可以原样保留；
/// Argon2 参数也能独立升级，不必让整库跟着重算。
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultFileV3 {
    pub format: String,
    /// 描述 KEK 的派生参数。与正文无关。
    pub kdf: KdfParams,
    /// 被 KEK 包裹的 DEK。
    pub dek: DekWrap,
    /// 正文的加密参数（每次保存换 nonce）。
    pub cipher: CipherParams,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub payload: String,
}

impl fmt::Debug for VaultFileV3 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultFileV3")
            .field("format", &self.format)
            .field("kdf", &self.kdf)
            .field("dek", &self.dek)
            .field("cipher", &self.cipher)
            .field("updated_at", &self.updated_at)
            .field("payload", &"<redacted>")
            .finish()
    }
}

/// 磁盘上任意一代格式的联合视图。
///
/// 读文件时只解析一次，后面的校验/取时间戳/取 KDF 都走这里，
/// 避免每个调用点各写一遍 `match format`——那种写法最容易漏掉新格式。
#[derive(Clone)]
pub enum AnyFile {
    Legacy(VaultFile),
    V3(VaultFileV3),
}

impl AnyFile {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| VaultError::Corrupt)?;
        let format = value
            .get("format")
            .and_then(|v| v.as_str())
            .ok_or(VaultError::Malformed("缺少 format"))?
            .to_string();
        match format.as_str() {
            FORMAT_V3 => serde_json::from_value(value)
                .map(AnyFile::V3)
                .map_err(|_| VaultError::Corrupt),
            FORMAT_V1 | FORMAT_V2 => serde_json::from_value(value)
                .map(AnyFile::Legacy)
                .map_err(|_| VaultError::Corrupt),
            _ => Err(VaultError::UnsupportedFormat),
        }
    }

    pub fn format(&self) -> &str {
        match self {
            AnyFile::Legacy(f) => &f.format,
            AnyFile::V3(f) => &f.format,
        }
    }

    pub fn updated_at(&self) -> &str {
        match self {
            AnyFile::Legacy(f) => &f.updated_at,
            AnyFile::V3(f) => &f.updated_at,
        }
    }

    pub fn kdf(&self) -> &KdfParams {
        match self {
            AnyFile::Legacy(f) => &f.kdf,
            AnyFile::V3(f) => &f.kdf,
        }
    }

    /// 不依赖密钥的自洽性校验。
    pub fn validate(&self) -> Result<()> {
        match self {
            AnyFile::Legacy(f) => validate_header(f),
            AnyFile::V3(f) => validate_header_v3(f),
        }
    }
}

/// v3 的 DEK 包裹 AAD：绑定格式与 KEK 派生参数。
///
/// 任何一项被改动都会让「解包裹」失败，从而无法拿到 DEK——这是防止降级
/// （把 KDF 参数改小从而加速离线爆破）的关键一环。
fn aad_dek(kdf: &KdfParams) -> Result<Vec<u8>> {
    let m = kdf.m_cost.ok_or(VaultError::Malformed("缺少 m_cost"))?;
    let t = kdf.t_cost.ok_or(VaultError::Malformed("缺少 t_cost"))?;
    let p = kdf.p_cost.ok_or(VaultError::Malformed("缺少 p_cost"))?;
    Ok(format!(
        "keynest.v3|dek|xchacha20-poly1305|{}|m={}|t={}|p={}|salt={}",
        kdf.algo, m, t, p, kdf.salt
    )
    .into_bytes())
}

/// v3 正文 AAD。
///
/// 刻意**只**绑定格式与正文算法，不绑定 KDF 参数与包裹块：
/// 换主密码时正文密文要能原样保留，绑上去就做不到「只换包裹」了。
/// 正文的安全性由随机 DEK 保证——换了主密码，DEK 不变，密文自然还能解。
const AAD_BODY_V3: &[u8] = b"keynest.v3|body|xchacha20-poly1305";

/// 用 KEK 包裹 DEK，产出可落盘的公开结构。
fn wrap_dek(kek: &SecretKey, kdf: &KdfParams, dek: &[u8; KEY_LEN]) -> Result<DekWrap> {
    let aad = aad_dek(kdf)?;
    let (cipher, ct) = seal_xchacha(kek.as_bytes(), &aad, dek)?;
    Ok(DekWrap {
        algo: cipher.algo,
        iv: cipher.iv,
        tag: cipher.tag,
        wrapped: b64(&ct),
    })
}

/// 用 KEK 解开 DEK。失败一律归为「主密码错误」——不区分「密码错」与「包裹块被改」。
fn unwrap_dek(kek: &SecretKey, kdf: &KdfParams, w: &DekWrap) -> Result<SecretKey> {
    let aad = aad_dek(kdf)?;
    let cipher = CipherParams {
        algo: w.algo.clone(),
        iv: w.iv.clone(),
        tag: w.tag.clone(),
    };
    let raw = open_xchacha(kek.as_bytes(), &aad, &cipher, &w.wrapped)?;
    let bytes: [u8; KEY_LEN] = raw
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::Malformed("DEK 长度非法"))?;
    Ok(SecretKey::new(bytes))
}

/// 用 DEK 加密正文，返回 `(密文参数, base64 载荷)`。
///
/// 直接返回 base64 是为了和 [`Vault::body_cache`] 的类型对齐：
/// 换主密码时要把上次落盘的载荷原样写回，两者必须是同一种表示。
fn seal_body(dek: &SecretKey, plain: &[u8]) -> Result<(CipherParams, String)> {
    let (cipher, ct) = seal_xchacha(dek.as_bytes(), AAD_BODY_V3, plain)?;
    Ok((cipher, b64(&ct)))
}

/// 用 DEK 解密正文。
fn open_body(
    dek: &SecretKey,
    cipher: &CipherParams,
    payload_b64: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    open_xchacha(dek.as_bytes(), AAD_BODY_V3, cipher, payload_b64)
}

/// 把 `VaultFileV3` 组装成落盘结构。`payload` 已经是 base64。
fn build_v3(
    kdf: &KdfParams,
    wrap: &DekWrap,
    cipher: CipherParams,
    payload: String,
    updated_at: String,
) -> VaultFileV3 {
    VaultFileV3 {
        format: FORMAT_V3.to_string(),
        kdf: kdf.clone(),
        dek: wrap.clone(),
        cipher,
        updated_at,
        payload,
    }
}

/// 磁盘上的文件结构（v1 / v2）。
///
/// `deny_unknown_fields` 是刻意的：把 v3 文件里的 `"format"` 改成 `"keynest.v2"`
/// 之后，`dek` 字段就成了「v2 结构里不该出现的东西」，解析会直接失败。
/// 没有这一条，一个被改了格式标签的 v3 文件会被当成 v2 静默接受，
/// 然后以一句「主密码错误」收场——把篡改伪装成了用户自己的问题。
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultFile {
    pub format: String,
    pub kdf: KdfParams,
    pub cipher: CipherParams,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub payload: String,
}

impl fmt::Debug for VaultFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultFile")
            .field("format", &self.format)
            .field("kdf", &self.kdf)
            .field("cipher", &self.cipher)
            .field("updated_at", &self.updated_at)
            .field("payload", &"<redacted>")
            .finish()
    }
}

/// 需要 `PartialEq`：设置页要判断「用户改了但还没保存」。
///
/// 这不只是体验问题——自动锁定从 60 分钟改成 5 分钟是**更安全**的方向，
/// 用户以为改好了、结果没点保存就关了窗口，程序仍然 60 分钟才锁。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "autoLockMinutes")]
    pub auto_lock_minutes: u32,
    #[serde(rename = "clipboardClearSeconds")]
    pub clipboard_clear_seconds: u32,
    #[serde(rename = "revealSeconds")]
    pub reveal_seconds: u32,
    #[serde(rename = "importPrompted")]
    pub import_prompted: bool,
}

/// 自动锁定上限（分钟）。1440 = 24 小时。
///
/// 为什么要有上限：自动锁定是密码管理器最基本的防线。设成几年
/// 等于把它关掉，而用户往往是在「嫌它太频繁」的时候随手填个大数，
/// 并不会意识到自己刚刚关掉了什么。
pub const MAX_AUTO_LOCK_MINUTES: u32 = 1440;

/// 剪贴板清理间隔上限（秒）。
///
/// 密码在剪贴板里停留越久，被其他程序读取的机会越多。
/// 300 秒已经足够完成粘贴，再长就没有安全意义了。
pub const MAX_CLIPBOARD_SECONDS: u32 = 300;

/// 密码显示时长上限（秒）。
pub const MAX_REVEAL_SECONDS: u32 = 300;

/// 剪贴板清理间隔下限（秒）。
///
/// 低于 3 秒时，用户还没切到目标窗口内容就被清掉了，
/// 表现为「点了复制但粘贴出来是空的」。
pub const MIN_CLIPBOARD_SECONDS: u32 = 3;

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: 5,
            clipboard_clear_seconds: 20,
            reveal_seconds: 20,
            import_prompted: false,
        }
    }
}

/// 内置类型名。
///
/// 类型做成了**用户可增删改的名字**（和分类一样），不再是封闭枚举——
/// 想加一个「服务器」「WiFi」是用户自己的事，不该由开发者决定。
/// 这里只保留四个内置名字，用来提供默认模板与「账号」的专属显示规则。
pub mod kinds {
    pub const LOGIN: &str = "账号";
    pub const NOTE: &str = "笔记";
    pub const CARD: &str = "信用卡";
    pub const IDENTITY: &str = "身份";

    /// AI 服务的 API Key（OpenAI / Anthropic / 自建…）。
    ///
    /// 做成一个类型而不是专门功能：类型系统本来就是「标签 + 字段模板」，
    /// API Key 只是又一组字段。这样它自动获得搜索、筛选、收藏、回收站、
    /// 导入导出、字段打码，不需要为它写一套 UI 或改 `vault.dat` 格式。
    pub const APIKEY: &str = "API Key";

    /// 默认的类型列表。
    pub const DEFAULT_TYPES: [&str; 5] = [LOGIN, NOTE, CARD, IDENTITY, APIKEY];

    /// 老版本把类型存成 `login` / `card` 这种英文 id，读进来要换成中文名。
    pub fn migrate_legacy(value: &str) -> Option<&'static str> {
        match value {
            "login" => Some(LOGIN),
            "note" => Some(NOTE),
            "card" => Some(CARD),
            "identity" => Some(IDENTITY),
            _ => None,
        }
    }

    /// 这种类型默认带哪些字段（只有内置类型有模板）。
    /// 返回（标签, 是否打码, 输入提示）。
    ///
    /// 提示语是**纯增量**的：老库里存的模板没有 hint，读进来是空串，
    /// 编辑框就不显示灰字。这不需要数据迁移。
    pub fn template(name: &str) -> &'static [(&'static str, bool, &'static str)] {
        match name {
            CARD => &[
                ("持卡人", false, "持卡人姓名"),
                ("卡号", true, "16 位卡号"),
                ("有效期", false, "MM/YY"),
                ("安全码", true, "背面 3–4 位"),
                ("发卡行", false, "例如 招商银行"),
            ],
            IDENTITY => &[
                ("姓名", false, "证件上的姓名"),
                ("证件号", true, "身份证 / 护照号"),
                ("出生日期", false, "YYYY-MM-DD"),
                ("地址", false, "常住地址"),
                ("电话", false, "带国家码，如 +86 138…"),
            ],
            // API Key 的字段设计见 docs/design-ai-apikey-type.md
            //
            // 字段取舍的依据（对照 1Password 的 API Credential 类别、
            // AWS Secrets Manager 的密钥结构建议、以及社区提案）：
            //
            // * **两段式凭据要有位置放**：AWS / 阿里云这类是「访问密钥 ID +
            //   访问密钥 Secret」两段，只存一个 Secret 等于存不全，用户还得
            //   用备注补——那就白做了。所以「Key ID」和「Secret」分开。
            // * **环境必须能筛**：同一个服务在 dev / prod 各有一把 key 是常态。
            //   没有这个字段，两条记录长得一模一样，靠标题里的 `(prod)` 硬分，
            //   迟早出错。做成一等字段才能按它筛。
            // * **scope 决定泄露后的影响面**：只读还是读写、能访问哪些资源。
            //   这条写下来，出事时才知道该慌到什么程度。
            // * **轮换周期**比「到期时间」更有用：很多 key 根本不过期，
            //   但该多久换一次是运维纪律。
            //
            // 全部用 `secret: true` 的只有 Secret 本身。Key ID 不是秘密
            // （它会出现在请求头与日志里），打码只会让人核对不了。
            APIKEY => &[
                ("服务商", false, "OpenAI / Anthropic / AWS / 自建…"),
                ("环境", false, "prod / staging / dev"),
                ("Key ID", false, "AKIA… 这类公开标识，没有就留空"),
                ("Secret", true, "sk-… / 访问密钥，粘贴进来"),
                ("权限范围", false, "只读 / 读写 / 具体 scope"),
                ("Base URL", false, "走代理或自建时填，官方留空"),
                ("到期时间", false, "YYYY-MM-DD，不过期就留空"),
                ("轮换周期", false, "例如 90 天"),
            ],
            _ => &[],
        }
    }
}

/// 类型定义。
///
/// 关键点：**模板跟着类型走，而不是跟着名字走**。
/// 之前把「信用卡」改名成「银行卡」后模板就失效了，因为模板是按名字查的。
/// 现在模板是这个类型自己的属性，改名只改标签。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(from = "TypeDefRepr")]
pub struct TypeDef {
    pub label: String,
    #[serde(default)]
    pub template: Vec<FieldTemplate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FieldTemplate {
    pub label: String,
    #[serde(default)]
    pub secret: bool,
    /// 输入框里的灰字提示（`hint_text`）。
    ///
    /// 「环境」「权限范围」这类字段光有标签不够——用户不知道
    /// 该填 `prod` 还是「生产环境」，也不知道 scope 要不要写全。
    /// 一句示例比一整段说明更容易被读完。
    ///
    /// `serde(default)`：老库里的模板没有这个字段，读进来是空串，
    /// 编辑框就不显示提示。这是**纯增量**的改动，不需要数据迁移。
    #[serde(default)]
    pub hint: String,
}

/// 兼容两种写法：老库里 `types` 是字符串数组，新格式是对象数组。
///
/// 注意：`Full` 里必须是一个**普通结构体**，不能直接放 `TypeDef`。
/// `TypeDef` 自己带 `#[serde(from = "TypeDefRepr")]`，再让它出现在 `TypeDefRepr`
/// 里就会变成「解 TypeDef 要先解 TypeDefRepr，而它又要解 TypeDef」——
/// 无限递归，栈直接爆掉。
#[derive(Deserialize)]
#[serde(untagged)]
enum TypeDefRepr {
    Label(String),
    Full(TypeDefFields),
}

#[derive(Deserialize)]
struct TypeDefFields {
    label: String,
    #[serde(default)]
    template: Vec<FieldTemplate>,
}

impl From<TypeDefRepr> for TypeDef {
    fn from(r: TypeDefRepr) -> Self {
        match r {
            TypeDefRepr::Full(t) => TypeDef {
                label: t.label,
                template: t.template,
            },
            TypeDefRepr::Label(label) => TypeDef {
                template: builtin_template(&label),
                label,
            },
        }
    }
}

impl TypeDef {
    pub fn new(label: &str, template: Vec<FieldTemplate>) -> Self {
        Self {
            label: label.to_string(),
            template,
        }
    }
}

/// 内置类型的默认模板。
fn builtin_template(name: &str) -> Vec<FieldTemplate> {
    kinds::template(name)
        .iter()
        .map(|(label, secret, hint)| FieldTemplate {
            label: (*label).to_string(),
            secret: *secret,
            hint: (*hint).to_string(),
        })
        .collect()
}

fn default_types() -> Vec<TypeDef> {
    kinds::DEFAULT_TYPES
        .iter()
        .map(|name| TypeDef::new(name, builtin_template(name)))
        .collect()
}

/// 一条自定义字段。
///
/// `secret = true` 表示界面上默认打码（安全码、PIN、证件号这类）。
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Field {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

impl fmt::Debug for Field {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Field")
            .field("label", &self.label)
            .field("value", &if self.secret { "<redacted>" } else { "…" })
            .field("secret", &self.secret)
            .finish()
    }
}

/// 字段数量上限。防御畸形库/导入文件把界面撑爆。
pub const MAX_FIELDS: usize = 50;

/// 条目各字段的长度上限（字符数，不是字节数）。
///
/// # 为什么要有
///
/// 没有上限时，一个 100 MB 的备注字段就能让整个密码库超过
/// `MAX_VAULT_BYTES`（64 MiB）——从此**再也保存不了**：
/// 每��保存都被文件大小挡住，用户只能手工改文件。
///
/// 这不只是"数据脏"，是**库被永久写坏**。
///
/// # 为什么与 bridge 的限制一致
///
/// `keynest-bridge` 的 `limits.rs` 里已经有一组同样的上限
/// （title 256 / username 320 / password 1024 / url 2048）。
/// 浏览器填充进来的条目会被 bridge 挡下，但从 GUI 直接添加的不会——
/// 两条路径的限制必须一致，否则「换个入口就能绕过」。
pub const MAX_TITLE_CHARS: usize = 256;
pub const MAX_USERNAME_CHARS: usize = 320;
pub const MAX_PASSWORD_CHARS: usize = 1024;
pub const MAX_URL_CHARS: usize = 2048;
pub const MAX_NOTES_CHARS: usize = 64 * 1024;
pub const MAX_CATEGORY_CHARS: usize = 64;
pub const MAX_KIND_CHARS: usize = 64;

/// TOTP 配置的长度上限。
///
/// TOTP 密钥是 Base32，正常是 16–32 字符。上限给到 512 足够，
/// 又能挡住"误粘贴了一个几 MB 的文件"。
pub const MAX_TOTP_CHARS: usize = 512;

impl VaultData {
    /// 找出重复的条目 id。
    ///
    /// `upsert_entry` 靠 `id` 定位条目。两条同 id 的记录会让
    /// 「编辑其中一条」变成「覆盖排在前面的那条」，另一条永远改不动也删不掉。
    ///
    /// 正常情况下 id 由 `Uuid::new_v4` 生成，不可能重复。
    /// 但库文件被手工编辑过、或由第三方工具生成时可能出现——
    /// 解锁后检查一次，能给出「库里有 N 组重复记录」这种具体提示，
    /// 而不是让用户在编辑时莫名发现内容串了。
    ///
    /// 返回去重后的 id 列表（顺序按首次出现）。
    pub fn find_duplicate_ids(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        let mut dups = Vec::new();
        for e in &self.entries {
            if !seen.insert(e.id.as_str()) && !dups.iter().any(|d: &String| d == &e.id) {
                dups.push(e.id.clone());
            }
        }
        dups
    }
    /// 兼容老数据：类型曾经是 `login` / `card` 这样的英文 id，现在存中文名。
    ///
    /// 必须在**读入之后、任何界面逻辑之前**做掉——否则老库里的条目会显示成
    /// `login`，而且不在任何类型筛选里。
    fn migrate_legacy(&mut self) {
        // 旧库里可能已经存着危险设置值（老版本没做夹紧，或库文件被手工改过）。
        // 只在**打开时**修一次内存副本——不改磁盘上的文件，
        // 用户下次在设置页点保存时才会写回新值。这样不会在用户不知情的
        // 情况下改写他的库。
        self.settings.auto_lock_minutes = self
            .settings
            .auto_lock_minutes
            .clamp(1, MAX_AUTO_LOCK_MINUTES);
        self.settings.clipboard_clear_seconds = self
            .settings
            .clipboard_clear_seconds
            .clamp(MIN_CLIPBOARD_SECONDS, MAX_CLIPBOARD_SECONDS);
        self.settings.reveal_seconds = self.settings.reveal_seconds.clamp(1, MAX_REVEAL_SECONDS);

        for e in self.entries.iter_mut() {
            if let Some(name) = kinds::migrate_legacy(&e.kind) {
                e.kind = name.to_string();
            }
        }
        // 类型表里可能还留着英文 id
        for t in self.types.iter_mut() {
            if let Some(name) = kinds::migrate_legacy(&t.label) {
                t.label = name.to_string();
            }
            // 老库只有名字，没有模板：内置类型补上默认模板
            if t.template.is_empty() {
                t.template = builtin_template(&t.label);
            }
        }
        if self.types.is_empty() {
            self.types = default_types();
        }

        // 「API Key」是后加的内置类型。类型表存在库文件里，
        // 所以**已有的库不会自动出现它**——这里补一次。
        //
        // 只补这一个，不碰其它内置类型：用户可能主动删了「笔记」，
        // 每次打开都加回去会很烦。API Key 是这版新增的，
        // 老库里不可能「被用户删过」，所以补它是安全的。
        if !self.types.iter().any(|t| t.label == kinds::APIKEY) {
            self.types
                .push(TypeDef::new(kinds::APIKEY, builtin_template(kinds::APIKEY)));
        }
        // 条目用到了但类型表里没有的，补进去（否则它会从类型下拉里消失）
        let used: Vec<String> = self.entries.iter().map(|e| e.kind.clone()).collect();
        for k in used {
            if !self.types.iter().any(|t| t.label == k) {
                self.types.push(TypeDef::new(&k, builtin_template(&k)));
            }
        }
    }
}

fn default_kind() -> String {
    kinds::LOGIN.to_string()
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub category: String,
    pub notes: String,
    /// 是否收藏。
    ///
    /// `#[serde(default)]` 是**兼容旧库的硬性要求**：v1/v2/v3 早先写出的文件里
    /// 没有这个字段，缺省即 `false`，否则老库会因为「缺字段」直接打不开。
    #[serde(default)]
    pub favorite: bool,
    /// 删除时间。`Some` 表示在回收站里，`None` 表示正常条目。
    ///
    /// 软删除而不是立即物理删除：误删是密码管理器最常见的事故，
    /// 而一条记录在库里只占几百字节，「先留着」的成本远低于「找不回来」。
    #[serde(rename = "deletedAt", default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    /// 条目类型名（用户可自定义，默认「账号」）。
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 自定义字段（信用卡号、证件号、任意键值）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
    /// 密码最后一次变更的时间。
    ///
    /// 与 `updated_at` 分开：改个备注不该让「这个密码多久没换」这件事失真。
    /// 旧库没有这个字段，`None` 时统计会退回到 `updated_at`。
    #[serde(
        rename = "passwordChangedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub password_changed_at: Option<String>,
    /// TOTP 配置，存 `otpauth://` URI（或裸 Base32）。
    ///
    /// 它与密码等价敏感：拿到它就能生成你的动态验证码。
    #[serde(rename = "totp", default, skip_serializing_if = "Option::is_none")]
    pub totp: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

impl Entry {
    /// 是否在回收站里。
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }
}

/// 条目销毁时主动清零敏感字段。
///
/// 注意：这只能清掉本结构自己持有的那块堆内存。
/// `serde_json` 反序列化过程中的临时 String、以及调用方自己克隆出来的
/// `password` 副本，本类型管不到（见文末「已知残留」说明）。
impl Drop for Entry {
    fn drop(&mut self) {
        // 标题/账号/网址同样属于「看到就等于泄漏一半」的信息，
        // 一并擦除的成本几乎为零。
        self.title.zeroize();
        self.username.zeroize();
        self.password.zeroize();
        self.url.zeroize();
        self.notes.zeroize();

        // TOTP 密钥与密码**同等敏感**：拿到它就能无限生成有效的动态验证码，
        // 二次验证因此完全失效。此前漏在清零范围之外。
        if let Some(t) = self.totp.as_mut() {
            t.zeroize();
        }

        // 自定义字段里可能存卡号、证件号（`secret: true`），
        // 全部擦除——非敏感字段多擦一遍的成本可以忽略。
        for f in self.fields.iter_mut() {
            f.value.zeroize();
            f.label.zeroize();
        }
    }
}

impl Drop for Field {
    fn drop(&mut self) {
        self.label.zeroize();
        self.value.zeroize();
    }
}

/// 手写 Debug：密码与备注打码，避免 `{:?}` 泄漏。
impl fmt::Debug for Entry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Entry")
            .field("id", &self.id)
            .field("title", &self.title)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .field("url", &self.url)
            .field("category", &self.category)
            .field(
                "notes",
                &if self.notes.is_empty() {
                    ""
                } else {
                    "<redacted>"
                },
            )
            .field("favorite", &self.favorite)
            .field("deleted_at", &self.deleted_at)
            .field("password_changed_at", &self.password_changed_at)
            .field("kind", &self.kind)
            .field("fields", &format_args!("<{} fields>", self.fields.len()))
            .field("totp", &self.totp.as_ref().map(|_| "<redacted>"))
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct VaultData {
    pub version: u32,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub settings: Settings,
    pub categories: Vec<String>,
    /// 条目类型（名称 + 默认字段模板）。默认是四个内置类型。
    #[serde(default = "default_types")]
    pub types: Vec<TypeDef>,
    pub entries: Vec<Entry>,
}

impl Default for VaultData {
    fn default() -> Self {
        Self {
            version: 2,
            created_at: now_iso(),
            updated_at: now_iso(),
            settings: Settings::default(),
            categories: DEFAULT_CATEGORIES.iter().map(|s| s.to_string()).collect(),
            types: default_types(),
            entries: Vec::new(),
        }
    }
}

impl fmt::Debug for VaultData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultData")
            .field("version", &self.version)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .field("settings", &self.settings)
            .field("categories", &self.categories)
            .field("entries", &format_args!("<{} entries>", self.entries.len()))
            .finish()
    }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

fn unb64(text: &str) -> Result<Zeroizing<Vec<u8>>> {
    let v = B64
        .decode(text)
        .map_err(|_| VaultError::Malformed("base64 解码失败"))?;
    Ok(Zeroizing::new(v))
}

/// OS CSPRNG 取随机字节。失败直接报错，绝不退回到弱随机源。
fn fill_random(buf: &mut [u8]) -> Result<()> {
    getrandom::getrandom(buf).map_err(|_| VaultError::Random)
}

/// 取 16 字节盐。
fn random_salt() -> Result<[u8; 16]> {
    let mut salt = [0u8; 16];
    fill_random(&mut salt)?;
    Ok(salt)
}

/// 给路径追加一段后缀（不引入 `OsString::push` 的覆盖语义，避免误吞扩展名）。
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn tmp_path(path: &Path) -> PathBuf {
    append_suffix(path, ".tmp")
}

/// 原子写入：临时文件 → fsync → rename。
///
/// 相比原实现补上了 `sync_all()`：
/// 没有 fsync 时，rename 只保证目录项改名，文件内容可能还在页缓存里，
/// 断电会留下「文件名对、内容是半截」的库。
/// 构造「写失败且旧文件也没能挪回来」时的错误文案。
///
/// 单独抽出来是为了能测：真实的双重失败在文件系统上很难稳定复现，
/// 但这句文案是用户唯一的线索——必须包含留档文件的**完整名字**，
/// 否则他不知道该把哪个文件改回 `vault.dat`。
fn rollback_failure_message(write_err: &str, aside: &Path) -> String {
    let name = aside
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| aside.display().to_string());
    format!(
        "写入失败（{write_err}），且旧库文件无法还原。
你的数据仍在「{name}」里（与 vault.dat 同一目录）。
请手工把它改回 vault.dat 后再打开钥巢。"
    )
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = tmp_path(path);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(VaultError::Io(e));
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* AAD：必须与加密时的字节完全一致，否则解不开                            */
/* ------------------------------------------------------------------ */

/// v1 的 AAD：与 Node 版 `aadOf()` 逐字节一致，仅用于打开旧文件。
#[derive(Serialize)]
struct AadV1<'a> {
    format: &'a str,
    kdf: AadV1Kdf<'a>,
    salt: &'a str,
}

#[derive(Serialize)]
struct AadV1Kdf<'a> {
    algo: &'a str,
    #[serde(rename = "N")]
    n: u64,
    r: u32,
    p: u32,
}

/// v1 AAD。参数已校验过，这里不再静默吞掉序列化错误。
fn aad_v1(kdf: &KdfParams, n: u64, r: u32, p: u32) -> Result<Vec<u8>> {
    let shape = AadV1 {
        format: FORMAT_V1,
        kdf: AadV1Kdf {
            algo: &kdf.algo,
            n,
            r,
            p,
        },
        salt: &kdf.salt,
    };
    // 原实现是 `unwrap_or_default()`：序列化失败会退化成空 AAD，
    // 等于关掉参数绑定（降级攻击面）。这里改为显式报错。
    serde_json::to_vec(&shape).map_err(|_| VaultError::Crypto("AAD 序列化失败"))
}

/// v2 的 AAD：规范定长拼接，不依赖 JSON 键顺序，参数任何一位改动都会解密失败。
fn aad_v2(kdf: &KdfParams) -> Result<Vec<u8>> {
    let m = kdf.m_cost.ok_or(VaultError::Malformed("缺少 m_cost"))?;
    let t = kdf.t_cost.ok_or(VaultError::Malformed("缺少 t_cost"))?;
    let p = kdf.p_cost.ok_or(VaultError::Malformed("缺少 p_cost"))?;
    Ok(format!(
        "keynest.v2|{}|m={}|t={}|p={}|salt={}",
        kdf.algo, m, t, p, kdf.salt
    )
    .into_bytes())
}

/* ------------------------------------------------------------------ */
/* KDF                                                                 */
/* ------------------------------------------------------------------ */

/// 校验 v1 scrypt 参数并换算成 log_n。
fn scrypt_params_of(kdf: &KdfParams) -> Result<(u8, u32, u32)> {
    let n = kdf.n.ok_or(VaultError::Malformed("缺少 N"))?;
    let r = kdf.r.ok_or(VaultError::Malformed("缺少 r"))?;
    let p = kdf.p.ok_or(VaultError::Malformed("缺少 p"))?;

    if n < 2 || !n.is_power_of_two() {
        return Err(VaultError::Malformed("N 必须是 2 的幂"));
    }
    let log_n = n.trailing_zeros() as u8;
    if log_n > SCRYPT_LOG_N_MAX {
        return Err(VaultError::Malformed("N 过大"));
    }
    if r == 0 || r > SCRYPT_R_MAX {
        return Err(VaultError::Malformed("r 越界"));
    }
    if p == 0 || p > SCRYPT_P_MAX {
        return Err(VaultError::Malformed("p 越界"));
    }
    // 关键：单独看 N、r 都合法，乘积却可能高达 4 GiB。
    let mem = n
        .checked_mul(r as u64)
        .and_then(|v| v.checked_mul(128))
        .ok_or(VaultError::Malformed("scrypt 参数溢出"))?;
    if mem > SCRYPT_MEM_LIMIT {
        return Err(VaultError::Malformed("scrypt 内存需求超限"));
    }
    Ok((log_n, r, p))
}

fn argon2_params_of(kdf: &KdfParams) -> Result<(u32, u32, u32)> {
    let m = kdf.m_cost.ok_or(VaultError::Malformed("缺少 m_cost"))?;
    let t = kdf.t_cost.ok_or(VaultError::Malformed("缺少 t_cost"))?;
    let p = kdf.p_cost.ok_or(VaultError::Malformed("缺少 p_cost"))?;

    if !(8..=ARGON2_M_COST_MAX).contains(&m) {
        return Err(VaultError::Malformed("m_cost 越界"));
    }
    if t == 0 || t > ARGON2_T_COST_MAX {
        return Err(VaultError::Malformed("t_cost 越界"));
    }
    if p == 0 || p > ARGON2_P_COST_MAX {
        return Err(VaultError::Malformed("p_cost 越界"));
    }
    Ok((m, t, p))
}

/// 派生主密钥。
///
/// 返回值是 [`SecretKey`]：密钥被放进一个页对齐、尽量锁定在物理内存里的容器，
/// drop 时先擦除再解锁。这比单纯 `Zeroizing<[u8; 32]>` 多挡住「换页 / 休眠 / 转储」三条泄漏路径。
fn derive_key(master: &str, salt: &[u8], kdf: &KdfParams) -> Result<SecretKey> {
    match kdf.algo.as_str() {
        ALGO_ARGON2ID => {
            use argon2::{Algorithm, Argon2, Params, Version};

            let (m, t, p) = argon2_params_of(kdf)?;
            if salt.len() < ARGON2_SALT_MIN {
                return Err(VaultError::Malformed("salt 过短"));
            }

            let params = Params::new(m, t, p, Some(KEY_LEN))
                .map_err(|_| VaultError::Kdf("Argon2id 参数非法"))?;
            let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

            let mut key = Zeroizing::new([0u8; KEY_LEN]);
            argon
                .hash_password_into(master.as_bytes(), salt, key.as_mut())
                .map_err(|_| VaultError::Kdf("Argon2id 派生失败"))?;
            Ok(SecretKey::new(*key))
        }
        ALGO_SCRYPT => {
            let (log_n, r, p) = scrypt_params_of(kdf)?;
            if salt.len() < SCRYPT_SALT_MIN {
                return Err(VaultError::Malformed("salt 过短"));
            }

            let sp = scrypt::Params::new(log_n, r, p, KEY_LEN)
                .map_err(|_| VaultError::Kdf("scrypt 参数非法"))?;

            let mut key = Zeroizing::new([0u8; KEY_LEN]);
            scrypt::scrypt(master.as_bytes(), salt, &sp, key.as_mut())
                .map_err(|_| VaultError::Kdf("scrypt 派生失败"))?;
            Ok(SecretKey::new(*key))
        }
        _ => Err(VaultError::UnsupportedFormat),
    }
}

/* ------------------------------------------------------------------ */
/* 加解密                                                              */
/* ------------------------------------------------------------------ */

/// XChaCha20-Poly1305 加密，nonce 每次随机。
///
/// 拆成「算法级」函数是为了让 v1/v2（按 header 分发）与 v3（固定算法）
/// 复用同一份实现，避免同一个 crate 里存在两份 XChaCha 调用写法。
fn seal_xchacha(key: &[u8; KEY_LEN], aad: &[u8], plain: &[u8]) -> Result<(CipherParams, Vec<u8>)> {
    let mut nonce = [0u8; 24];
    fill_random(&mut nonce)?;

    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| VaultError::Crypto("密钥长度不合法"))?;
    let out = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| VaultError::Crypto("加密失败"))?;

    let (ct, tag) = out.split_at(out.len() - TAG_LEN);
    Ok((
        CipherParams {
            algo: CIPHER_XCHACHA.into(),
            iv: b64(&nonce),
            tag: b64(tag),
        },
        ct.to_vec(),
    ))
}

/// AES-256-GCM 加密，仅用于 v1 兼容写入路径。
fn seal_aes(key: &[u8; KEY_LEN], aad: &[u8], plain: &[u8]) -> Result<(CipherParams, Vec<u8>)> {
    let mut iv = [0u8; 12];
    fill_random(&mut iv)?;

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| VaultError::Crypto("密钥长度不合法"))?;
    let out = cipher
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plain, aad })
        .map_err(|_| VaultError::Crypto("加密失败"))?;

    let (ct, tag) = out.split_at(out.len() - TAG_LEN);
    Ok((
        CipherParams {
            algo: CIPHER_AES_GCM.into(),
            iv: b64(&iv),
            tag: b64(tag),
        },
        ct.to_vec(),
    ))
}

/// 用当前 header 对应的算法加密明文（v1 / v2 路径）。
fn seal(key: &[u8; KEY_LEN], kdf: &KdfParams, plain: &[u8]) -> Result<(CipherParams, Vec<u8>)> {
    match kdf.algo.as_str() {
        // v2：XChaCha20-Poly1305。GCM 的 96 位随机 nonce 在高频保存下存在生日碰撞的
        // 理论风险，一旦 nonce 复用即灾难性失效；192 位 nonce 可以纯随机生成。
        ALGO_ARGON2ID => {
            let aad = aad_v2(kdf)?;
            seal_xchacha(key, &aad, plain)
        }
        // v1 兼容路径，逻辑与 AAD 形状保持与原实现一致。
        ALGO_SCRYPT => {
            let (_, r, p) = scrypt_params_of(kdf)?;
            let n = kdf.n.ok_or(VaultError::Malformed("缺少 N"))?;
            let aad = aad_v1(kdf, n, r, p)?;
            seal_aes(key, &aad, plain)
        }
        _ => Err(VaultError::UnsupportedFormat),
    }
}

/// XChaCha20-Poly1305 解密。
///
/// nonce 长度前置校验：原实现直接 `Nonce::from_slice`，文件里的 iv 一旦被截断，
/// `GenericArray::from_slice` 会 panic。
fn open_xchacha(
    key: &[u8; KEY_LEN],
    aad: &[u8],
    cipher: &CipherParams,
    payload_b64: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    let ct = unb64(payload_b64)?;
    let tag = unb64(&cipher.tag)?;
    let iv = unb64(&cipher.iv)?;

    if tag.len() != TAG_LEN {
        return Err(VaultError::Malformed("tag 长度非法"));
    }
    let nonce: [u8; 24] = iv
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::Malformed("XChaCha nonce 长度非法"))?;

    let mut all = Zeroizing::new(Vec::with_capacity(ct.len() + tag.len()));
    all.extend_from_slice(ct.as_slice());
    all.extend_from_slice(tag.as_slice());

    let c =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| VaultError::Crypto("密钥长度不合法"))?;
    c.decrypt(XNonce::from_slice(&nonce), Payload { msg: &all, aad })
        .map(Zeroizing::new)
        .map_err(|_| VaultError::InvalidPassword)
}

/// AES-256-GCM 解密，仅用于 v1 兼容读取。
fn open_aes(
    key: &[u8; KEY_LEN],
    aad: &[u8],
    cipher: &CipherParams,
    payload_b64: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    let mut ct = unb64(payload_b64)?;
    let tag = unb64(&cipher.tag)?;
    let iv = unb64(&cipher.iv)?;

    if tag.len() != TAG_LEN {
        return Err(VaultError::Malformed("tag 长度非法"));
    }
    let nonce: [u8; 12] = iv
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::Malformed("AES-GCM nonce 长度非法"))?;

    ct.extend_from_slice(tag.as_slice());
    let c = Aes256Gcm::new_from_slice(key).map_err(|_| VaultError::Crypto("密钥长度不合法"))?;
    c.decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| VaultError::InvalidPassword)
}

/// 解密 v1 / v2 文件。返回的明文用 `Zeroizing` 包裹，用完即清零。
fn open(file: &VaultFile, key: &[u8; KEY_LEN]) -> Result<Zeroizing<Vec<u8>>> {
    match file.cipher.algo.as_str() {
        CIPHER_XCHACHA => {
            let aad = aad_v2(&file.kdf)?;
            open_xchacha(key, &aad, &file.cipher, &file.payload)
        }
        CIPHER_AES_GCM => {
            let n = file.kdf.n.ok_or(VaultError::Malformed("缺少 N"))?;
            let r = file.kdf.r.ok_or(VaultError::Malformed("缺少 r"))?;
            let p = file.kdf.p.ok_or(VaultError::Malformed("缺少 p"))?;
            let aad = aad_v1(&file.kdf, n, r, p)?;
            open_aes(key, &aad, &file.cipher, &file.payload)
        }
        _ => Err(VaultError::UnsupportedFormat),
    }
}

/* ------------------------------------------------------------------ */
/* 统一打开：v1 / v2 / v3 共用一条路径                                   */
/* ------------------------------------------------------------------ */

/// 一次成功打开后的全部状态。
///
/// 抽出来是因为 `unlock()` 与 `restore_from_backup()` 需要完全相同的逻辑，
/// 而这两条路径恰恰是最不能有分歧的地方：恢复时少校验一步，
/// 就等于给「用坏备份覆盖好库」开了口子。
struct Opened {
    key: SecretKey,
    header: KdfParams,
    /// v3 才有：被 KEK 包裹的 DEK，落盘时要原样写回。
    wrap: Option<DekWrap>,
    /// v3 才有：当前正文密文，换主密码时可原样复用。
    cache: Option<(CipherParams, String)>,
    data: VaultData,
}

/// 用主密码打开任意一代格式。失败一律映射为「主密码错误或文件损坏」。
fn open_any(any: &AnyFile, master: &str) -> Result<Opened> {
    match any {
        AnyFile::Legacy(f) => {
            let salt = unb64(&f.kdf.salt)?;
            let key = derive_key(master, salt.as_slice(), &f.kdf)?;
            let plain = open(f, key.as_bytes())?;
            let mut data: VaultData = serde_json::from_slice(plain.as_slice())
                .map_err(|_| VaultError::InvalidPassword)?;
            data.migrate_legacy();
            Ok(Opened {
                key,
                header: f.kdf.clone(),
                wrap: None,
                cache: None,
                data,
            })
        }
        AnyFile::V3(f) => {
            let salt = unb64(&f.kdf.salt)?;
            let kek = derive_key(master, salt.as_slice(), &f.kdf)?;
            let dek = unwrap_dek(&kek, &f.kdf, &f.dek)?;
            let plain = open_body(&dek, &f.cipher, &f.payload)?;
            let mut data: VaultData = serde_json::from_slice(plain.as_slice())
                .map_err(|_| VaultError::InvalidPassword)?;
            data.migrate_legacy();
            Ok(Opened {
                key: dek,
                header: f.kdf.clone(),
                wrap: Some(f.dek.clone()),
                cache: Some((f.cipher.clone(), f.payload.clone())),
                data,
            })
        }
    }
}

/// 用**已有密钥**重新解开磁盘上的一份文件。
///
/// 与 `open_any` 的区别：不派生 KDF（不要求主密码），直接用现有密钥解密。
/// 用于 `reload()`：库被外部改动后重新载入，此时会话里的密钥仍然有效。
///
/// 密钥与文件不匹配时解密会失败——恰好能区分"同一个库被改过"
/// 与"换成了别的库"，不需要额外的身份标记。
///
/// 返回 `(数据, v3 的正文缓存)`。
fn open_with_key(
    any: &AnyFile,
    key_bytes: &[u8],
) -> Result<(VaultData, Option<(CipherParams, String)>)> {
    match any {
        AnyFile::Legacy(f) => {
            let mut tmp = [0u8; KEY_LEN];
            if key_bytes.len() != KEY_LEN {
                return Err(VaultError::Corrupt);
            }
            tmp.copy_from_slice(key_bytes);
            let plain = open(f, &tmp)?;
            let mut data: VaultData =
                serde_json::from_slice(plain.as_slice()).map_err(|_| VaultError::Corrupt)?;
            data.migrate_legacy();
            Ok((data, None))
        }
        AnyFile::V3(f) => {
            // 复制一份再交给 SecretKey（它会把传入数组清零）。
            // 不能把会话里那把密钥的字节直接传进去——那会被清零，
            // 之后整个会话就再也保存不了了。
            let mut tmp = [0u8; KEY_LEN];
            if key_bytes.len() != KEY_LEN {
                return Err(VaultError::Corrupt);
            }
            tmp.copy_from_slice(key_bytes);
            let dek = SecretKey::new(tmp);
            let plain = open_body(&dek, &f.cipher, &f.payload)?;
            let mut data: VaultData =
                serde_json::from_slice(plain.as_slice()).map_err(|_| VaultError::Corrupt)?;
            data.migrate_legacy();
            Ok((data, Some((f.cipher.clone(), f.payload.clone()))))
        }
    }
}

/// 推荐的 KDF 下限。
///
/// 这不是"能不能解开"的门槛，而是"够不够扛离线爆破"的门槛。
/// 低于它的库仍然能正常打开——拒绝打开一个用户的真实数据是不可接受的——
/// 但界面要明确告诉他该升级了。
pub const RECOMMENDED_ARGON2_M_COST: u32 = 65536;
pub const RECOMMENDED_ARGON2_T_COST: u32 = 3;
pub const RECOMMENDED_SCRYPT_LOG_N: u8 = 17;
pub const RECOMMENDED_SCRYPT_R: u32 = 8;

/// 清洗自定义字段：丢掉空行、去首尾空白、限制数量与长度。
fn sanitize_fields(fields: Vec<Field>) -> Vec<Field> {
    let mut out = Vec::with_capacity(fields.len().min(MAX_FIELDS));
    for f in fields {
        let label = f.label.trim().to_string();
        let value = f.value.trim_end().to_string();
        if label.is_empty() && value.is_empty() {
            continue;
        }
        // 只有值没有标签的，给个占位名，否则界面上会出现一行空白
        let label = if label.is_empty() {
            "字段".to_string()
        } else {
            label
        };
        out.push(Field {
            label: label.chars().take(64).collect(),
            value: value.chars().take(4096).collect(),
            secret: f.secret,
        });
        if out.len() >= MAX_FIELDS {
            break;
        }
    }
    out
}

/// 检查条目各字段的长度上限。
///
/// 长度按**字符数**算而不是字节数：中文一个字占 3 字节，
/// 按字节算会让中文用户实际能用到的长度只有预期的三分之一。
fn check_entry_lengths(e: &Entry) -> Result<()> {
    fn check(name: &str, len: usize, max: usize) -> Result<()> {
        if len > max {
            return Err(VaultError::FieldTooLong(name.to_string(), max));
        }
        Ok(())
    }
    check("标题", e.title.chars().count(), MAX_TITLE_CHARS)?;
    check("账号", e.username.chars().count(), MAX_USERNAME_CHARS)?;
    check("密码", e.password.chars().count(), MAX_PASSWORD_CHARS)?;
    check("网址", e.url.chars().count(), MAX_URL_CHARS)?;
    check("备注", e.notes.chars().count(), MAX_NOTES_CHARS)?;
    check("分类", e.category.chars().count(), MAX_CATEGORY_CHARS)?;
    check("类型", e.kind.chars().count(), MAX_KIND_CHARS)?;
    if let Some(t) = e.totp.as_deref() {
        check("验证码配置", t.chars().count(), MAX_TOTP_CHARS)?;
    }
    Ok(())
}

/// 取 32 字节随机数据密钥。
fn random_key() -> Result<[u8; KEY_LEN]> {
    let mut key = [0u8; KEY_LEN];
    fill_random(&mut key)?;
    Ok(key)
}

/* ------------------------------------------------------------------ */
/* 头校验：只依赖文件本身，不需要密钥                                    */
/* ------------------------------------------------------------------ */

/// 校验 header 的自洽性：格式、算法配对、参数范围、nonce/tag 长度。
///
/// 这个函数刻意不看 payload 的**内容**（那需要密钥），但足以识别两类文件：
/// * 被截断、被别的程序改坏的；
/// * 格式与算法被手工拼成「能读但语义错乱」的。
fn validate_header(file: &VaultFile) -> Result<()> {
    match file.format.as_str() {
        FORMAT_V1 | FORMAT_V2 => {}
        _ => return Err(VaultError::UnsupportedFormat),
    }

    // 格式与算法必须成对出现。原实现只按 cipher.algo 分发，
    // 于是「format 写 v1、算法却是 v2」这种文件会被静默接受。
    let expect_iv_len = match (file.kdf.algo.as_str(), file.cipher.algo.as_str()) {
        (ALGO_ARGON2ID, CIPHER_XCHACHA) => {
            argon2_params_of(&file.kdf)?;
            if file.format != FORMAT_V2 {
                return Err(VaultError::Malformed("format 与 KDF 算法不匹配"));
            }
            24
        }
        (ALGO_SCRYPT, CIPHER_AES_GCM) => {
            scrypt_params_of(&file.kdf)?;
            if file.format != FORMAT_V1 {
                return Err(VaultError::Malformed("format 与 KDF 算法不匹配"));
            }
            12
        }
        _ => return Err(VaultError::Malformed("格式、KDF 与加密算法不匹配")),
    };

    let salt = unb64(&file.kdf.salt)?;
    let min_salt = match file.kdf.algo.as_str() {
        ALGO_ARGON2ID => ARGON2_SALT_MIN,
        _ => SCRYPT_SALT_MIN,
    };
    if salt.len() < min_salt {
        return Err(VaultError::Malformed("salt 过短"));
    }

    let iv = unb64(&file.cipher.iv)?;
    if iv.len() != expect_iv_len {
        return Err(VaultError::Malformed("nonce 长度非法"));
    }

    let tag = unb64(&file.cipher.tag)?;
    if tag.len() != TAG_LEN {
        return Err(VaultError::Malformed("tag 长度非法"));
    }

    // payload 必须是合法 base64。否则后面解密只会得到「密码错误」，
    // 把真实的「文件已损坏」掩盖成「你密码打错了」。
    let _ = unb64(&file.payload)?;

    Ok(())
}

/// 校验 v3 header 的自洽性：KEK 参数、DEK 包裹块、正文参数。
///
/// 与 [`validate_header`] 一样不碰 payload 内容，但 v3 多了一层「包裹块」要查：
/// 包裹块长度不对意味着这个文件即使密码正确也解不出 DEK，属于损坏而不是密码错。
fn validate_header_v3(file: &VaultFileV3) -> Result<()> {
    if file.format != FORMAT_V3 {
        return Err(VaultError::Malformed("format 与 v3 结构不匹配"));
    }

    // 只允许 argon2id 做 KEK：v3 是新格式，没有历史包袱，没有理由接受 scrypt。
    if file.kdf.algo != ALGO_ARGON2ID {
        return Err(VaultError::Malformed("v3 的 KEK 必须是 argon2id"));
    }
    argon2_params_of(&file.kdf)?;
    let salt = unb64(&file.kdf.salt)?;
    if salt.len() < ARGON2_SALT_MIN {
        return Err(VaultError::Malformed("salt 过短"));
    }

    // DEK 包裹块
    if file.dek.algo != CIPHER_XCHACHA {
        return Err(VaultError::Malformed("DEK 包裹算法不受支持"));
    }
    if unb64(&file.dek.iv)?.len() != 24 {
        return Err(VaultError::Malformed("DEK 包裹 nonce 长度非法"));
    }
    if unb64(&file.dek.tag)?.len() != TAG_LEN {
        return Err(VaultError::Malformed("DEK 包裹 tag 长度非法"));
    }
    let wrapped = unb64(&file.dek.wrapped)?;
    if wrapped.len() != KEY_LEN {
        return Err(VaultError::Malformed("DEK 密文长度非法"));
    }

    // 正文
    if file.cipher.algo != CIPHER_XCHACHA {
        return Err(VaultError::Malformed("正文算法不受支持"));
    }
    if unb64(&file.cipher.iv)?.len() != 24 {
        return Err(VaultError::Malformed("nonce 长度非法"));
    }
    if unb64(&file.cipher.tag)?.len() != TAG_LEN {
        return Err(VaultError::Malformed("tag 长度非法"));
    }
    let _ = unb64(&file.payload)?;

    Ok(())
}

/// 不解密、只按结构判断一段字节是不是完好的库文件。
fn is_structurally_valid(bytes: &[u8]) -> bool {
    match AnyFile::parse(bytes) {
        Ok(f) => f.validate().is_ok(),
        Err(_) => false,
    }
}

/// 把库文件读成内存字节，并套上大小上限。
pub(crate) fn read_vault_bytes(path: &Path) -> Result<Vec<u8>> {
    let meta = fs::metadata(path)?;
    if meta.len() > MAX_VAULT_BYTES {
        return Err(VaultError::Malformed("库文件过大"));
    }
    Ok(fs::read(path)?)
}

/* ------------------------------------------------------------------ */
/* 磁盘指纹：用来发现「文件被别的程序改过」                              */
/* ------------------------------------------------------------------ */

/// 我们上次写出去的那一版文件的指纹。
///
/// 只取 `(长度, updatedAt)`：
/// * `updatedAt` 每次保存都重新生成，回滚到旧版一定会变；
/// * 不取 mtime —— 杀毒软件、备份工具、同步盘都会「摸」一下 mtime，
///   用它判等会造成大批误报，反而逼用户把这个保护关掉。
#[derive(Clone, PartialEq, Eq, Debug)]
struct DiskStamp {
    len: u64,
    updated_at: String,
}

impl DiskStamp {
    fn of(bytes: &[u8]) -> Result<Self> {
        let file = AnyFile::parse(bytes)?;
        Ok(Self {
            len: bytes.len() as u64,
            updated_at: file.updated_at().to_string(),
        })
    }
}

/* ------------------------------------------------------------------ */
/* Vault                                                               */
/* ------------------------------------------------------------------ */

/// 一份可用备份的描述，供界面直接展示。
#[derive(Clone, Debug)]
pub struct BackupInfo {
    pub path: PathBuf,
    pub bytes: u64,
    /// 该备份内数据的最后更新时间（RFC3339）。解析失败时为空串。
    pub updated_at: String,
}

/// 一份「恢复留档」：从备份恢复时把原来那份挪到一边留下的文件。
///
/// 里面的内容可能是损坏的库，也可能是用户手工改坏的版本。
/// 保留它是为了"还能抢救"，但不是让人一直攒着——
/// 所以设置页要能看到并能清理。
#[derive(Clone, Debug)]
pub struct RecoveryLeftover {
    pub path: PathBuf,
    pub bytes: u64,
    /// 文件修改时间（RFC3339，秒精度）。取不到时为空串。
    pub modified: String,
}

pub struct Vault {
    pub path: PathBuf,
    /// 派生密钥。`SecretKey` 负责放进锁定的页并在 drop 时清零 + 解锁。
    key: Option<SecretKey>,
    header: Option<KdfParams>,
    /// v3 才有：被 KEK 包裹的 DEK。`None` 表示仍是 v1/v2。
    wrap: Option<DekWrap>,
    /// v3 才有：上次落盘的正文密文，换主密码时可原样复用。
    body_cache: Option<(CipherParams, String)>,
    data: Option<VaultData>,
    /// 上次成功写盘后的指纹；`None` 表示「还不知道盘上是什么」。
    on_disk: Option<DiskStamp>,
}

impl Vault {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            key: None,
            header: None,
            wrap: None,
            body_cache: None,
            data: None,
            on_disk: None,
        }
    }

    /// 旧版单份备份的路径（`vault.dat.bak`）。
    ///
    /// 保留这个名字是为了让 `wipe()` 能连带清掉老版本留下的文件；
    /// 新版备份改成了多代轮转，见 [`Vault::backup_slots`]。
    pub fn backup_path(&self) -> PathBuf {
        append_suffix(&self.path, ".bak")
    }

    /// 第 `slot` 代备份的路径，`1` 为最新。`slot` 从 1 开始，越界返回最后一代。
    pub fn backup_slot(&self, slot: usize) -> PathBuf {
        let slot = slot.clamp(1, BACKUP_GENERATIONS);
        append_suffix(&self.path, &format!(".bak.{slot}"))
    }

    fn backup_slots(&self) -> Vec<PathBuf> {
        (1..=BACKUP_GENERATIONS)
            .map(|i| self.backup_slot(i))
            .collect()
    }

    /// 现存的备份，**新的在前**。
    ///
    /// `updated_at` 取自备份文件自身的明文头部，含义是「这份备份里的数据截止到什么时候」，
    /// 比文件系统的 mtime 更贴近用户的理解（mtime 会被复制/同步改掉）。
    pub fn list_backups(&self) -> Vec<BackupInfo> {
        let mut candidates = self.backup_slots();
        candidates.push(self.backup_path()); // 旧版单份备份排在最后

        let mut out = Vec::new();
        for path in candidates {
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let updated_at = fs::read(&path)
                .ok()
                .and_then(|b| AnyFile::parse(&b).ok())
                .map(|f| f.updated_at().to_string())
                .unwrap_or_default();
            out.push(BackupInfo {
                path,
                bytes: meta.len(),
                updated_at,
            });
        }
        out
    }

    /// 恢复前把当前文件挪到一边，不删除（`vault.dat.corrupt-<秒>`）。
    fn set_aside_current(&self) -> Result<Option<PathBuf>> {
        if !self.path.exists() {
            return Ok(None);
        }
        let secs = Utc::now().timestamp();
        let mut aside = append_suffix(&self.path, &format!(".{CORRUPT_PREFIX}{secs}"));
        let mut n = 1;
        while aside.exists() {
            aside = append_suffix(&self.path, &format!(".{CORRUPT_PREFIX}{secs}-{n}"));
            n += 1;
            if n > 100 {
                return Err(VaultError::Io(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "无法为旧库文件找到可用文件名",
                )));
            }
        }
        fs::rename(&self.path, &aside)?;
        Ok(Some(aside))
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    /// 当前库使用的 KDF 算法（未解锁时返回 None）。
    /// 当前库的 KDF 参数是否达到推荐下限。
    ///
    /// `None` 表示还没读到文件头，此时不下判断（不吓唬用户）。
    pub fn kdf_meets_floor(&self) -> Option<bool> {
        Some(self.header.as_ref()?.meets_floor())
    }

    pub fn kdf_algo(&self) -> Option<&str> {
        self.header.as_ref().map(|h| h.algo.as_str())
    }

    /// 是否还是「主密钥即数据密钥」的旧格式（v1 / v2），需要显式升级到 v3。
    pub fn is_legacy(&self) -> bool {
        self.wrap.is_none()
    }

    /// 当前格式标记，供界面显示。
    pub fn format(&self) -> Option<&'static str> {
        if self.wrap.is_some() {
            return Some(FORMAT_V3);
        }
        match self.kdf_algo()? {
            ALGO_SCRYPT => Some(FORMAT_V1),
            ALGO_ARGON2ID => Some(FORMAT_V2),
            _ => None,
        }
    }

    /// 密钥是否真的被锁定在物理内存里。
    ///
    /// `None` = 未解锁；`Some(false)` = 平台拒绝锁定，已降级为零化。
    pub fn key_memory_locked(&self) -> Option<bool> {
        self.key.as_ref().map(|k| k.is_locked())
    }

    /// 新建仓库。使用 v3：Argon2id 派生 KEK，KEK 包裹随机 DEK，DEK 加密正文。
    pub fn create(&mut self, master: &str) -> Result<VaultData> {
        if self.exists() {
            return Err(VaultError::AlreadyExists);
        }
        if master.chars().count() < MIN_MASTER_LEN {
            return Err(VaultError::WeakPassword(MIN_MASTER_LEN));
        }

        let salt = random_salt()?;
        let kdf = KdfParams {
            salt: b64(&salt),
            ..KdfParams::argon2_default()
        };
        let kek = derive_key(master, &salt, &kdf)?;
        let dek = SecretKey::new(random_key()?);
        let wrap = wrap_dek(&kek, &kdf, dek.as_bytes())?;

        self.key = Some(dek);
        self.header = Some(kdf);
        self.wrap = Some(wrap);
        self.body_cache = None;
        self.data = Some(VaultData::default());
        self.save()?;

        // 不再 unwrap：save 成功后 data 一定存在。
        self.data.clone().ok_or(VaultError::Locked)
    }

    /// 打开仓库。自动识别 v1 / v2 / v3。
    pub fn unlock(&mut self, master: &str) -> Result<VaultData> {
        let bytes = match read_vault_bytes(&self.path) {
            Ok(b) => b,
            Err(VaultError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(VaultError::NoVault)
            }
            Err(e) => return Err(e),
        };
        // 这里读到的整份文件都是密文容器（payload 是 base64 密文），
        // 不含任何明文，因此不需要零化缓冲。
        let any = AnyFile::parse(&bytes)?;

        // 先做不依赖密钥的自洽性校验：格式/算法配对、参数范围、nonce 与 tag 长度。
        // 这样「文件坏了」会在解密之前被识别，而不是伪装成「主密码错误」。
        any.validate()?;

        let stamp = DiskStamp {
            len: bytes.len() as u64,
            updated_at: any.updated_at().to_string(),
        };

        let opened = open_any(&any, master)?;

        self.key = Some(opened.key);
        self.header = Some(opened.header);
        self.wrap = opened.wrap;
        self.body_cache = opened.cache;
        self.data = Some(opened.data.clone());
        self.on_disk = Some(stamp);
        Ok(opened.data)
    }

    /// 锁定：密钥清零，数据丢弃（`Entry::drop` 会清零密码）。
    pub fn lock(&mut self) {
        self.key = None; // SecretKey 在 drop 时清零并解锁内存页
        self.header = None;
        self.wrap = None;
        self.body_cache = None;
        self.data = None;
        self.on_disk = None;
    }

    pub fn snapshot(&self) -> Result<VaultData> {
        self.data.clone().ok_or(VaultError::Locked)
    }

    /// 写盘。按当前 header 决定格式（v1 库继续写 v1，v2 库写 v2）。
    ///
    /// 写之前会做两件事：
    /// 1. **外部改动检测**：盘上若已不是我们上次写的那一份，直接拒绝保存，
    ///    而不是把人家的改动整体覆盖掉；
    /// 2. **备份轮转**：把当前文件轮转进 `.bak.1..N`，且只在它结构完好时才占坑。
    pub fn save(&mut self) -> Result<()> {
        self.save_inner(false)
    }

    /// 写盘。`reuse_body = true` 表示正文密文不重新加密（只用于换主密码）。
    fn save_inner(&mut self, reuse_body: bool) -> Result<()> {
        // 这两步只需要 &self，必须放在拿密钥/数据的借用之前。
        let current = self.snapshot_current()?;
        if let (Some(bytes), Some(prev)) = (current.as_deref(), self.on_disk.as_ref()) {
            // 读不懂盘上那份文件时也判为「被改过」：
            // 要么别人写坏了，要么有人替换成了别的东西，两种都不该继续覆盖。
            match DiskStamp::of(bytes) {
                Ok(stamp) if &stamp == prev => {}
                _ => return Err(VaultError::ExternalChange),
            }
        }
        // 备份轮转**不能**放在这里。
        //
        // 原来是在写新文件之前轮转，于是：写盘失败时库内容没变，
        // 备份却已经整体移位了一代。连试几次（磁盘满、杀毒软件反复锁文件），
        // 若干代真实历史会被同一个旧内容挤空——这是数据完整性缺陷。
        //
        // 现在改成：先写成功，再由各写盘路径自己去轮转。
        // 这样"备份"永远只记录已经成功落盘过的内容。
        if self.wrap.is_some() {
            self.save_v3(reuse_body, current.as_deref())
        } else {
            self.save_legacy(current.as_deref())
        }
    }

    /// v3 写盘：DEK 加密正文，KEK 包裹块原样写回。
    ///
    /// `previous` 是写盘**之前**盘上的旧内容。新文件成功落盘之后，
    /// 才用它轮转备份——顺序反了会在写盘失败时把历史挤掉。
    fn save_v3(&mut self, reuse_body: bool, previous: Option<&[u8]>) -> Result<()> {
        let kdf = self.header.clone().ok_or(VaultError::Locked)?;
        let wrap = self.wrap.clone().ok_or(VaultError::Locked)?;

        let updated_at = {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            data.updated_at = now_iso();
            data.updated_at.clone()
        };

        let (cipher, payload) = if reuse_body {
            // 换主密码：DEK 没变，正文密文可以逐字节保留。
            // 这正是 DEK / KEK 分离带来的好处——不用为改密码重写整个库。
            self.body_cache.clone().ok_or(VaultError::Corrupt)?
        } else {
            let dek = self.key.as_ref().ok_or(VaultError::Locked)?;
            let data = self.data.as_ref().ok_or(VaultError::Locked)?;
            // 序列化结果含全部明文密码，用 Zeroizing 包裹。
            let plain = Zeroizing::new(serde_json::to_vec(data)?);
            seal_body(dek, plain.as_slice())?
        };

        let file = build_v3(&kdf, &wrap, cipher.clone(), payload.clone(), updated_at);
        let json = Zeroizing::new(serde_json::to_string_pretty(&file)?);
        let len = json.len() as u64;
        write_atomic(&self.path, json.as_bytes())?;

        // 新内容已经落盘，现在才把旧内容推进备份。
        // 即使这一步失败，用户的库也是完好的——只是少了一代历史。
        self.rotate_backup(previous)?;

        self.body_cache = Some((cipher, payload));
        self.on_disk = Some(DiskStamp {
            len,
            updated_at: file.updated_at,
        });
        Ok(())
    }

    /// v1 / v2 写盘：主密钥直接加密正文（旧路径，保持原行为）。
    ///
    /// 与 v3 一样：先写成功，再轮转备份。
    fn save_legacy(&mut self, previous: Option<&[u8]>) -> Result<()> {
        let key = self.key.as_ref().ok_or(VaultError::Locked)?;
        let header = self.header.clone().ok_or(VaultError::Locked)?;

        let data = self.data.as_mut().ok_or(VaultError::Locked)?;
        data.updated_at = now_iso();
        let updated_at = data.updated_at.clone();

        // 序列化结果含全部明文密码，用 Zeroizing 包裹。
        let plain = Zeroizing::new(serde_json::to_vec(&*data)?);
        let (cipher, payload) = seal(key.as_bytes(), &header, plain.as_slice())?;

        let format = match header.algo.as_str() {
            ALGO_ARGON2ID => FORMAT_V2,
            ALGO_SCRYPT => FORMAT_V1,
            _ => return Err(VaultError::UnsupportedFormat),
        };

        let file = VaultFile {
            format: format.to_string(),
            kdf: header,
            cipher,
            updated_at,
            payload: b64(&payload),
        };

        let json = Zeroizing::new(serde_json::to_string_pretty(&file)?);
        let len = json.len() as u64;
        write_atomic(&self.path, json.as_bytes())?;

        self.rotate_backup(previous)?;

        self.on_disk = Some(DiskStamp {
            len,
            updated_at: file.updated_at,
        });
        Ok(())
    }

    /// 读取当前盘上的库文件；不存在返回 `None`。
    fn snapshot_current(&self) -> Result<Option<Vec<u8>>> {
        match fs::metadata(&self.path) {
            Ok(meta) => {
                if meta.len() > MAX_VAULT_BYTES {
                    return Err(VaultError::Malformed("库文件过大"));
                }
                Ok(Some(fs::read(&self.path)?))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(VaultError::Io(e)),
        }
    }

    /// 把当前文件轮转进备份槽（`.bak.1` 最新），最多保留 [`BACKUP_GENERATIONS`] 份。
    ///
    /// 只有结构完好的文件才占坑：一个被截断/损坏的文件不该把上一份好备份挤掉，
    /// 否则「一次损坏」会被放大成「永久丢失」。
    fn rotate_backup(&self, current: Option<&[u8]>) -> Result<()> {
        let Some(bytes) = current else { return Ok(()) };
        if !is_structurally_valid(bytes) {
            return Ok(());
        }

        // 从最旧的一代开始腾位：.bak.4 -> .bak.5，...，.bak.1 -> .bak.2
        for i in (1..BACKUP_GENERATIONS).rev() {
            let from = self.backup_slot(i);
            let to = self.backup_slot(i + 1);
            if from.exists() {
                let _ = fs::remove_file(&to);
                fs::rename(&from, &to)?;
            }
        }
        write_atomic(&self.backup_slot(1), bytes)?;
        Ok(())
    }

    /// 从备份恢复。
    ///
    /// 顺序刻意是「先认证、再动盘」：
    /// 1. 用 `master` 验证备份确实解得开——密码错或备份损坏都在这一步失败，
    ///    此时磁盘上**一个字节都没动**；
    /// 2. 把当前（可能已损坏的）文件改名留档，不删除；
    /// 3. 原子写回备份字节；写失败就把留档放回原处，不让用户两头落空；
    /// 4. 用刚解出来的会话直接接管，用户不用再输一次密码。
    pub fn restore_from_backup<P: AsRef<Path>>(
        &mut self,
        backup: P,
        master: &str,
    ) -> Result<VaultData> {
        let backup = backup.as_ref();
        if !backup.is_file() {
            return Err(VaultError::NoBackup);
        }

        let bytes = read_vault_bytes(backup)?;
        let any = AnyFile::parse(&bytes)?;
        any.validate()?;

        let stamp = DiskStamp {
            len: bytes.len() as u64,
            updated_at: any.updated_at().to_string(),
        };
        let opened = open_any(&any, master)?;
        let data = opened.data;

        // —— 到这里备份已被证明可用，才开始动磁盘 ——
        let aside = self.set_aside_current()?;
        if let Err(e) = write_atomic(&self.path, &bytes) {
            // 写新文件失败：把旧文件挪回原位。
            //
            // **还原失败必须让用户知道**。原来这里是 `let _ = fs::rename(...)`，
            // 失败了也照样只报「写入失败」——而实际上库文件已经不在原位，
            // 只剩一份 `vault.dat.corrupt-*`。用户会以为库还在，重启后
            // 才发现打不开，而且不知道该去找哪个文件。
            if let Some(aside) = aside.as_ref() {
                if fs::rename(aside, &self.path).is_err() {
                    return Err(VaultError::Io(std::io::Error::other(
                        rollback_failure_message(&e.to_string(), aside),
                    )));
                }
            }
            return Err(e);
        }

        self.key = Some(opened.key);
        self.header = Some(opened.header);
        self.wrap = opened.wrap;
        self.body_cache = opened.cache;
        self.data = Some(data.clone());
        self.on_disk = Some(stamp);
        Ok(data)
    }

    pub fn upsert_entry(&mut self, mut entry: Entry) -> Result<Entry> {
        if entry.title.trim().is_empty() {
            return Err(VaultError::InvalidEntry);
        }

        // 字段长度上限。
        //
        // 超长时**拒绝**而不是截断：截断会静默丢掉用户的输入，
        // 而他以为自己保存成功了——那是更难发现的数据丢失。
        //
        // 没有这道闸，一个超长备注就能把库撑过 `MAX_VAULT_BYTES`，
        // 从此**再也保存不了**。
        check_entry_lengths(&entry)?;

        // 字段清洗：去空、去重标签、限量。导入的文件里什么都可能有。
        entry.fields = sanitize_fields(std::mem::take(&mut entry.fields));

        // TOTP 在写库前校验并规范化：存进去的东西必须是能算出码的。
        // 允许用户把「带空格/小写/带补位」的密钥贴进来，统一转成标准 URI。
        if let Some(raw) = entry.totp.as_deref() {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                entry.totp = None;
            } else {
                let totp = crate::totp::Totp::parse(trimmed)?;
                entry.totp = Some(totp.to_uri());
            }
        }
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();

        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            let now = now_iso();

            if entry.id.is_empty() {
                entry.id = Uuid::new_v4().to_string();
                entry.created_at = now.clone();
            }
            entry.updated_at = now.clone();

            // 「密码什么时候改过」只认真正的密码变化：
            // 编辑备注、换分类、改网址都不该刷新这个时间。
            entry.password_changed_at = match data.entries.iter().find(|e| e.id == entry.id) {
                Some(existing) if existing.password == entry.password => existing
                    .password_changed_at
                    .clone()
                    .or_else(|| Some(now.clone())),
                Some(_) => Some(now.clone()),
                None => Some(now.clone()),
            };

            match data.entries.iter_mut().find(|e| e.id == entry.id) {
                Some(existing) => *existing = entry.clone(),
                None => data.entries.insert(0, entry.clone()),
            }
            if !data.categories.iter().any(|c| c == &entry.category) {
                data.categories.push(entry.category.clone());
            }
        }

        self.commit(before)?;
        Ok(entry)
    }

    /// 批量导入，并带上**解析阶段**的统计。
    ///
    /// # 为什么单独一个方法
    ///
    /// 解析阶段（CSV/JSON → Entry）已经会丢掉一些条目：没有标题的、
    /// 格式不对的、超出 `MAX_IMPORT_ENTRIES` 的。如果只调用
    /// [`Vault::import_entries`]，这些"在进库之前就丢掉"的条目
    /// **完全不出现在报告里**——用户看到「导入 100 条」，
    /// 而文件里其实有 5000 条，其中 4900 条被悄悄扔了。
    ///
    /// `skipped_invalid` 这个字段本来就在报告里，只是没人给它赋值。
    /// 这个方法把两边的统计合到一起。
    ///
    /// # 去重规则不变
    ///
    /// 「标题 + 账号」已存在就跳过，**绝不覆盖**。
    pub fn import_entries_with_stats(
        &mut self,
        incoming: Vec<Entry>,
        parsed_total: usize,
        invalid: usize,
    ) -> Result<crate::portable::ImportReport> {
        let mut report = self.import_entries(incoming)?;
        // parsed 要包含解析阶段就丢掉的部分——否则「源文件里有 N 条」
        // 这个数字是错的。
        report.parsed = report.parsed.max(parsed_total);
        report.skipped_invalid += invalid;
        Ok(report)
    }

    /// 批量导入：整批只写一次盘，失败整体回滚。
    ///
    /// 去重规则是「标题 + 账号」已存在就跳过，**绝不覆盖**。
    /// 静默覆盖是丢数据最快的方式——用户导入一份旧 CSV，新密码就被冲掉了。
    pub fn import_entries(
        &mut self,
        incoming: Vec<Entry>,
    ) -> Result<crate::portable::ImportReport> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        let mut report = crate::portable::ImportReport {
            parsed: incoming.len(),
            ..Default::default()
        };
        let mut added_any = false;

        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            // 上限在**导入时**就要挡：读盘时的 MAX_VAULT_BYTES 管不到
            // "内存里刚导入进来的一大批条目"。放任它冲进库里的后果是
            // 每次保存都要序列化全部条目、加密结果远超文件上限、
            // 最终保存失败——用户已经看到的条目却存不下去。
            //
            // 注意这里**不提前整体拒绝**：已达上限时仍然走一遍循环，
            // 把每一条如实计入 `skipped_limit`。用户需要看到
            // "有 5 条没导进来"，而不是一个笼统的失败。
            // 只把「活跃」条目算作已存在：用户删掉某条之后重新导入，
            // 说明他想要它回来，不该被回收站里的旧记录挡住。
            let mut seen: std::collections::HashSet<(String, String)> = data
                .entries
                .iter()
                .filter(|e| !e.is_deleted())
                .map(|e| {
                    (
                        e.title.trim().to_lowercase(),
                        e.username.trim().to_lowercase(),
                    )
                })
                .collect();

            for mut e in incoming {
                let title = e.title.trim().to_string();
                if title.is_empty() {
                    report.skipped_invalid += 1;
                    continue;
                }
                if let Some(raw) = e.totp.clone() {
                    match crate::totp::Totp::parse(raw.trim()) {
                        Ok(t) => e.totp = Some(t.to_uri()),
                        Err(_) => {
                            // 验证码配置坏了不影响密码本身，丢掉这一项而不是整条拒绝
                            e.totp = None;
                        }
                    }
                }
                let key = (title.to_lowercase(), e.username.trim().to_lowercase());
                if seen.contains(&key) {
                    report.skipped_existing += 1;
                    continue;
                }

                // 超长字段：跳过这一条，**不要让整批失败**。
                //
                // 导入是「尽力而为」的批量操作：一条有问题不该毁掉另外 999 条。
                // 但也不能放它进去——超长字段会让库超出 MAX_VAULT_BYTES，
                // 从此再也保存不了。
                if let Err(e) = check_entry_lengths(&e) {
                    if e.code() == "FIELD_TOO_LONG" {
                        report.skipped_invalid += 1;
                        continue;
                    }
                    return Err(e);
                }
                seen.insert(key);

                e.id = Uuid::new_v4().to_string();
                e.title = title;
                e.created_at = now_iso();
                e.updated_at = now_iso();
                if e.category.trim().is_empty() {
                    e.category = "其他".into();
                }
                if !data.categories.iter().any(|c| c == &e.category) {
                    data.categories.push(e.category.clone());
                }
                if data.entries.len() >= MAX_ENTRIES {
                    // 达到上限就停，把"没导进去"如实计入报告，
                    // 而不是让整批失败——已经导进来的部分是有价值的。
                    report.skipped_limit += 1;
                    continue;
                }
                data.entries.push(e);
                report.added += 1;
                added_any = true;
            }
        }

        if added_any {
            self.commit(before)?;
        }
        Ok(report)
    }

    /// 删除 = **移入回收站**。
    ///
    /// 不做物理删除：误删是密码管理器最常见的事故，而一条记录只占几百字节，
    /// 留着远比找不回来便宜。真要彻底删，走 [`Vault::purge_entry`]。
    pub fn delete_entry(&mut self, id: &str) -> Result<()> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            let entry = data
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or(VaultError::NotFound)?;
            if entry.deleted_at.is_some() {
                return Err(VaultError::NotFound);
            }
            let now = now_iso();
            entry.deleted_at = Some(now.clone());
            entry.updated_at = now;
        }
        self.commit(before)
    }

    /// 从回收站恢复。
    pub fn restore_entry(&mut self, id: &str) -> Result<()> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            let entry = data
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or(VaultError::NotFound)?;
            if entry.deleted_at.is_none() {
                return Err(VaultError::NotFound);
            }
            entry.deleted_at = None;
            entry.updated_at = now_iso();
        }
        self.commit(before)
    }

    /// 永久删除单条。不可恢复。
    pub fn purge_entry(&mut self, id: &str) -> Result<()> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            let len_before = data.entries.len();
            data.entries.retain(|e| e.id != id);
            if data.entries.len() == len_before {
                return Err(VaultError::NotFound);
            }
        }
        self.commit(before)
    }

    /// 清空回收站，返回删除的条数。
    pub fn empty_trash(&mut self) -> Result<usize> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        let removed;
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            let len_before = data.entries.len();
            data.entries.retain(|e| e.deleted_at.is_none());
            removed = len_before - data.entries.len();
        }
        if removed > 0 {
            self.commit(before)?;
        }
        Ok(removed)
    }

    /// 收藏 / 取消收藏。
    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<()> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            let entry = data
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or(VaultError::NotFound)?;
            if entry.favorite == favorite {
                return Ok(());
            }
            entry.favorite = favorite;
            entry.updated_at = now_iso();
        }
        self.commit(before)
    }

    /// 回收站条目数。
    pub fn trash_count(&self) -> usize {
        self.data
            .as_ref()
            .map(|d| d.entries.iter().filter(|e| e.is_deleted()).count())
            .unwrap_or(0)
    }

    /// 变更后保存；保存失败就把内存状态退回变更前。
    ///
    /// 否则「保存被拒绝」（外部改动、磁盘满）会在内存里留下一个**磁盘上不存在**
    /// 的条目，下一次 `snapshot()` 就会把它当成已保存的数据显示出来。
    fn commit(&mut self, before: VaultData) -> Result<()> {
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.data = Some(before);
                Err(e)
            }
        }
    }

    /// 新增条目类型。
    pub fn add_type(&mut self, name: &str) -> Result<String> {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 24 {
            return Err(VaultError::InvalidCategory);
        }
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            if data.types.iter().any(|t| t.label == trimmed) {
                return Err(VaultError::AlreadyExists);
            }
            data.types.push(TypeDef {
                label: trimmed.to_string(),
                template: Vec::new(),
            });
        }
        self.commit(before)?;
        Ok(trimmed.to_string())
    }

    /// 重命名类型：类型表与所有条目的 `kind` 一起改。
    pub fn rename_type(&mut self, from: &str, to: &str) -> Result<String> {
        let to = to.trim();
        if to.is_empty() || to.chars().count() > 24 {
            return Err(VaultError::InvalidEntry);
        }
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            if !data.types.iter().any(|t| t.label == from) {
                return Err(VaultError::InvalidEntry);
            }
            if from != to && data.types.iter().any(|t| t.label == to) {
                return Err(VaultError::AlreadyExists);
            }
            // 只改标签，模板留在类型自己身上——这正是「改名不丢模板」的关键
            for t in data.types.iter_mut() {
                if t.label == from {
                    t.label = to.to_string();
                }
            }
            for e in data.entries.iter_mut() {
                if e.kind == from {
                    e.kind = to.to_string();
                }
            }
        }
        self.commit(before)?;
        Ok(to.to_string())
    }

    /// 删除类型。旗下条目会归到「账号」。
    ///
    /// 与分类一样：任何类型都能删，但至少保留一个。
    pub fn delete_type(&mut self, name: &str) -> Result<usize> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        let moved;
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            if data.types.len() <= 1 {
                return Err(VaultError::InvalidEntry);
            }
            let Some(pos) = data.types.iter().position(|t| t.label == name) else {
                return Err(VaultError::InvalidEntry);
            };
            data.types.remove(pos);
            let fallback = data.types[0].label.clone();
            moved = data
                .entries
                .iter_mut()
                .filter(|e| e.kind == name)
                .map(|e| {
                    e.kind = fallback.clone();
                })
                .count();
        }
        self.commit(before)?;
        Ok(moved)
    }

    /// 重命名分类：分类表与所有条目的 `category` 一起改。
    ///
    /// 只改分类表不改条目，会让那些条目指向一个不存在的分类——
    /// 界面上它们会从所有分类筛选中消失，看起来像数据丢了。
    pub fn rename_category(&mut self, from: &str, to: &str) -> Result<String> {
        let to = to.trim();
        if to.is_empty() {
            return Err(VaultError::InvalidEntry);
        }
        if to.chars().count() > 32 {
            return Err(VaultError::InvalidEntry);
        }

        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            if !data.categories.iter().any(|c| c == from) {
                return Err(VaultError::InvalidEntry);
            }
            if from != to && data.categories.iter().any(|c| c == to) {
                return Err(VaultError::InvalidEntry);
            }
            for c in data.categories.iter_mut() {
                if c == from {
                    *c = to.to_string();
                }
            }
            for e in data.entries.iter_mut() {
                if e.category == from {
                    e.category = to.to_string();
                }
            }
        }
        self.commit(before)?;
        Ok(to.to_string())
    }

    /// 删除分类。旗下条目会移到剩下的第一个分类。
    ///
    /// 任何分类都能删——包括「其他」。曾经把「其他」设成不可删的兜底，
    /// 但那是替用户做决定：他想删就该能删，只要还有别的分类接得住这些条目。
    /// 唯一硬约束是**至少保留一个分类**，否则条目会没有归属。
    pub fn delete_category(&mut self, name: &str) -> Result<usize> {
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        let moved;
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            if data.categories.len() <= 1 {
                return Err(VaultError::InvalidEntry);
            }
            let Some(pos) = data.categories.iter().position(|c| c == name) else {
                return Err(VaultError::InvalidEntry);
            };
            data.categories.remove(pos);
            let fallback = data.categories[0].clone();
            moved = data
                .entries
                .iter_mut()
                .filter(|e| e.category == name)
                .map(|e| {
                    e.category = fallback.clone();
                })
                .count();
        }
        self.commit(before)?;
        Ok(moved)
    }

    pub fn add_category(&mut self, name: &str) -> Result<String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(VaultError::InvalidCategory);
        }
        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            if !data.categories.iter().any(|c| c == trimmed) {
                data.categories.push(trimmed.to_string());
            }
        }
        self.commit(before)?;
        Ok(trimmed.to_string())
    }

    pub fn update_settings(&mut self, mut settings: Settings) -> Result<()> {
        // 夹紧到安全范围。
        //
        // 在**写入这一层**做，而不是只在 UI 层：UI 可能有多个入口
        // （设置页、将来的快捷键、导入的库），漏一个就会写进危险值。
        // 而且这些值还可能来自旧版本或手工编辑过的库文件。
        settings.auto_lock_minutes = settings.auto_lock_minutes.clamp(1, MAX_AUTO_LOCK_MINUTES);
        settings.clipboard_clear_seconds = settings
            .clipboard_clear_seconds
            .clamp(MIN_CLIPBOARD_SECONDS, MAX_CLIPBOARD_SECONDS);
        settings.reveal_seconds = settings.reveal_seconds.clamp(1, MAX_REVEAL_SECONDS);

        let before = self.data.as_ref().ok_or(VaultError::Locked)?.clone();
        {
            let data = self.data.as_mut().ok_or(VaultError::Locked)?;
            data.settings = settings;
        }
        self.commit(before)
    }

    /// 换主密码。
    ///
    /// * v3：只重新包裹 DEK，正文密文原样保留（毫秒级，与库大小无关）；
    /// * v1 / v2：没有 DEK，只能整体重加密（旧行为）。
    pub fn change_master(&mut self, old_password: &str, new_password: &str) -> Result<()> {
        if new_password.chars().count() < MIN_MASTER_LEN {
            return Err(VaultError::WeakPassword(MIN_MASTER_LEN));
        }

        let header = self.header.clone().ok_or(VaultError::Locked)?;

        // ---------- v3 ----------
        if let Some(wrap) = self.wrap.clone() {
            let salt = unb64(&header.salt)?;
            let old_kek = derive_key(old_password, salt.as_slice(), &header)?;

            // 旧密码是否正确 = 旧 KEK 能否解开包裹，且解出的 DEK 与内存一致。
            // 只比较 KEK 不够：那只能证明密码对，证明不了包裹块没被替换。
            let unwrapped = unwrap_dek(&old_kek, &header, &wrap)?;
            let current = self.key.as_ref().ok_or(VaultError::Locked)?;
            if !current.ct_eq(unwrapped.as_bytes()) {
                return Err(VaultError::InvalidPassword);
            }
            drop(unwrapped);
            drop(old_kek);

            let new_salt = random_salt()?;
            let new_header = KdfParams {
                salt: b64(&new_salt),
                ..KdfParams::argon2_default()
            };
            let new_kek = derive_key(new_password, &new_salt, &new_header)?;
            let new_wrap = wrap_dek(&new_kek, &new_header, current.as_bytes())?;

            // **先把旧状态取出来，改完再写盘，失败就回滚。**
            //
            // 这里不能直接改 self 再保存：写盘失败时内存里已是新 wrap，
            // 磁盘上还是旧库，此后任何一次保存都会把"新 wrap + 旧密码承诺"
            // 写进去——用户重启后旧密码打不开，新密码也从未真正生效。
            // 那是不可逆的数据丢失（库还在，但没人能打开）。
            let old_header = self.header.take();
            let old_wrap = self.wrap.take();

            self.header = Some(new_header);
            self.wrap = Some(new_wrap);
            // 正文不重新加密——这正是 DEK / KEK 分离存在的理由。
            return match self.save_inner(true) {
                Ok(()) => Ok(()),
                Err(e) => {
                    // 回滚到旧 header/wrap，让库继续用旧密码
                    self.header = old_header;
                    self.wrap = old_wrap;
                    Err(e)
                }
            };
        }

        // ---------- v1 / v2 ----------
        let salt = unb64(&header.salt)?;
        // 比较走常量时间实现：`!=` 会在第一个不同字节提前返回，泄漏匹配长度。
        let old_key = derive_key(old_password, salt.as_slice(), &header)?;
        let current = self.key.as_ref().ok_or(VaultError::Locked)?;
        if !current.ct_eq(old_key.as_bytes()) {
            return Err(VaultError::InvalidPassword);
        }

        let new_salt = random_salt()?;
        let new_header = KdfParams {
            salt: b64(&new_salt),
            ..header
        };
        let new_key = derive_key(new_password, &new_salt, &new_header)?;

        // 与 v3 同样的回滚要求：旧库没有 DEK，换密码要整体重加密，
        // 失败时磁盘内容没变，内存里的 key/header 也必须退回去。
        let old_key = self.key.take();
        let old_header = self.header.take();

        self.key = Some(new_key);
        self.header = Some(new_header);
        match self.save() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.key = old_key;
                self.header = old_header;
                Err(e)
            }
        }
    }

    /// 放弃本地未保存的改动，重新载入磁盘上的库。
    ///
    /// # 这个方法解决的现实问题
    ///
    /// 库放在网盘同步目录里，另一台机器改了它、同步过来——`save_inner` 会
    /// 返回 `ExternalChange` 并拒绝保存（这是对的：覆盖会丢掉对方的改动）。
    ///
    /// 但在加这个方法之前，用户**没有任何恢复路径**：`on_disk` 一旦对不上
    /// 就永久对不上，此后每次保存都失败，只能重启程序（丢掉未保存的编辑）
    /// 或手动删文件。
    ///
    /// # 它做什么、不做什么
    ///
    /// - 重新读盘、重新解密，用**已解锁的密钥**重建内存状态
    /// - 不重置 `key` / `header` / `wrap`：密钥还是那一套，只是数据换成盘上的
    /// - 磁盘上的文件如果不是同一个库（换了主密码 / 换了 salt），
    ///   解密会失败——此时返回错误，内存状态保持不变（不会变成半截状态）
    ///
    /// 调用方（GUI）应当先确认用户愿意放弃本地改动。
    pub fn reload(&mut self) -> Result<VaultData> {
        // 未解锁时无从校验密钥，直接拒绝——这不是「载入」而是「打开」，
        // 应当走 `unlock`。
        let key = self.key.as_ref().ok_or(VaultError::Locked)?;

        let bytes = read_vault_bytes(&self.path)?;
        let any = AnyFile::parse(&bytes)?;
        any.validate()?;

        // 用现有密钥解开磁盘上的那一份。
        // `open_with_key` 只在密钥与文件的 wrap/header 匹配时成功——
        // 恰好能区分"同一个库被改过" 与 "换成了别的库"。
        let (data, body_cache) = open_with_key(&any, key.as_bytes())?;

        let stamp = DiskStamp {
            len: bytes.len() as u64,
            updated_at: any.updated_at().to_string(),
        };

        // —— 到这里磁盘上的内容已被证明可用，才开始改内存状态 ——
        self.data = Some(data.clone());
        self.body_cache = body_cache;
        self.on_disk = Some(stamp);
        Ok(data)
    }

    /// 把任意旧格式（v1 / v2）显式升级为 v3（KEK 包裹随机 DEK）。
    ///
    /// 需要再次提供主密码：新的 KEK 只能从主密码派生，无法从旧密钥「转换」。
    ///
    /// 安全要求（对应任务书「迁移必须先备份、可回滚」）：
    /// 1. 先验证主密码，密码错则什么都不做；
    /// 2. 记住旧文件字节；
    /// 3. 写新文件后**用主密码重新打开一次**做验证，而不是自己说自己成功；
    /// 4. 任何一步失败都把旧字节写回去，并用主密码恢复会话状态。
    pub fn upgrade_to_v3(&mut self, master: &str) -> Result<()> {
        if self.wrap.is_some() {
            return Ok(()); // 已是 v3
        }

        let header = self.header.clone().ok_or(VaultError::Locked)?;
        let salt = unb64(&header.salt)?;
        let check = derive_key(master, salt.as_slice(), &header)?;
        let current = self.key.as_ref().ok_or(VaultError::Locked)?;
        if !current.ct_eq(check.as_bytes()) {
            return Err(VaultError::InvalidPassword);
        }
        drop(check);

        // 旧字节留作回滚依据；同时 save() 内部还会把旧文件轮转进 .bak.1。
        let old_bytes = fs::read(&self.path).ok();

        let new_salt = random_salt()?;
        let kdf = KdfParams {
            salt: b64(&new_salt),
            ..KdfParams::argon2_default()
        };
        let kek = derive_key(master, &new_salt, &kdf)?;
        let dek = SecretKey::new(random_key()?);
        let wrap = wrap_dek(&kek, &kdf, dek.as_bytes())?;

        self.key = Some(dek);
        self.header = Some(kdf);
        self.wrap = Some(wrap);
        self.body_cache = None;

        if let Err(e) = self.save() {
            self.rollback_migration(old_bytes, master);
            return Err(e);
        }

        match self.verify_reopen(master) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.rollback_migration(old_bytes, master);
                Err(e)
            }
        }
    }

    /// 迁移后的独立验证：新建一个 `Vault` 实例按正常路径重新打开。
    fn verify_reopen(&self, master: &str) -> Result<()> {
        let expect_entries = self.data.as_ref().ok_or(VaultError::Locked)?.entries.len();
        let mut probe = Vault::new(&self.path);
        let data = probe.unlock(master)?;
        if probe.format() != Some(FORMAT_V3) {
            return Err(VaultError::Corrupt);
        }
        if data.entries.len() != expect_entries {
            return Err(VaultError::Corrupt);
        }
        Ok(())
    }

    /// 迁移失败：把旧字节写回并用主密码恢复会话。
    fn rollback_migration(&mut self, old: Option<Vec<u8>>, master: &str) {
        self.lock();
        let Some(bytes) = old else { return };
        if write_atomic(&self.path, &bytes).is_ok() {
            let _ = self.unlock(master);
        }
    }

    /// 把 v1（scrypt + AES-GCM）库显式升级为 v2（Argon2id + XChaCha）。
    ///
    /// 需要再次提供主密码：Argon2id 的密钥只能从主密码重新派生，
    /// 无法从已有的 scrypt 密钥「转换」得到。
    pub fn upgrade_to_v2(&mut self, master: &str) -> Result<()> {
        let header = self.header.clone().ok_or(VaultError::Locked)?;
        if header.algo == ALGO_ARGON2ID {
            return Ok(()); // 已是 v2
        }

        let salt = unb64(&header.salt)?;
        let check = derive_key(master, salt.as_slice(), &header)?;
        let current = self.key.as_ref().ok_or(VaultError::Locked)?;
        if !current.ct_eq(check.as_bytes()) {
            return Err(VaultError::InvalidPassword);
        }

        let new_salt = random_salt()?;
        let new_header = KdfParams {
            salt: b64(&new_salt),
            ..KdfParams::argon2_default()
        };
        let new_key = derive_key(master, &new_salt, &new_header)?;

        self.key = Some(new_key);
        self.header = Some(new_header);
        self.save()?;
        Ok(())
    }

    /// 列出所有「恢复留档」文件（`vault.dat.corrupt-*`）。
    ///
    /// # 为什么需要它
    ///
    /// 每次从备份恢复都会把原来那份（可能是损坏的）留档到一边，而不是删除——
    /// 这是对的：用户可能还想抢救它。
    ///
    /// 但此前**没有任何途径看到这些文件**。反复恢复失败的用户会在磁盘上
    /// 攒下一堆几百 KB 的留档，既占空间又让人困惑（"这些到底是什么？"），
    /// 而界面上完全无迹可寻。
    ///
    /// 返回按修改时间倒序（最新的在前），便于用户判断哪一份是刚才那次。
    pub fn list_recovery_leftovers(&self) -> Vec<RecoveryLeftover> {
        let Some(dir) = self.path.parent() else {
            return Vec::new();
        };
        let Some(name) = self.path.file_name() else {
            return Vec::new();
        };
        let prefix = format!("{}.{}", name.to_string_lossy(), CORRUPT_PREFIX);

        let Ok(rd) = fs::read_dir(dir) else {
            return Vec::new();
        };

        let mut out: Vec<RecoveryLeftover> = rd
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some(RecoveryLeftover {
                    path: e.path(),
                    bytes: meta.len(),
                    // 时间取修改时间；取不到就留空，不编造。
                    modified: meta
                        .modified()
                        .ok()
                        .map(|t| {
                            let dt: chrono::DateTime<chrono::Utc> = t.into();
                            dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                        })
                        .unwrap_or_default(),
                })
            })
            .collect();

        // 新的在前：用户最可能想处理的是刚才那次留下的
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        out
    }

    /// 删除所有恢复留档，返回删除的数量。
    ///
    /// 只在用户**明确要求**时调用（设置页里那个按钮）。
    /// 与 `wipe()` 不同：这里不动库、不动备份，只清留档。
    pub fn clear_recovery_leftovers(&self) -> Result<usize> {
        let items = self.list_recovery_leftovers();
        let mut removed = 0usize;
        let mut first_err: Option<std::io::Error> = None;
        for it in items {
            match fs::remove_file(&it.path) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        match first_err {
            Some(e) => Err(VaultError::Io(e)),
            None => Ok(removed),
        }
    }

    /// 彻底删除仓库、所有备份代、恢复留档与临时文件。
    ///
    /// 返回第一个真实失败（`NotFound` 不算失败）——原实现全部 `let _ =`，
    /// 于是「删除失败」会被静默吞掉，用户却以为数据已经没了。
    ///
    /// 注意：即便文件被删除，SSD / CoW 文件系统上底层数据仍可能残留。
    /// 本函数**不承诺物理擦除**，这一点必须在文档里如实说明。
    pub fn wipe(&mut self) -> Result<()> {
        self.lock();

        let mut paths = vec![self.path.clone(), tmp_path(&self.path), self.backup_path()];
        paths.extend(self.backup_slots());

        // 恢复留档：vault.dat.corrupt-<秒>
        if let (Some(dir), Some(name)) = (self.path.parent(), self.path.file_name()) {
            if let Ok(rd) = fs::read_dir(dir) {
                let prefix = format!("{}.{}", name.to_string_lossy(), CORRUPT_PREFIX);
                for entry in rd.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(&prefix) {
                        paths.push(entry.path());
                    }
                }
            }
        }

        let mut first_err: Option<std::io::Error> = None;
        for p in paths {
            match fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }

        match first_err {
            Some(e) => Err(VaultError::Io(e)),
            None => Ok(()),
        }
    }
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// 「API Key」类型的字段模板必须齐全，且 Secret 本身要打码。
    ///
    /// 打码不是审美问题：API Key 泄露的经济后果与密码同级
    /// （有人拿它刷你的额度），而它经常被投屏、截屏、录屏。
    #[test]
    fn api_key_template_masks_the_secret_only() {
        let tpl = kinds::template(kinds::APIKEY);
        assert!(!tpl.is_empty(), "API Key 类型应当有字段模板");

        let secret_field = tpl
            .iter()
            .find(|(label, _, _)| *label == "Secret")
            .expect("模板里必须有「Secret」字段");
        assert!(secret_field.1, "「Secret」字段必须打码");

        // 其余字段是辅助信息，不该打码：
        // Key ID 会出现在请求头与日志里，根本不是秘密；
        // 服务商/环境/scope 打码只会让人核对不了。
        for (label, secret, _) in tpl {
            if *label != "Secret" {
                assert!(!secret, "「{label}」不该打码");
            }
        }
    }

    /// 两段式凭据要有地方放：Key ID 与 Secret 必须是**两个**字段。
    ///
    /// AWS / 阿里云这类是「访问密钥 ID + 访问密钥 Secret」两段。
    /// 只给一个 Secret 字段等于存不全，用户只能拿备注补——
    /// 备注不参与搜索高亮、也不能单独复制。
    #[test]
    fn api_key_type_supports_two_part_credentials() {
        let labels: Vec<&str> = kinds::template(kinds::APIKEY)
            .iter()
            .map(|(l, _, _)| *l)
            .collect();
        assert!(labels.contains(&"Key ID"), "缺 Key ID 字段：{labels:?}");
        assert!(labels.contains(&"Secret"), "缺 Secret 字段：{labels:?}");
    }

    /// 环境必须是一等字段——同一服务在 dev / prod 各有一把 key 是常态。
    ///
    /// 没有这个字段，两条记录长得一模一样，只能靠标题里写 `(prod)` 硬分，
    /// 迟早出事故：在开发机上跑了生产 key，或者在生产上跑了测试 key。
    #[test]
    fn api_key_type_has_an_environment_field() {
        let labels: Vec<&str> = kinds::template(kinds::APIKEY)
            .iter()
            .map(|(l, _, _)| *l)
            .collect();
        assert!(labels.contains(&"环境"), "缺「环境」字段：{labels:?}");
    }

    /// 每个内置字段都要有**非空**提示语。
    ///
    /// 「环境」「权限范围」这类字段光有标签不够——用户不知道
    /// 该填 `prod` 还是「生产环境」，也不知道 scope 要不要写全。
    /// 一句示例比一整段说明更容易被读完。
    #[test]
    fn every_builtin_field_has_a_hint() {
        for name in kinds::DEFAULT_TYPES {
            for (label, _, hint) in kinds::template(name) {
                assert!(!hint.is_empty(), "「{name}」的「{label}」字段没有输入提示");
            }
        }
    }

    /// 「API Key」必须在默认类型列表里，且带模板。
    #[test]
    fn api_key_is_a_default_type_with_a_template() {
        assert!(
            kinds::DEFAULT_TYPES.contains(&kinds::APIKEY),
            "API Key 应当是内置类型"
        );
        let defs = default_types();
        let found = defs
            .iter()
            .find(|t| t.label == kinds::APIKEY)
            .expect("默认类型里应当有 API Key");
        assert!(
            !found.template.is_empty(),
            "默认类型里的 API Key 必须带字段模板"
        );
    }

    /// **老库打开后必须出现「API Key」类型。**
    ///
    /// 类型表存在库文件里，所以新加的内置类型不会自动出现在已有库中。
    /// 不补这一步，用户升级后根本找不到这个类型——功能等于没加。
    #[test]
    fn opening_an_old_vault_adds_the_api_key_type() {
        // 造一个「旧库」：只有四个内置类型，没有 API Key
        let mut data = VaultData::default();
        data.types.retain(|t| t.label != kinds::APIKEY);
        assert!(!data.types.iter().any(|t| t.label == kinds::APIKEY));

        data.migrate_legacy();

        let added = data
            .types
            .iter()
            .find(|t| t.label == kinds::APIKEY)
            .expect("打开旧库后应当补上 API Key 类型");
        assert!(!added.template.is_empty(), "补上的类型要带字段模板");
    }

    /// 已经有了就不能重复添加（反复打开库不该堆出五个 API Key）。
    #[test]
    fn migration_is_idempotent_for_the_api_key_type() {
        let mut data = VaultData::default();
        data.migrate_legacy();
        data.migrate_legacy();
        data.migrate_legacy();

        let n = data
            .types
            .iter()
            .filter(|t| t.label == kinds::APIKEY)
            .count();
        assert_eq!(n, 1, "迁移不幂等，出现了 {n} 个 API Key 类型");
    }

    /// 用户**主动删掉**别的内置类型时，迁移不该强行加回来。
    ///
    /// 否则用户每次打开库都会发现自己删掉的类型又冒出来。
    #[test]
    fn migration_does_not_resurrect_user_deleted_types() {
        let mut data = VaultData::default();
        data.types.retain(|t| t.label != kinds::NOTE);
        assert!(!data.types.iter().any(|t| t.label == kinds::NOTE));

        data.migrate_legacy();

        assert!(
            !data.types.iter().any(|t| t.label == kinds::NOTE),
            "迁移把用户删掉的「笔记」类型加回来了"
        );
    }

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn entry(title: &str, pwd: &str) -> Entry {
        Entry {
            id: String::new(),
            title: title.into(),
            username: "u".into(),
            password: pwd.into(),
            url: "https://x.test".into(),
            category: "网站".into(),
            notes: String::new(),
            favorite: false,
            kind: kinds::LOGIN.to_string(),
            fields: Vec::new(),
            totp: None,
            password_changed_at: None,
            deleted_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// 把库文件读成 `serde_json::Value`。
    ///
    /// 篡改类测试必须走 Value，而不是先反序列化成 `VaultFile` 再改：
    /// 那样写回去会**丢字段**（v3 的 `dek` 就没了），测试会以「解析失败」
    /// 通过，看起来绿了，其实什么都没验证。
    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn write_json(path: &Path, v: &serde_json::Value) {
        std::fs::write(path, serde_json::to_string_pretty(v).unwrap()).unwrap();
    }

    /// 测试用快参数，避免每个用例都跑 64MiB Argon2。
    ///
    /// v3 下不能只换 `header`：包裹块是用旧 KEK 封的，换了参数就解不开。
    /// 所以这里连 DEK 一起换新、重新包裹。
    fn fast_vault(dir: &Path) -> Vault {
        let mut v = Vault::new(dir.join("vault.dat"));
        v.create("master-password-123").unwrap();

        let salt = random_salt().unwrap();
        let kdf = KdfParams {
            salt: b64(&salt),
            ..KdfParams::argon2_with(8 * 1024, 2, 1)
        };
        let kek = derive_key("master-password-123", &salt, &kdf).unwrap();
        let dek = SecretKey::new(random_key().unwrap());
        let wrap = wrap_dek(&kek, &kdf, dek.as_bytes()).unwrap();

        v.key = Some(dek);
        v.header = Some(kdf);
        v.wrap = Some(wrap);
        v.body_cache = None;
        v.save().unwrap();
        v
    }

    /// 手工造一个 v1 库（scrypt + AES-GCM）。
    fn make_v1(dir: &Path, master: &str) -> Vault {
        let path = dir.join("v1.dat");
        let mut v = Vault::new(&path);
        let salt = random_salt().unwrap();
        let kdf = KdfParams {
            salt: b64(&salt),
            ..KdfParams::scrypt_default()
        };
        v.key = Some(derive_key(master, &salt, &kdf).unwrap());
        v.header = Some(kdf);
        v.data = Some(VaultData::default());
        v.save().unwrap();
        v
    }

    /// 手工造一个 v2 库（Argon2id + XChaCha，无 DEK）。
    fn make_v2(dir: &Path, master: &str) -> Vault {
        let path = dir.join("v2.dat");
        let mut v = Vault::new(&path);
        let salt = random_salt().unwrap();
        let kdf = KdfParams {
            salt: b64(&salt),
            ..KdfParams::argon2_with(8 * 1024, 2, 1)
        };
        v.key = Some(derive_key(master, &salt, &kdf).unwrap());
        v.header = Some(kdf);
        v.wrap = None;
        v.data = Some(VaultData::default());
        v.save().unwrap();
        v
    }

    #[test]
    fn v3_roundtrip() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        v.upsert_entry(entry("GitHub", "ghP@ss1")).unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        let data = v2.unlock("master-password-123").unwrap();
        assert_eq!(data.entries.len(), 1);
        assert_eq!(data.entries[0].password, "ghP@ss1");
        assert_eq!(v2.kdf_algo(), Some(ALGO_ARGON2ID));
        assert_eq!(v2.format(), Some(FORMAT_V3));
        assert!(!v2.is_legacy());
    }

    #[test]
    fn v3_file_has_dek_wrap_and_body_layers() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let f: VaultFileV3 = serde_json::from_str(&raw).unwrap();
        assert_eq!(f.format, FORMAT_V3);
        assert_eq!(f.kdf.algo, "argon2id");
        assert_eq!(f.kdf.m_cost, Some(ARGON2_M_COST_DEFAULT));

        // 包裹层：24 字节 nonce + 32 字节 DEK 密文 + 16 字节 tag
        assert_eq!(B64.decode(&f.dek.iv).unwrap().len(), 24);
        assert_eq!(B64.decode(&f.dek.tag).unwrap().len(), TAG_LEN);
        assert_eq!(B64.decode(&f.dek.wrapped).unwrap().len(), KEY_LEN);

        // 正文层：同样 24 字节随机 nonce
        assert_eq!(f.cipher.algo, CIPHER_XCHACHA);
        assert_eq!(B64.decode(&f.cipher.iv).unwrap().len(), 24);
    }

    #[test]
    fn nonce_changes_every_save() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();

        let n1 = read_json(&path)["cipher"]["iv"]
            .as_str()
            .unwrap()
            .to_string();
        v.upsert_entry(entry("A", "p")).unwrap();
        let n2 = read_json(&path)["cipher"]["iv"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(n1, n2, "每次保存必须换 nonce");
    }

    #[test]
    fn change_master_keeps_body_ciphertext() {
        // DEK / KEK 分离的核心价值：换主密码不该重写正文。
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "pw-A")).unwrap();

        let before = read_json(&v.path);
        v.change_master("master-password-123", "new-master-password-456")
            .unwrap();
        let after = read_json(&v.path);

        assert_eq!(
            before["payload"], after["payload"],
            "正文密文必须逐字节保留"
        );
        assert_eq!(before["cipher"]["iv"], after["cipher"]["iv"]);
        assert_ne!(
            before["dek"]["wrapped"], after["dek"]["wrapped"],
            "包裹块必须换新"
        );
        assert_ne!(before["kdf"]["salt"], after["kdf"]["salt"], "盐必须换新");
    }

    /// 换主密码写盘失败时，内存状态必须回滚。
    ///
    /// 缺陷：v3 路径先把 `self.header` / `self.wrap` 换成了新密码派生的那一套，
    /// 然后才 `save_inner(true)`。如果写盘失败：
    ///
    ///   * 磁盘上还是旧密码保护的库（用户看不出异常）
    ///   * 内存里却已经是新 wrap
    ///   * 之后任何一次保存都会把**新 wrap + 旧密码承诺**写进去
    ///     → 用户重启后旧密码打不开，新密码也从未真正生效过
    ///
    /// 这是不可逆的数据丢失：库还在，但没人能打开。
    #[test]
    fn failed_change_master_keeps_old_password_working() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "pw-A")).unwrap();

        // 让写盘失败
        let tmp_file = super::tmp_path(&v.path);
        std::fs::create_dir(&tmp_file).unwrap();
        let r = v.change_master("master-password-123", "new-master-password-456");
        let _ = std::fs::remove_dir(&tmp_file);

        assert!(r.is_err(), "前提：这次换密码本该失败");

        // 失败之后，内存里的库必须还能正常用（内部状态已回滚）
        v.upsert_entry(entry("B", "pw-B")).unwrap();
        v.lock();

        // 关键断言：旧密码仍然能打开，并且能看到失败之后新增的 B
        let mut reopened = Vault::new(&path);
        let data = reopened
            .unlock("master-password-123")
            .expect("换密码失败后，旧密码必须仍然可用");
        assert!(
            data.entries.iter().any(|e| e.title == "B"),
            "失败回滚后新增的条目应当已落盘"
        );
    }

    #[test]
    fn change_master_then_reopen_with_new_password() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "pw-A")).unwrap();
        v.change_master("master-password-123", "new-master-password-456")
            .unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        assert_eq!(
            v2.unlock("master-password-123").unwrap_err().code(),
            "INVALID_PASSWORD",
            "旧密码必须失效"
        );
        let data = v2.unlock("new-master-password-456").unwrap();
        assert_eq!(data.entries.len(), 1);
        assert_eq!(data.entries[0].password, "pw-A");
    }

    #[test]
    fn change_master_rejects_wrong_old_password() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let err = v
            .change_master("wrong-old-password", "new-master-password-456")
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_PASSWORD");
    }

    #[test]
    fn upgrade_v2_to_v3_keeps_data_and_password() {
        let dir = tmp();
        let master = "master-password-123";
        let mut v = make_v2(dir.path(), master);
        v.upsert_entry(entry("A", "pw-A")).unwrap();
        assert!(v.is_legacy());

        v.upgrade_to_v3(master).unwrap();
        assert_eq!(v.format(), Some(FORMAT_V3));
        v.lock();

        let mut v2 = Vault::new(dir.path().join("v2.dat"));
        let data = v2.unlock(master).unwrap();
        assert_eq!(data.entries.len(), 1);
        assert_eq!(data.entries[0].password, "pw-A");
        assert_eq!(v2.format(), Some(FORMAT_V3));
    }

    #[test]
    fn upgrade_v1_to_v3_works() {
        let dir = tmp();
        let master = "master-password-123";
        let mut v = make_v1(dir.path(), master);
        v.upsert_entry(entry("A", "pw-A")).unwrap();

        v.upgrade_to_v3(master).unwrap();
        assert_eq!(v.format(), Some(FORMAT_V3));
        v.lock();

        let mut v2 = Vault::new(dir.path().join("v1.dat"));
        assert_eq!(v2.unlock(master).unwrap().entries.len(), 1);
    }

    #[test]
    fn upgrade_rejects_wrong_password_and_leaves_file_alone() {
        let dir = tmp();
        let mut v = make_v2(dir.path(), "master-password-123");
        let before = std::fs::read(&v.path).unwrap();

        let err = v.upgrade_to_v3("wrong-password-999").unwrap_err();
        assert_eq!(err.code(), "INVALID_PASSWORD");
        assert_eq!(
            std::fs::read(&v.path).unwrap(),
            before,
            "密码错时不得改动文件"
        );
        assert!(v.is_legacy());
    }

    #[test]
    fn upgrade_keeps_a_rollback_copy() {
        let dir = tmp();
        let master = "master-password-123";
        let mut v = make_v2(dir.path(), master);
        v.upsert_entry(entry("A", "pw-A")).unwrap();
        v.upgrade_to_v3(master).unwrap();

        // save() 在迁移前把旧文件轮转进了 .bak.1
        assert!(v.backup_slot(1).exists(), "迁移前必须留下可回滚的旧版本");
        let bak = read_json(&v.backup_slot(1));
        assert_eq!(bak["format"], FORMAT_V2, "回滚副本应当是迁移前的格式");
    }

    #[test]
    fn tampered_dek_wrap_is_rejected() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        v.lock();

        let mut json = read_json(&path);
        let wrapped = json["dek"]["wrapped"].as_str().unwrap().to_string();
        // 翻转 base64 里一个字节，保持长度合法
        let mut bytes = B64.decode(&wrapped).unwrap();
        bytes[0] ^= 0xFF;
        json["dek"]["wrapped"] = serde_json::json!(B64.encode(&bytes));
        write_json(&path, &json);

        let mut v2 = Vault::new(&path);
        assert_eq!(
            v2.unlock("master-password-123").unwrap_err().code(),
            "INVALID_PASSWORD"
        );
    }

    #[test]
    fn tampered_kdf_params_break_dek_unwrap() {
        // 降级攻击面：把 Argon2 参数改小以加速离线爆破。
        // AAD 绑定了 m/t/p，改了参数就解不出 DEK。
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        v.lock();

        let mut json = read_json(&path);
        json["kdf"]["t_cost"] = serde_json::json!(4);
        write_json(&path, &json);

        let mut v2 = Vault::new(&path);
        assert!(v2.unlock("master-password-123").is_err());
    }

    #[test]
    fn wrong_password_fails() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        let err = v2.unlock("wrong-password-999").unwrap_err();
        assert_eq!(err.code(), "INVALID_PASSWORD");
    }

    #[test]
    fn v1_file_still_readable() {
        let dir = tmp();
        let path = dir.path().join("v1.dat");

        // 手工造一个 v1 库
        let mut v = Vault::new(&path);
        let salt = random_salt().unwrap();
        let kdf = KdfParams {
            salt: b64(&salt),
            ..KdfParams::scrypt_default()
        };
        v.key = Some(derive_key("master-password-123", &salt, &kdf).unwrap());
        v.header = Some(kdf);
        v.data = Some(VaultData::default());
        v.save().unwrap();
        v.lock();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"keynest.v1\""));

        let mut v2 = Vault::new(&path);
        let data = v2.unlock("master-password-123").unwrap();
        assert_eq!(data.version, 2);
        assert_eq!(v2.kdf_algo(), Some(ALGO_SCRYPT));
        assert!(v2.is_legacy());
    }

    #[test]
    fn upgrade_v1_to_v2() {
        let dir = tmp();
        let path = dir.path().join("v1.dat");

        let mut v = Vault::new(&path);
        let salt = random_salt().unwrap();
        let kdf = KdfParams {
            salt: b64(&salt),
            ..KdfParams::scrypt_default()
        };
        v.key = Some(derive_key("master-password-123", &salt, &kdf).unwrap());
        v.header = Some(kdf);
        v.data = Some(VaultData::default());
        v.save().unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        v2.unlock("master-password-123").unwrap();
        v2.upgrade_to_v2("master-password-123").unwrap();
        assert_eq!(v2.kdf_algo(), Some(ALGO_ARGON2ID));
        v2.lock();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"keynest.v2\""));
        assert!(!raw.contains("\"keynest.v1\""));

        let mut v3 = Vault::new(&path);
        assert!(v3.unlock("master-password-123").is_ok());
    }

    #[test]
    fn malformed_nonce_returns_error_not_panic() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        v.lock();

        // 把 iv 改短（原来 24 字节）
        let mut json = read_json(&path);
        json["cipher"]["iv"] = serde_json::json!(b64(&[0u8; 4]));
        write_json(&path, &json);

        let mut v2 = Vault::new(&path);
        let err = v2.unlock("master-password-123").unwrap_err();
        assert_eq!(err.code(), "CORRUPT");
    }

    #[test]
    fn tampered_aad_params_rejected_v2() {
        // v2 没有 DEK，AAD 直接绑定 KDF 参数：改了参数就解密失败。
        // 这条用例保证「旧格式的降级防护」没有被 v3 的改动带偏。
        let dir = tmp();
        let mut v = make_v2(dir.path(), "master-password-123");
        v.lock();
        let path = dir.path().join("v2.dat");

        let mut json = read_json(&path);
        json["kdf"]["t_cost"] = serde_json::json!(4);
        write_json(&path, &json);

        let mut v2 = Vault::new(&path);
        assert!(v2.unlock("master-password-123").is_err());
    }

    #[test]
    fn aad_v1_matches_legacy_bytes() {
        let kdf = KdfParams {
            salt: "AAAA".into(),
            ..KdfParams::scrypt_default()
        };
        let aad = aad_v1(&kdf, 131072, 8, 1).unwrap();
        let text = String::from_utf8(aad).unwrap();
        assert!(text.starts_with("{\"format\":\"keynest.v1\",\"kdf\":{\"algo\":\"scrypt\""));
        assert!(text.contains("\"N\":131072"));
        assert!(text.ends_with(",\"salt\":\"AAAA\"}"));
    }

    #[test]
    fn entry_debug_redacts_password() {
        let e = entry("GitHub", "super-secret-pw");
        let s = format!("{:?}", e);
        assert!(!s.contains("super-secret-pw"), "Debug 泄漏了密码: {s}");
        assert!(s.contains("<redacted>"));
    }

    #[test]
    fn vault_data_debug_hides_entries() {
        let mut d = VaultData::default();
        d.entries.push(entry("A", "pw-123456"));
        let s = format!("{:?}", d);
        assert!(!s.contains("pw-123456"), "VaultData Debug 泄漏了密码: {s}");
    }

    #[test]
    fn backup_created_on_second_save() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        v.upsert_entry(entry("A", "p")).unwrap();
        assert!(v.backup_slot(1).exists(), ".bak.1 应当存在");
    }

    /* ---------------- 阶段 A：数据完整性 ---------------- */

    #[test]
    fn backup_rotates_and_caps_generations() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        for i in 0..7 {
            v.upsert_entry(entry(&format!("e{i}"), "p")).unwrap();
        }
        for i in 1..=BACKUP_GENERATIONS {
            assert!(v.backup_slot(i).exists(), ".bak.{i} 应当存在");
        }
        assert_eq!(v.list_backups().len(), BACKUP_GENERATIONS);
    }

    #[test]
    fn corrupt_current_does_not_consume_backup_slot() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "p")).unwrap();
        let good = std::fs::read(v.backup_slot(1)).unwrap();

        // 模拟主文件被截断（磁盘故障 / 同步盘中断）
        let raw = std::fs::read(&v.path).unwrap();
        std::fs::write(&v.path, &raw[..raw.len() / 2]).unwrap();
        v.on_disk = None; // 视为「损坏发生在我们自己写完之后」

        v.upsert_entry(entry("B", "p")).unwrap();

        assert_eq!(
            std::fs::read(v.backup_slot(1)).unwrap(),
            good,
            "坏文件不得顶掉完好的备份"
        );
    }

    /// 写盘失败时，**不能把备份轮转掉**。
    ///
    /// 数据完整性缺陷：`save_inner` 先 `rotate_backup` 再写新文件。
    /// 如果写新文件失败（磁盘满、权限、杀毒软件锁文件），库内容其实没变，
    /// 但备份已经整体移位了一代——连试几次，若干代真实历史会被同一个旧内容挤空。
    ///
    /// 正确顺序：**先写成功（临时文件 + fsync + rename），再轮转备份。**
    /// 这样"备份"永远只记录已经成功落盘过的内容。
    #[test]
    fn failed_save_does_not_rotate_backups() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        // 造出多代可区分的历史
        for i in 0..3 {
            v.upsert_entry(entry(&format!("gen{i}"), "p")).unwrap();
        }
        let before = backup_fingerprint(&v);
        assert!(
            before.iter().filter(|x| x.is_some()).count() >= 2,
            "前提：应当已有多个备份代"
        );

        // 让下一次写盘必然失败：把临时文件路径占成一个目录。
        // （比改文件权限可靠——Windows 上以管理员运行的程序不受只读位限制。）
        let tmp_file = super::tmp_path(&v.path);
        std::fs::create_dir(&tmp_file).unwrap();

        let r = v.save();
        let after = backup_fingerprint(&v);
        let _ = std::fs::remove_dir(&tmp_file);

        assert!(r.is_err(), "前提：这次保存本该失败");
        assert_eq!(
            before, after,
            "写盘失败后备份不得移位——否则连续失败会把真实历史挤空"
        );
    }

    /// 备份指纹：每代取 (长度, 内容前 32 字节) 的简易摘要。
    ///
    /// 只用于比较"是否变化"，不需要密码学强度；
    /// 直接把整份密文放进断言消息会让失败输出无法阅读。
    fn backup_fingerprint(v: &Vault) -> Vec<Option<(usize, Vec<u8>)>> {
        (1..=BACKUP_GENERATIONS)
            .map(|i| {
                std::fs::read(v.backup_slot(i)).ok().map(|b| {
                    let head = b.iter().take(32).copied().collect();
                    (b.len(), head)
                })
            })
            .collect()
    }

    #[test]
    fn restore_from_backup_recovers_data() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "pw-A")).unwrap();
        v.upsert_entry(entry("B", "pw-B")).unwrap();
        v.lock();

        let path = dir.path().join("vault.dat");
        let mut raw = std::fs::read(&path).unwrap();
        let n = raw.len();
        raw[n / 2] ^= 0xFF; // 打坏一个字节
        std::fs::write(&path, &raw).unwrap();

        let mut v2 = Vault::new(&path);
        assert!(
            v2.unlock("master-password-123").is_err(),
            "损坏后应解锁失败"
        );

        let slot = v2.backup_slot(1);
        let data = v2
            .restore_from_backup(&slot, "master-password-123")
            .unwrap();
        assert_eq!(data.entries.len(), 1);
        assert_eq!(data.entries[0].title, "A");

        // 恢复后是一个完全可用的库
        v2.lock();
        assert!(v2.unlock("master-password-123").is_ok());

        // 坏掉的那份被留档，而不是删除
        let leftovers: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("corrupt-"))
            .collect();
        assert_eq!(leftovers.len(), 1, "应当留档一份坏文件: {leftovers:?}");
    }

    #[test]
    fn restore_with_wrong_password_touches_nothing() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "pw-A")).unwrap();
        v.lock();

        let path = dir.path().join("vault.dat");
        let before = std::fs::read(&path).unwrap();

        let mut v2 = Vault::new(&path);
        let slot = v2.backup_slot(1);
        let err = v2
            .restore_from_backup(&slot, "wrong-password-999")
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_PASSWORD");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "认证失败不得改动磁盘上的任何字节"
        );
    }

    /// 检测到外部改动后，必须有一条**用户能走通的路**。
    ///
    /// 现实场景：库放在网盘同步目录里，另一台机器改了它，同步过来。
    /// 此时应当提示"文件被别处改过"，然后让用户选择：
    /// 放弃本地改动重新载入，或者另存为一份新库。
    ///
    /// 缺陷：`on_disk` 一旦对不上就永久对不上——`save_inner` 每次都返回
    /// `ExternalChange`，而没有任何公开方法能让它重新对齐。
    /// 用户只能重启程序（丢掉未保存的编辑）或手动删文件。
    /// `Entry` 被丢弃时必须清零敏感字段。
    ///
    /// 直接验"drop 之后内存是 0"不可行——那块内存已经归还给分配器，
    /// 再去读是未定义行为。所以用**同一套 zeroize 语义**的对照组来验：
    /// `Zeroizing<String>` 会在 drop 时清零，而 `Entry::drop` 对每个字段
    /// 调用的正是同一个 `Zeroize::zeroize()`。
    ///
    /// 这条测试的真正价值是**盯着 `impl Drop for Entry` 别被删掉**：
    /// 有人重构时把那个 impl 去掉，测试不会失败，但在真实使用中
    /// 密码会留在堆上。为了防止这种情况，这里同时检查源码里
    /// 那五个字段都被显式 zeroize 了——用 include_str! 读自己的源文件。
    /// `Entry` 被丢弃时必须清零敏感字段。
    ///
    /// 直接验"drop 之后内存是 0"不可行——那块内存已经归还给分配器，
    /// 再去读是未定义行为。所以盯源码：这个测试的价值是**挡住
    /// "重构时顺手删掉某个 zeroize"**。
    ///
    /// # 截取范围必须精确到函数体
    ///
    /// 第一次写这条时用 `src.split("impl Drop for Entry").nth(1)`，
    /// 得到的是**从这里到文件末尾**的全部内容——里面包含下面这个测试自己，
    /// 于是"源码里有没有 self.totp"永远为真，守卫完全失效（实测过两次）。
    ///
    /// 现在按行截到第一个行首 `}`，并断言范围里确实有 `fn drop`，
    /// 防止将来锚点改名后测试悄悄变成空断言。
    #[test]
    fn entry_drop_zeroizes_sensitive_fields() {
        let src = include_str!("vault.rs");
        let after_sig = src
            .split("impl Drop for Entry {")
            .nth(1)
            .expect("Entry 必须实现 Drop（否则密码不会清零）");

        // 截到**第 0 缩进**的 `}`（即 impl 块自己的结尾）。
        // 只用 `trim() != "}"` 会停在函数里第一个内层块（if/for）的右花括号上，
        // 于是后面的字段检查全部落空——守卫看起来通过，实际什么都没验。
        let body = after_sig
            .lines()
            .take_while(|l| *l != "}")
            .collect::<Vec<_>>()
            .join(
                "
",
            );

        assert!(
            body.contains("fn drop"),
            "截取范围里没有 drop 函数体，测试锚点失效"
        );
        // 自检：截取范围必须覆盖到函数体结尾，否则所有字段断言都在空范围内
        assert!(
            body.contains("self.notes.zeroize()"),
            "截取范围过短，守卫测试已失效"
        );

        for field in ["title", "username", "password", "url", "notes"] {
            assert!(
                body.contains(&format!("self.{field}.zeroize()")),
                "Entry::drop 没有清零字段 {field}"
            );
        }
        // TOTP 密钥拿到就能无限生成动态码，二次验证因此失效——
        // 与密码同等敏感，必须在清零范围内。
        // 只检查 "含 self.totp" 不够：`let _ = &self.totp;` 也能通过，
        // 而它什么都没清零。要检查"取出来之后确实调了 zeroize"。
        assert!(
            body.contains("self.totp.as_mut()") && body.contains("t.zeroize()"),
            "Entry::drop 没有清零 totp（TOTP 密钥可生成所有未来的验证码）"
        );
        assert!(
            body.contains("for f in self.fields.iter_mut()") && body.contains("f.value.zeroize()"),
            "Entry::drop 没有清零自定义字段（可能存卡号/证件号）"
        );
    }

    /// 还原失败时的错误信息必须**指明数据在哪**。
    ///
    /// 原来那一步是 `let _ = fs::rename(aside, &self.path)`：失败了也照样
    /// 只报「写入失败」。而实际上库文件已经不在原位，只剩一份
    /// `vault.dat.corrupt-*`——用户以为库还在，重启才发现打不开，
    /// 而且不知道该去找哪个文件。
    ///
    /// # 为什么直接测错误构造，而不是构造真实的双重失败
    ///
    /// 要让「写新文件」和「把留档挪回来」**同时**失败，需要精确控制文件系统
    /// 状态；而 `set_aside_current` 会先把目标挪走，目标路径空出来后
    /// 写入往往反而成功（试过：把 vault.dat 换成目录，恢复照样成功）。
    ///
    /// 这种测试即使写出来也是在与平台行为博弈，很容易变成"看起来在测、
    /// 实际没测到"。所以退一步：直接验错误信息的构造，保证一旦真的发生，
    /// 用户能看懂该去哪个文件。
    #[test]
    fn rollback_failure_message_points_at_the_aside_file() {
        let aside = PathBuf::from("vault.dat.corrupt-1700000000");
        let msg = rollback_failure_message("磁盘已满", &aside);
        assert!(msg.contains("无法还原"), "没说明还原失败: {msg}");
        assert!(
            msg.contains("vault.dat.corrupt-1700000000"),
            "没给出留档文件名，用户无从下手: {msg}"
        );
        assert!(msg.contains("磁盘已满"), "没保留原始错误原因: {msg}");
    }

    /// 恢复留档必须能被**列出来**。    /// 恢复留档必须能被**列出来**。
    ///
    /// 此前只有 `wipe()` 会碰这些文件（全部删掉）。用户反复从备份恢复失败时，
    /// 磁盘上会攒下一堆 `vault.dat.corrupt-*`，界面上却完全看不到——
    /// 既占空间，也让人困惑「这些到底是什么」。
    #[test]
    fn recovery_leftovers_are_listed() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "p")).unwrap();

        // 手工造两个留档（正常路径要用 restore 触发，这里直接放文件更直观）
        let base = v.path.to_string_lossy().to_string();
        std::fs::write(format!("{base}.corrupt-1000"), b"old-one").unwrap();
        std::fs::write(format!("{base}.corrupt-2000"), b"old-two-longer").unwrap();

        let items = v.list_recovery_leftovers();
        assert_eq!(items.len(), 2, "应当列出两份留档: {items:?}");
        // 大小如实反映
        assert!(items
            .iter()
            .any(|i| i.bytes == b"old-two-longer".len() as u64));
    }

    /// 没有留档时返回空列表，不报错。
    #[test]
    fn no_leftovers_yields_empty_list() {
        let dir = tmp();
        let v = fast_vault(dir.path());
        assert!(v.list_recovery_leftovers().is_empty());
    }

    /// 清理只删留档，**不动库与备份**。
    ///
    /// 这是与 `wipe()` 的关键区别：用户想清掉垃圾文件，
    /// 不该顺便把自己的库和备份一起删了。
    #[test]
    fn clearing_leftovers_keeps_vault_and_backups() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "p")).unwrap();
        v.upsert_entry(entry("B", "p")).unwrap(); // 触发一次备份

        let base = v.path.to_string_lossy().to_string();
        std::fs::write(format!("{base}.corrupt-1000"), b"junk").unwrap();
        std::fs::write(format!("{base}.corrupt-2000"), b"junk").unwrap();

        let removed = v.clear_recovery_leftovers().unwrap();
        assert_eq!(removed, 2);
        assert!(v.list_recovery_leftovers().is_empty());

        // 库还在，备份还在
        assert!(v.path.exists(), "库文件不该被删");
        assert!(v.backup_slot(1).exists(), "备份不该被删");

        // 库仍然可用
        v.lock();
        let mut v2 = Vault::new(&v.path);
        assert_eq!(v2.unlock("master-password-123").unwrap().entries.len(), 2);
    }

    /// 留档之外的文件（比如备份）不能被误当成留档列出来。
    #[test]
    fn backups_are_not_listed_as_leftovers() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "p")).unwrap();
        v.upsert_entry(entry("B", "p")).unwrap();
        assert!(v.backup_slot(1).exists(), "前提：应当已有备份");

        assert!(
            v.list_recovery_leftovers().is_empty(),
            "备份不该被当成恢复留档"
        );
    }

    /// 设置项必须被夹紧到安全范围，否则库会变成「打不开也用不了」。
    ///
    /// 具体后果：
    /// * `auto_lock_minutes = 0` → `should_auto_lock` 每帧都为真，
    ///   用户解锁后立刻又被锁，程序完全不可用
    /// * `clipboard_clear_seconds = 0` → 刚写入就被定时器清空，
    ///   表现为「点了复制但剪贴板是空的」
    /// * `reveal_seconds = 0` → 密码一显示就消失
    ///
    /// 这些值可能来自旧版本、手工编辑库文件，或将来某个 UI 缺陷。
    /// 在写入这一层夹紧，比在 UI 层修补更可靠——UI 可能有多个入口。
    #[test]
    fn update_settings_clamps_dangerous_values() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        let bad = Settings {
            auto_lock_minutes: 0,
            clipboard_clear_seconds: 0,
            reveal_seconds: 0,
            ..Default::default()
        };
        v.update_settings(bad).unwrap();

        let s = v.snapshot().unwrap().settings;
        assert!(
            s.auto_lock_minutes >= 1,
            "自动锁定不得为 0: {}",
            s.auto_lock_minutes
        );
        assert!(
            s.clipboard_clear_seconds >= 3,
            "剪贴板清理间隔过短: {}",
            s.clipboard_clear_seconds
        );
        assert!(
            s.reveal_seconds >= 1,
            "显示时长不得为 0: {}",
            s.reveal_seconds
        );
    }

    /// 过大的值也要夹紧：自动锁定设成几年等于关掉这个安全功能，
    /// 而它是密码管理器最基本的一道防线。
    #[test]
    fn update_settings_caps_huge_values() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        let bad = Settings {
            auto_lock_minutes: 100_000,
            clipboard_clear_seconds: 100_000,
            reveal_seconds: 100_000,
            ..Default::default()
        };
        v.update_settings(bad).unwrap();

        let s = v.snapshot().unwrap().settings;
        assert!(
            s.auto_lock_minutes <= MAX_AUTO_LOCK_MINUTES,
            "{}",
            s.auto_lock_minutes
        );
        assert!(s.clipboard_clear_seconds <= MAX_CLIPBOARD_SECONDS);
        assert!(s.reveal_seconds <= MAX_REVEAL_SECONDS);
    }

    /// 打开旧库时，里面已存的危险设置值也要被夹紧。
    ///
    /// 否则「升级程序」对已有库没有效果：用户解锁后仍然立刻被锁，
    /// 而他并不知道问题出在库文件里存的那个 0。
    #[test]
    fn opening_legacy_vault_clamps_settings_in_memory() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        // 直接把危险值写进内存数据并保存（模拟旧版本写出的库）
        {
            let data = v.data.as_mut().unwrap();
            data.settings.auto_lock_minutes = 0;
            data.settings.clipboard_clear_seconds = 0;
            data.settings.reveal_seconds = 0;
        }
        v.save().unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        let data = v2.unlock("master-password-123").unwrap();
        assert!(data.settings.auto_lock_minutes >= 1, "解锁后仍为 0");
        assert!(data.settings.clipboard_clear_seconds >= MIN_CLIPBOARD_SECONDS);
        assert!(data.settings.reveal_seconds >= 1);
    }

    /// 正常值必须原样保留，不能被"顺手"改掉。
    #[test]
    fn update_settings_keeps_valid_values() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let good = Settings {
            auto_lock_minutes: 15,
            clipboard_clear_seconds: 30,
            reveal_seconds: 10,
            ..Default::default()
        };
        v.update_settings(good.clone()).unwrap();
        let s = v.snapshot().unwrap().settings;
        assert_eq!(s.auto_lock_minutes, 15);
        assert_eq!(s.clipboard_clear_seconds, 30);
        assert_eq!(s.reveal_seconds, 10);
    }

    /// 库里出现重复 id 时必须被检出。
    ///
    /// 为什么这条重要：`upsert_entry` 靠 `id` 定位条目。两条同 id 的记录会让
    /// 「编辑其中一条」变成「覆盖排在前面的那条」，另一条永远改不动也删不掉。
    ///
    /// 现实中怎么出现：
    /// * 用户手工编辑过库文件（哪怕只是复制粘贴了一段）
    /// * 第三方工具生成的库
    /// * 导入时若将来放宽去重规则，可能引入
    ///
    /// 检出时机是**解锁之后**——那时才拿到明文，也才有机会在不破坏文件的前提下
    /// 提示用户。这里直接验 `VaultData::find_duplicate_ids`。
    #[test]
    fn duplicate_entry_ids_are_detected() {
        let mut data = VaultData::default();
        let mut a = entry("A", "p");
        a.id = "same-id".into();
        let mut b = entry("B", "p");
        b.id = "same-id".into();
        data.entries = vec![a, b];

        let dup = data.find_duplicate_ids();
        assert_eq!(dup, vec!["same-id".to_string()], "应当检出重复 id");
    }

    /// 正常库不应报告重复。
    #[test]
    fn unique_ids_report_nothing() {
        let mut data = VaultData::default();
        let mut a = entry("A", "p");
        a.id = "id-a".into();
        let mut b = entry("B", "p");
        b.id = "id-b".into();
        data.entries = vec![a, b];
        assert!(data.find_duplicate_ids().is_empty());
    }

    /// 超长的字段必须被**拒绝**，而不是截断。
    ///
    /// # 为什么这是数据完整性问题而不只是"输入校验"
    ///
    /// `MAX_VAULT_BYTES` 是 64 MiB。没有字段长度上限时，
    /// 一个 100 MB 的备注就能让库超出这个上限——
    /// 此后**每次保存都被文件大小挡住**，用户再也存不进任何东西。
    /// 库从此写不坏也写不好。
    ///
    /// 截断比拒绝更糟：用户以为保存成功了，实际上尾部被悄悄丢掉。
    #[test]
    fn oversized_fields_are_rejected_not_truncated() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        // 超长备注
        let mut e = entry("A", "pw");
        e.notes = "x".repeat(MAX_NOTES_CHARS + 1);
        let err = v.upsert_entry(e).unwrap_err();
        assert_eq!(err.code(), "FIELD_TOO_LONG");
        assert!(
            err.to_string().contains("备注"),
            "错误信息要指出是哪个字段: {err}"
        );

        // 超长标题
        let mut e = entry("B", "pw");
        e.title = "x".repeat(MAX_TITLE_CHARS + 1);
        assert_eq!(v.upsert_entry(e).unwrap_err().code(), "FIELD_TOO_LONG");

        // 超长 TOTP 配置
        let mut e = entry("C", "pw");
        e.totp = Some("x".repeat(MAX_TOTP_CHARS + 1));
        assert_eq!(v.upsert_entry(e).unwrap_err().code(), "FIELD_TOO_LONG");

        // 库里确实什么都没进去
        assert_eq!(v.snapshot().unwrap().entries.len(), 0);
    }

    /// 刚好在上限上的内容必须能存进去（别把合法输入也挡了）。
    #[test]
    fn fields_at_the_limit_are_accepted() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        let mut e = entry("A", "pw");
        e.title = "x".repeat(MAX_TITLE_CHARS);
        e.notes = "y".repeat(MAX_NOTES_CHARS);
        v.upsert_entry(e).unwrap();
        assert_eq!(v.snapshot().unwrap().entries.len(), 1);
    }

    /// 长度按**字符数**算，不是字节数。
    ///
    /// 中文一个字占 3 字节——按字节算的话，中文用户实际能用到的
    /// 长度只有预期的三分之一，而且没有任何提示。
    #[test]
    fn length_limits_count_characters_not_bytes() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        let mut e = entry("标题", "pw");
        // 每个中文字符 3 字节；按字节算会超限，按字符算正好在限内
        e.notes = "中".repeat(MAX_NOTES_CHARS);
        assert!(e.notes.len() > MAX_NOTES_CHARS, "前提：字节数确实超了");
        v.upsert_entry(e).unwrap();
        assert_eq!(v.snapshot().unwrap().entries.len(), 1);
    }

    /// 导入必须有条目上限，且超限时**保留已导入的部分**。
    ///
    /// 没有上限时：一个 32 MiB 的 CSV 能造出上百万条记录，
    /// 每次保存都要序列化全部条目 → 界面卡死；
    /// 加密结果远超 `MAX_VAULT_BYTES` → 保存失败，库从此写不进去。
    /// 用户已经看到那些条目，却存不下去——实际的数据丢失。
    #[test]
    fn import_stops_at_entry_limit() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        // 造到上限前一点，避免测试本身太慢：直接替换内存数据
        {
            let data = v.data.as_mut().unwrap();
            data.entries = (0..MAX_ENTRIES)
                .map(|i| {
                    let mut e = entry(&format!("filler{i}"), "p");
                    e.id = format!("id-{i}");
                    e
                })
                .collect();
        }

        let incoming: Vec<Entry> = (0..5).map(|i| entry(&format!("new{i}"), "p")).collect();
        let report = v.import_entries(incoming).unwrap();

        assert_eq!(report.added, 0, "已达上限，不该再写入");
        assert_eq!(report.skipped_limit, 5, "被上限挡下的条数要如实计入报告");
        assert!(report.summary().contains("条目上限"), "摘要要说明原因");
    }

    /// 导入时遇到超长字段：**跳过这一条**，不要让整批失败。
    ///
    /// 导入是「尽力而为」的批量操作：一条有问题不该毁掉另外 999 条。
    /// 但也不能放它进去——超长字段会让库超出 MAX_VAULT_BYTES，从此再也保存不了。
    #[test]
    fn import_skips_oversized_entries_without_failing_the_batch() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        let mut huge = entry("Huge", "pw");
        huge.notes = "x".repeat(MAX_NOTES_CHARS + 1);

        let report = v
            .import_entries(vec![huge, entry("Good1", "pw"), entry("Good2", "pw")])
            .unwrap();

        assert_eq!(report.added, 2, "正常条目必须照样导入");
        assert_eq!(report.skipped_invalid, 1, "超长那条要计入跳过数");
        assert_eq!(v.snapshot().unwrap().entries.len(), 2);
    }

    /// 解析阶段丢掉的条目必须出现在报告里。
    ///
    /// 缺陷：解析阶段（CSV/JSON → Entry）会丢掉格式不对的条目，
    /// 但 GUI 原来把 invalid 计数**丢掉了**（`_invalid`），
    /// 于是报告里的 `skipped_invalid` 永远是 0。
    ///
    /// 用户看到的是「导入 100 条」，而文件里其实有 5000 条、
    /// 4900 条在进库之前就被悄悄扔了——他完全不知道。
    #[test]
    fn import_report_includes_entries_dropped_during_parsing() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        let incoming = vec![entry("A", "p"), entry("B", "p")];
        // 源文件里识别出 100 条，其中 3 条格式不对
        let report = v.import_entries_with_stats(incoming, 100, 3).unwrap();

        assert_eq!(report.added, 2, "两条都应当写入");
        assert_eq!(report.parsed, 100, "parsed 要反映源文件里的候选条数");
        assert_eq!(report.skipped_invalid, 3, "解析阶段丢掉的 3 条必须被计入");
    }

    /// 未达上限时导入照常，且 `skipped_limit` 为 0。
    #[test]
    fn import_below_limit_is_unaffected() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let report = v
            .import_entries((0..3).map(|i| entry(&format!("n{i}"), "p")).collect())
            .unwrap();
        assert_eq!(report.added, 3);
        assert_eq!(report.skipped_limit, 0);
    }

    #[test]
    fn can_reload_after_external_change() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "p")).unwrap();

        // 模拟另一个进程写入了新内容（版本号变了但仍是同一个库）
        let mut json = read_json(&path);
        json["updatedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
        write_json(&path, &json);

        let err = v.upsert_entry(entry("B", "p")).unwrap_err();
        assert_eq!(err.code(), "EXTERNAL_CHANGE");

        // 用户选择「重新载入」——必须成功，且之后能正常保存
        v.reload().expect("应当能重新载入磁盘上的库");
        v.upsert_entry(entry("C", "p"))
            .expect("重新载入之后应当能正常保存");

        v.lock();
        let mut reopened = Vault::new(&path);
        let data = reopened.unlock("master-password-123").unwrap();
        assert!(data.entries.iter().any(|e| e.title == "C"));
    }

    /// 磁盘上被换成**另一个库**时，`reload` 必须失败且不破坏内存状态。
    ///
    /// 现实场景：用户把另一台机器的 vault.dat 拷进来覆盖了。
    /// 那不是"同一个库被改过"，而是"换了一个库"——
    /// 用旧会话的密钥解不开它，此时绝不能把内存清空或留下半截状态。
    #[test]
    fn reload_rejects_a_different_vault() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("mine", "p")).unwrap();
        let before = v.snapshot().unwrap().entries.len();

        // 造一个"别人的库"覆盖上去
        let other = dir.path().join("other.dat");
        {
            let mut o = Vault::new(&other);
            o.create("another-master-password").unwrap();
        }
        std::fs::copy(&other, &path).unwrap();

        let r = v.reload();
        assert!(r.is_err(), "换了库却 reload 成功——旧密钥不该能解开新库");

        // 内存状态必须保持原样：用户还没决定要放弃本地数据
        let after = v.snapshot().unwrap().entries.len();
        assert_eq!(after, before, "reload 失败时不得清空或改动内存状态");
    }

    #[test]
    fn external_change_is_detected_and_rolled_back() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "p")).unwrap();
        let snapshot_before = v.snapshot().unwrap();

        // 模拟另一个进程把库改成了别的内容
        let mut json = read_json(&path);
        json["updatedAt"] = serde_json::json!("2000-01-01T00:00:00.000Z");
        write_json(&path, &json);

        let err = v.upsert_entry(entry("B", "p")).unwrap_err();
        assert_eq!(err.code(), "EXTERNAL_CHANGE");

        // 内存状态必须回滚，不能留下一个磁盘上不存在的条目
        let after = v.snapshot().unwrap();
        assert_eq!(after.entries.len(), snapshot_before.entries.len());
    }

    #[test]
    fn old_json_without_kind_and_fields_parses_as_login() {
        let json = r#"{"id":"1","title":"t","username":"u","password":"p","url":"",
                       "category":"c","notes":"","createdAt":"a","updatedAt":"b"}"#;
        let e: Entry = serde_json::from_str(json).unwrap();
        assert_eq!(e.kind, kinds::LOGIN);
        assert!(e.fields.is_empty());
    }

    #[test]
    fn kinds_and_fields_survive_unlock() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();

        let mut card = entry("招行卡", "");
        card.kind = kinds::CARD.to_string();
        card.fields = vec![
            Field {
                label: "卡号".into(),
                value: "6225 1234 5678 9012".into(),
                secret: true,
            },
            Field {
                label: "有效期".into(),
                value: "08/29".into(),
                secret: false,
            },
        ];
        v.upsert_entry(card).unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        let data = v2.unlock("master-password-123").unwrap();
        let e = &data.entries[0];
        assert_eq!(e.kind, kinds::CARD);
        assert_eq!(e.fields.len(), 2);
        assert_eq!(e.fields[0].value, "6225 1234 5678 9012");
        assert!(e.fields[0].secret);
    }

    #[test]
    fn fields_are_sanitized() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let mut e = entry("A", "pw");
        e.fields = vec![
            Field {
                label: "  ".into(),
                value: "  ".into(),
                secret: false,
            }, // 全空 → 丢
            Field {
                label: "".into(),
                value: "只有值".into(),
                secret: false,
            }, // 补占位标签
            Field {
                label: "  备注  ".into(),
                value: "值 ".into(),
                secret: false,
            },
        ];
        let saved = v.upsert_entry(e).unwrap();
        assert_eq!(saved.fields.len(), 2);
        assert_eq!(saved.fields[0].label, "字段");
        assert_eq!(saved.fields[1].label, "备注");
    }

    #[test]
    fn fields_are_capped() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let mut e = entry("A", "pw");
        e.fields = (0..100)
            .map(|i| Field {
                label: format!("f{i}"),
                value: "v".into(),
                secret: false,
            })
            .collect();
        let saved = v.upsert_entry(e).unwrap();
        assert_eq!(saved.fields.len(), MAX_FIELDS);
    }

    #[test]
    fn secret_fields_are_redacted_in_debug() {
        let f = Field {
            label: "安全码".into(),
            value: "123".into(),
            secret: true,
        };
        let s = format!("{f:?}");
        assert!(!s.contains("123"), "Debug 泄漏了敏感字段: {s}");
        assert!(s.contains("<redacted>"));
    }

    #[test]
    fn entry_debug_does_not_dump_field_values() {
        let mut e = entry("卡", "");
        e.fields = vec![Field {
            label: "卡号".into(),
            value: "6225123456789012".into(),
            secret: true,
        }];
        let s = format!("{e:?}");
        assert!(!s.contains("6225123456789012"), "Debug 泄漏了卡号: {s}");
        assert!(s.contains("<1 fields>"));
    }

    #[test]
    fn password_change_time_tracks_only_password_edits() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let saved = v.upsert_entry(entry("A", "pw-1")).unwrap();
        let first = saved
            .password_changed_at
            .clone()
            .expect("新建条目应带时间戳");

        // 只改备注：密码时间戳必须不变
        let mut edited = saved.clone();
        edited.notes = "改个备注".into();
        let after_notes = v.upsert_entry(edited).unwrap();
        assert_eq!(
            after_notes.password_changed_at.as_deref(),
            Some(first.as_str()),
            "改备注不该刷新密码时间"
        );

        // 改密码：时间戳必须更新（用 sleep 拉开毫秒，否则同一毫秒内字符串相同）
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut changed = after_notes.clone();
        changed.password = "pw-2".into();
        let after_pw = v.upsert_entry(changed).unwrap();
        assert_ne!(
            after_pw.password_changed_at.as_deref(),
            Some(first.as_str()),
            "改密码必须刷新时间"
        );
    }

    #[test]
    fn password_change_time_survives_unlock() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        let saved = v.upsert_entry(entry("A", "pw")).unwrap();
        assert!(saved.password_changed_at.is_some());
        v.lock();

        let mut v2 = Vault::new(&path);
        let data = v2.unlock("master-password-123").unwrap();
        assert!(data.entries[0].password_changed_at.is_some());
    }

    #[test]
    fn old_json_without_password_changed_at_still_parses() {
        let json = r#"{"id":"1","title":"t","username":"u","password":"p","url":"",
                       "category":"c","notes":"","createdAt":"a","updatedAt":"b"}"#;
        let e: Entry = serde_json::from_str(json).unwrap();
        assert!(e.password_changed_at.is_none());
    }

    #[test]
    fn renaming_a_type_keeps_its_template() {
        // 这是上一版的真缺陷：模板按名字查，改名后「银行卡」就不带卡号字段了
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.rename_type(kinds::CARD, "银行卡").unwrap();

        let data = v.snapshot().unwrap();
        let t = data
            .types
            .iter()
            .find(|t| t.label == "银行卡")
            .expect("改名后应当还在");
        assert!(
            t.template.iter().any(|f| f.label == "卡号"),
            "改名不该丢掉模板字段，实际: {:?}",
            t.template.iter().map(|f| &f.label).collect::<Vec<_>>()
        );
    }

    #[test]
    fn old_string_types_are_upgraded_with_templates() {
        // 老库的 types 是 ["账号","信用卡"] 这种字符串数组。直接测 serde 表示，
        // 不必构造整个 VaultData（那样只会被一堆必填字段淹没重点）。
        let mut data = VaultData {
            types: serde_json::from_str::<Vec<TypeDef>>(r#"["账号","信用卡"]"#).unwrap(),
            ..VaultData::default()
        };
        data.migrate_legacy();
        let card = data.types.iter().find(|t| t.label == kinds::CARD).unwrap();
        assert!(card.template.iter().any(|f| f.label == "卡号"));
    }

    /// 新库应当带上**全部**内置类型。
    ///
    /// 断言写的是 `DEFAULT_TYPES.len()` 而不是字面量 4/5——
    /// 原来这里写死 `4`，加「API Key」类型时它立刻变红。
    /// 那不是缺陷被发现，而是测试在提醒「你改了内置类型集合，
    /// 确认一下别的数字有没有跟着变」。改成引用常量后，
    /// 它验的是「默认类型一个不少」，这才是真正想守的东西。
    #[test]
    fn types_default_to_all_builtins() {
        let dir = tmp();
        let v = fast_vault(dir.path());
        let data = v.snapshot().unwrap();
        assert_eq!(data.types.len(), kinds::DEFAULT_TYPES.len());
        for name in kinds::DEFAULT_TYPES {
            assert!(
                data.types.iter().any(|t| t.label == name),
                "默认类型里缺「{name}」"
            );
        }
        assert_eq!(data.types.len(), 5, "内置类型数量变化时请同步这行");
    }

    #[test]
    fn add_rename_delete_type_keeps_entries_consistent() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());

        v.add_type("服务器").unwrap();
        let mut e = entry("外卖服务器", "pw");
        e.kind = "服务器".into();
        v.upsert_entry(e).unwrap();

        // 改名：条目必须跟着走
        v.rename_type("服务器", "云主机").unwrap();
        let data = v.snapshot().unwrap();
        assert!(data.types.iter().any(|t| t.label == "云主机"));
        assert_eq!(data.entries[0].kind, "云主机");

        // 删除：条目归到剩下的第一个类型
        let moved = v.delete_type("云主机").unwrap();
        assert_eq!(moved, 1);
        let data = v.snapshot().unwrap();
        assert!(!data.types.iter().any(|t| t.label == "云主机"));
        assert!(data.types.iter().any(|t| t.label == data.entries[0].kind));
    }

    #[test]
    fn type_name_must_be_unique_and_non_empty() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        assert!(v.add_type("").is_err());
        assert!(v.add_type("账号").is_err(), "重名应拒绝");
        assert!(v.add_type("WiFi").is_ok());
    }

    #[test]
    fn legacy_english_kind_is_migrated_on_open() {
        // 老库把类型存成 login/card，读进来必须变成中文名，否则条目会从所有类型筛选中消失
        let mut data = VaultData::default();
        let mut e = entry("A", "pw");
        e.kind = "card".into();
        data.entries.push(e);
        data.migrate_legacy();
        assert_eq!(data.entries[0].kind, kinds::CARD);
        assert!(data.types.iter().any(|t| t.label == kinds::CARD));
    }

    #[test]
    fn rename_category_moves_entries_too() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let mut e = entry("A", "pw");
        e.category = "测试分类".into();
        v.upsert_entry(e).unwrap();
        assert!(v
            .snapshot()
            .unwrap()
            .categories
            .iter()
            .any(|c| c == "测试分类"));

        v.rename_category("测试分类", "改名后").unwrap();
        let data = v.snapshot().unwrap();
        assert!(data.categories.iter().any(|c| c == "改名后"));
        assert!(!data.categories.iter().any(|c| c == "测试分类"));
        // 关键：条目必须跟着走，否则它会从所有分类筛选中消失
        assert_eq!(data.entries[0].category, "改名后");
    }

    #[test]
    fn rename_to_existing_is_rejected() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        assert_eq!(
            v.rename_category("网站", "邮箱").unwrap_err().code(),
            "INVALID_ENTRY"
        );
    }

    #[test]
    fn delete_category_moves_entries_to_a_remaining_one() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let mut e = entry("A", "pw");
        e.category = "待删".into();
        v.upsert_entry(e).unwrap();

        let moved = v.delete_category("待删").unwrap();
        assert_eq!(moved, 1);
        let data = v.snapshot().unwrap();
        assert!(!data.categories.iter().any(|c| c == "待删"));
        // 条目必须落到一个**仍然存在**的分类里，否则它会从所有筛选里消失
        assert!(data.categories.contains(&data.entries[0].category));
    }

    #[test]
    fn cannot_delete_the_last_category() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        // 「其他」现在也能删——不再替用户做决定
        assert!(v.delete_category("其他").is_ok() || v.snapshot().unwrap().categories.len() > 1);

        // 删到只剩一个时必须拒绝
        for c in ["网站", "邮箱", "应用", "金融", "服务器"] {
            let _ = v.delete_category(c);
        }
        let left = v.snapshot().unwrap().categories;
        assert_eq!(left.len(), 1, "应当只剩一个分类");
        assert!(
            v.delete_category(&left[0]).is_err(),
            "最后一个分类不能删，否则条目没有归属"
        );
    }

    #[test]
    fn fresh_v3_vault_meets_kdf_floor() {
        let dir = tmp();
        let mut v = Vault::new(dir.path().join("vault.dat"));
        assert!(v.kdf_meets_floor().is_none(), "还没读文件时不下判断");
        v.create("master-password-123").unwrap();
        assert_eq!(v.kdf_meets_floor(), Some(true));
    }

    #[test]
    fn weak_kdf_parameters_are_reported_as_below_floor() {
        // 注意：不能靠"改现有库的 m_cost"来测——改了参数就派生出另一个密钥，
        // 结果只是解密失败（那条已有 tampered_kdf_params_break_dek_unwrap 覆盖）。
        // 这里直接测判定函数本身。
        let mut p = KdfParams::argon2_default();
        assert!(p.meets_floor());

        p.m_cost = Some(1024);
        assert!(!p.meets_floor(), "m_cost 低于 64 MiB 应判为不达标");

        let mut p = KdfParams::argon2_default();
        p.t_cost = Some(1);
        assert!(!p.meets_floor(), "t_cost 低于 3 应判为不达标");

        let weak_scrypt = KdfParams {
            algo: ALGO_SCRYPT.into(),
            n: Some(16384), // N = 2^14，低于 2^17
            r: Some(8),
            p: Some(1),
            m_cost: None,
            t_cost: None,
            p_cost: None,
            salt: String::new(),
        };
        assert!(!weak_scrypt.meets_floor(), "scrypt N=2^14 应判为不达标");

        let ok_scrypt = KdfParams {
            n: Some(131_072), // 2^17
            ..weak_scrypt
        };
        assert!(ok_scrypt.meets_floor());
    }

    #[test]
    fn totp_is_normalized_on_save() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let mut e = entry("A", "pw");
        // 用户贴进来的是「带空格、小写、带补位」的写法
        e.totp = Some("jbsw y3dp ehpk 3pxp====".into());
        let saved = v.upsert_entry(e).unwrap();

        // 注意 `.clone()`：`Entry` 实现了 `Drop`，不能把字段移出来
        let stored = saved.totp.clone().expect("应当被规范化后保存");
        assert!(stored.starts_with("otpauth://totp/"), "实际: {stored}");
        assert!(stored.contains("secret=JBSWY3DPEHPK3PXP"));
        // 规范化的结果必须能重新解析，且算出同样的码
        let back = crate::totp::Totp::parse(&stored).unwrap();
        assert_eq!(
            back.code_at(1_234_567_890),
            crate::totp::Totp::parse("JBSWY3DPEHPK3PXP")
                .unwrap()
                .code_at(1_234_567_890)
        );
    }

    #[test]
    fn invalid_totp_is_rejected_on_save() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let mut e = entry("A", "pw");
        e.totp = Some("这不是 base32".into());
        assert_eq!(v.upsert_entry(e).unwrap_err().code(), "TOTP");
    }

    #[test]
    fn empty_totp_becomes_none() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let mut e = entry("A", "pw");
        e.totp = Some("   ".into());
        let saved = v.upsert_entry(e).unwrap();
        assert!(saved.totp.is_none());
    }

    #[test]
    fn totp_survives_unlock() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        let mut e = entry("A", "pw");
        e.totp = Some("JBSWY3DPEHPK3PXP".into());
        v.upsert_entry(e).unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        let data = v2.unlock("master-password-123").unwrap();
        assert!(data.entries[0].totp.as_deref().unwrap().contains("secret="));
    }

    #[test]
    fn entry_json_without_new_fields_still_parses() {
        // 旧库写出的条目没有 favorite / deletedAt，
        // 必须能按默认值解析，否则升级后老库直接打不开。
        let json = r#"{"id":"1","title":"t","username":"u","password":"p","url":"",
                       "category":"c","notes":"","createdAt":"a","updatedAt":"b"}"#;
        let e: Entry = serde_json::from_str(json).unwrap();
        assert!(!e.favorite);
        assert!(e.deleted_at.is_none());
    }

    #[test]
    fn delete_moves_to_trash_and_restore_brings_back() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let saved = v.upsert_entry(entry("A", "pw")).unwrap();

        v.delete_entry(&saved.id).unwrap();
        let data = v.snapshot().unwrap();
        assert_eq!(data.entries.len(), 1, "软删除不减少条目数");
        assert!(data.entries[0].is_deleted());
        assert_eq!(v.trash_count(), 1);

        v.restore_entry(&saved.id).unwrap();
        assert!(!v.snapshot().unwrap().entries[0].is_deleted());
        assert_eq!(v.trash_count(), 0);
    }

    #[test]
    fn purge_is_permanent() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let saved = v.upsert_entry(entry("A", "pw")).unwrap();
        v.delete_entry(&saved.id).unwrap();
        v.purge_entry(&saved.id).unwrap();

        assert_eq!(v.snapshot().unwrap().entries.len(), 0);
        assert_eq!(v.trash_count(), 0);
        assert_eq!(v.purge_entry(&saved.id).unwrap_err().code(), "NOT_FOUND");
    }

    #[test]
    fn empty_trash_keeps_active_entries() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let a = v.upsert_entry(entry("A", "pw")).unwrap();
        let b = v.upsert_entry(entry("B", "pw")).unwrap();
        v.delete_entry(&a.id).unwrap();

        assert_eq!(v.empty_trash().unwrap(), 1);
        let data = v.snapshot().unwrap();
        assert_eq!(data.entries.len(), 1);
        assert_eq!(data.entries[0].id, b.id);
    }

    #[test]
    fn deleting_twice_is_not_found() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let a = v.upsert_entry(entry("A", "pw")).unwrap();
        v.delete_entry(&a.id).unwrap();
        assert_eq!(v.delete_entry(&a.id).unwrap_err().code(), "NOT_FOUND");
    }

    #[test]
    fn favorite_and_trash_persist_across_unlock() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        let a = v.upsert_entry(entry("A", "pw")).unwrap();
        let b = v.upsert_entry(entry("B", "pw")).unwrap();
        v.set_favorite(&a.id, true).unwrap();
        v.delete_entry(&b.id).unwrap();
        v.lock();

        let mut v2 = Vault::new(&path);
        let data = v2.unlock("master-password-123").unwrap();
        assert!(data.entries.iter().find(|e| e.id == a.id).unwrap().favorite);
        assert!(data
            .entries
            .iter()
            .find(|e| e.id == b.id)
            .unwrap()
            .is_deleted());
        assert_eq!(v2.trash_count(), 1);
    }

    #[test]
    fn import_entries_never_overwrites_existing() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "old-pw")).unwrap();

        let report = v
            .import_entries(vec![
                entry("A", "new-pw"),
                entry("B", "pw-B"),
                entry("", "no-title"),
            ])
            .unwrap();

        assert_eq!(report.parsed, 3);
        assert_eq!(report.added, 1);
        assert_eq!(report.skipped_existing, 1);
        assert_eq!(report.skipped_invalid, 1);

        let data = v.snapshot().unwrap();
        let a = data.entries.iter().find(|e| e.title == "A").unwrap();
        assert_eq!(a.password, "old-pw", "导入绝不能覆盖已有密码");
        assert!(data.entries.iter().any(|e| e.title == "B"));
    }

    #[test]
    fn import_entries_dedups_within_batch() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        let report = v
            .import_entries(vec![entry("Dup", "pw"), entry("Dup", "pw")])
            .unwrap();
        assert_eq!(report.added, 1);
        assert_eq!(report.skipped_existing, 1);
        assert_eq!(v.snapshot().unwrap().entries.len(), 1);
    }

    #[test]
    fn import_dedup_ignores_letter_case() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("GitHub", "pw1")).unwrap();
        let report = v.import_entries(vec![entry("github", "pw2")]).unwrap();
        assert_eq!(report.skipped_existing, 1, "大小写不同应视为同一条");
    }

    #[test]
    fn scrypt_memory_product_is_bounded() {
        // 2^20 * 32 * 128 = 4 GiB，必须被拒
        let bomb = KdfParams {
            n: Some(1 << 20),
            r: Some(32),
            p: Some(1),
            ..KdfParams::scrypt_default()
        };
        assert!(
            scrypt_params_of(&bomb).is_err(),
            "4 GiB 的参数组合必须被拒绝"
        );

        // 合法参数：2^17 * 8 * 128 = 128 MiB
        let ok = KdfParams {
            n: Some(1 << 17),
            r: Some(8),
            p: Some(1),
            ..KdfParams::scrypt_default()
        };
        assert!(scrypt_params_of(&ok).is_ok());
    }

    #[test]
    fn argon2_memory_cap_rejects_absurd_params() {
        assert!(argon2_params_of(&KdfParams::argon2_with(512 * 1024, 3, 1)).is_err());
        assert!(argon2_params_of(&KdfParams::argon2_with(64 * 1024, 3, 1)).is_ok());
    }

    #[test]
    fn oversized_file_is_rejected() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        {
            let f = std::fs::File::create(&path).unwrap();
            f.set_len(MAX_VAULT_BYTES + 1).unwrap();
        }
        let mut v = Vault::new(&path);
        let err = v.unlock("master-password-123").unwrap_err();
        assert_eq!(err.code(), "CORRUPT");
    }

    #[test]
    fn mismatched_format_is_rejected() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        v.lock();

        // 把 v3 的格式标签改成 v1：`dek` 字段就成了 v1 结构里的非法成员，
        // 解析直接失败——而不是被当成旧格式「勉强解密」后报一句密码错。
        let mut json = read_json(&path);
        json["format"] = serde_json::json!(FORMAT_V1);
        write_json(&path, &json);

        let mut v2 = Vault::new(&path);
        let err = v2.unlock("master-password-123").unwrap_err();
        assert_eq!(err.code(), "CORRUPT");
    }

    #[test]
    fn wipe_removes_every_artifact() {
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("A", "p")).unwrap();
        v.upsert_entry(entry("B", "p")).unwrap();
        let path = v.path.clone();
        assert!(v.backup_slot(1).exists());

        v.wipe().unwrap();

        assert!(!path.exists());
        assert!(!v.backup_path().exists());
        for i in 1..=BACKUP_GENERATIONS {
            assert!(!v.backup_slot(i).exists(), ".bak.{i} 应当被删除");
        }
    }

    #[test]
    fn tmp_file_cleaned_after_save() {
        let dir = tmp();
        let path = dir.path().join("vault.dat");
        let mut v = Vault::new(&path);
        v.create("master-password-123").unwrap();
        assert!(!tmp_path(&path).exists(), "临时文件不应残留");
    }

    #[test]
    fn weak_password_rejected() {
        let dir = tmp();
        let mut v = Vault::new(dir.path().join("vault.dat"));
        let err = v.create("short").unwrap_err();
        assert_eq!(err.code(), "WEAK_PASSWORD");
    }

    #[test]
    fn legacy_fast_path_still_works() {
        // 覆盖 fast_vault 辅助函数本身（小参数 Argon2 可正常加解密）
        let dir = tmp();
        let mut v = fast_vault(dir.path());
        v.upsert_entry(entry("B", "pw")).unwrap();
        v.lock();
        let mut v2 = Vault::new(dir.path().join("vault.dat"));
        assert_eq!(v2.unlock("master-password-123").unwrap().entries.len(), 1);
    }
}
