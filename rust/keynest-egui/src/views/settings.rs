//! 设置界面。

use std::path::PathBuf;
use zeroize::Zeroizing;

use keynest_core::vault::Settings;

use crate::ui::{icons, theme};

/// 打开设置时算好的一份安全概况。
///
/// 在 `app.rs` 里算、在这里只负责画：视图层不碰数据判定，
/// 这样"什么算弱密码"这类规则只有一处定义。
#[derive(Clone, Copy, Default, Debug)]
pub struct SecuritySummary {
    pub total: usize,
    pub weak: usize,
    pub reused: usize,
    pub with_totp: usize,
    pub stale: usize,
}

/// 设置面板的分区。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Tab {
    #[default]
    Appearance,
    Security,
    Data,
    Browser,
    Danger,
}

impl Tab {
    const ALL: [Tab; 5] = [
        Tab::Appearance,
        Tab::Security,
        Tab::Data,
        Tab::Browser,
        Tab::Danger,
    ];

    fn label(self) -> &'static str {
        match self {
            Tab::Appearance => "外观",
            Tab::Security => "安全",
            Tab::Data => "数据",
            Tab::Browser => "浏览器",
            Tab::Danger => "危险",
        }
    }
}

pub struct SettingsState {
    /// 当前分区。
    ///
    /// 以前所有设置挤在一列里，滚动条长到用户找不到「导入/导出」；
    /// 分区之后每一屏都是完整的，不需要滚。
    pub tab: Tab,
    /// 分类列表（打开设置时的快照；增删改后由 `app.rs` 刷新）。
    pub categories: Vec<String>,
    pub new_category: String,
    pub types: Vec<keynest_core::TypeDef>,
    pub new_type: String,
    pub renaming_type: Option<(String, String)>,
    /// 正在改名的分类：(原名, 新名缓冲)
    pub renaming: Option<(String, String)>,
    pub draft: Settings,
    pub old_pw: Zeroizing<String>,
    pub new_pw: Zeroizing<String>,
    pub new_pw2: Zeroizing<String>,
    pub upgrade_pw: Zeroizing<String>,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub wipe_open: bool,
    pub wipe_confirm_text: String,
    pub legacy: bool,
    pub data_dir: PathBuf,
    pub on_roaming: bool,
    pub kdf_algo: String,
    /// 当前库的格式标记（`keynest.v1` / `.v2` / `.v3`）。
    pub format: String,
    /// 密钥是否真的被锁定在物理内存里；`None` 表示未解锁。
    pub key_locked: Option<bool>,
    /// 当前库的 KDF 是否达到推荐下限；`None` 表示不判断。
    pub kdf_ok: Option<bool>,
    pub security: SecuritySummary,
    /// 恢复留档（`vault.dat.corrupt-*`）的文件列表与总大小。
    ///
    /// 每次从备份恢复都会把原来那份挪到一边保留。此前界面完全看不到它们，
    /// 反复恢复失败的用户会在磁盘上攒一堆几 MB 的留档。
    pub leftovers: Vec<keynest_core::vault::RecoveryLeftover>,
    pub leftovers_bytes: u64,
    /// 清空留档的二次确认
    pub confirm_clear_leftovers: bool,
    pub font_note: Option<String>,
    /// 深色模式开关（仅本次运行，不写入仓库）
    pub dark: bool,
    /// 正在改主密码。
    ///
    /// Argon2id 要派生两次（旧 KEK + 新 KEK），在 UI 线程上会阻塞
    /// 160–400ms。没有这个标记时，用户在冻结期间会反复点按钮，
    /// 于是排队多次 `change_master`——第二次因为旧密码已经变了而失败，
    /// 用户看到一个莫名其妙的错误。
    pub changing_master: bool,

    /// 正在升级格式。同样是 Argon2id 派生 + 重写整个库，会阻塞。
    pub upgrading: bool,

    /// 用户填的扩展 ID（从扩展 popup 里复制来的）。
    ///
    /// 未发布到商店的扩展 ID 由安装路径的哈希决定，**每台机器不同**，
    /// 所以桌面程序没法自己猜，只能让用户填。
    pub bridge_ext_id: String,
    /// 浏览器桥接的安装状态提示。
    pub bridge_status: Option<String>,
    /// 浏览器桥接是否已安装（打开设置时查一次）。
    pub bridge_installed: bool,
    /// 正在播放关闭动画
    pub closing: bool,
}

/// 打开设置时需要从仓库里带出来的一堆只读信息。
///
/// 用一个结构体而不是八个位置参数：这东西每加一项，
/// 所有调用点都会多出一个"第 6 个参数到底填什么"的问题。
#[derive(Clone, Debug, Default)]
pub struct SettingsContext {
    pub categories: Vec<String>,
    pub types: Vec<keynest_core::TypeDef>,
    pub legacy: bool,
    pub kdf_algo: String,
    pub format: String,
    pub key_locked: Option<bool>,
    pub kdf_ok: Option<bool>,
    pub security: SecuritySummary,
    /// 恢复留档（`vault.dat.corrupt-*`）的快照。打开设置时读一次。
    pub leftovers: Vec<keynest_core::vault::RecoveryLeftover>,
    pub font_note: Option<String>,
    pub dark: bool,
    /// 浏览器桥接是否已安装（打开设置时查一次，只读）。
    pub bridge_installed: bool,
}

impl SettingsState {
    pub fn new(settings: &Settings, ctx: SettingsContext) -> Self {
        Self {
            tab: Tab::default(),
            categories: ctx.categories,
            new_category: String::new(),
            types: ctx.types,
            new_type: String::new(),
            renaming_type: None,
            renaming: None,
            draft: settings.clone(),
            old_pw: Zeroizing::new(String::new()),
            new_pw: Zeroizing::new(String::new()),
            new_pw2: Zeroizing::new(String::new()),
            upgrade_pw: Zeroizing::new(String::new()),
            error: None,
            notice: None,
            wipe_open: false,
            wipe_confirm_text: String::new(),
            legacy: ctx.legacy,
            confirm_clear_leftovers: false,
            data_dir: keynest_core::paths::resolve_data_dir(),
            on_roaming: keynest_core::paths::is_on_roaming_profile(),
            kdf_algo: ctx.kdf_algo,
            format: ctx.format,
            key_locked: ctx.key_locked,
            kdf_ok: ctx.kdf_ok,
            security: ctx.security,
            leftovers_bytes: ctx.leftovers.iter().map(|l| l.bytes).sum(),
            leftovers: ctx.leftovers,
            font_note: ctx.font_note,
            dark: ctx.dark,
            changing_master: false,
            upgrading: false,
            bridge_ext_id: String::new(),
            bridge_status: None,
            bridge_installed: ctx.bridge_installed,
            closing: false,
        }
    }
}

#[allow(deprecated)]
fn window_id() -> egui::Id {
    egui::Id::new("settings-window")
}

pub enum SettingsIntent {
    None,
    /// 关掉设置并跳到「弱密码」筛选
    ShowWeak,
    /// 新增分类（名字在 `new_category` 里）
    AddCategory,
    /// 重命名分类
    RenameCategory {
        from: String,
        to: String,
    },
    /// 删除分类（旗下条目会移到「其他」）
    DeleteCategory(String),
    /// 新增类型
    AddType,
    RenameType {
        from: String,
        to: String,
    },
    DeleteType(String),
    /// 关掉设置并跳到「重复」筛选
    ShowReused,
    Close,
    Save,
    ChangeMaster,
    Upgrade,
    OpenWipe,
    CancelWipe,
    Wipe,
    SetTheme(bool),
    /// 安装 / 重新安装浏览器桥接
    InstallBridge,
    /// 卸载浏览器桥接
    UninstallBridge,
    /// 导出明文 CSV（需要二次确认）
    ExportCsv,
    /// 导出明文 JSON（需要二次确认）
    ExportJson,
    /// 导出加密备份（本身就是密文，不需要确认）
    ExportBackup,
    /// 从 CSV / JSON 文件导入
    ImportFile,
    /// 清空恢复留档（`vault.dat.corrupt-*`）。
    ClearLeftovers,
    /// 放弃本地未保存的改动，重新载入磁盘上的库。
    ///
    /// 用于「库文件被别处改过」之后——那是网盘同步/多机使用的常见情况，
    /// 用户需要一条能走通的路，而不是只能重启程序。
    ReloadFromDisk,
    /// 关闭动画播完
    Closed,
}

/// 一行「标签 + 滑块」。
fn slider_row(
    ui: &mut egui::Ui,
    label: &str,
    value: &mut u32,
    range: std::ops::RangeInclusive<u32>,
) {
    ui.horizontal(|ui| {
        ui.label(theme::body(label));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_sized(
                [200.0, 22.0],
                egui::Slider::new(value, range).show_value(true),
            );
        });
    });
}

pub fn show(ctx: &egui::Context, st: &mut SettingsState) -> SettingsIntent {
    let mut intent = SettingsIntent::None;
    let mut open = true;
    let p = theme::palette();

    let wid = window_id();
    let t = ctx.animate_bool_with_time(wid.with("fade"), !st.closing, 0.18);
    let slide = (1.0 - t) * 10.0;

    egui::Window::new("设置")
        .id(wid)
        .collapsible(false)
        .resizable(false)
        // 固定尺寸，而不是「按内容自动定高」：
        // 自动定高 + resizable(false) 会让窗口锁定在第一帧算出的高度上，
        // 于是内容再长也只在那一小块里滚动，看起来就是「设置窗口缺了一截」。
        .fixed_size(egui::vec2(520.0, 620.0))
        .anchor(egui::Align2::CENTER_TOP, [0.0, 36.0 + slide])
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
            ui.set_width(480.0);
            ui.multiply_opacity(t);

            // 分区标签
            ui.horizontal(|ui| {
                for tab in Tab::ALL {
                    if theme::chip(ui, st.tab == tab, tab.label()).clicked() {
                        st.tab = tab;
                    }
                }
            });
            ui.add_space(10.0);
            ui.separator();
            ui.add_space(10.0);

            egui::ScrollArea::vertical()
                .max_height(470.0)
                .show(ui, |ui| match st.tab {
                    Tab::Appearance => tab_appearance(ui, st, &mut intent),
                    Tab::Security => tab_security(ui, st, &mut intent),
                    Tab::Data => tab_data(ui, st, &mut intent),
                    Tab::Browser => tab_browser(ui, st, &mut intent),
                    Tab::Danger => tab_danger(ui, st, &mut intent),
                });

            // 提示固定在底部，不随分区切换消失
            if let Some(err) = &st.error {
                ui.add_space(8.0);
                ui.label(egui::RichText::new(err).size(12.0).color(p.danger));
            }
            if let Some(msg) = &st.notice {
                ui.add_space(8.0);
                ui.label(egui::RichText::new(msg).size(12.0).color(p.success));
            }
        });

    if !open && !st.closing && matches!(intent, SettingsIntent::None) {
        st.closing = true;
    }
    if st.closing && t < 0.02 {
        return SettingsIntent::Closed;
    }
    intent
}

/* ------------------------------------------------------------------ */
/* 各分区                                                              */
/* ------------------------------------------------------------------ */

fn tab_appearance(ui: &mut egui::Ui, st: &mut SettingsState, intent: &mut SettingsIntent) {
    ui.label(theme::h3("外观"));
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        let mut dark = st.dark;
        if ui.checkbox(&mut dark, "深色模式").changed() {
            st.dark = dark;
            *intent = SettingsIntent::SetTheme(dark);
        }
    });
    ui.add_space(6.0);
    ui.label(theme::caption("深色模式只影响本次运行，不写入密码库。"));

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(10.0);

    // 快捷键清单：这里列的都是**真的绑定了**的，不写未来计划。
    // 只写快捷键却不写说明，等于默认用户会去翻文档——而没人翻。
    ui.label(theme::h3("快捷键"));
    ui.add_space(6.0);
    for (key, desc) in [
        ("Ctrl + F", "聚焦搜索框"),
        ("Ctrl + N", "新增条目"),
        ("Ctrl + L", "锁定密码库"),
        ("Esc", "关闭当前对话框 / 取消"),
        ("Enter", "在解锁或创建界面提交"),
    ] {
        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new(key)
                    .size(11.5)
                    .monospace()
                    .color(theme::palette().text),
            );
            ui.add_space(8.0);
            ui.label(theme::caption(desc));
        });
        ui.add_space(2.0);
    }
}

fn tab_security(ui: &mut egui::Ui, st: &mut SettingsState, intent: &mut SettingsIntent) {
    let p = theme::palette();
    let sec = st.security;

    ui.label(theme::h3("安全概览"));
    ui.add_space(6.0);
    ui.label(theme::caption(format!(
        "共 {} 条记录。下面几项是「值得现在处理」的：",
        sec.total
    )));
    ui.add_space(8.0);
    ui.horizontal_wrapped(|ui| {
        let weak_color = if sec.weak > 0 { p.danger } else { p.muted };
        theme::tag(ui, &format!("弱密码 {}", sec.weak), weak_color);
        let reused_color = if sec.reused > 0 { p.warn } else { p.muted };
        theme::tag(ui, &format!("重复使用 {}", sec.reused), reused_color);
        theme::tag(ui, &format!("已启用验证码 {}", sec.with_totp), p.muted);
        let stale_color = if sec.stale > 0 { p.warn } else { p.muted };
        theme::tag(ui, &format!("180 天未更新 {}", sec.stale), stale_color);
    });
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        if sec.weak > 0 && theme::ghost_button(ui, "查看弱密码").clicked() {
            *intent = SettingsIntent::ShowWeak;
        }
        if sec.reused > 0 && theme::ghost_button(ui, "查看重复").clicked() {
            *intent = SettingsIntent::ShowReused;
        }
    });
    ui.add_space(4.0);
    ui.label(theme::caption(
        "「180 天未更新」按密码最后一次变更的时间算；旧记录没有这个时间时，退回用条目最后修改时间估算。",
    ));

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(10.0);

    ui.label(theme::h3("自动锁定与剪贴板"));
    ui.add_space(6.0);
    slider_row(
        ui,
        "自动锁定（分钟）",
        &mut st.draft.auto_lock_minutes,
        1..=120,
    );
    slider_row(
        ui,
        "剪贴板清除（秒）",
        &mut st.draft.clipboard_clear_seconds,
        5..=120,
    );
    slider_row(ui, "显示密码（秒）", &mut st.draft.reveal_seconds, 5..=120);
    ui.add_space(4.0);
    ui.label(theme::caption(
        "自动锁定取「应用闲置」与「系统闲置」中较短的那个：在本窗口里操作不会误锁，\
         但离开电脑后系统级闲置到点就锁。",
    ));
    ui.add_space(8.0);
    if theme::primary_button(ui, "保存设置", 120.0).clicked() {
        *intent = SettingsIntent::Save;
    }

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(10.0);

    ui.label(theme::h3("修改主密码"));
    ui.add_space(6.0);
    ui.label(theme::caption(format!(
        "至少 {} 位。当前格式下只需重新包裹数据密钥，不必重写整个库。",
        keynest_core::vault::MIN_MASTER_LEN
    )));
    ui.add_space(6.0);
    egui::Grid::new("master-grid")
        .num_columns(2)
        .spacing([10.0, 6.0])
        .show(ui, |ui| {
            ui.label(theme::label("当前密码"));
            ui.add_sized(
                [220.0, 30.0],
                egui::TextEdit::singleline(&mut *st.old_pw).password(true),
            );
            ui.end_row();
            ui.label(theme::label("新密码"));
            ui.add_sized(
                [220.0, 30.0],
                egui::TextEdit::singleline(&mut *st.new_pw).password(true),
            );
            ui.end_row();
            ui.label(theme::label("再输一次"));
            ui.add_sized(
                [220.0, 30.0],
                egui::TextEdit::singleline(&mut *st.new_pw2).password(true),
            );
            ui.end_row();
        });
    ui.add_space(8.0);
    if st.changing_master {
        // 明确告诉用户"正在忙"，而不是让窗口看起来死了
        ui.add_enabled(false, egui::Button::new("正在修改…"))
            .on_disabled_hover_text("正在派生密钥，请稍候");
    } else if theme::ghost_button(ui, "修改主密码").clicked() {
        *intent = SettingsIntent::ChangeMaster;
    }
}

fn tab_data(ui: &mut egui::Ui, st: &mut SettingsState, intent: &mut SettingsIntent) {
    let p = theme::palette();

    ui.label(theme::h3("仓库"));
    ui.add_space(6.0);
    egui::Frame::new()
        .fill(p.surface_alt)
        .corner_radius(egui::CornerRadius::same(theme::R_SM))
        .inner_margin(egui::Margin::symmetric(10, 8))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(theme::label("位置"));
                ui.label(
                    egui::RichText::new(st.data_dir.display().to_string())
                        .size(11.0)
                        .monospace()
                        .color(p.text),
                );
            });
            ui.horizontal(|ui| {
                ui.label(theme::label("格式"));
                ui.label(egui::RichText::new(&st.format).size(11.5).color(p.text));
                ui.label(theme::label("密钥派生"));
                ui.label(egui::RichText::new(&st.kdf_algo).size(11.5).color(p.text));
                ui.label(theme::label("加密"));
                ui.label(
                    egui::RichText::new(if st.legacy {
                        "AES-256-GCM / XChaCha20-Poly1305"
                    } else {
                        "XChaCha20-Poly1305"
                    })
                    .size(11.5)
                    .color(p.text),
                );
            });
            if let Some(locked) = st.key_locked {
                ui.horizontal(|ui| {
                    ui.label(theme::label("内存"));
                    let (text, color) = if locked {
                        ("密钥已锁定在物理内存", p.muted)
                    } else {
                        ("平台拒绝内存锁定，已降级为仅零化", p.warn)
                    };
                    ui.label(egui::RichText::new(text).size(11.0).color(color));
                });
            }
            if let Some(f) = &st.font_note {
                ui.horizontal(|ui| {
                    ui.label(theme::label("字体"));
                    ui.label(egui::RichText::new(f).size(10.5).color(p.muted));
                });
            }
        });

    // KDF 低于推荐下限：能打开，但该升级了。这里不拦人，只提醒。
    if st.kdf_ok == Some(false) {
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new(
                "⚠ 当前密码库的密钥派生参数低于推荐值。库能正常打开，但抗离线爆破能力较弱——请升级到 v3（见下方）。",
            )
            .size(11.0)
            .color(p.warn),
        );
    }

    if st.on_roaming {
        ui.add_space(6.0);
        ui.label(
            egui::RichText::new(
                "⚠ 仓库位于漫游目录（%APPDATA%），域环境或开启同步时可能被复制到其他机器。",
            )
            .size(11.0)
            .color(p.warn),
        );
    }

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(10.0);

    ui.label(theme::h3("类型"));
    ui.add_space(4.0);
    ui.label(theme::caption(
        "类型决定编辑表单里的默认字段（信用卡带卡号、身份带证件号）。删除类型时，\
         它下面的条目会归到剩下的第一个类型。",
    ));
    ui.add_space(6.0);

    let mut remove_type: Option<String> = None;
    let mut commit_type_rename: Option<(String, String)> = None;
    let mut cancel_type_rename = false;

    for t in st.types.clone() {
        let t = t.label;
        ui.horizontal(|ui| {
            if let Some((_, buf)) = st.renaming_type.as_mut().filter(|(f, _)| f == &t) {
                ui.add_sized(
                    [150.0, 26.0],
                    egui::TextEdit::singleline(buf).hint_text("新名称"),
                );
                if theme::ghost_button(ui, "确定").clicked() {
                    commit_type_rename = Some((t.clone(), buf.clone()));
                }
                if theme::ghost_button(ui, "取消").clicked() {
                    cancel_type_rename = true;
                }
            } else {
                ui.allocate_ui_with_layout(
                    egui::vec2(150.0, 26.0),
                    egui::Layout::left_to_right(egui::Align::Center),
                    |ui| {
                        ui.add(egui::Label::new(theme::body(&t)).truncate());
                    },
                );
                if theme::ghost_button(ui, "改名").clicked() {
                    st.renaming_type = Some((t.clone(), t.clone()));
                }
                if st.types.len() > 1 && theme::ghost_button(ui, "删除").clicked() {
                    remove_type = Some(t.clone());
                }
            }
        });
    }

    if let Some((from, to)) = commit_type_rename {
        if !to.trim().is_empty() && to.trim() != from {
            *intent = SettingsIntent::RenameType { from, to };
        }
        st.renaming_type = None;
    }
    if cancel_type_rename {
        st.renaming_type = None;
    }
    if let Some(t) = remove_type {
        *intent = SettingsIntent::DeleteType(t);
    }

    ui.add_space(6.0);
    ui.horizontal(|ui| {
        ui.add_sized(
            [150.0, 26.0],
            egui::TextEdit::singleline(&mut st.new_type).hint_text("新类型名"),
        );
        if theme::ghost_button(ui, "添加").clicked() && !st.new_type.trim().is_empty() {
            *intent = SettingsIntent::AddType;
        }
    });

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(10.0);

    ui.label(theme::h3("分类"));
    ui.add_space(4.0);
    ui.label(theme::caption(
        "删除分类时，它下面的条目会移到剩下的第一个分类，不会丢。至少要保留一个分类。",
    ));
    ui.add_space(6.0);

    let mut remove: Option<String> = None;
    let mut commit_rename: Option<(String, String)> = None;
    let mut cancel_rename = false;

    for cat in st.categories.clone() {
        let editing = matches!(&st.renaming, Some((from, _)) if from == &cat);
        ui.horizontal(|ui| {
            if let Some((_, buf)) = st.renaming.as_mut().filter(|(f, _)| f == &cat) {
                let resp = ui.add_sized(
                    [150.0, 26.0],
                    egui::TextEdit::singleline(buf).hint_text("新名称"),
                );
                if resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                    commit_rename = Some((cat.clone(), buf.clone()));
                }
                if theme::ghost_button(ui, "确定").clicked() {
                    commit_rename = Some((cat.clone(), buf.clone()));
                }
                if theme::ghost_button(ui, "取消").clicked() {
                    cancel_rename = true;
                }
            } else {
                // 用固定宽度的子 Ui 左对齐：`add_sized` 会把标签居中，
                // 一列分类名会左右参差，看着很乱。
                ui.allocate_ui_with_layout(
                    egui::vec2(150.0, 26.0),
                    egui::Layout::left_to_right(egui::Align::Center),
                    |ui| {
                        ui.add(egui::Label::new(theme::body(&cat)).truncate());
                    },
                );
                if theme::ghost_button(ui, "改名").clicked() {
                    st.renaming = Some((cat.clone(), cat.clone()));
                }
                // 任何分类都能删（包括「其他」），只要还有别的分类接得住这些条目
                if st.categories.len() > 1 && theme::ghost_button(ui, "删除").clicked() {
                    remove = Some(cat.clone());
                }
            }
            let _ = editing;
        });
    }

    if let Some((from, to)) = commit_rename {
        if !to.trim().is_empty() && to.trim() != from {
            *intent = SettingsIntent::RenameCategory { from, to };
        }
        st.renaming = None;
    }
    if cancel_rename {
        st.renaming = None;
    }
    if let Some(cat) = remove {
        *intent = SettingsIntent::DeleteCategory(cat);
    }

    ui.add_space(6.0);
    ui.horizontal(|ui| {
        ui.add_sized(
            [150.0, 26.0],
            egui::TextEdit::singleline(&mut st.new_category).hint_text("新分类名"),
        );
        if theme::ghost_button(ui, "添加").clicked() && !st.new_category.trim().is_empty() {
            *intent = SettingsIntent::AddCategory;
        }
    });

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(10.0);

    ui.label(theme::h3("导入 / 导出"));
    ui.add_space(4.0);
    ui.label(theme::caption(
        "明文导出会把库里的密码写成任何人都能读的文本，用于迁移到其他软件。\
         加密备份保持加密状态，用于换机或防灾。",
    ));
    ui.add_space(8.0);
    ui.horizontal_wrapped(|ui| {
        if theme::ghost_button(ui, "导出 CSV（明文）").clicked() {
            *intent = SettingsIntent::ExportCsv;
        }
        if theme::ghost_button(ui, "导出 JSON（明文）").clicked() {
            *intent = SettingsIntent::ExportJson;
        }
    });
    ui.add_space(6.0);
    ui.horizontal_wrapped(|ui| {
        if icons::labeled(ui, icons::Icon::Key, "导出加密备份").clicked() {
            *intent = SettingsIntent::ExportBackup;
        }
        if icons::labeled(ui, icons::Icon::Plus, "从文件导入").clicked() {
            *intent = SettingsIntent::ImportFile;
        }
        if icons::labeled(ui, icons::Icon::Refresh, "重新载入磁盘上的库").clicked() {
            *intent = SettingsIntent::ReloadFromDisk;
        }
    });
    ui.add_space(4.0);
    ui.label(theme::caption(
        "导入只新增条目：同名同账号的记录会跳过，绝不覆盖库里已有的密码。\
         支持 Chrome / Edge / Firefox / Bitwarden 导出的 CSV，以及 JSON。",
    ));

    if st.legacy {
        ui.add_space(16.0);
        ui.separator();
        ui.add_space(10.0);
        ui.label(theme::h3("升级到 v3 格式"));
        ui.add_space(4.0);
        ui.label(theme::caption(
            "当前库里，主密码派生的密钥直接就是数据加密密钥。\
             升级后会改成「主密码派生密钥只用来包裹一把随机数据密钥」：\
             换主密码不再需要重写整个库，Argon2 参数也能独立调整。",
        ));
        ui.add_space(4.0);
        ui.label(theme::caption(
            "升级会先备份当前文件；验证失败会自动回滚，原密码继续有效。",
        ));
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.add_sized(
                [220.0, 30.0],
                egui::TextEdit::singleline(&mut *st.upgrade_pw)
                    .password(true)
                    .hint_text("主密码"),
            );
            if st.upgrading {
                ui.add_enabled(false, egui::Button::new("正在升级…"))
                    .on_disabled_hover_text("正在重写整个库，请稍候");
            } else if icons::labeled(ui, icons::Icon::Shield, "升级").clicked() {
                *intent = SettingsIntent::Upgrade;
            }
        });
    }
}

/// 浏览器桥接：安装 / 卸载 Native Messaging 宿主。
///
/// # 为什么需要这一页
///
/// 扩展与桌面程序之间的全部通信都要经过浏览器启动的
/// `keynest-native-host.exe`，而浏览器只在**注册表**里找它。
/// 没有这一步，扩展装上了也**连不上**——握手根本起不了步，
/// 用户看到的只是「KeyNest 未运行」。
///
/// # 扩展 ID 为什么必须用户填
///
/// 清单里的 `allowed_origins` 要写**精确的扩展 ID**。未发布到商店的
/// 扩展 ID 由安装路径的哈希决定，**每台机器都不一样**，
/// 桌面程序没法自己猜。扩展的 popup 里有一块专门显示它，复制过来即可。
fn tab_browser(ui: &mut egui::Ui, st: &mut SettingsState, intent: &mut SettingsIntent) {
    let p = theme::palette();

    theme::section(ui, "浏览器桥接");
    ui.label(theme::caption(
        r"扩展与本程序之间的通信要经过一个本地宿主进程。安装它会在
%LOCALAPPDATA%\KeyNestin\ 放一份宿主程序，并在当前用户下写两条注册表项（不需要管理员权限）。",
    ));
    ui.add_space(8.0);

    if st.bridge_installed {
        ui.label(egui::RichText::new("已安装").size(12.0).color(p.success));
    } else {
        ui.label(egui::RichText::new("尚未安装").size(12.0).color(p.warn));
    }
    ui.add_space(10.0);

    theme::section(ui, "扩展 ID");
    ui.label(theme::caption(
        "打开浏览器扩展的弹窗，复制显示的扩展 ID 粘贴到这里。
未发布到商店的扩展 ID 每台机器都不同，所以必须由你填。",
    ));
    ui.add_space(6.0);
    ui.add(
        egui::TextEdit::singleline(&mut st.bridge_ext_id)
            .hint_text("32 个 a–p 的小写字母")
            .desired_width(f32::INFINITY),
    );
    ui.add_space(10.0);

    let id_ok = keynest_bridge::hostinstall::is_valid_extension_id(st.bridge_ext_id.trim());
    if !st.bridge_ext_id.trim().is_empty() && !id_ok {
        ui.label(
            egui::RichText::new("扩展 ID 看起来不对：应当是 32 个 a–p 的小写字母")
                .size(11.0)
                .color(p.danger),
        );
        ui.add_space(6.0);
    }

    ui.horizontal(|ui| {
        let btn = egui::Button::new(if st.bridge_installed {
            "重新安装"
        } else {
            "安装"
        });
        if ui.add_enabled(id_ok, btn).clicked() {
            *intent = SettingsIntent::InstallBridge;
        }
        if st.bridge_installed && theme::ghost_button(ui, "卸载").clicked() {
            *intent = SettingsIntent::UninstallBridge;
        }
    });

    if let Some(msg) = &st.bridge_status {
        ui.add_space(8.0);
        ui.label(egui::RichText::new(msg).size(11.5).color(p.muted));
    }
}

fn tab_danger(ui: &mut egui::Ui, st: &mut SettingsState, intent: &mut SettingsIntent) {
    let p = theme::palette();
    ui.label(
        egui::RichText::new("危险操作")
            .size(14.0)
            .strong()
            .color(p.danger),
    );
    ui.add_space(6.0);
    ui.label(theme::caption(
        "这里的操作没有撤销。日常删除条目请用详情页的「删除」，它会先进入回收站。",
    ));
    ui.add_space(10.0);

    if !st.wipe_open {
        if theme::danger_button(ui, "彻底删除仓库").clicked() {
            *intent = SettingsIntent::OpenWipe;
        }
    } else {
        ui.label(
            egui::RichText::new(
                "将删除 vault.dat、全部备份（vault.dat.bak.1–5）、恢复留档与临时文件，无法恢复。输入「删除」确认。",
            )
            .size(11.5)
            .color(p.danger),
        );
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.add_sized(
                [160.0, 30.0],
                egui::TextEdit::singleline(&mut st.wipe_confirm_text).hint_text("删除"),
            );
            let ok = st.wipe_confirm_text.trim() == "删除";
            if ui.add_enabled(ok, egui::Button::new("确认删除")).clicked() {
                *intent = SettingsIntent::Wipe;
            }
            if theme::ghost_button(ui, "取消").clicked() {
                *intent = SettingsIntent::CancelWipe;
            }
        });
    }
}
