//! 视觉主题：配色、圆角、间距、文字层级。
//!
//! 全部离线定义，不依赖任何外部素材。默认浅色（更接近常见密码管理器的观感），
//! 设置里可切深色。

use std::sync::atomic::{AtomicBool, Ordering};

static DARK: AtomicBool = AtomicBool::new(false);

/// 一套配色。
#[derive(Clone, Copy)]
pub struct Palette {
    pub bg: egui::Color32,
    pub surface: egui::Color32,
    pub surface_alt: egui::Color32,
    pub border: egui::Color32,
    pub text: egui::Color32,
    pub muted: egui::Color32,
    pub accent: egui::Color32,
    pub accent_hover: egui::Color32,
    pub accent_soft: egui::Color32,
    pub danger: egui::Color32,
    pub success: egui::Color32,
    pub warn: egui::Color32,
    /// 主按钮上的文字颜色
    pub on_accent: egui::Color32,
}

const LIGHT: Palette = Palette {
    bg: egui::Color32::from_rgb(0xF2, 0xF4, 0xF8),
    surface: egui::Color32::from_rgb(0xFF, 0xFF, 0xFF),
    surface_alt: egui::Color32::from_rgb(0xF7, 0xF8, 0xFB),
    border: egui::Color32::from_rgb(0xE2, 0xE6, 0xF0),
    text: egui::Color32::from_rgb(0x16, 0x1B, 0x26),
    muted: egui::Color32::from_rgb(0x6B, 0x74, 0x80),
    accent: egui::Color32::from_rgb(0x3B, 0x5B, 0xDB),
    accent_hover: egui::Color32::from_rgb(0x33, 0x4F, 0xC4),
    accent_soft: egui::Color32::from_rgb(0xEE, 0xF2, 0xFF),
    danger: egui::Color32::from_rgb(0xC0, 0x39, 0x2B),
    success: egui::Color32::from_rgb(0x1E, 0x8E, 0x5A),
    warn: egui::Color32::from_rgb(0xB4, 0x76, 0x1F),
    on_accent: egui::Color32::from_rgb(0xFF, 0xFF, 0xFF),
};

const DARK_P: Palette = Palette {
    bg: egui::Color32::from_rgb(0x14, 0x17, 0x1E),
    surface: egui::Color32::from_rgb(0x1C, 0x20, 0x28),
    surface_alt: egui::Color32::from_rgb(0x23, 0x28, 0x32),
    border: egui::Color32::from_rgb(0x2A, 0x30, 0x3C),
    text: egui::Color32::from_rgb(0xE8, 0xEA, 0xF0),
    muted: egui::Color32::from_rgb(0x98, 0xA0, 0xAE),
    accent: egui::Color32::from_rgb(0x6B, 0x8A, 0xFF),
    accent_hover: egui::Color32::from_rgb(0x82, 0x9C, 0xFF),
    accent_soft: egui::Color32::from_rgb(0x23, 0x2A, 0x3D),
    danger: egui::Color32::from_rgb(0xE0, 0x6C, 0x5F),
    success: egui::Color32::from_rgb(0x4A, 0xC0, 0x8A),
    warn: egui::Color32::from_rgb(0xE0, 0xA8, 0x50),
    on_accent: egui::Color32::from_rgb(0x0E, 0x11, 0x18),
};

pub fn palette() -> Palette {
    if DARK.load(Ordering::Relaxed) {
        DARK_P
    } else {
        LIGHT
    }
}

/// 当前配色对应的系统主题（用于同步原生标题栏）。
pub fn system_theme() -> egui::SystemTheme {
    if is_dark() {
        egui::SystemTheme::Dark
    } else {
        egui::SystemTheme::Light
    }
}

pub fn is_dark() -> bool {
    DARK.load(Ordering::Relaxed)
}

/// 圆角常量
pub const R_SM: u8 = 6;
pub const R_MD: u8 = 10;
pub const R_LG: u8 = 14;

/// 应用主题（配色 + 间距 + 字号层级）。
pub fn apply(ctx: &egui::Context, dark: bool) {
    DARK.store(dark, Ordering::Relaxed);
    let p = palette();

    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };

    visuals.panel_fill = p.bg;
    visuals.window_fill = p.surface;
    visuals.extreme_bg_color = p.surface_alt;
    visuals.faint_bg_color = p.surface_alt;
    visuals.override_text_color = Some(p.text);
    visuals.window_corner_radius = egui::CornerRadius::same(R_LG);
    visuals.menu_corner_radius = egui::CornerRadius::same(R_MD);
    visuals.window_stroke = egui::Stroke::new(1.0, p.border);
    visuals.error_fg_color = p.danger;
    visuals.warn_fg_color = p.warn;
    visuals.hyperlink_color = p.accent;
    visuals.selection.bg_fill = p.accent_soft;
    visuals.selection.stroke = egui::Stroke::new(1.0, p.accent);
    visuals.window_shadow = egui::epaint::Shadow {
        offset: [0, 8],
        blur: 24,
        spread: 0,
        color: egui::Color32::from_black_alpha(if dark { 90 } else { 26 }),
    };

    // 控件三态
    let w = &mut visuals.widgets;
    for (state, fill, stroke_color) in [
        (0usize, p.surface_alt, p.border),
        (1, p.accent_soft, p.accent),
        (2, p.accent_soft, p.accent),
    ] {
        let v = match state {
            0 => &mut w.inactive,
            1 => &mut w.hovered,
            _ => &mut w.active,
        };
        v.weak_bg_fill = fill;
        v.bg_fill = fill;
        v.bg_stroke = egui::Stroke::new(1.0, stroke_color);
        v.corner_radius = egui::CornerRadius::same(R_SM);
        v.fg_stroke = egui::Stroke::new(1.0, p.text);
    }
    w.noninteractive.bg_fill = p.surface;
    w.noninteractive.weak_bg_fill = p.surface;
    w.noninteractive.bg_stroke = egui::Stroke::new(1.0, p.border);
    w.noninteractive.corner_radius = egui::CornerRadius::same(R_SM);
    w.noninteractive.fg_stroke = egui::Stroke::new(1.0, p.muted);
    // 窗口标题栏用的是 `widgets.open.weak_bg_fill`。不显式设置的话，
    // 它会退回 egui 默认的灰底 —— 浅色主题下看起来像一块突兀的水泥板。
    w.open.bg_stroke = egui::Stroke::new(1.0, p.accent);
    w.open.weak_bg_fill = p.surface_alt;
    w.open.bg_fill = p.surface_alt;
    w.open.fg_stroke = egui::Stroke::new(1.0, p.text);
    w.open.corner_radius = egui::CornerRadius::same(R_SM);

    ctx.set_visuals(visuals);

    // 让 Windows 原生标题栏跟随应用明暗，避免「浅色界面 + 深色标题栏」的割裂
    ctx.send_viewport_cmd(egui::ViewportCommand::SetTheme(system_theme()));

    ctx.all_styles_mut(|style| {
        style.spacing.item_spacing = egui::vec2(8.0, 8.0);
        style.spacing.button_padding = egui::vec2(12.0, 6.0);
        style.spacing.interact_size = egui::vec2(32.0, 28.0);
        style.spacing.menu_margin = egui::Margin::same(8);
        style.spacing.window_margin = egui::Margin::same(14);
        // 滚动条浮在内容上方，不占宽度（宽度不跳动）
        style.spacing.scroll.floating = true;

        use egui::{FontFamily::Proportional, FontId, TextStyle};
        style
            .text_styles
            .insert(TextStyle::Heading, FontId::new(22.0, Proportional));
        style
            .text_styles
            .insert(TextStyle::Body, FontId::new(14.0, Proportional));
        style
            .text_styles
            .insert(TextStyle::Button, FontId::new(14.0, Proportional));
        style
            .text_styles
            .insert(TextStyle::Small, FontId::new(11.5, Proportional));
        style.text_styles.insert(
            TextStyle::Monospace,
            FontId::new(13.0, egui::FontFamily::Monospace),
        );
    });
}

/* ---------------- 常用 Frame ---------------- */

/// 页面级卡片（白底 + 细边 + 圆角）
pub fn card() -> egui::Frame {
    let p = palette();
    egui::Frame::new()
        .fill(p.surface)
        .stroke(egui::Stroke::new(1.0, p.border))
        .corner_radius(egui::CornerRadius::same(R_MD))
        .inner_margin(egui::Margin::same(16))
}

/// 实测单行文本宽度（像素）。
///
/// 按字数估算对中英混排误差太大，按钮宽度必须按真实排版来算，
/// 否则会出现「按钮留了位但文字被省略成 …」。
pub fn text_width(ui: &egui::Ui, text: &str, font: &egui::FontId) -> f32 {
    ui.painter()
        .layout_no_wrap(text.to_owned(), font.clone(), egui::Color32::WHITE)
        .size()
        .x
}

/// 按最大宽度把文本截断成「前缀 + …」。
///
/// 手绘文本没有自动换行/裁剪，长标题会直接压到右边那一列上。
/// 这里用二分查找找到能放下的最长前缀，比逐字测量快得多。
pub fn elide(ui: &egui::Ui, text: &str, font: &egui::FontId, max_w: f32) -> String {
    if max_w <= 0.0 || text.is_empty() {
        return String::new();
    }

    let measure = |s: &str| -> f32 {
        ui.painter()
            .layout_no_wrap(s.to_owned(), font.clone(), egui::Color32::WHITE)
            .size()
            .x
    };

    if measure(text) <= max_w {
        return text.to_owned();
    }

    // 连一个省略号都放不下就干脆不画
    if measure("…") > max_w {
        return String::new();
    }

    let total = text.chars().count();
    let mut lo = 0usize;
    let mut hi = total;
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        let mut probe: String = text.chars().take(mid).collect();
        probe.push('…');
        if measure(&probe) <= max_w {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }

    let mut out: String = text.chars().take(lo).collect();
    if lo < total {
        out.push('…');
    }
    out
}

/// 在指定矩形内绘制被裁剪的单行文本，左对齐居中。
///
/// `with_clip_rect` 是最后一道保险：即使省略算法算错，也不会画到隔壁列。
pub fn draw_text_clipped(
    ui: &egui::Ui,
    rect: egui::Rect,
    pos: egui::Pos2,
    text: &str,
    font: egui::FontId,
    color: egui::Color32,
) {
    let clipped = ui.painter().with_clip_rect(rect);
    clipped.text(pos, egui::Align2::LEFT_CENTER, text, font, color);
}

/* ---------------- 文字层级 ---------------- */

pub fn h2(text: impl Into<String>) -> egui::RichText {
    let p = palette();
    egui::RichText::new(text).size(18.0).strong().color(p.text)
}

pub fn h3(text: impl Into<String>) -> egui::RichText {
    let p = palette();
    egui::RichText::new(text).size(14.5).strong().color(p.text)
}

pub fn body(text: impl Into<String>) -> egui::RichText {
    let p = palette();
    egui::RichText::new(text).size(14.0).color(p.text)
}

pub fn caption(text: impl Into<String>) -> egui::RichText {
    let p = palette();
    egui::RichText::new(text).size(11.0).color(p.muted)
}

/// 小标签（字段名）
pub fn label(text: impl Into<String>) -> egui::RichText {
    let p = palette();
    egui::RichText::new(text).size(11.5).color(p.muted)
}

pub fn mono(text: impl Into<String>) -> egui::RichText {
    let p = palette();
    egui::RichText::new(text)
        .size(14.0)
        .monospace()
        .color(p.text)
}

/// 分组标题（带一点字距感）
pub fn section(ui: &mut egui::Ui, text: &str) {
    let p = palette();
    ui.add_space(4.0);
    ui.label(egui::RichText::new(text).size(11.0).strong().color(p.muted));
    ui.add_space(2.0);
}

/// 胶囊筛选按钮（带选中态过渡）。
pub fn chip(ui: &mut egui::Ui, selected: bool, label: &str) -> egui::Response {
    let p = palette();
    let font = egui::FontId::new(12.5, egui::FontFamily::Proportional);
    // 分类名可能很长：限制最大宽度并省略，避免一行胶囊被一条长名字撑爆
    const MAX_CHIP_W: f32 = 168.0;
    let full = text_width(ui, label, &font);
    let shown = if full + 22.0 > MAX_CHIP_W {
        elide(ui, label, &font, MAX_CHIP_W - 22.0)
    } else {
        label.to_owned()
    };
    let w = text_width(ui, &shown, &font) + 22.0;
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(w, 28.0), egui::Sense::click());

    let t = crate::ui::anim::value(
        ui.ctx(),
        ui.scope_id().with(("chip", label)),
        if selected { 1.0 } else { 0.0 },
        0.15,
    );
    let hover = crate::ui::anim::hover(
        ui.ctx(),
        ui.scope_id().with(("chiph", label)),
        resp.hovered(),
        0.12,
    );

    let fill = crate::ui::anim::lerp_color(
        crate::ui::anim::lerp_color(p.surface, p.surface_alt, hover),
        p.accent_soft,
        t,
    );
    let text_c = crate::ui::anim::lerp_color(
        crate::ui::anim::lerp_color(p.muted, p.text, hover),
        p.accent,
        t,
    );
    let radius = egui::CornerRadius::same(R_SM);
    ui.painter().rect_filled(rect, radius, fill);
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        shown,
        font,
        text_c,
    );
    resp
}

/// 小标签（强度、重复次数等）。
/// 强度分档：文字、进度（0..1）、颜色。
///
/// 界面上**不显示 bit 数**——"99 bit" 对绝大多数人没有意义，
/// 反而会让人以为分数越高越好、于是去数位数。给出的是能比较的四档 + 一根条，
/// 想看原始估算值的人可以悬停。
pub fn strength_level(bits: f64) -> (&'static str, f32, egui::Color32) {
    let p = palette();
    if bits >= 100.0 {
        ("很强", 1.0, p.success)
    } else if bits >= 65.0 {
        ("强", 0.75, p.success)
    } else if bits >= 45.0 {
        ("一般", 0.5, p.warn)
    } else {
        ("弱", 0.25, p.danger)
    }
}

/// 一根 4 段的强度条 + 文字。悬停给出「按字符集粗估」的原值。
pub fn strength_meter(ui: &mut egui::Ui, bits: f64) {
    let (label, frac, color) = strength_level(bits);
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(96.0, 8.0), egui::Sense::hover());
    let seg_w = (rect.width() - 3.0 * 3.0) / 4.0;
    for i in 0..4 {
        let x = rect.left() + i as f32 * (seg_w + 3.0);
        let seg = egui::Rect::from_min_size(egui::Pos2::new(x, rect.top()), egui::vec2(seg_w, 8.0));
        // 已点亮到第几段：0.25 一档
        let lit = frac > i as f32 * 0.25;
        ui.painter().rect_filled(
            seg,
            egui::CornerRadius::same(2),
            if lit { color } else { palette().border },
        );
    }
    resp.on_hover_text(format!("强度（按字符集粗估）：{label}，约 {bits:.0} bit"));
}

pub fn tag(ui: &mut egui::Ui, label: &str, color: egui::Color32) {
    let font = egui::FontId::new(10.5, egui::FontFamily::Proportional);
    let w = text_width(ui, label, &font) + 14.0;
    let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 20.0), egui::Sense::hover());
    ui.painter().rect_filled(
        rect,
        egui::CornerRadius::same(4),
        crate::ui::anim::with_alpha(color, 0.14),
    );
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        label,
        font,
        color,
    );
}

/* ---------------- 按钮 ---------------- */

/// 主按钮（实心强调色，带悬停插值与按下缩放）。
pub fn primary_button(ui: &mut egui::Ui, text: &str, width: f32) -> egui::Response {
    let p = palette();
    let size = egui::vec2(width, 36.0);
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::click());

    let hover = crate::ui::anim::hover(
        ui.ctx(),
        ui.scope_id().with("primary-btn"),
        resp.hovered(),
        0.12,
    );
    // 按下时轻微缩到 97%，松开回弹
    let press = crate::ui::anim::value(
        ui.ctx(),
        ui.scope_id().with("primary-press"),
        if resp.is_pointer_button_down_on() {
            0.97
        } else {
            1.0
        },
        0.08,
    );

    let scaled = egui::Rect::from_center_size(rect.center(), size * press);
    let fill = crate::ui::anim::lerp_color(p.accent, p.accent_hover, hover);
    let radius = egui::CornerRadius::same(R_SM);

    ui.painter().rect_filled(scaled, radius, fill);
    let font = egui::FontId::new(14.0, egui::FontFamily::Proportional);
    let shown = elide(ui, text, &font, (scaled.width() - 16.0).max(0.0));
    ui.painter().with_clip_rect(scaled).text(
        scaled.center(),
        egui::Align2::CENTER_CENTER,
        shown,
        font,
        p.on_accent,
    );
    resp
}

/// 次要按钮（描边，悬停时底色渐显）。
pub fn ghost_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let p = palette();
    let font = egui::FontId::new(13.0, egui::FontFamily::Proportional);
    let w = text_width(ui, text, &font) + 26.0;
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(w, 32.0), egui::Sense::click());

    let hover = crate::ui::anim::hover(
        ui.ctx(),
        ui.scope_id().with("ghost-btn"),
        resp.hovered(),
        0.12,
    );
    let fill = crate::ui::anim::lerp_color(p.surface, p.surface_alt, hover);
    let stroke_c = crate::ui::anim::lerp_color(p.border, p.accent.gamma_multiply(0.55), hover);
    let text_c = crate::ui::anim::lerp_color(p.text, p.accent, hover);
    let radius = egui::CornerRadius::same(R_SM);

    ui.painter().rect(
        rect,
        radius,
        fill,
        egui::Stroke::new(1.0, stroke_c),
        egui::StrokeKind::Middle,
    );
    let shown = elide(ui, text, &font, (rect.width() - 16.0).max(0.0));
    ui.painter().with_clip_rect(rect).text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        shown,
        font,
        text_c,
    );
    resp
}

/// 危险按钮（描边红，悬停时红底渐显）。
pub fn danger_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let p = palette();
    let font = egui::FontId::new(13.0, egui::FontFamily::Proportional);
    let w = text_width(ui, text, &font) + 26.0;
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(w, 32.0), egui::Sense::click());

    let hover = crate::ui::anim::hover(
        ui.ctx(),
        ui.scope_id().with("danger-btn"),
        resp.hovered(),
        0.12,
    );
    let fill = crate::ui::anim::lerp_color(p.surface, with_alpha_bg(p.danger, 0.10), hover);
    let radius = egui::CornerRadius::same(R_SM);

    ui.painter().rect(
        rect,
        radius,
        fill,
        egui::Stroke::new(1.0, p.danger.gamma_multiply(0.5 + 0.3 * hover)),
        egui::StrokeKind::Middle,
    );
    let shown = elide(ui, text, &font, (rect.width() - 16.0).max(0.0));
    ui.painter().with_clip_rect(rect).text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        shown,
        font,
        p.danger,
    );
    resp
}

fn with_alpha_bg(c: egui::Color32, a: f32) -> egui::Color32 {
    // 用一个接近纸面的底色的半透明色做悬停填充
    let p = palette();
    crate::ui::anim::lerp_color(p.surface, c, a)
}
