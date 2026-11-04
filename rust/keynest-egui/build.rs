// 把图标与版本信息嵌进 Windows exe。
//
// # 为什么需要这个
//
// 没有它，资源管理器里显示的是**默认空白图标**——用户看不出这是哪个程序，
// 任务栏与快捷方式也一样。功能上不影响，但一个密码管理器长得像
// 未知程序，会让人不敢双击。
//
// `build/icon.ico` 是仓库里原有的素材（256×256，蓝底盾牌 + 钥匙孔）。
//
// 非 Windows 平台不做任何事：`.ico` 是 Windows 资源格式，
// 其它平台由打包流程处理（.icns / .png）。这里静默跳过，
// 不让 Linux/macOS 的构建因为一个 Windows 专属步骤而失败。

fn main() {
    if std::env::var_os("CARGO_CFG_WINDOWS").is_none() {
        return;
    }

    let icon = std::path::Path::new("../../build/icon.ico");
    if !icon.exists() {
        // 图标缺失不该让构建失败——那是发布流程该报的错，
        // 不是每个开发者本地都必须有。
        println!("cargo:warning=build/icon.ico 不存在，exe 将使用默认图标");
        return;
    }

    let mut res = winresource::WindowsResource::new();
    res.set_icon(icon.to_str().unwrap_or(""));
    res.set("ProductName", "钥巢 KeyNest");
    res.set("FileDescription", "钥巢 — 本地加密密码管理器");
    res.set("LegalCopyright", "MIT OR Apache-2.0");
    if let Err(e) = res.compile() {
        println!("cargo:warning=嵌入 Windows 资源失败：{e}");
    }

    // 图标变了要重编
    println!("cargo:rerun-if-changed=../../build/icon.ico");
    println!("cargo:rerun-if-changed=build.rs");
}
