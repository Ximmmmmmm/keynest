//! 动画工具。
//!
//! egui 是即时模式，动画状态存在 `Context` 的 memory 里，按 `Id` 索引，
//! 只要每帧用同一个 `Id` 调用就会自动插值。

use egui::Color32;

/// 三次缓出：起步快、收尾稳，适合卡片进场与淡入。
pub fn ease_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

/// 缓入缓出，适合位移。
pub fn ease_in_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

/// 颜色线性插值。
pub fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    let f = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t).round() as u8;
    Color32::from_rgba_premultiplied(
        f(a.r(), b.r()),
        f(a.g(), b.g()),
        f(a.b(), b.b()),
        f(a.a(), b.a()),
    )
}

/// 给颜色乘一个透明度系数。
pub fn with_alpha(c: Color32, a: f32) -> Color32 {
    let a = (c.a() as f32 * a.clamp(0.0, 1.0)).round() as u8;
    Color32::from_rgba_premultiplied(c.r(), c.g(), c.b(), a)
}

/// 入场动画：第一次调用时从 0 渐变到 1，之后恒为 1。
///
/// 实现方式是把目标值固定为 `true`，而 egui 的 memory 初始值是 `false`，
/// 于是首帧自然形成 0 → 1 的过渡，不需要额外状态字段。
pub fn enter(ctx: &egui::Context, id: egui::Id, seconds: f32) -> f32 {
    ease_out(ctx.animate_bool_with_time(id, true, seconds))
}

/// 悬停过渡：`on` 为真时升到 1，否则降回 0。
pub fn hover(ctx: &egui::Context, id: egui::Id, on: bool, seconds: f32) -> f32 {
    ease_out(ctx.animate_bool_with_time(id, on, seconds))
}

/// 数值过渡。
pub fn value(ctx: &egui::Context, id: egui::Id, target: f32, seconds: f32) -> f32 {
    ctx.animate_value_with_time(id, target, seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ease_out_is_monotonic_and_clamped() {
        let mut prev = -1.0;
        for i in 0..=20 {
            let t = i as f32 / 20.0;
            let e = ease_out(t);
            assert!(e >= prev, "必须单调不减");
            assert!((0.0..=1.0).contains(&e), "必须落在 [0,1]");
            prev = e;
        }
        assert!((ease_out(0.0) - 0.0).abs() < 1e-6);
        assert!((ease_out(1.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn ease_in_out_hits_midpoint() {
        let mid = ease_in_out(0.5);
        assert!((mid - 0.5).abs() < 0.05, "中点应接近 0.5，实际 {mid}");
    }

    #[test]
    fn lerp_color_endpoints() {
        let a = Color32::from_rgb(0, 0, 0);
        let b = Color32::from_rgb(255, 128, 64);
        assert_eq!(lerp_color(a, b, 0.0), a);
        assert_eq!(lerp_color(a, b, 1.0), b);
        let mid = lerp_color(a, b, 0.5);
        assert!((mid.r() as i32 - 128).abs() <= 1);
        assert!((mid.g() as i32 - 64).abs() <= 1);
        assert!((mid.b() as i32 - 32).abs() <= 1);
    }

    #[test]
    fn with_alpha_scales() {
        let c = Color32::from_rgba_unmultiplied(10, 20, 30, 200);
        let half = with_alpha(c, 0.5);
        assert_eq!(half.a(), 100);
        let zero = with_alpha(c, 0.0);
        assert_eq!(zero.a(), 0);
    }
}
