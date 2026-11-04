//! 集成测试：只走公开 API，验证 v3 的完整生命周期。
//!
//! 单元测试在 `vault.rs` 内部，可以访问私有函数（例如手工构造 v1/v2 库）。
//! 这里刻意只用外部使用者能拿到的东西，确保：
//!
//! * 库的公开接口自洽，没有依赖内部耦合才能用起来；
//! * 「创建 → 使用 → 换主密码 → 备份 → 恢复 → 删除」这条主链路真的能跑通。
//!
//! 每个用例都会真实跑一次 Argon2id(64MiB)，因此比单元测试慢，这是刻意的：
//! 集成测试要测的是「用户实际会走的那条路径」。

use std::path::{Path, PathBuf};

use keynest_core::vault::Entry;
use keynest_core::{AnyFile, Vault, FORMAT_V3, MIN_MASTER_LEN};

const MASTER: &str = "correct-horse-battery-staple";

struct Env {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.dat");
        Self { _dir: dir, path }
    }

    fn vault(&self) -> Vault {
        Vault::new(&self.path)
    }
}

fn fake_entry(title: &str, password: &str) -> Entry {
    Entry {
        id: String::new(),
        title: title.into(),
        username: format!("{title}@example.test"),
        password: password.into(),
        url: "https://example.test".into(),
        category: "网站".into(),
        notes: String::new(),
        favorite: false,
        kind: keynest_core::kinds::LOGIN.to_string(),
        fields: Vec::new(),
        totp: None,
        password_changed_at: None,
        deleted_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn read_header(path: &Path) -> AnyFile {
    let bytes = std::fs::read(path).unwrap();
    AnyFile::parse(&bytes).unwrap()
}

#[test]
fn new_vault_is_v3() {
    let env = Env::new();
    let mut v = env.vault();
    v.create(MASTER).unwrap();

    assert_eq!(v.format(), Some(FORMAT_V3));
    assert!(!v.is_legacy());
    assert_eq!(read_header(&env.path).format(), FORMAT_V3);
}

#[test]
fn create_use_lock_reopen() {
    let env = Env::new();
    let mut v = env.vault();
    v.create(MASTER).unwrap();
    v.upsert_entry(fake_entry("GitHub", "gh-Secret-1")).unwrap();
    v.upsert_entry(fake_entry("Figma", "fg-Secret-2")).unwrap();
    v.lock();

    assert!(!v.is_unlocked());

    let mut reopened = env.vault();
    let data = reopened.unlock(MASTER).unwrap();
    assert_eq!(data.entries.len(), 2);
    // 最新写入的排在最前
    assert_eq!(data.entries[0].title, "Figma");
    assert_eq!(data.entries[1].password, "gh-Secret-1");
}

#[test]
fn wrong_password_is_rejected_and_leaves_file_intact() {
    let env = Env::new();
    let mut v = env.vault();
    v.create(MASTER).unwrap();
    let before = std::fs::read(&env.path).unwrap();

    let mut other = env.vault();
    assert_eq!(
        other.unlock("wrong-password-here").unwrap_err().code(),
        "INVALID_PASSWORD"
    );
    assert_eq!(std::fs::read(&env.path).unwrap(), before);
}

#[test]
fn change_master_does_not_touch_body_ciphertext() {
    let env = Env::new();
    let mut v = env.vault();
    v.create(MASTER).unwrap();
    v.upsert_entry(fake_entry("A", "pw-A")).unwrap();

    let body_before = std::fs::read_to_string(&env.path).unwrap();

    let new_master = "x".repeat(MIN_MASTER_LEN + 8);
    v.change_master(MASTER, &new_master).unwrap();

    let after = std::fs::read_to_string(&env.path).unwrap();
    // 只比较 payload 行，避免 updatedAt 变化造成干扰
    let payload_of = |text: &str| -> String {
        text.lines()
            .find(|l| l.trim_start().starts_with("\"payload\""))
            .unwrap_or_default()
            .to_string()
    };
    assert_eq!(
        payload_of(&body_before),
        payload_of(&after),
        "正文密文必须不变"
    );
    assert_eq!(read_header(&env.path).format(), FORMAT_V3);

    v.lock();
    let mut reopened = env.vault();
    assert!(reopened.unlock(MASTER).is_err(), "旧密码必须失效");
    assert_eq!(reopened.unlock(&new_master).unwrap().entries.len(), 1);
}

/// 改主密码后，**旧的备份仍然由旧密码保护**。
///
/// # 为什么这条值得单独测
///
/// 改主密码只换掉 wrap（包裹 DEK 的那层），正文密文不变。
/// 于是磁盘上的 `.bak.*` 里裹的还是**旧 wrap** —— 只能用**旧密码**打开。
///
/// 威胁模型里把这一条列为已知限制：
/// 「换密码后旧备份 → ❌ 仍由旧密码保护」。
///
/// 但用户不知道这一点：界面只提示「主密码已修改」。
/// 真到了需要从备份恢复的那一天，他用新密码打不开，
/// 会以为「备份全废了」甚至放弃恢复。
///
/// 所以这个事实必须被测试钉住，同时要在界面上说清楚。
#[test]
fn old_backups_stay_protected_by_the_old_password_after_change() {
    let env = Env::new();
    let mut v = env.vault();
    v.create(MASTER).unwrap();
    v.upsert_entry(fake_entry("A", "pw-A")).unwrap();

    let new_master = "y".repeat(MIN_MASTER_LEN + 8);
    v.change_master(MASTER, &new_master).unwrap();

    // 备份确实存在
    let backups = v.list_backups();
    assert!(!backups.is_empty(), "应当有备份");

    // 用**新密码**打开旧备份：必须失败
    let backup_path = v.backup_slot(1);
    assert!(
        backup_path.exists(),
        "备份文件应当存在: {}",
        backup_path.display()
    );

    let mut restored = env.vault();
    let err = restored
        .restore_from_backup(&backup_path, &new_master)
        .expect_err("旧备份不该能用新密码打开");
    assert_eq!(err.code(), "INVALID_PASSWORD");

    // 用**旧密码**打开：必须成功
    let mut restored2 = env.vault();
    restored2
        .restore_from_backup(&backup_path, MASTER)
        .expect("旧备份应当仍能用旧密码打开");
    assert_eq!(restored2.snapshot().unwrap().entries.len(), 1);
}

#[test]
fn backups_exist_and_can_be_restored() {
    let env = Env::new();
    let mut v = env.vault();
    v.create(MASTER).unwrap();
    v.upsert_entry(fake_entry("A", "pw-A")).unwrap();
    v.upsert_entry(fake_entry("B", "pw-B")).unwrap();

    let backups = v.list_backups();
    assert!(!backups.is_empty(), "多次保存后应当有备份");
    let newest = backups[0].path.clone();
    assert!(!newest.as_os_str().is_empty());
    let expected_entries = v.snapshot().unwrap().entries.len();
    v.lock();

    // 打坏主文件
    let mut bytes = std::fs::read(&env.path).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    std::fs::write(&env.path, &bytes).unwrap();

    let mut broken = env.vault();
    assert!(broken.unlock(MASTER).is_err(), "损坏后不应能打开");

    // 从备份恢复：只要备份是上一次保存的状态，条目数应当是 expected_entries 或更早的少一条
    let restored = broken.restore_from_backup(&newest, MASTER).unwrap();
    assert!(restored.entries.len() <= expected_entries);
    assert!(broken.unlock(MASTER).is_ok(), "恢复后必须能正常打开");
}

#[test]
fn wipe_removes_main_file_and_backups() {
    let env = Env::new();
    let mut v = env.vault();
    v.create(MASTER).unwrap();
    v.upsert_entry(fake_entry("A", "pw-A")).unwrap();
    v.upsert_entry(fake_entry("B", "pw-B")).unwrap();
    assert!(!v.list_backups().is_empty());

    v.wipe().unwrap();

    assert!(!env.path.exists());
    assert!(v.list_backups().is_empty());
}
