//! 验收用：生成一份只含**虚构条目**的临时库，条目网址可指定。
//!
//! 存在的理由：浏览器桥的验收需要一个「origin 能对上测试站点」的条目。
//! 现有的 `write` 示例写死 `https://rust.test`，对不上 `https://127.0.0.1:9445`。
//! 与其在测试脚本里改产品代码，不如加一个专门的夹具生成器。
//!
//! 它不参与发布产物，也不碰任何既有库（路径与主密码都由参数给出）。
//!
//! ```text
//! cargo run -p keynest-core --example seed_site -- <vault.dat> <主密码> <origin 或 url> [用户名] [密码]
//! ```

use keynest_core::vault::{Entry, Vault};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("用法: seed_site <vault.dat> <master-password> <url> [username] [password]");
        std::process::exit(2);
    }
    let path = &args[1];
    let master = &args[2];
    let url = &args[3];
    let username = args
        .get(4)
        .cloned()
        .unwrap_or_else(|| "kn-test-user".into());
    let password = args
        .get(5)
        .cloned()
        .unwrap_or_else(|| "Kn-Test-P@ss-2026".into());

    let mut vault = Vault::new(path);
    vault.create(master)?;

    vault.upsert_entry(Entry {
        id: String::new(),
        title: "Phase 2.7.4 Fixture".into(),
        username,
        password,
        url: url.clone(),
        category: "网站".into(),
        notes: "验收夹具，虚构数据".into(),
        favorite: false,
        kind: keynest_core::kinds::LOGIN.to_string(),
        fields: Vec::new(),
        totp: None,
        password_changed_at: None,
        deleted_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    })?;

    // 第二条：同 origin、不同端口/子域，用来验证「不做子域通配」
    vault.upsert_entry(Entry {
        id: String::new(),
        title: "Phase 2.7.4 Fixture (other origin)".into(),
        username: "other-origin-user".into(),
        password: "Other-Origin-P@ss-2026".into(),
        url: "https://localhost:9446/".into(),
        category: "网站".into(),
        notes: "验收夹具，虚构数据".into(),
        favorite: false,
        kind: keynest_core::kinds::LOGIN.to_string(),
        fields: Vec::new(),
        totp: None,
        password_changed_at: None,
        deleted_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    })?;

    vault.lock();
    println!("ok");
    Ok(())
}
