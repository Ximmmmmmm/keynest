//! 锁屏 / 首次创建界面。
//!
//! 布局用 `Area` 锚定屏幕中心，避免 `CentralPanel` 内做高度计算导致滚动条。

use std::path::PathBuf;

use zeroize::Zeroizing;

use keynest_core::password;

use crate::ui::{anim, icons, theme};

pub enum LockIntent {
    None,
    Submit,
    /// 用主密码验证并恢复指定的备份。
    Restore,
}

/// 可恢复的备份提示。
///
/// 只在「文件已损坏」或「连续多次解锁失败」时才构造：
/// 光打错一次密码就弹出恢复入口，反而会诱导用户用旧备份覆盖掉完好的库。
#[derive(Clone, Debug)]
pub struct RestoreOffer {
    pub path: PathBuf,
    /// 形如 `2026-10-31 23:50:12 · 3.2 KB`，直接显示给用户。
    pub label: String,
}

/// 背景 + 居中的卡片。
fn shell(ui: &mut egui::Ui, width: f32, add: impl FnOnce(&mut egui::Ui)) {
    let p = theme::palette();
    ui.painter().rect_filled(ui.max_rect(), 0.0, p.bg);

    #[allow(deprecated)]
    let area_id = egui::Id::new("auth-card");

    // 入场动画：淡入 + 从下方 16px 滑上来
    let t = anim::enter(ui.ctx(), area_id.with("enter"), 0.42);
    let lift = (1.0 - t) * 16.0;

    egui::Area::new(area_id)
        .anchor(egui::Align2::CENTER_CENTER, [0.0, -24.0 + lift])
        .show(ui.ctx(), |ui| {
            ui.multiply_opacity(t);
            theme::card().show(ui, |ui| {
                ui.set_width(width);
                add(ui);
            });
        });
}

/// 标志 + 产品名。
fn brand(ui: &mut egui::Ui) {
    let p = theme::palette();
    ui.horizontal(|ui| {
        let (rect, _) = ui.allocate_exact_size(egui::vec2(38.0, 38.0), egui::Sense::hover());
        icons::paint_logo(ui.painter(), rect, p.accent, p.on_accent);
        ui.add_space(4.0);
        ui.vertical(|ui| {
            ui.label(
                egui::RichText::new("钥巢")
                    .size(22.0)
                    .strong()
                    .color(p.text),
            );
            ui.label(egui::RichText::new("KEYNEST").size(10.5).color(p.muted));
        });
    });
}

/// 解锁失败时给出的可执行建议。
///
/// 关键取舍：**文案不区分「密码错」与「密文被改」**（那会给攻击者一个判定 oracle），
/// 但**用户必须能自救**。所以这里给的是「两类原因 + 各自该做什么」，
/// 让真正打错密码的人去检查 CapsLock，让文件真坏的人去找备份。
fn unlock_advice(code: &str) -> (&'static str, String) {
    match code {
        "CORRUPT" | "UNSUPPORTED_FORMAT" => (
            "密码库文件已损坏或被改动过",
            // 一条一条列出来，而不是连着写一大段：
            // 中文长句在窄卡片里自动换行后很难读，分点之后用户能扫。
            "这不是密码的问题——程序在解密之前就发现文件结构不对。\n\n• 先试下方的备份恢复\n• 恢复也失败，说明备份同样损坏".to_string(),
        ),
        "NO_VAULT" => (
            "找不到密码库文件",
            "文件可能被移动或删除了。\n\n• 确认数据目录位置\n• 或从备份恢复".to_string(),
        ),
        "KDF" | "RANDOM" | "IO" => (
            "运行环境有问题",
            "密钥派生或文件读写失败。\n\n• 检查磁盘空间与目录权限后重试".to_string(),
        ),
        _ => (
            "主密码错误",
            "按顺序检查：\n\n• 大写锁定是否打开\n• 输入法是否处于中文状态\n• 粘贴时有没有带上首尾空格\n\n如果确认密码无误，那可能是文件被改坏了。出于安全考虑，程序不告诉你到底是哪一种——但那也会让攻击者能分辨。".to_string(),
        ),
    }
}

pub fn show(
    ui: &mut egui::Ui,
    password: &mut Zeroizing<String>,
    error: Option<&str>,
    error_code: Option<&str>,
    busy: bool,
    restore: Option<&RestoreOffer>,
) -> LockIntent {
    let mut intent = LockIntent::None;
    let p = theme::palette();

    shell(ui, 340.0, |ui| {
        brand(ui);
        ui.add_space(18.0);

        ui.label(theme::h2("解锁密码库"));
        ui.add_space(4.0);
        ui.label(theme::caption("输入主密码以解密本机仓库"));
        ui.add_space(16.0);

        ui.label(theme::label("主密码"));
        ui.add_space(4.0);
        let resp = ui.add_sized(
            [ui.available_width(), 34.0],
            egui::TextEdit::singleline(&mut **password)
                .password(true)
                .hint_text("主密码")
                .interactive(!busy),
        );

        let enter = ui.input(|i| i.key_pressed(egui::Key::Enter));
        if enter && !busy && (resp.has_focus() || resp.lost_focus()) {
            intent = LockIntent::Submit;
        }

        ui.add_space(14.0);
        let btn = theme::primary_button(
            ui,
            if busy { "正在解锁…" } else { "解锁" },
            ui.available_width(),
        );
        if btn.clicked() && !busy && !password.is_empty() {
            intent = LockIntent::Submit;
        }

        if let Some(msg) = error {
            ui.add_space(10.0);
            ui.label(egui::RichText::new(msg).size(12.0).color(p.danger));

            // 有错误码就给出「该怎么办」，而不是只把错误丢给用户
            if let Some(code) = error_code {
                let (title, advice) = unlock_advice(code);
                ui.add_space(6.0);
                egui::Frame::new()
                    .fill(p.surface_alt)
                    .corner_radius(egui::CornerRadius::same(theme::R_SM))
                    .inner_margin(egui::Margin::symmetric(10, 8))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.label(egui::RichText::new(title).size(12.0).strong().color(p.text));
                        ui.add_space(3.0);
                        // 必须显式 `.wrap()`：普通 `ui.label` 不会自动换行，
                        // 长句会横向溢出，被裁成「一个字一个字往外挤」的样子。
                        ui.add(
                            egui::Label::new(
                                egui::RichText::new(&advice).size(11.0).color(p.muted),
                            )
                            .wrap(),
                        );
                    });
            }
        }

        // 恢复入口：只在库确实打不开时才出现，见 `RestoreOffer` 的说明。
        if let Some(offer) = restore {
            ui.add_space(12.0);
            ui.separator();
            ui.add_space(8.0);
            ui.label(theme::label("检测到可用备份"));
            ui.add_space(2.0);
            ui.label(theme::caption(&offer.label));
            ui.add_space(8.0);

            let can_restore = !busy && !password.is_empty();
            let r = ui.add_enabled(
                can_restore,
                egui::Button::new(egui::RichText::new("用上面的主密码从备份恢复").size(13.0))
                    .min_size(egui::vec2(ui.available_width(), 30.0)),
            );
            if r.clicked() {
                intent = LockIntent::Restore;
            }
            if !can_restore {
                ui.add_space(4.0);
                ui.label(theme::caption("先在输入框里填入该备份的主密码"));
            }
            ui.add_space(4.0);
            ui.label(theme::caption(
                "恢复会先验证备份可解密，再把当前文件改名留档，不会删除任何东西。",
            ));
        }

        ui.add_space(16.0);
        ui.separator();
        ui.add_space(6.0);
        ui.label(theme::caption(
            "XChaCha20-Poly1305 · Argon2id · 数据不出本机",
        ));
    });

    intent
}

/// 已有实例持有单实例锁时显示。
///
/// 这不是一个「限制」，而是数据完整性的必要条件：两个实例各自持有一份
/// 完整明文，后保存的会静默覆盖先保存的改动。所以这里必须说清楚原因，
/// 而不是简单甩一句「已在运行」。
pub fn show_already_running(ui: &mut egui::Ui) -> LockIntent {
    shell(ui, 380.0, |ui| {
        brand(ui);
        ui.add_space(18.0);

        ui.label(theme::h2("钥巢已在运行"));
        ui.add_space(6.0);
        ui.label(theme::caption(
            "同一个密码库不允许多个实例同时解锁：两边各持一份明文副本，\
             后保存的会把先保存的改动整体覆盖，且没有任何提示。",
        ));
        ui.add_space(10.0);
        ui.label(theme::caption(
            "请切换到已经打开的那个窗口。如果找不到它，\
             在任务管理器里结束 keynest-egui.exe 后重新启动。",
        ));
        ui.add_space(18.0);

        if theme::primary_button(ui, "关闭这个窗口", ui.available_width()).clicked() {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
        }

        ui.add_space(14.0);
        ui.separator();
        ui.add_space(6.0);
        ui.label(theme::caption("单实例锁由操作系统持有，进程退出即释放"));
    });

    LockIntent::None
}

pub fn show_create(
    ui: &mut egui::Ui,
    master: &mut Zeroizing<String>,
    confirm: &mut Zeroizing<String>,
    error: Option<&str>,
    busy: bool,
) -> LockIntent {
    let mut intent = LockIntent::None;
    let p = theme::palette();

    shell(ui, 360.0, |ui| {
        brand(ui);
        ui.add_space(18.0);

        ui.label(theme::h2("创建密码库"));
        ui.add_space(4.0);
        ui.label(theme::caption(format!(
            "主密码至少 {} 位，且无法找回",
            keynest_core::vault::MIN_MASTER_LEN
        )));
        ui.add_space(16.0);

        ui.label(theme::label("主密码"));
        ui.add_space(4.0);
        let r1 = ui.add_sized(
            [ui.available_width(), 34.0],
            egui::TextEdit::singleline(&mut **master)
                .password(true)
                .hint_text("设置主密码")
                .interactive(!busy),
        );

        ui.add_space(10.0);
        ui.label(theme::label("再输一次"));
        ui.add_space(4.0);
        let r2 = ui.add_sized(
            [ui.available_width(), 34.0],
            egui::TextEdit::singleline(&mut **confirm)
                .password(true)
                .hint_text("确认主密码")
                .interactive(!busy),
        );

        // 主密码强度：从第一个字符起就给反馈，别等用户点了「创建」才说太弱
        if !master.is_empty() {
            let bits = password::estimate_strength(master);
            // 阈值刻意保守：熵是按「出现过哪几类字符」粗估的，
            // 天然对 `Password1!` 这类口令高估，所以门槛往上抬。
            let (frac, label, color) = if bits >= 90.0 {
                (1.0, "很强", p.success)
            } else if bits >= 65.0 {
                (0.75, "强", p.success)
            } else if bits >= 45.0 {
                (0.5, "一般", p.warn)
            } else {
                (0.25, "弱", p.danger)
            };
            ui.add_space(10.0);
            // 文字不要塞进进度条里：6px 的条放不下 11px 的字，会被压扁到看不清。
            ui.add(egui::ProgressBar::new(frac).desired_height(6.0).fill(color));
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(format!("强度（粗估）：{label}"))
                        .size(11.5)
                        .color(color),
                );
            });
            ui.add_space(2.0);
            ui.label(theme::caption(
                "更可靠的做法是四个以上互不相干的词，例如「海豚 铁钉 星期 蓝莓」。",
            ));
        }

        let enter = ui.input(|i| i.key_pressed(egui::Key::Enter));
        if enter && !busy && (r1.has_focus() || r2.has_focus()) {
            intent = LockIntent::Submit;
        }

        ui.add_space(14.0);
        let btn = theme::primary_button(
            ui,
            if busy {
                "正在创建…"
            } else {
                "创建并进入"
            },
            ui.available_width(),
        );
        if btn.clicked() && !busy && !master.is_empty() && !confirm.is_empty() {
            intent = LockIntent::Submit;
        }

        if let Some(msg) = error {
            ui.add_space(10.0);
            ui.label(egui::RichText::new(msg).size(12.0).color(p.danger));
        }

        ui.add_space(16.0);
        ui.separator();
        ui.add_space(6.0);
        ui.label(theme::caption(
            "生成 16 字节随机盐 + Argon2id(64MiB) 派生密钥后整体加密",
        ));
    });

    intent
}
