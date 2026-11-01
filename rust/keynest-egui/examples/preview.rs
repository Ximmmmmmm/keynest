//! 设计预览：用假数据直接渲染主界面，不需要真实仓库、不需要登录。
//!
//! 这是开发辅助工具，不参与发布产物。
//!   cargo run --example preview -p keynest-egui

use std::time::{Duration, Instant};

use keynest_core::vault::{Entry, VaultData};
use keynest_egui::ui::theme;
use keynest_egui::views::main_view::{self, Filter, MainIntent, MainView, SortBy};

struct Preview {
    data: VaultData,
    search: String,
    filter: Filter,
    sort: SortBy,
    selected: Option<String>,
    reveal: Option<(zeroize::Zeroizing<String>, Instant)>,
    banner: Option<(Instant, u32)>,
    new_cat: String,
    chrome_synced: bool,
}

fn sample() -> VaultData {
    // 注意：下面所有账号与密码都是**虚构样例**，仅用于界面截图，不对应任何真实账户。
    let mut d = VaultData::default();
    let rows = [
        (
            "GitHub",
            "alice@example.com",
            "ghP@ssw0rd!2026",
            "网站",
            "已开启两步验证",
        ),
        (
            "腾讯云控制台",
            "admin@example.com",
            "Tc-2026!Aq7#z",
            "服务器",
            "轻量服务器 2 台",
        ),
        (
            "QQ 邮箱",
            "demo.user@example.com",
            "mail-Passw0rd!77",
            "邮箱",
            "",
        ),
        (
            "招商银行",
            "6225 **** **** 8842",
            "882108",
            "金融",
            "仅用于查询",
        ),
        (
            "Figma",
            "design@example.com",
            "Fg-2026$Design!",
            "应用",
            "团队协作",
        ),
        ("Steam", "demo_steam", "St3am!#Secret", "其他", ""),
        // 超长标题 / 用户名，用来验证列内省略与裁剪
        (
            "一个非常非常长的标题用来测试会不会溢出压到用户名那一列上",
            "this.is.a.very.long.username@some-very-long-domain.example.com",
            "LongP@ssw0rd!2026",
            "服务器",
            "长内容测试",
        ),
    ];
    let now = chrono_stamp();
    for (i, (t, u, p, c, n)) in rows.iter().enumerate() {
        d.entries.push(Entry {
            id: format!("id-{i}"),
            title: (*t).into(),
            username: (*u).into(),
            password: (*p).into(),
            url: "https://example.com".into(),
            category: (*c).into(),
            notes: (*n).into(),
            // 前两条标成收藏，用来检查列表里的星标与「收藏」筛选
            favorite: i < 2,
            kind: keynest_core::kinds::LOGIN.to_string(),
            fields: Vec::new(),
            totp: None,
            password_changed_at: None,
            deleted_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        });
    }
    d
}

fn chrono_stamp() -> String {
    // 避免依赖 chrono：直接给一个固定格式的时间字符串
    "2026-10-31T23:50:12.000Z".to_string()
}

impl eframe::App for Preview {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        keynest_egui::ui::winchrome::remember_window(frame);
        if !self.chrome_synced {
            self.chrome_synced = true;
            keynest_egui::ui::winchrome::sync_titlebar();
        }

        if !self.data.categories.iter().any(|c| c == "服务器") {
            self.data.categories.push("服务器".into());
        }

        let intent = main_view::show(
            ui,
            MainView {
                data: &self.data,
                search: &mut self.search,
                filter: &mut self.filter,
                sort: &mut self.sort,
                selected_id: &mut self.selected,
                reveal: &mut self.reveal,
                copy_banner: &self.banner,
                new_category_buf: &mut self.new_cat,
                focus_search: false,
                idle_left_secs: 287,
                toast: None,
            },
        );

        match intent {
            // 预览程序不碰真实剪贴板，只模拟「已复制」状态用于看界面反馈
            MainIntent::CopyPassword(_) | MainIntent::CopyUsername(_) => {
                self.banner = Some((Instant::now(), 20));
            }
            MainIntent::Select(id) => self.selected = Some(id),
            MainIntent::SetFilter(f) => self.filter = f,
            MainIntent::SetSort(s) => self.sort = s,
            MainIntent::Reveal(id) => {
                if let Some(e) = self.data.entries.iter().find(|e| e.id == id) {
                    self.reveal = Some((
                        zeroize::Zeroizing::new(e.password.clone()),
                        Instant::now() + Duration::from_secs(20),
                    ));
                }
            }
            MainIntent::HideReveal => self.reveal = None,
            _ => {}
        }
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1180.0, 720.0])
            .with_title("钥巢 · 设计预览"),
        ..Default::default()
    };

    eframe::run_native(
        "钥巢 · 设计预览",
        options,
        Box::new(|cc| {
            keynest_egui::ui::fonts::install_cjk_font(&cc.egui_ctx);
            theme::apply(&cc.egui_ctx, false);
            let mut data = sample();
            data.categories.push("服务器".into());
            data.categories
                .push("这是一个特别长的分类名称用来测试侧栏省略".into());
            // 便于截图验证不同筛选状态：PREVIEW_CAT=邮箱
            let cat = std::env::var("PREVIEW_CAT")
                .ok()
                .filter(|v| !v.is_empty())
                .map(Filter::Category)
                .unwrap_or(Filter::All);
            // PREVIEW_SEL=id-6 可指定初始选中项，便于截图检查详情面板
            let sel = std::env::var("PREVIEW_SEL")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "id-1".to_string());
            Ok(Box::new(Preview {
                data,
                search: String::new(),
                filter: cat,
                sort: SortBy::UpdatedDesc,
                selected: Some(sel),
                reveal: None,
                banner: Some((Instant::now(), 18)),
                new_cat: String::new(),
                chrome_synced: false,
            }))
        }),
    )
}
