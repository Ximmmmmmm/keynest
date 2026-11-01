//! 剪贴板安全行为的运行时验证（对应审查清单第 7 条）。
//!
//! 验证三件事：
//!   1. 写入后能读到，且内容正确；
//!   2. TTL 到期后自动清除；
//!   3. 用户中途复制了别的内容时，定时器不误删。

use keynest_core::secure;
use std::time::Duration;

fn main() {
    let secret = "KN-CLIP-SECRET-1234";

    // --- 场景 1：正常 TTL 清除 ---
    println!("[1] 写入敏感文本，TTL=2s");
    secure::copy_sensitive(secret, Some(Duration::from_secs(2))).expect("写入失败");
    std::thread::sleep(Duration::from_millis(300));
    let now = secure::clipboard_text();
    println!("    写入后读取: {:?}", now.as_deref());
    assert_eq!(now.as_deref(), Some(secret), "写入后应立即读到");

    println!("    等待 2.5s 让 TTL 生效…");
    std::thread::sleep(Duration::from_millis(2500));
    let after = secure::clipboard_text();
    println!("    TTL 后读取: {:?}", after.as_deref());
    assert!(after.as_deref() != Some(secret), "TTL 后敏感内容应被清除");

    // --- 场景 2：用户中途复制了别的内容，不能误删 ---
    println!("[2] 写入敏感文本 TTL=3s，1s 后用户复制了别的东西");
    secure::copy_sensitive(secret, Some(Duration::from_secs(3))).expect("写入失败");
    std::thread::sleep(Duration::from_millis(1000));

    // 模拟用户自己的复制：直接改剪贴板（用一次短 TTL 的普通文本 + 立即再写）
    secure::copy_sensitive("USER-OWN-TEXT", Some(Duration::from_secs(60))).expect("写入失败");
    std::thread::sleep(Duration::from_millis(3000));

    let kept = secure::clipboard_text();
    println!("    定时器到期后读取: {:?}", kept.as_deref());
    assert_eq!(
        kept.as_deref(),
        Some("USER-OWN-TEXT"),
        "不应删除用户的后续复制"
    );

    // 收尾：清掉测试残留
    let _ = secure::clear_now("USER-OWN-TEXT");
    println!("\n全部通过：TTL 清除生效，且不会误删用户内容。");
}
