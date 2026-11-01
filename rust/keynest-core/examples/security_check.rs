//! 本机能力诊断：**不需要主密码**，也不会碰库里的任何明文。
//!
//! 用来确认三件事是否真的生效，而不是停留在「代码里写了」：
//!
//! 1. 库文件与备份的位置、备份代数；
//! 2. 密钥内存锁定（`VirtualLock`）在当前机器上是否被允许；
//!    受限环境下它会失败，此时只能降级为零化，必须让人知道；
//! 3. 单实例锁当前是否被别的进程持有。
//!
//! ```text
//! cargo run -p keynest-core --example security_check
//! ```

use keynest_core::{paths, AnyFile, InstanceLock, SecretKey, Vault};

fn main() {
    println!("=== 数据目录 ===");
    println!("库文件 : {}", paths::resolve_vault_path().display());
    println!("锁文件 : {}", paths::resolve_lock_path().display());
    println!("仍在漫游目录: {}", paths::is_on_roaming_profile());

    let vault_path = paths::resolve_vault_path();
    if let Ok(bytes) = std::fs::read(&vault_path) {
        match AnyFile::parse(&bytes) {
            Ok(f) => println!("格式   : {} （数据截止 {}）", f.format(), f.updated_at()),
            Err(e) => println!("格式   : 无法解析（{e}）"),
        }
    }

    let backups = Vault::new(&vault_path).list_backups();
    if backups.is_empty() {
        println!("备份   : （无）");
    } else {
        println!("备份   :");
        for b in backups {
            println!(
                "  - {} ({} 字节, 数据截止 {})",
                b.path.display(),
                b.bytes,
                b.updated_at
            );
        }
    }

    println!("\n=== 密钥内存锁定 ===");
    let key = SecretKey::new([0x42; 32]);
    if key.is_locked() {
        println!("VirtualLock : 生效（密钥页已固定在物理内存）");
    } else {
        println!("VirtualLock : 未生效（已降级为零化，换页/休眠可能留下密钥副本）");
    }

    println!("\n=== 单实例锁 ===");
    match InstanceLock::acquire(&paths::resolve_lock_path()) {
        Ok(Some(lock)) => {
            println!("可获取：当前没有其他实例在运行");
            drop(lock);
        }
        Ok(None) => println!("已被其他实例持有（正常，说明互斥生效）"),
        Err(e) => println!("无法判定：{e}"),
    }
}
