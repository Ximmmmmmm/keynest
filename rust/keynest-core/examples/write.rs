//! 反向验证：Rust 创建 vault.dat，交给 Node 版打开。

use keynest_core::vault::Entry;
use keynest_core::Vault;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: write <vault.dat> <master-password>");
        std::process::exit(2);
    }
    let path = &args[1];
    let master = &args[2];

    let mut vault = Vault::new(path);
    vault.create(master)?;

    vault.upsert_entry(Entry {
        id: String::new(),
        title: "RustWritten".into(),
        username: "rust@example.com".into(),
        password: "RustP@ss!2026".into(),
        url: "https://rust.test".into(),
        category: "网站".into(),
        notes: "由 Rust 版写入".into(),
        created_at: String::new(),
        updated_at: String::new(),
    })?;

    vault.lock();
    println!("[+] Rust 版已写入: {path}");
    Ok(())
}
