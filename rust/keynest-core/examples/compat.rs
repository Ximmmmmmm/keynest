//! 格式兼容验证：读 Node 版创建的 vault.dat，确认 Rust 能解开且内容一致。
//!
//! 用法：cargo run --example compat -- <vault.dat 路径> <主密码>

use keynest_core::Vault;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: compat <vault.dat> <master-password>");
        std::process::exit(2);
    }
    let path = &args[1];
    let master = &args[2];

    println!("[*] 打开: {path}");
    let mut vault = Vault::new(path);

    match vault.unlock(master) {
        Ok(data) => {
            println!("[+] 解锁成功");
            println!("    条目数: {}", data.entries.len());
            println!("    分类: {:?}", data.categories);
            for e in &data.entries {
                println!("    - {} | {} | {} | {}", e.title, e.username, e.password, e.url);
            }
            // 输出 JSON，便于和 Node 版逐字节比对
            println!("--- JSON ---");
            println!("{}", serde_json::to_string_pretty(&data)?);
            Ok(())
        }
        Err(e) => {
            eprintln!("[-] 解锁失败: {e} (code={})", e.code());
            std::process::exit(1);
        }
    }
}
