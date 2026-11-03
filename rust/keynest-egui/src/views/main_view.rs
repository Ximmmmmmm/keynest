//! 主界面：顶栏 + 筛选胶囊 + 列表 + 详情。
//!
//! 设计原则：少即是多。
//! * 只有一个强调色，其余用中性灰阶
//! * 去掉左侧栏，分类/智能筛选压成一行胶囊
//! * 列表用细分隔线，不用卡片边框和阴影
//! * 复制、编辑等操作只在需要时出现（行悬停、详情面板）

use std::time::Instant;

use zeroize::Zeroizing;

use keynest_core::password;
use keynest_core::vault::{Entry, VaultData};

use crate::ui::{icons, theme};

/// 列表筛选。
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Filter {
    All,
    Category(String),
    /// 弱密码（熵不足 60 bit）
    Weak,
    /// 与其它条目重复使用的密码
    Reused,
    /// 仅收藏
    Favorites,
    /// 回收站（软删除的条目）
    Trash,
}

/// 排序方式。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SortBy {
    UpdatedDesc,
    TitleAsc,
    CreatedDesc,
}

impl SortBy {
    pub const ALL: [SortBy; 3] = [SortBy::UpdatedDesc, SortBy::TitleAsc, SortBy::CreatedDesc];

    pub fn label(self) -> &'static str {
        match self {
            SortBy::UpdatedDesc => "最近更新",
            SortBy::TitleAsc => "标题 A→Z",
            SortBy::CreatedDesc => "最近创建",
        }
    }
}

pub enum MainIntent {
    None,
    Lock,
    OpenSettings,
    NewEntry,
    Edit(String),
    AskDelete(String),
    CopyPassword(String),
    CopyUsername(String),
    Reveal(String),
    HideReveal,
    SetFilter(Filter),
    /// 清空**所有**筛选条件（含搜索词）并回到「全部」。
    ///
    /// 与 `SetFilter(Filter::All)` 不同：那个只改筛选。
    /// 用户搜了关键词、看到「没有匹配的条目」，点「清除筛选」却仍然空着——
    /// 因为搜索词还在。按钮的名字承诺了它做不到的事。
    ClearAllFilters,
    SetSort(SortBy),
    NewCategory(String),
    /// 选中某条
    Select(String),
    /// 收藏 / 取消收藏
    ToggleFavorite(String),
    /// 复制动态验证码
    CopyTotp(String),
    /// 复制某个自定义字段的值
    CopyField(String, String),
    /// 用系统默认浏览器打开条目的网址
    OpenUrl(String),
    /// 从回收站恢复
    Restore(String),
    /// 永久删除
    Purge(String),
    /// 清空回收站
    EmptyTrash,
}

pub struct MainView<'a> {
    pub data: &'a VaultData,
    pub search: &'a mut String,
    pub filter: &'a mut Filter,
    pub sort: &'a mut SortBy,
    pub selected_id: &'a mut Option<String>,
    pub reveal: &'a mut Option<(Zeroizing<String>, Instant)>,
    pub copy_banner: &'a Option<(Instant, u32)>,
    pub new_category_buf: &'a mut String,
    /// 一次性：本帧把焦点给搜索框
    pub focus_search: bool,
    pub idle_left_secs: u64,
    pub toast: Option<&'a str>,
}

const DETAIL_W: f32 = 400.0;
const ROW_H: f32 = 46.0;

/// 把条目里填的网址整理成一个**可以安全交给浏览器**的地址。
///
/// 只放行 http/https。理由：条目内容可能来自导入的第三方文件，而 `file://`、
/// `data:`、`javascript:` 这类协议在 Windows 上能被关联到会执行东西的处理程序——
/// 一个密码管理器的「打开网址」不该成为执行入口。
///
/// 没写协议的（`example.com/login`）补成 https，这符合用户预期。
pub fn openable_url(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let lower = text.to_ascii_lowercase();

    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Some(text.to_string());
    }
    // 任何显式的其它协议一律拒绝，不猜。
    // 判断"有没有协议"的口径：冒号前那一段不含点号，就当成协议名
    // （`mailto:` / `ms-settings:` / `javascript:` 都属于这种）；
    // 含点号的是 `host:port`，那是正常的网址。
    if lower.contains("://") {
        return None;
    }
    if let Some(idx) = text.find(':') {
        let head = &text[..idx];
        if !head.contains('.') && !head.contains('/') {
            return None;
        }
    }
    if text.contains(char::is_whitespace) || !text.contains('.') {
        return None;
    }
    Some(format!("https://{text}"))
}

/// 右侧详情面板。
///
/// 抽成独立函数是因为它只读一条条目、只往外发意图——不碰列表的选中逻辑，
/// 这样「列表怎么选」和「详情怎么显示」可以分开改。
fn detail_panel(
    ui: &mut egui::Ui,
    entry: &Entry,
    data: &VaultData,
    reveal: &mut Option<(Zeroizing<String>, Instant)>,
    just_copied: bool,
    intent: &mut MainIntent,
) {
    let p = theme::palette();
    let is_login = entry.kind == keynest_core::kinds::LOGIN;

    ui.add_space(18.0);

    // 标题
    ui.add(
        egui::Label::new(
            egui::RichText::new(&entry.title)
                .size(16.0)
                .strong()
                .color(p.text),
        )
        .truncate(),
    );

    // 强度 / 重复 / 熵：只对账号类型有意义
    if is_login {
        let bits = password::estimate_strength(&entry.password);
        // 这里可以扫全表：详情面板每帧只渲染**一个**条目，
        // 是 O(n) 而不是 O(n²)。列表筛选那边才是热点，已改成查表。
        let reused = reuse_count(&data.entries, &entry.password);
        ui.add_space(6.0);
        ui.horizontal_wrapped(|ui| {
            theme::strength_meter(ui, bits);
            let (label, _frac, color) = theme::strength_level(bits);
            ui.label(egui::RichText::new(label).size(11.5).color(color));
            if reused > 1 {
                theme::tag(ui, &format!("重复使用 {reused} 次"), p.danger);
            }
        });
    }

    if is_login {
        ui.add_space(16.0);
        ui.horizontal(|ui| {
            ui.label(theme::label("用户名"));
            if !entry.username.is_empty()
                && icons::button(ui, icons::Icon::User, "复制用户名").clicked()
            {
                *intent = MainIntent::CopyUsername(entry.id.clone());
            }
        });
        ui.add_space(2.0);
        ui.add(
            egui::Label::new(theme::body(if entry.username.is_empty() {
                "—"
            } else {
                entry.username.as_str()
            }))
            .truncate(),
        );

        // 密码
        ui.add_space(16.0);
        ui.label(theme::label("密码"));
        ui.add_space(2.0);

        let now = Instant::now();
        let showing = reveal
            .as_ref()
            .filter(|(_, deadline)| *deadline > now)
            .map(|(pw, deadline)| (pw.to_string(), deadline.saturating_duration_since(now)));

        ui.horizontal(|ui| {
            match &showing {
                Some((pw, left)) => {
                    ui.add(
                        egui::Label::new(
                            egui::RichText::new(pw).size(14.0).monospace().color(p.text),
                        )
                        .truncate(),
                    );
                    ui.label(theme::caption(format!("{}s", left.as_secs())));
                    if icons::button(ui, icons::Icon::EyeOff, "收起").clicked() {
                        *intent = MainIntent::HideReveal;
                    }
                }
                None => {
                    ui.label(
                        egui::RichText::new(
                            "•".repeat(entry.password.chars().count().clamp(6, 18)),
                        )
                        .size(14.0)
                        .color(p.muted),
                    );
                    if icons::button(ui, icons::Icon::Eye, "显示").clicked() {
                        *intent = MainIntent::Reveal(entry.id.clone());
                    }
                }
            }
            let (icon, tint) = if just_copied {
                (icons::Icon::CopyCheck, Some(p.success))
            } else {
                (icons::Icon::Lock, None)
            };
            if icons::button_tinted(ui, icon, "复制密码", tint).clicked() {
                *intent = MainIntent::CopyPassword(entry.id.clone());
            }
        });
    }

    // 动态验证码
    if let Some(raw) = entry.totp.as_deref() {
        if let Ok(totp) = keynest_core::Totp::parse(raw) {
            ui.add_space(16.0);
            ui.label(theme::label("动态验证码"));
            ui.add_space(2.0);
            let secs = keynest_core::totp::now_secs();
            let code = totp.code_at(secs);
            let left = totp.remaining(secs);
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(&code)
                        .size(20.0)
                        .monospace()
                        .color(p.accent),
                );
                ui.add_space(6.0);
                // 剩余时间越少越红
                let color = if left <= 5 { p.danger } else { p.muted };
                ui.label(
                    egui::RichText::new(format!("{left}s"))
                        .size(11.5)
                        .color(color),
                );
                if icons::button(ui, icons::Icon::Copy, "复制验证码").clicked() {
                    *intent = MainIntent::CopyTotp(entry.id.clone());
                }
            });
        }
    }

    // 自定义字段
    if !entry.fields.is_empty() {
        ui.add_space(16.0);
        ui.label(theme::label("自定义字段"));
        ui.add_space(4.0);
        for f in &entry.fields {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(&f.label).size(11.5).color(p.muted));
                if icons::button(ui, icons::Icon::Copy, "复制").clicked() {
                    *intent = MainIntent::CopyField(entry.id.clone(), f.label.clone());
                }
            });
            ui.add_space(2.0);
            let shown = if f.secret {
                "•".repeat(f.value.chars().count().clamp(6, 16))
            } else {
                f.value.clone()
            };
            ui.add(egui::Label::new(theme::body(&shown)).truncate());
            if f.secret {
                ui.add_space(2.0);
                ui.label(theme::caption("已隐藏（复制可用）"));
            }
            ui.add_space(6.0);
        }
    }

    // 网址
    ui.add_space(16.0);
    ui.horizontal(|ui| {
        ui.label(theme::label("网址"));
        if openable_url(&entry.url).is_some()
            && icons::labeled(ui, icons::Icon::External, "打开").clicked()
        {
            *intent = MainIntent::OpenUrl(entry.id.clone());
        }
    });
    ui.add_space(2.0);
    ui.add(
        egui::Label::new(theme::body(if entry.url.is_empty() {
            "—"
        } else {
            entry.url.as_str()
        }))
        .truncate(),
    );

    // 备注
    if !entry.notes.is_empty() {
        ui.add_space(16.0);
        ui.label(theme::label("备注"));
        ui.add_space(2.0);
        ui.add(egui::Label::new(egui::RichText::new(&entry.notes).size(12.5).color(p.text)).wrap());
    }

    // 时间
    if is_login {
        if let Some(changed) = entry.password_changed_at.as_deref() {
            ui.add_space(16.0);
            ui.label(theme::label("密码更新于"));
            ui.add_space(2.0);
            ui.label(theme::caption(
                changed.get(..19).unwrap_or(changed).replace('T', " "),
            ));
        }
    }

    ui.add_space(16.0);
    ui.label(theme::label("最近更新"));
    ui.add_space(2.0);
    ui.label(theme::caption(
        entry
            .updated_at
            .get(..19)
            .unwrap_or(&entry.updated_at)
            .replace('T', " "),
    ));

    if let Some(at) = entry.deleted_at.as_deref() {
        ui.add_space(10.0);
        ui.label(theme::label("移入回收站"));
        ui.add_space(2.0);
        ui.label(theme::caption(at.get(..19).unwrap_or(at).replace('T', " ")));
    }

    // 操作
    ui.add_space(18.0);
    ui.horizontal_wrapped(|ui| {
        if entry.is_deleted() {
            if icons::labeled(ui, icons::Icon::Plus, "恢复").clicked() {
                *intent = MainIntent::Restore(entry.id.clone());
            }
            if icons::labeled(ui, icons::Icon::Trash, "永久删除").clicked() {
                *intent = MainIntent::Purge(entry.id.clone());
            }
        } else {
            let (icon, text) = if entry.favorite {
                (icons::Icon::Shield, "已收藏")
            } else {
                (icons::Icon::Shield, "收藏")
            };
            if icons::labeled(ui, icon, text).clicked() {
                *intent = MainIntent::ToggleFavorite(entry.id.clone());
            }
            if icons::labeled(ui, icons::Icon::Edit, "编辑").clicked() {
                *intent = MainIntent::Edit(entry.id.clone());
            }
            if icons::labeled(ui, icons::Icon::Trash, "删除").clicked() {
                *intent = MainIntent::AskDelete(entry.id.clone());
            }
        }
    });

    ui.add_space(18.0);
}

/// 某个密码被多少条条目共用。
fn reuse_count(entries: &[Entry], password: &str) -> usize {
    if password.is_empty() {
        return 0;
    }
    entries.iter().filter(|e| e.password == password).count()
}

/// 一次遍历算出「每个密码被多少条条目使用」。
///
/// # 为什么需要它
///
/// 原来筛选「重复」和统计侧栏数字时，对**每条条目**都调一次 `reuse_count`，
/// 而它每次扫全表 —— O(n²)。5000 条时是每帧 2500 万次字符串比较，
/// 界面会明显卡住；而这只是画一帧的成本。
///
/// 这个函数 O(n) 建一张表，调用方查表即可。
///
/// 空密码不参与统计：多条「没有密码」的笔记不该被报成「重复使用」。
fn reuse_counts(entries: &[Entry]) -> std::collections::HashMap<&str, usize> {
    let mut map: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for e in entries {
        if e.password.is_empty() {
            continue;
        }
        *map.entry(e.password.as_str()).or_insert(0) += 1;
    }
    map
}

fn is_weak(password: &str) -> bool {
    password::estimate_strength(password) < 60.0
}

pub fn show(ui: &mut egui::Ui, v: MainView<'_>) -> MainIntent {
    let mut intent = MainIntent::None;
    let p = theme::palette();

    let just_copied = v
        .copy_banner
        .map(|b| crate::ui::clipboard::banner_remaining(&b) > 0)
        .unwrap_or(false);

    // ---------- 筛选 + 排序（详情与列表共用同一份结果）----------
    let needle = v.search.trim().to_lowercase();
    let filter = v.filter.clone();

    // 一次遍历算好复用次数，供筛选与侧栏统计共用。
    // 放在筛选之前：否则筛选闭包里每条都要扫全表（O(n²)）。
    let counts = reuse_counts(&v.data.entries);

    let mut visible: Vec<usize> = v
        .data
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| {
            // 回收站与正常列表互斥：一边只看已删除，另一边只看未删除。
            if matches!(filter, Filter::Trash) {
                if !e.is_deleted() {
                    return false;
                }
            } else {
                if e.is_deleted() {
                    return false;
                }
                match &filter {
                    Filter::All | Filter::Trash => {}
                    Filter::Category(c) => {
                        if &e.category != c {
                            return false;
                        }
                    }
                    Filter::Weak => {
                        if !is_weak(&e.password) {
                            return false;
                        }
                    }
                    Filter::Reused => {
                        // 查预先算好的表，不在这里扫全表
                        if counts.get(e.password.as_str()).copied().unwrap_or(0) < 2 {
                            return false;
                        }
                    }
                    Filter::Favorites => {
                        if !e.favorite {
                            return false;
                        }
                    }
                }
            }
            // 搜索
            if needle.is_empty() {
                return true;
            }
            e.title.to_lowercase().contains(&needle)
                || e.username.to_lowercase().contains(&needle)
                || e.url.to_lowercase().contains(&needle)
                || e.notes.to_lowercase().contains(&needle)
                // 分类与类型也要能搜：用户经常只记得「那张卡」「那个服务器」
                || e.category.to_lowercase().contains(&needle)
                || e.kind.to_lowercase().contains(&needle)
                // 自定义字段：卡号、证件号填在这里，搜不到等于白存
                || e.fields.iter().any(|f| {
                    f.label.to_lowercase().contains(&needle)
                        || f.value.to_lowercase().contains(&needle)
                })
        })
        .map(|(i, _)| i)
        .collect();

    match v.sort {
        SortBy::UpdatedDesc => visible.sort_by(|a, b| {
            v.data.entries[*b]
                .updated_at
                .cmp(&v.data.entries[*a].updated_at)
        }),
        SortBy::CreatedDesc => visible.sort_by(|a, b| {
            v.data.entries[*b]
                .created_at
                .cmp(&v.data.entries[*a].created_at)
        }),
        SortBy::TitleAsc => visible.sort_by(|a, b| {
            v.data.entries[*a]
                .title
                .to_lowercase()
                .cmp(&v.data.entries[*b].title.to_lowercase())
        }),
    }

    // 选中项不可见时，自动选中第一条
    if visible.is_empty() {
        *v.selected_id = None;
    } else {
        let still = v
            .selected_id
            .as_ref()
            .map(|id| visible.iter().any(|&i| &v.data.entries[i].id == id))
            .unwrap_or(false);
        if !still {
            *v.selected_id = Some(v.data.entries[visible[0]].id.clone());
        }
    }

    /* ================= 顶栏 ================= */
    let top = egui::Frame::new()
        .fill(p.surface)
        .inner_margin(egui::Margin::symmetric(16, 10));

    egui::Panel::top("topbar")
        .show_separator_line(false)
        .frame(top)
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                let (logo, _) =
                    ui.allocate_exact_size(egui::vec2(24.0, 24.0), egui::Sense::hover());
                icons::paint_logo(ui.painter(), logo, p.accent, p.on_accent);
                ui.add_space(2.0);
                ui.label(
                    egui::RichText::new("钥巢")
                        .size(15.0)
                        .strong()
                        .color(p.text),
                );

                ui.add_space(18.0);

                // 搜索
                let search_w = (ui.available_width() - 360.0).clamp(160.0, 420.0);
                let sf = egui::Frame::new()
                    .fill(p.surface_alt)
                    .corner_radius(egui::CornerRadius::same(theme::R_SM))
                    .inner_margin(egui::Margin::symmetric(9, 5));
                sf.show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (ir, _) =
                            ui.allocate_exact_size(egui::vec2(13.0, 13.0), egui::Sense::hover());
                        icons::paint(ui.painter(), ir, icons::Icon::Search, p.muted, 1.5);
                        let resp = ui.add_sized(
                            [search_w, 20.0],
                            egui::TextEdit::singleline(v.search)
                                .frame(egui::Frame::NONE)
                                .hint_text("搜索"),
                        );
                        if v.focus_search {
                            resp.request_focus();
                        }
                        if !v.search.is_empty()
                            && ui
                                .add(
                                    egui::Button::new(
                                        egui::RichText::new("×").size(13.0).color(p.muted),
                                    )
                                    .frame(false),
                                )
                                .clicked()
                        {
                            v.search.clear();
                        }
                    });
                });

                ui.add_space(10.0);
                if icons::labeled(ui, icons::Icon::Plus, "新增").clicked() {
                    intent = MainIntent::NewEntry;
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if icons::button(ui, icons::Icon::Gear, "设置").clicked() {
                        intent = MainIntent::OpenSettings;
                    }
                    if icons::button(ui, icons::Icon::Lock, "锁定").clicked() {
                        intent = MainIntent::Lock;
                    }
                    // 空闲倒计时。低于 30 秒时变红并加一句提示——
                    // 到点直接锁掉、用户正在输入的内容丢失，是最难受的一种意外。
                    let left = v.idle_left_secs;
                    let text = if left >= 60 {
                        format!("{}:{:02}", left / 60, left % 60)
                    } else {
                        format!("{left}s")
                    };
                    if left <= 30 {
                        ui.label(
                            egui::RichText::new(format!("{text} 后锁定"))
                                .size(11.0)
                                .color(p.danger),
                        );
                    } else {
                        ui.label(theme::caption(text));
                    }
                });
            });
        });

    /* ================= 筛选胶囊 ================= */
    let chip_frame = egui::Frame::new()
        .fill(p.surface)
        .inner_margin(egui::Margin::symmetric(16, 6));
    egui::Panel::top("chips")
        .show_separator_line(false)
        .frame(chip_frame)
        .show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                if theme::chip(ui, matches!(filter, Filter::All), "全部").clicked() {
                    intent = MainIntent::SetFilter(Filter::All);
                }
                for cat in &v.data.categories {
                    let selected = matches!(&filter, Filter::Category(c) if c == cat);
                    // 长分类名会被胶囊宽度截断，悬停给出全名
                    if theme::chip(ui, selected, cat).on_hover_text(cat).clicked() {
                        intent = MainIntent::SetFilter(Filter::Category(cat.clone()));
                    }
                }

                ui.add_space(8.0);
                ui.separator();
                ui.add_space(8.0);

                let active: Vec<&Entry> =
                    v.data.entries.iter().filter(|e| !e.is_deleted()).collect();
                let weak_n = active.iter().filter(|e| is_weak(&e.password)).count();
                let reused_n = active
                    .iter()
                    .filter(|e| counts.get(e.password.as_str()).copied().unwrap_or(0) > 1)
                    .count();
                let fav_n = active.iter().filter(|e| e.favorite).count();
                let trash_n = v.data.entries.iter().filter(|e| e.is_deleted()).count();

                if theme::chip(
                    ui,
                    matches!(filter, Filter::Weak),
                    &format!("弱密码 {weak_n}"),
                )
                .clicked()
                {
                    intent = MainIntent::SetFilter(Filter::Weak);
                }
                if theme::chip(
                    ui,
                    matches!(filter, Filter::Reused),
                    &format!("重复 {reused_n}"),
                )
                .clicked()
                {
                    intent = MainIntent::SetFilter(Filter::Reused);
                }
                if theme::chip(
                    ui,
                    matches!(filter, Filter::Favorites),
                    &format!("收藏 {fav_n}"),
                )
                .clicked()
                {
                    intent = MainIntent::SetFilter(Filter::Favorites);
                }
                if theme::chip(
                    ui,
                    matches!(filter, Filter::Trash),
                    &format!("回收站 {trash_n}"),
                )
                .clicked()
                {
                    intent = MainIntent::SetFilter(Filter::Trash);
                }
            });
        });

    /* ================= 空状态 ================= */
    if visible.is_empty() {
        ui.add_space(60.0);
        ui.vertical_centered(|ui| {
            let (r, _) = ui.allocate_exact_size(egui::vec2(56.0, 56.0), egui::Sense::hover());
            ui.painter().rect_filled(
                r,
                egui::CornerRadius::same(theme::R_LG),
                p.accent_soft,
            );
            icons::paint(
                ui.painter(),
                egui::Rect::from_center_size(r.center(), egui::vec2(26.0, 26.0)),
                icons::Icon::Shield,
                p.accent,
                1.6,
            );
            ui.add_space(12.0);
            ui.label(
                egui::RichText::new(if v.data.entries.is_empty() {
                    "还没有条目"
                } else {
                    "没有匹配的条目"
                })
                .size(13.5)
                .color(p.muted),
            );
            ui.add_space(4.0);
            if v.data.entries.is_empty() {
                ui.label(theme::caption("点右上角「新增」创建第一条"));
                ui.add_space(2.0);
                ui.label(theme::caption(
                    "已有的密码在浏览器里？设置 → 数据 → 从文件导入，可以读 Chrome/Edge/Firefox 导出的 CSV。",
                ));
            } else {
                ui.label(theme::caption("换个关键词或筛选条件"));
                ui.add_space(6.0);
                if theme::ghost_button(ui, "清除搜索与筛选").clicked() {
                    intent = MainIntent::ClearAllFilters;
                }
            }
        });
        return intent;
    }

    /* ================= 列表头 ================= */
    let header_frame = egui::Frame::new()
        .fill(p.surface)
        .inner_margin(egui::Margin::symmetric(16, 4));
    egui::Panel::top("list-header")
        .show_separator_line(false)
        .frame(header_frame)
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(theme::caption(format!("{} 条", visible.len())));
                if matches!(filter, Filter::Trash)
                    && theme::ghost_button(ui, "清空回收站").clicked()
                {
                    intent = MainIntent::EmptyTrash;
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    egui::ComboBox::from_id_salt("sort-by")
                        .selected_text(egui::RichText::new(v.sort.label()).size(11.5))
                        .width(104.0)
                        .show_ui(ui, |ui| {
                            for s in SortBy::ALL {
                                if ui.selectable_label(*v.sort == s, s.label()).clicked() {
                                    intent = MainIntent::SetSort(s);
                                }
                            }
                        });
                });
            });
        });

    /* ================= 列表 + 详情 ================= */
    let mut clicked_id: Option<String> = None;
    let mut quick_copy: Option<String> = None;
    let mut quick_copy_user: Option<String> = None;
    let mut quick_open: Option<String> = None;

    ui.horizontal_top(|ui| {
        // 列表区没有自己的 Frame，必须显式铺一层底色：
        // 否则这块区域是透明的，截图里会呈现为黑色，界面上则取决于桌面底色。
        ui.painter().rect_filled(
            ui.available_rect_before_wrap(),
            egui::CornerRadius::ZERO,
            p.surface,
        );

        let detail_w = if ui.available_width() > DETAIL_W + 320.0 {
            DETAIL_W
        } else {
            0.0
        };

        let list_w = ui.available_width() - detail_w;
        ui.allocate_ui_with_layout(
            egui::vec2(list_w, ui.available_height()),
            egui::Layout::top_down(egui::Align::Min),
            |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        for &idx in &visible {
                            let e = &v.data.entries[idx];
                            let is_sel = v
                                .selected_id
                                .as_ref()
                                .map(|id| id == &e.id)
                                .unwrap_or(false);

                            let (rect, resp) = ui.allocate_exact_size(
                                egui::vec2(ui.available_width(), ROW_H),
                                egui::Sense::click(),
                            );

                            if is_sel {
                                ui.painter().rect_filled(
                                    rect,
                                    egui::CornerRadius::same(theme::R_SM),
                                    p.accent_soft,
                                );
                            } else if resp.hovered() {
                                ui.painter().rect_filled(
                                    rect,
                                    egui::CornerRadius::same(theme::R_SM),
                                    p.surface_alt,
                                );
                            }

                            // 标题行（收藏加 ★）
                            let title = if e.favorite {
                                format!("★ {}", e.title)
                            } else {
                                e.title.clone()
                            };
                            ui.painter().text(
                                egui::Pos2::new(rect.left() + 14.0, rect.center().y - 8.0),
                                egui::Align2::LEFT_CENTER,
                                &title,
                                egui::FontId::proportional(13.0),
                                if is_sel { p.accent } else { p.text },
                            );
                            // 副标题：账号 · 分类
                            let mut sub = String::new();
                            if !e.username.is_empty() {
                                sub.push_str(&e.username);
                                sub.push_str(" · ");
                            }
                            sub.push_str(&e.category);
                            ui.painter().text(
                                egui::Pos2::new(rect.left() + 14.0, rect.center().y + 9.0),
                                egui::Align2::LEFT_CENTER,
                                &sub,
                                egui::FontId::proportional(11.0),
                                p.muted,
                            );

                            // 悬停/选中时右侧出现快捷复制（图标手绘，点击用 x 坐标判定，
                            // 避免为两个小按钮嵌套 Ui 影响行高与点击区域）
                            let show_actions = resp.hovered() || is_sel;
                            // 从右到左：复制密码 / 复制用户名 / 打开网址
                            let pass_x = rect.right() - 40.0;
                            let user_x = rect.right() - 74.0;
                            let open_x = rect.right() - 108.0;
                            let can_open = openable_url(&e.url).is_some();

                            if show_actions {
                                if can_open {
                                    let r = egui::Rect::from_center_size(
                                        egui::Pos2::new(open_x + 15.0, rect.center().y),
                                        egui::vec2(16.0, 16.0),
                                    );
                                    // 外链箭头 = 直接用浏览器打开
                                    icons::paint(
                                        ui.painter(),
                                        r,
                                        icons::Icon::External,
                                        p.muted,
                                        1.5,
                                    );
                                }
                                if !e.username.is_empty() {
                                    let r = egui::Rect::from_center_size(
                                        egui::Pos2::new(user_x + 15.0, rect.center().y),
                                        egui::vec2(16.0, 16.0),
                                    );
                                    // 人形 = 复制用户名
                                    icons::paint(ui.painter(), r, icons::Icon::User, p.muted, 1.5);
                                }
                                if !e.password.is_empty() {
                                    let r = egui::Rect::from_center_size(
                                        egui::Pos2::new(pass_x + 15.0, rect.center().y),
                                        egui::vec2(16.0, 16.0),
                                    );
                                    // 钥匙 = 复制密码（信用卡/笔记没有密码，不显示这个按钮）
                                    icons::paint(ui.painter(), r, icons::Icon::Key, p.muted, 1.5);
                                }
                            }

                            // 分隔线
                            if idx + 1 < v.data.entries.len() {
                                ui.painter().hline(
                                    (rect.left() + 14.0)..=(rect.right() - 8.0),
                                    rect.bottom() - 0.5,
                                    egui::Stroke::new(1.0, p.border),
                                );
                            }

                            if resp.clicked() {
                                match resp.interact_pointer_pos() {
                                    Some(pos) if pos.x >= pass_x && !e.password.is_empty() => {
                                        quick_copy = Some(e.id.clone())
                                    }
                                    Some(pos) if pos.x >= user_x && !e.username.is_empty() => {
                                        quick_copy_user = Some(e.id.clone())
                                    }
                                    Some(pos) if pos.x >= open_x && can_open => {
                                        quick_open = Some(e.id.clone())
                                    }
                                    _ => clicked_id = Some(e.id.clone()),
                                }
                            }
                            if resp.hovered() {
                                ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                                // 图标是手绘的，没有独立 widget，按鼠标 x 位置判断悬停在哪一个。
                                //
                                // 提示必须用 `at_pointer()`：`resp` 是**整行**，
                                // 直接挂提示会让它出现在行左下角，离图标很远，看着像 bug。
                                if let Some(pos) = ui.ctx().pointer_hover_pos() {
                                    let tip = if pos.x >= pass_x && !e.password.is_empty() {
                                        Some("复制密码")
                                    } else if pos.x >= user_x && !e.username.is_empty() {
                                        Some("复制用户名")
                                    } else if pos.x >= open_x && can_open {
                                        Some("在浏览器中打开")
                                    } else {
                                        None
                                    };
                                    if let Some(text) = tip {
                                        egui::Tooltip::for_widget(&resp)
                                            .at_pointer()
                                            .gap(8.0)
                                            .show(|ui| {
                                                ui.label(text);
                                            });
                                    }
                                }
                            }
                        }
                    });
            },
        );

        if detail_w > 0.0 {
            if let Some(sel_id) = v.selected_id.as_ref() {
                if let Some(entry) = v.data.entries.iter().find(|e| &e.id == sel_id) {
                    ui.add_space(1.0);
                    ui.painter().vline(
                        ui.min_rect().left(),
                        ui.min_rect().y_range(),
                        egui::Stroke::new(1.0, p.border),
                    );
                    ui.add_space(16.0);
                    // 详情要能滚：备注 + 多字段 + 各段时间加起来会超过窗口高度，
                    // 不加滚动的话下面的「删除」按钮会被窗口底边裁掉、点不到。
                    egui::ScrollArea::vertical()
                        .id_salt("detail-scroll")
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            ui.vertical(|ui| {
                                ui.set_width(detail_w - 36.0);
                                detail_panel(ui, entry, v.data, v.reveal, just_copied, &mut intent);
                            });
                        });
                }
            }
        }
    });

    if let Some(id) = quick_copy {
        intent = MainIntent::CopyPassword(id);
    } else if let Some(id) = quick_copy_user {
        intent = MainIntent::CopyUsername(id);
    } else if let Some(id) = quick_open {
        intent = MainIntent::OpenUrl(id);
    } else if let Some(id) = clicked_id {
        intent = MainIntent::Select(id);
    }

    /* ================= 底部浮层提示 ================= */
    // 复制提示 / 操作提示：做成**浮层**，不参与布局。
    //
    // 原来这里是 `Panel::top`，一出现就把下面整块内容往下推——
    // 用户点一下「复制」，列表就跳一下。提示信息不该改变页面结构。
    let tip_msg: Option<(String, egui::Color32)> = match (v.toast, v.copy_banner) {
        (Some(msg), _) => Some((msg.to_string(), p.success)),
        (None, Some(banner)) => {
            let left = crate::ui::clipboard::banner_remaining(banner);
            (left > 0).then(|| (format!("已复制到剪贴板，{left} 秒后自动清除"), p.accent))
        }
        _ => None,
    };

    if let Some((text, color)) = tip_msg {
        egui::Area::new(ui.make_persistent_id("kn-tip-overlay"))
            .order(egui::Order::Foreground)
            .interactable(false)
            .anchor(egui::Align2::CENTER_BOTTOM, [0.0, -20.0])
            .show(ui.ctx(), |ui| {
                egui::Frame::new()
                    .fill(p.surface)
                    .stroke(egui::Stroke::new(1.0, p.border))
                    .corner_radius(egui::CornerRadius::same(theme::R_LG))
                    .inner_margin(egui::Margin::symmetric(14, 7))
                    .shadow(egui::epaint::Shadow {
                        offset: [0, 4],
                        blur: 16,
                        spread: 0,
                        color: egui::Color32::from_black_alpha(28),
                    })
                    .show(ui, |ui| {
                        ui.label(egui::RichText::new(text).size(12.0).color(color));
                    });
            });
    }

    intent
}

#[cfg(test)]
mod tests {
    use super::{openable_url, reuse_count, reuse_counts};
    use keynest_core::vault::Entry;

    fn e(title: &str, pw: &str) -> Entry {
        let mut x = Entry::default();
        x.id = title.to_string();
        x.title = title.to_string();
        x.password = pw.to_string();
        x
    }

    /// 查表结果必须与逐个扫描完全一致。
    ///
    /// 这个改动把 O(n²) 换成了 O(n)，代价是多了一份实现。
    /// 两份实现分叉的表现是「侧栏说重复 3 条，点进去筛出 2 条」——
    /// 用户会以为筛选坏了。
    #[test]
    fn reuse_counts_matches_naive_scan() {
        let entries = vec![
            e("a", "same"),
            e("b", "same"),
            e("c", "same"),
            e("d", "other"),
            e("note1", ""),
            e("note2", ""),
        ];
        let map = reuse_counts(&entries);
        for x in &entries {
            let naive = reuse_count(&entries, &x.password);
            let via_map = if x.password.is_empty() {
                0 // 空密码不进表
            } else {
                map.get(x.password.as_str()).copied().unwrap_or(0)
            };
            assert_eq!(naive, via_map, "条目 {} 的统计不一致", x.title);
        }
    }

    /// 空密码不参与统计：多条「没有密码」的笔记不该被报成「重复使用」。
    #[test]
    fn empty_passwords_are_not_counted_as_reuse() {
        let entries = vec![e("note1", ""), e("note2", ""), e("note3", "")];
        let map = reuse_counts(&entries);
        assert!(map.is_empty(), "空密码不该进表: {map:?}");
    }

    #[test]
    fn normalizes_bare_domains() {
        assert_eq!(
            openable_url("example.com/login").as_deref(),
            Some("https://example.com/login")
        );
        assert_eq!(
            openable_url("  example.com  ").as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn keeps_explicit_http_and_https() {
        assert_eq!(
            openable_url("http://intranet.local:8080/x").as_deref(),
            Some("http://intranet.local:8080/x")
        );
        assert_eq!(
            openable_url("HTTPS://Example.COM").as_deref(),
            Some("HTTPS://Example.COM")
        );
    }

    #[test]
    fn refuses_every_other_scheme() {
        // 这些协议在 Windows 上可能被关联到会执行东西的处理程序
        for bad in [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///C:/Windows/System32/calc.exe",
            "ms-settings:privacy",
            "smb://server/share",
            "mailto:a@b.c",
        ] {
            assert_eq!(openable_url(bad), None, "不应放行 {bad}");
        }
    }

    #[test]
    fn refuses_thing_that_is_not_a_url() {
        assert_eq!(openable_url(""), None);
        assert_eq!(openable_url("   "), None);
        assert_eq!(openable_url("just some text"), None);
        assert_eq!(openable_url("localhost"), None, "没有点号时不猜协议");
        assert_eq!(
            openable_url("example.com:8080/admin").as_deref(),
            Some("https://example.com:8080/admin"),
            "host:port 属于正常网址，不该被当成协议"
        );
    }
}
