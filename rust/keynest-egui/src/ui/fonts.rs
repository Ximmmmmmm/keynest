//! 中文字体加载。
//!
//! egui 内置字体不含 CJK 字形，不注册会全是豆腐块。
//! 这里按优先级尝试 Windows 自带字体：
//!   msyh.ttc（微软雅黑）→ deng.ttf（等线）→ simhei.ttf（黑体）→ simsun.ttc（宋体）
//!
//! `.ttc` 是字体集合，需要指定 index（这里统一用 0 号字面）。

use std::path::Path;
use std::sync::Arc;

const CANDIDATES: [&str; 4] = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\deng.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
];

/// 尝试加载中文字体并注册进 egui。
///
/// 返回实际使用的字体路径；全部失败时返回 None（界面仍可运行，只是中文显示为方块）。
pub fn install_cjk_font(ctx: &egui::Context) -> Option<String> {
    for path in CANDIDATES {
        if !Path::new(path).exists() {
            continue;
        }
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert(
            "cjk".to_owned(),
            Arc::new(egui::FontData::from_owned(bytes)),
        );

        // 追加到两个字族的末尾作为回退：
        // 拉丁字符仍用 egui 自带字体（更清晰），CJK 走系统字体。
        for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            fonts
                .families
                .entry(family)
                .or_default()
                .push("cjk".to_owned());
        }

        ctx.set_fonts(fonts);
        return Some(path.to_string());
    }

    None
}
