//! 矢量图标：用 egui 的 painter 直接绘制。
//!
//! 为什么不用图标字体或 PNG：纯代码绘制在任意 DPI 下都清晰，不引入额外依赖，
//! 也不受网络与授权限制。每个图标都在 `rect` 内按归一化坐标绘制。

use egui::{Color32, Pos2, Rect, Stroke, StrokeKind, Vec2};

use super::theme;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Search,
    Plus,
    Gear,
    Lock,
    Copy,
    Eye,
    EyeOff,
    Edit,
    Trash,
    Key,
    Shield,
    CopyCheck,
    /// 人形：用于「复制用户名」，与「复制密码」的钥匙明确区分
    User,
    /// 外链箭头：用于「在浏览器中打开」
    External,
    /// 环形箭头：用于「重新载入磁盘上的库」
    Refresh,
}

impl Icon {
    /// SVG 里常用的 viewBox 尺寸，用 24x24 的归一化坐标。
    fn units(self) -> f32 {
        24.0
    }
}

/// 在 `rect` 内绘制图标。
pub fn paint(painter: &egui::Painter, rect: Rect, icon: Icon, color: Color32, width: f32) {
    let s = rect.width().min(rect.height()) / icon.units();
    let o = rect.center() - Vec2::splat(icon.units() * s / 2.0);
    let pt = |x: f32, y: f32| Pos2::new(o.x + x * s, o.y + y * s);
    let stroke = Stroke::new(width, color);

    match icon {
        Icon::Search => {
            painter.circle_stroke(pt(10.5, 10.5), 6.5 * s, stroke);
            painter.line_segment([pt(15.5, 15.5), pt(20.5, 20.5)], stroke);
        }
        Icon::Plus => {
            painter.line_segment([pt(12.0, 5.0), pt(12.0, 19.0)], stroke);
            painter.line_segment([pt(5.0, 12.0), pt(19.0, 12.0)], stroke);
        }
        Icon::Gear => {
            painter.circle_stroke(pt(12.0, 12.0), 3.2 * s, stroke);
            for i in 0..8 {
                let a = i as f32 * std::f32::consts::TAU / 8.0;
                let (sin, cos) = a.sin_cos();
                painter.line_segment(
                    [
                        pt(12.0 + cos * 6.0, 12.0 + sin * 6.0),
                        pt(12.0 + cos * 9.0, 12.0 + sin * 9.0),
                    ],
                    stroke,
                );
            }
        }
        Icon::Lock => {
            painter.rect_stroke(
                Rect::from_min_max(pt(5.0, 11.0), pt(19.0, 21.0)),
                egui::CornerRadius::same(2),
                stroke,
                StrokeKind::Middle,
            );
            // 锁梁
            let c = pt(12.0, 11.0);
            painter.add(egui::epaint::PathShape::line(
                vec![
                    pt(8.0, 11.0),
                    pt(8.0, 8.0),
                    pt(9.2, 5.4),
                    pt(12.0, 4.4),
                    pt(14.8, 5.4),
                    pt(16.0, 8.0),
                    pt(16.0, 11.0),
                ],
                Stroke::new(width, color),
            ));
            let _ = c;
        }
        Icon::Key => {
            // 圆头 + 斜杆 + 两枚齿。
            // 只画「圆 + 一根斜线」在 16px 下会被看成放大镜——
            // 齿是区分钥匙和放大镜的唯一有效特征。
            painter.circle_stroke(pt(8.0, 8.0), 3.8 * s, stroke);
            painter.line_segment([pt(10.7, 10.7), pt(19.5, 19.5)], stroke);
            painter.line_segment([pt(15.2, 15.2), pt(13.2, 17.2)], stroke);
            painter.line_segment([pt(18.0, 18.0), pt(16.0, 20.0)], stroke);
        }
        Icon::User => {
            painter.circle_stroke(pt(12.0, 8.5), 3.6 * s, stroke);
            painter.add(egui::epaint::PathShape::line(
                vec![
                    pt(4.8, 19.5),
                    pt(6.4, 15.6),
                    pt(12.0, 14.2),
                    pt(17.6, 15.6),
                    pt(19.2, 19.5),
                ],
                Stroke::new(width, color),
            ));
        }
        Icon::Refresh => {
            // 一个带缺口的圆环 + 箭头，表示"重新载入"
            let r = 6.5 * s;
            let c = pt(12.0, 12.0);
            // 弧：从 -60° 画到 240°，留出缺口给箭头
            let start = -std::f32::consts::FRAC_PI_3;
            let end = start + std::f32::consts::PI * 1.55;
            let steps = 24;
            let mut prev = pt(12.0 + r / s * start.cos(), 12.0 + r / s * start.sin());
            for i in 1..=steps {
                let t = start + (end - start) * (i as f32 / steps as f32);
                let cur = pt(12.0 + r / s * t.cos(), 12.0 + r / s * t.sin());
                painter.line_segment([prev, cur], stroke);
                prev = cur;
            }
            // 箭头：在弧的起点处画一个指向切线方向的三角
            let ax = 12.0 + r / s * start.cos();
            let ay = 12.0 + r / s * start.sin();
            painter.line_segment([pt(ax, ay), pt(ax - 1.5, ay - 3.5)], stroke);
            painter.line_segment([pt(ax, ay), pt(ax + 3.0, ay - 2.5)], stroke);
            let _ = c;
        }
        Icon::External => {
            // 方框 + 指向右上的箭头：一眼能看出是「跳出去」
            painter.add(egui::epaint::PathShape::line(
                vec![pt(13.0, 5.0), pt(19.0, 5.0), pt(19.0, 11.0)],
                Stroke::new(width, color),
            ));
            painter.line_segment([pt(19.0, 5.0), pt(11.0, 13.0)], stroke);
            painter.add(egui::epaint::PathShape::line(
                vec![
                    pt(17.0, 14.5),
                    pt(17.0, 19.0),
                    pt(5.0, 19.0),
                    pt(5.0, 7.0),
                    pt(9.5, 7.0),
                ],
                Stroke::new(width, color),
            ));
        }
        Icon::Shield => {
            let pts = vec![
                pt(12.0, 3.0),
                pt(20.0, 6.0),
                pt(20.0, 12.0),
                pt(12.0, 21.0),
                pt(4.0, 12.0),
                pt(4.0, 6.0),
            ];
            painter.add(egui::epaint::PathShape::convex_polygon(
                pts,
                Color32::TRANSPARENT,
                Stroke::new(width, color),
            ));
        }
        Icon::Copy | Icon::CopyCheck => {
            painter.rect_stroke(
                Rect::from_min_max(pt(9.0, 9.0), pt(20.0, 20.0)),
                egui::CornerRadius::same(2),
                stroke,
                StrokeKind::Middle,
            );
            // 背面的那张
            painter.add(egui::epaint::PathShape::line(
                vec![
                    pt(6.0, 16.0),
                    pt(5.0, 16.0),
                    pt(4.0, 16.0),
                    pt(4.0, 4.0),
                    pt(16.0, 4.0),
                    pt(16.0, 5.0),
                ],
                Stroke::new(width, color),
            ));
            if icon == Icon::CopyCheck {
                painter.add(egui::epaint::PathShape::line(
                    vec![pt(11.5, 15.0), pt(14.0, 17.5), pt(18.0, 12.5)],
                    Stroke::new(width, color),
                ));
            }
        }
        Icon::Eye | Icon::EyeOff => {
            // 上下两条弧近似杏仁形
            painter.add(egui::epaint::PathShape::line(
                vec![
                    pt(3.0, 12.0),
                    pt(6.5, 7.5),
                    pt(12.0, 6.0),
                    pt(17.5, 7.5),
                    pt(21.0, 12.0),
                    pt(17.5, 16.5),
                    pt(12.0, 18.0),
                    pt(6.5, 16.5),
                    pt(3.0, 12.0),
                ],
                Stroke::new(width, color),
            ));
            painter.circle_stroke(pt(12.0, 12.0), 2.6 * s, stroke);
            if icon == Icon::EyeOff {
                painter.line_segment([pt(4.0, 20.0), pt(20.0, 4.0)], stroke);
            }
        }
        Icon::Edit => {
            // 笔杆
            painter.line_segment([pt(5.0, 19.0), pt(16.5, 7.5)], stroke);
            painter.line_segment([pt(16.5, 7.5), pt(19.0, 10.0)], stroke);
            painter.line_segment([pt(19.0, 10.0), pt(7.5, 21.5)], Stroke::new(width, color));
            // 笔尖
            painter.add(egui::epaint::PathShape::convex_polygon(
                vec![pt(5.0, 19.0), pt(4.4, 21.6), pt(7.0, 21.0)],
                color,
                Stroke::NONE,
            ));
        }
        Icon::Trash => {
            painter.line_segment([pt(4.0, 6.5), pt(20.0, 6.5)], stroke);
            painter.rect_stroke(
                Rect::from_min_max(pt(6.5, 8.0), pt(17.5, 21.0)),
                egui::CornerRadius::same(2),
                stroke,
                StrokeKind::Middle,
            );
            painter.line_segment([pt(9.5, 6.5), pt(10.2, 3.5)], stroke);
            painter.line_segment([pt(14.5, 6.5), pt(13.8, 3.5)], stroke);
            painter.line_segment([pt(10.2, 3.5), pt(13.8, 3.5)], stroke);
            painter.line_segment(
                [pt(10.5, 11.0), pt(10.5, 18.0)],
                Stroke::new(width * 0.8, color),
            );
            painter.line_segment(
                [pt(13.5, 11.0), pt(13.5, 18.0)],
                Stroke::new(width * 0.8, color),
            );
        }
    }
}

/// 可点击的图标按钮（带 hover 背景与 tooltip）。
pub fn button(ui: &mut egui::Ui, icon: Icon, tip: &str) -> egui::Response {
    button_tinted(ui, icon, tip, None)
}

/// 同上，但可以指定常态颜色（用于「已复制」时变绿）。
pub fn button_tinted(
    ui: &mut egui::Ui,
    icon: Icon,
    tip: &str,
    tint: Option<egui::Color32>,
) -> egui::Response {
    let p = theme::palette();
    let size = egui::vec2(30.0, 28.0);
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::click());

    if resp.hovered() {
        ui.painter()
            .rect_filled(rect, egui::CornerRadius::same(theme::R_SM), p.accent_soft);
    }

    let color = match (tint, resp.hovered()) {
        (Some(c), false) => c,
        (_, true) => p.accent,
        _ => p.muted,
    };
    let inner = Rect::from_center_size(rect.center(), Vec2::splat(18.0));
    paint(ui.painter(), inner, icon, color, 1.7);

    if !tip.is_empty() {
        resp.clone().on_hover_text(tip)
    } else {
        resp
    }
}

/// 带图标 + 文字的按钮。
pub fn labeled(ui: &mut egui::Ui, icon: Icon, text: &str) -> egui::Response {
    let p = theme::palette();
    let font = egui::FontId::new(13.5, egui::FontFamily::Proportional);
    // 左边距 8 + 图标 16 + 间距 6 + 文字 + 右边距 10
    let text_w = theme::text_width(ui, text, &font);
    let size = egui::vec2(40.0 + text_w, 30.0);
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::click());

    let fill = if resp.hovered() {
        p.accent_soft
    } else {
        p.surface
    };
    let stroke = if resp.hovered() {
        egui::Stroke::new(1.0, p.accent.gamma_multiply(0.6))
    } else {
        egui::Stroke::new(1.0, p.border)
    };
    ui.painter().rect(
        rect,
        egui::CornerRadius::same(theme::R_SM),
        fill,
        stroke,
        StrokeKind::Middle,
    );

    let icon_rect = Rect::from_min_size(
        Pos2::new(rect.left() + 8.0, rect.center().y - 8.0),
        Vec2::splat(16.0),
    );
    paint(
        ui.painter(),
        icon_rect,
        icon,
        if resp.hovered() { p.accent } else { p.text },
        1.6,
    );

    ui.painter().with_clip_rect(rect).text(
        Pos2::new(icon_rect.right() + 6.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        text,
        font,
        p.text,
    );

    resp
}

/// 危险操作按钮（红字红边）。
pub fn labeled_danger(ui: &mut egui::Ui, icon: Icon, text: &str) -> egui::Response {
    let p = theme::palette();
    let font = egui::FontId::new(13.5, egui::FontFamily::Proportional);
    // 左边距 8 + 图标 16 + 间距 6 + 文字 + 右边距 10
    let text_w = theme::text_width(ui, text, &font);
    let size = egui::vec2(40.0 + text_w, 30.0);
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::click());

    let fill = if resp.hovered() {
        p.danger.gamma_multiply(0.12)
    } else {
        p.surface
    };
    ui.painter().rect(
        rect,
        egui::CornerRadius::same(theme::R_SM),
        fill,
        egui::Stroke::new(1.0, p.danger.gamma_multiply(0.45)),
        StrokeKind::Middle,
    );

    let icon_rect = Rect::from_min_size(
        Pos2::new(rect.left() + 8.0, rect.center().y - 8.0),
        Vec2::splat(16.0),
    );
    paint(ui.painter(), icon_rect, icon, p.danger, 1.6);
    ui.painter().with_clip_rect(rect).text(
        Pos2::new(icon_rect.right() + 6.0, rect.center().y),
        egui::Align2::LEFT_CENTER,
        text,
        font,
        p.danger,
    );

    resp
}

/// 应用标志：盾牌 + 钥匙孔。
pub fn paint_logo(painter: &egui::Painter, rect: Rect, accent: Color32, fill: Color32) {
    let s = rect.width().min(rect.height()) / 24.0;
    let o = rect.center() - Vec2::splat(24.0 * s / 2.0);
    let pt = |x: f32, y: f32| Pos2::new(o.x + x * s, o.y + y * s);

    // 盾牌填充
    painter.add(egui::epaint::PathShape::convex_polygon(
        vec![
            pt(12.0, 2.5),
            pt(21.0, 6.0),
            pt(21.0, 12.5),
            pt(12.0, 21.5),
            pt(3.0, 12.5),
            pt(3.0, 6.0),
        ],
        accent,
        Stroke::NONE,
    ));
    // 钥匙孔
    painter.circle_filled(pt(12.0, 10.0), 2.0 * s, fill);
    painter.add(egui::epaint::PathShape::convex_polygon(
        vec![
            pt(10.9, 11.2),
            pt(13.1, 11.2),
            pt(12.6, 15.2),
            pt(11.4, 15.2),
        ],
        fill,
        Stroke::NONE,
    ));
}
