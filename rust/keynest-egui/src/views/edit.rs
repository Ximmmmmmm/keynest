//! 新增 / 编辑对话框 + 密码生成器。

use zeroize::Zeroizing;

use keynest_core::password::{self, GenOptions};
use keynest_core::{kinds, Field};

use crate::ui::{icons, theme};

/// 编辑中的一行自定义字段。
///
/// 值单独用 `Zeroizing` 装：它可能是卡号、证件号，与密码同等敏感。
pub struct FieldDraft {
    pub label: String,
    pub value: Zeroizing<String>,
    pub secret: bool,
}

/// 打开对话框那一刻的内容快照，用于判断"用户是否真的改过"。
///
/// 为什么需要它：`edit.is_some()` 只能说明对话框开着，
/// 打开又原样关掉也算。锁定时若据此提示"有未保存的修改"，
/// 会变成噪音，用户很快就不看提示了。
#[derive(Clone)]
pub struct EditOriginal {
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub category: String,
    pub kind: String,
    pub favorite: bool,
    pub totp: String,
    pub field_values: Vec<String>,
}

pub struct EditState {
    pub id: Option<String>,
    /// 当前类型对应的默认字段模板（打开对话框时按下拉里的类型查好）。
    pub template: Vec<keynest_core::FieldTemplate>,
    pub kind: String,
    pub fields: Vec<FieldDraft>,
    pub title: String,
    pub username: String,
    pub password: Zeroizing<String>,
    pub url: String,
    pub category: String,
    pub notes: String,
    /// 收藏状态随编辑一起保留：改个备注不该把收藏弄丢。
    pub favorite: bool,
    /// TOTP 配置（`otpauth://` 或 Base32）。与密码同等敏感，用 `Zeroizing` 装。
    pub totp: Zeroizing<String>,
    /// 保持「在回收站里」的状态，编辑不应让它悄悄复活。
    pub deleted_at: Option<String>,
    pub error: Option<String>,
    pub generator_open: bool,
    pub gen: GeneratorState,
    /// 正在播放关闭动画
    pub closing: bool,
    /// 打开时的内容快照（`None` 表示这是新增条目）
    pub original: Option<EditOriginal>,
}

impl EditState {
    /// 把编辑草稿转成待入库的字段集合（清洗交给 `Vault`）。
    pub fn fields(&self) -> Vec<Field> {
        self.fields
            .iter()
            .map(|f| Field {
                label: f.label.clone(),
                value: f.value.to_string(),
                secret: f.secret,
            })
            .collect()
    }

    /// 用户是否真的动过内容。
    ///
    /// 用途：锁定时判断"要不要提示有未保存的编辑"。
    /// 不能只看 `edit.is_some()`——打开对话框但一字未改也满足那个条件，
    /// 提示会变成噪音，用户很快就不看了。
    ///
    /// 判据：新增条目时只要有任意非空内容就算脏；编辑既有条目时
    /// 与打开时记下的原始值比较。
    pub fn is_dirty(&self) -> bool {
        let has_content = !self.title.trim().is_empty()
            || !self.username.trim().is_empty()
            || !self.password.is_empty()
            || !self.url.trim().is_empty()
            || !self.notes.trim().is_empty()
            || !self.totp.is_empty()
            || self.fields.iter().any(|f| !f.value.is_empty());

        match &self.original {
            // 新增条目：有内容就算脏
            None => has_content,
            // 编辑既有条目：与原始值逐项比较
            Some(orig) => {
                orig.title != self.title
                    || orig.username != self.username
                    || orig.password.as_str() != self.password.as_str()
                    || orig.url != self.url
                    || orig.notes != self.notes
                    || orig.favorite != self.favorite
                    || orig.category != self.category
                    || orig.kind != self.kind
                    || orig.totp.as_str() != self.totp.as_str()
                    || orig.field_values.len() != self.fields.len()
                    || orig
                        .field_values
                        .iter()
                        .zip(self.fields.iter())
                        .any(|(a, b)| a != b.value.as_str())
            }
        }
    }

    /// 切到某个类型时，若还没有任何字段，就按模板预填一份。
    pub fn apply_template(&mut self) {
        if !self.fields.is_empty() {
            return;
        }
        self.fields = self
            .template
            .iter()
            .map(|t| FieldDraft {
                label: t.label.clone(),
                value: Zeroizing::new(String::new()),
                secret: t.secret,
            })
            .collect();
    }

    /// 取出 TOTP：空串表示"没有"。
    pub fn totp(&self) -> Option<String> {
        let t = self.totp.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    }

    pub fn new_entry(default_category: String) -> Self {
        Self {
            id: None,
            template: Vec::new(),
            kind: kinds::LOGIN.to_string(),
            fields: Vec::new(),
            title: String::new(),
            username: String::new(),
            password: Zeroizing::new(String::new()),
            url: String::new(),
            category: default_category,
            notes: String::new(),
            favorite: false,
            totp: Zeroizing::new(String::new()),
            deleted_at: None,
            error: None,
            generator_open: false,
            gen: GeneratorState::default(),
            closing: false,
            original: None,
        }
    }

    pub fn from_entry(e: &keynest_core::vault::Entry) -> Self {
        Self {
            id: Some(e.id.clone()),
            template: Vec::new(),
            kind: e.kind.clone(),
            fields: e
                .fields
                .iter()
                .map(|f| FieldDraft {
                    label: f.label.clone(),
                    value: Zeroizing::new(f.value.clone()),
                    secret: f.secret,
                })
                .collect(),
            title: e.title.clone(),
            username: e.username.clone(),
            password: Zeroizing::new(e.password.clone()),
            url: e.url.clone(),
            category: e.category.clone(),
            notes: e.notes.clone(),
            favorite: e.favorite,
            totp: Zeroizing::new(e.totp.clone().unwrap_or_default()),
            deleted_at: e.deleted_at.clone(),
            error: None,
            generator_open: false,
            gen: GeneratorState::default(),
            closing: false,
            original: Some(EditOriginal {
                title: e.title.clone(),
                username: e.username.clone(),
                password: e.password.clone(),
                url: e.url.clone(),
                notes: e.notes.clone(),
                category: e.category.clone(),
                kind: e.kind.clone(),
                favorite: e.favorite,
                totp: e.totp.clone().unwrap_or_default(),
                field_values: e.fields.iter().map(|f| f.value.clone()).collect(),
            }),
        }
    }
}

pub struct GeneratorState {
    pub length: usize,
    pub lowercase: bool,
    pub uppercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub exclude_ambiguous: bool,
    pub preview: Zeroizing<String>,
    pub preview_strength: f64,
}

impl Default for GeneratorState {
    fn default() -> Self {
        Self {
            length: 20,
            lowercase: true,
            uppercase: true,
            digits: true,
            symbols: true,
            exclude_ambiguous: true,
            preview: Zeroizing::new(String::new()),
            preview_strength: 0.0,
        }
    }
}

impl GeneratorState {
    fn options(&self) -> GenOptions {
        GenOptions {
            length: self.length,
            lowercase: self.lowercase,
            uppercase: self.uppercase,
            digits: self.digits,
            symbols: self.symbols,
            exclude_ambiguous: self.exclude_ambiguous,
        }
    }

    pub fn refresh(&mut self) {
        match password::generate(&self.options()) {
            Ok(p) => {
                self.preview_strength = password::estimate_strength(&p);
                self.preview = Zeroizing::new(p);
            }
            Err(_) => {
                self.preview = Zeroizing::new(String::new());
                self.preview_strength = 0.0;
            }
        }
    }
}

#[allow(deprecated)]
fn window_id() -> egui::Id {
    egui::Id::new("edit-window")
}

pub enum EditIntent {
    None,
    Save,
    Cancel,
    UseGenerated,
    /// 关闭动画播完，可以真正销毁状态
    Closed,
}

fn strength_view(bits: f64) -> (&'static str, egui::Color32, f32) {
    let p = theme::palette();
    if bits < 40.0 {
        ("弱", p.danger, 0.25)
    } else if bits < 70.0 {
        ("中", p.warn, 0.55)
    } else if bits < 100.0 {
        ("强", p.success, 0.8)
    } else {
        ("很强", p.success, 1.0)
    }
}

pub fn show(
    ctx: &egui::Context,
    st: &mut EditState,
    categories: &[String],
    types: &[keynest_core::TypeDef],
) -> EditIntent {
    let mut intent = EditIntent::None;
    let mut open = true;
    let p = theme::palette();
    let title = if st.id.is_some() {
        "编辑条目"
    } else {
        "新增条目"
    };

    // 入场/退场：t=1 完全可见，t=0 完全消失
    let wid = window_id();
    let t = ctx.animate_bool_with_time(wid.with("fade"), !st.closing, 0.18);
    let slide = (1.0 - t) * 10.0;

    egui::Window::new(title)
        .id(wid)
        .collapsible(false)
        .resizable(false)
        .default_width(460.0)
        // 固定高度 + 内部滚动：条目类型和自定义字段加起来会比一屏还高，
        // 不固定的话窗口会顶出屏幕，标题栏被切掉。
        .fixed_size(egui::vec2(500.0, 640.0))
        .anchor(egui::Align2::CENTER_TOP, [0.0, 24.0 + slide])
        .open(&mut open)
        .frame(
            egui::Frame::new()
                .fill(p.surface)
                .corner_radius(egui::CornerRadius::same(theme::R_LG))
                .inner_margin(egui::Margin::same(18))
                .shadow(egui::epaint::Shadow {
                    offset: [0, 10],
                    blur: 30,
                    spread: 0,
                    color: egui::Color32::from_black_alpha(40),
                }),
        )
        .show(ctx, |ui| {
            ui.set_width(440.0);
            ui.multiply_opacity(t);

            egui::ScrollArea::vertical()
                .max_height(560.0)
                .show(ui, |ui| {
                    // 标题
                    theme::section(ui, "标题 *");
                    ui.add_sized(
                        [ui.available_width(), 32.0],
                        egui::TextEdit::singleline(&mut st.title).hint_text("例如 GitHub"),
                    );
                    ui.add_space(10.0);

                    // 用户名
                    theme::section(ui, "用户名");
                    ui.add_sized(
                        [ui.available_width(), 32.0],
                        egui::TextEdit::singleline(&mut st.username).hint_text("账号 / 邮箱"),
                    );
                    ui.add_space(10.0);

                    // 密码
                    theme::section(ui, "密码");
                    ui.horizontal(|ui| {
                        let w = (ui.available_width() - 80.0).max(120.0);
                        ui.add_sized(
                            [w, 32.0],
                            egui::TextEdit::singleline(&mut *st.password).password(true),
                        );
                        if icons::labeled(ui, icons::Icon::Key, "生成").clicked() {
                            st.generator_open = !st.generator_open;
                            if st.generator_open {
                                st.gen.refresh();
                            }
                        }
                    });

                    // 生成器
                    if st.generator_open {
                        egui::Frame::new()
                            .fill(p.surface_alt)
                            .corner_radius(egui::CornerRadius::same(theme::R_SM))
                            .inner_margin(egui::Margin::same(12))
                            .show(ui, |ui| {
                                ui.set_width(ui.available_width());

                                ui.horizontal(|ui| {
                                    ui.label(theme::label("长度"));
                                    ui.add(
                                        egui::Slider::new(&mut st.gen.length, 8..=64)
                                            .show_value(true),
                                    );
                                });

                                ui.horizontal(|ui| {
                                    let mut changed = false;
                                    changed |= ui.checkbox(&mut st.gen.lowercase, "小写").changed();
                                    changed |= ui.checkbox(&mut st.gen.uppercase, "大写").changed();
                                    changed |= ui.checkbox(&mut st.gen.digits, "数字").changed();
                                    changed |= ui.checkbox(&mut st.gen.symbols, "符号").changed();
                                    if changed {
                                        st.gen.refresh();
                                    }
                                });
                                if ui
                                    .checkbox(&mut st.gen.exclude_ambiguous, "排除易混字符 IlO0o1")
                                    .changed()
                                {
                                    st.gen.refresh();
                                }

                                ui.add_space(8.0);
                                ui.label(theme::mono(st.gen.preview.as_str()));

                                // 强度条
                                let (label, color, ratio) = strength_view(st.gen.preview_strength);
                                let (rect, _) = ui.allocate_exact_size(
                                    egui::vec2(ui.available_width(), 6.0),
                                    egui::Sense::hover(),
                                );
                                ui.painter().rect_filled(
                                    rect,
                                    egui::CornerRadius::same(3),
                                    p.border,
                                );
                                let mut fill = rect;
                                fill.set_width(rect.width() * ratio);
                                ui.painter()
                                    .rect_filled(fill, egui::CornerRadius::same(3), color);
                                ui.add_space(2.0);
                                ui.label(
                                    egui::RichText::new(format!("强度 {label}"))
                                        .size(11.0)
                                        .color(color),
                                );

                                ui.add_space(8.0);
                                ui.horizontal(|ui| {
                                    if icons::labeled(ui, icons::Icon::Copy, "换一个").clicked()
                                    {
                                        st.gen.refresh();
                                    }
                                    if icons::labeled(ui, icons::Icon::Eye, "使用此密码").clicked()
                                    {
                                        intent = EditIntent::UseGenerated;
                                    }
                                });
                            });
                    }

                    ui.add_space(10.0);

                    // 条目类型
                    let mut kind = st.kind.clone();
                    ui.horizontal(|ui| {
                        theme::section(ui, "类型");
                        egui::ComboBox::from_id_salt("edit-kind")
                            .selected_text(kind.clone())
                            .width(140.0)
                            .show_ui(ui, |ui| {
                                for k in types {
                                    ui.selectable_value(
                                        &mut kind,
                                        k.label.clone(),
                                        k.label.as_str(),
                                    );
                                }
                            });
                        if kind != st.kind && !st.fields.is_empty() {
                            ui.label(theme::caption("（已切换类型，现有字段保留）"));
                        }
                    });
                    if kind != st.kind {
                        st.kind = kind;
                        // 模板挂在类型定义上（不按名字硬编码），改名后依然有效
                        st.template = types
                            .iter()
                            .find(|t| t.label == st.kind)
                            .map(|t| t.template.clone())
                            .unwrap_or_default();
                        // 从「账号」切到「信用卡」这类操作，用户期待看到模板字段
                        st.apply_template();
                    }

                    ui.add_space(10.0);
                    theme::section(ui, "自定义字段");

                    let mut remove: Option<usize> = None;
                    for (i, f) in st.fields.iter_mut().enumerate() {
                        ui.horizontal(|ui| {
                            ui.add_sized(
                                [120.0, 28.0],
                                egui::TextEdit::singleline(&mut f.label).hint_text("名称"),
                            );
                            let w = (ui.available_width() - 96.0).max(80.0);
                            ui.add_sized(
                                [w, 28.0],
                                egui::TextEdit::singleline(&mut *f.value)
                                    .hint_text("值")
                                    .password(f.secret),
                            );
                            let mut secret = f.secret;
                            if ui
                                .checkbox(&mut secret, "隐藏")
                                .on_hover_text("勾选后列表与详情页默认打码")
                                .changed()
                            {
                                f.secret = secret;
                            }
                            if ui.button("×").on_hover_text("删除这一行").clicked() {
                                remove = Some(i);
                            }
                        });
                    }
                    if let Some(i) = remove {
                        st.fields.remove(i);
                    }

                    if st.fields.len() < keynest_core::vault::MAX_FIELDS
                        && theme::ghost_button(ui, "+ 添加字段").clicked()
                    {
                        st.fields.push(FieldDraft {
                            label: String::new(),
                            value: Zeroizing::new(String::new()),
                            secret: false,
                        });
                    }

                    ui.add_space(10.0);

                    // 网址 + 分类
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            theme::section(ui, "网址");
                            ui.add_sized(
                                [200.0, 32.0],
                                egui::TextEdit::singleline(&mut st.url).hint_text("https://"),
                            );
                        });
                        ui.add_space(8.0);
                        ui.vertical(|ui| {
                            theme::section(ui, "分类");
                            egui::ComboBox::from_id_salt("edit-cat")
                                .selected_text(if st.category.is_empty() {
                                    "未分类"
                                } else {
                                    st.category.as_str()
                                })
                                .width(180.0)
                                .show_ui(ui, |ui| {
                                    for c in categories {
                                        ui.selectable_value(&mut st.category, c.clone(), c);
                                    }
                                });
                        });
                    });

                    ui.add_space(10.0);
                    theme::section(ui, "动态验证码（TOTP，可留空）");
                    let totp_hint = if st.totp.is_empty() {
                        "otpauth:// 链接，或 Base32 密钥"
                    } else {
                        ""
                    };
                    ui.add_sized(
                        [ui.available_width(), 32.0],
                        egui::TextEdit::singleline(&mut *st.totp).hint_text(totp_hint),
                    );
                    // 边输边校验：格式错了立刻说，不要等到保存时才发现
                    if !st.totp.trim().is_empty() {
                        match keynest_core::Totp::parse(st.totp.trim()) {
                            Ok(t) => {
                                ui.label(theme::caption(format!(
                                    "{} 位 · {} 秒 · {:?}",
                                    t.digits(),
                                    t.period(),
                                    t.algorithm()
                                )));
                            }
                            Err(e) => {
                                ui.label(
                                    egui::RichText::new(e.to_string())
                                        .size(11.0)
                                        .color(p.danger),
                                );
                            }
                        }
                    }

                    ui.add_space(10.0);
                    theme::section(ui, "备注");
                    ui.add_sized(
                        [ui.available_width(), 64.0],
                        egui::TextEdit::multiline(&mut st.notes).hint_text("任意备注"),
                    );

                    if let Some(err) = &st.error {
                        ui.add_space(8.0);
                        ui.label(egui::RichText::new(err).size(12.0).color(p.danger));
                    }

                    ui.add_space(14.0);
                    ui.separator();
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        if theme::primary_button(ui, "保存", 110.0).clicked() {
                            intent = EditIntent::Save;
                        }
                        if theme::ghost_button(ui, "取消").clicked() {
                            intent = EditIntent::Cancel;
                        }
                    });
                });
        });

    // 用户点了标题栏的 × ：进入关闭动画
    if !open && !st.closing && matches!(intent, EditIntent::None) {
        st.closing = true;
    }

    // 动画播完才真正销毁
    if st.closing && t < 0.02 {
        return EditIntent::Closed;
    }
    intent
}

#[cfg(test)]
mod tests {
    use super::*;
    use keynest_core::vault::Entry;

    fn sample_entry() -> Entry {
        Entry {
            id: "id-1".into(),
            title: "站点".into(),
            username: "user".into(),
            password: "pw".into(),
            url: "https://x.test".into(),
            category: "网站".into(),
            notes: "note".into(),
            favorite: false,
            kind: kinds::LOGIN.to_string(),
            fields: Vec::new(),
            totp: None,
            password_changed_at: None,
            deleted_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// 打开编辑框但一字未改 → 不算脏。
    ///
    /// 这条最关键：锁定时若据此提示"有未保存的修改"，用户每次锁库都会看到
    /// 一个没有意义的确认框，很快就养成"闭眼点确定"的习惯——
    /// 那等于把这道防线废掉。
    #[test]
    fn untouched_edit_is_not_dirty() {
        let st = EditState::from_entry(&sample_entry());
        assert!(!st.is_dirty());
    }

    #[test]
    fn changed_title_is_dirty() {
        let mut st = EditState::from_entry(&sample_entry());
        st.title = "改过的标题".into();
        assert!(st.is_dirty());
    }

    #[test]
    fn changed_password_is_dirty() {
        let mut st = EditState::from_entry(&sample_entry());
        st.password = Zeroizing::new("another".to_string());
        assert!(st.is_dirty());
    }

    #[test]
    fn changed_note_is_dirty() {
        let mut st = EditState::from_entry(&sample_entry());
        st.notes.push_str(" 补充");
        assert!(st.is_dirty());
    }

    #[test]
    fn toggled_favorite_is_dirty() {
        let mut st = EditState::from_entry(&sample_entry());
        st.favorite = true;
        assert!(st.is_dirty());
    }

    /// 改了又改回原值 → 不算脏（比较快照而不是"有没有动过"）。
    #[test]
    fn reverted_change_is_not_dirty() {
        let mut st = EditState::from_entry(&sample_entry());
        st.title = "临时改的".into();
        st.title = "站点".into();
        assert!(!st.is_dirty());
    }

    /// 新增条目：空表单不算脏，填了内容就算。
    #[test]
    fn new_entry_dirty_only_after_input() {
        let st = EditState::new_entry("网站".into());
        assert!(!st.is_dirty(), "刚打开的空新增表单不该算脏");

        let mut st = EditState::new_entry("网站".into());
        st.title = "新站点".into();
        assert!(st.is_dirty());
    }

    /// 自定义字段的值变化也要算脏——否则用户改了卡号却收不到提示。
    #[test]
    fn changed_custom_field_is_dirty() {
        let mut e = sample_entry();
        e.fields = vec![keynest_core::vault::Field {
            label: "卡号".into(),
            value: "6222".into(),
            secret: true,
        }];
        let mut st = EditState::from_entry(&e);
        assert!(!st.is_dirty());
        st.fields[0].value = Zeroizing::new("6223".to_string());
        assert!(st.is_dirty());
    }

    /// 字段数量变化（增/删一行）也要算脏。
    #[test]
    fn added_field_row_is_dirty() {
        let mut st = EditState::from_entry(&sample_entry());
        st.fields.push(FieldDraft {
            label: "新字段".into(),
            value: Zeroizing::new("v".to_string()),
            secret: false,
        });
        assert!(st.is_dirty());
    }
}
