//! 设计预览用：生成一份带示例条目的仓库。
//!
//! 这只是个开发辅助工具，不参与发布产物。
//!
//! 用法：
//!   cargo run --example seed -- <vault.dat 路径> <主密码>

use keynest_core::vault::{Entry, Vault};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: seed <vault.dat> <master-password>");
        std::process::exit(2);
    }

    let mut v = Vault::new(&args[1]);
    v.create(&args[2])?;

    let samples = [
        (
            "GitHub",
            "alice@example.com",
            "ghP@ssw0rd!2026",
            "https://github.com",
            "网站",
            "已开启两步验证",
        ),
        (
            "腾讯云控制台",
            "admin@ximlab.cn",
            "Tc-2026!Aq7#z",
            "https://console.cloud.tencent.com",
            "服务器",
            "轻量服务器 2 台",
        ),
        (
            "QQ 邮箱",
            "xim@qq.com",
            "mail-Passw0rd!77",
            "https://mail.qq.com",
            "邮箱",
            "",
        ),
        (
            "招商银行",
            "6225 **** **** 8842",
            "882108",
            "https://www.cmbchina.com",
            "金融",
            "仅用于查询",
        ),
        (
            "Figma",
            "design@ximlab.cn",
            "Fg-2026$Design!",
            "https://www.figma.com",
            "应用",
            "团队协作",
        ),
        (
            "Steam",
            "xim_steam",
            "St3am!#Secret",
            "https://store.steampowered.com",
            "其他",
            "",
        ),
    ];

    for (title, user, pw, url, cat, notes) in samples {
        v.upsert_entry(Entry {
            id: String::new(),
            title: title.into(),
            username: user.into(),
            password: pw.into(),
            url: url.into(),
            category: cat.into(),
            notes: notes.into(),
            favorite: false,
            kind: keynest_core::kinds::LOGIN.to_string(),
            fields: Vec::new(),
            totp: None,
            password_changed_at: None,
            deleted_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        })?;
    }

    v.lock();
    println!("已写入 {} 条示例条目: {}", samples.len(), args[1]);
    Ok(())
}
