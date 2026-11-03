//! 界面截图工具：把关键界面真实渲染一遍并存成 PNG。
//!
//! # 为什么需要它
//!
//! 在此之前，所有界面改动只靠「能编译 + 逻辑单测」验证——那只能证明代码跑得通，
//! 证明不了**排得下、看得清、没被截断**。而这一类问题（长标题压到副标题、
//! 胶囊行溢出、按钮被挤到看不见）恰恰是最常见的回归。
//!
//! 这个程序把 `App` 真正跑起来，逐屏截取，产出 `docs/shots/*.png`。
//! 改了界面就跑一次，用眼睛或者图像差异工具比对。
//!
//! # 它不会碰真实仓库
//!
//! 启动前把 `KEYNEST_DATA_DIR` 指到一个临时目录，并在里面**新建**一个演示库。
//! 你 `%APPDATA%` 里那份真实 `vault.dat` 全程不会被读到，更不会被写。
//!
//! ```text
//! cargo run -p keynest-egui --example shots
//! ```

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use zeroize::Zeroizing;

use keynest_core::vault::{Entry, Vault, VaultData};
use keynest_egui::app::{App, AppState};
use keynest_egui::views::edit::EditState;
use keynest_egui::views::main_view::{Filter, SortBy};
use keynest_egui::views::settings::{SecuritySummary, SettingsContext, SettingsState, Tab};

/// 演示库的主密码。仅用于这个临时库，且临时目录在退出时删除。
const DEMO_MASTER: &str = "demo-master-password-2026";

/// 截图尺寸：与 README 里现有截图的观感保持一致。
const SIZE: [f32; 2] = [1180.0, 760.0];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scene {
    Create,
    Lock,
    Main,
    Favorites,
    Trash,
    Settings,
    SettingsData,
    Reveal,
    Totp,
    Card,
    Appearance,
    Edit,
}

impl Scene {
    fn name(self) -> &'static str {
        match self {
            Scene::Create => "01-create",
            Scene::Lock => "02-lock",
            Scene::Main => "03-main",
            Scene::Favorites => "04-favorites",
            Scene::Trash => "05-trash",
            Scene::Settings => "06-settings",
            Scene::SettingsData => "07-settings-data",
            Scene::Reveal => "08-reveal",
            Scene::Totp => "09-totp",
            Scene::Card => "09b-card",
            Scene::Appearance => "06b-appearance",
            Scene::Edit => "11-edit",
        }
    }
}

const SCENES: [Scene; 12] = [
    Scene::Create,
    Scene::Lock,
    Scene::Main,
    Scene::Favorites,
    Scene::Trash,
    Scene::Settings,
    Scene::SettingsData,
    Scene::Reveal,
    Scene::Totp,
    Scene::Card,
    Scene::Appearance,
    Scene::Edit,
];

/// 演示数据：标题、账号、密码、网址、分类、备注、是否收藏。
const SAMPLES: [(&str, &str, &str, &str, &str, &str, bool); 8] = [
    (
        "GitHub",
        "alice@example.com",
        "ghP@ssw0rd!2026",
        "https://github.com",
        "网站",
        "已开启两步验证",
        true,
    ),
    (
        "腾讯云控制台",
        "admin@example.cn",
        "Tc-2026!Aq7#z",
        "https://console.example.cn",
        "服务器",
        "轻量服务器 2 台",
        false,
    ),
    (
        "QQ 邮箱",
        "demo.user@example.com",
        "mail-Passw0rd!77",
        "https://mail.example.com",
        "邮箱",
        "",
        false,
    ),
    (
        "招商银行",
        "6225 **** **** 8842",
        "882108",
        "https://www.example-bank.com",
        "金融",
        "仅用于查询",
        true,
    ),
    (
        "Figma",
        "design@example.cn",
        "Fg-2026$Design!",
        "https://www.figma.com",
        "应用",
        "团队协作",
        false,
    ),
    (
        "Steam",
        "demo_steam",
        "St3am!#Secret",
        "https://store.example.com",
        "其他",
        "",
        false,
    ),
    (
        "一个非常非常长的标题用来测试会不会溢出压到用户名那一列上",
        "this.is.a.very.long.username@some-very-long-domain.example.com",
        "LongP@ssw0rd!2026",
        "https://example.com",
        "服务器",
        "长内容测试",
        false,
    ),
    (
        "重复密码示例",
        "dup@example.com",
        "ghP@ssw0rd!2026",
        "https://example.com",
        "网站",
        "与 GitHub 使用同一个密码",
        false,
    ),
];

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("shots")
}

fn save_png(path: &Path, img: &egui::ColorImage) {
    let file = match std::fs::File::create(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[!] 无法创建 {}: {e}", path.display());
            return;
        }
    };
    let w = std::io::BufWriter::new(file);
    let mut enc = png::Encoder::new(w, img.width() as u32, img.height() as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = match enc.write_header() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[!] PNG 头写入失败: {e}");
            return;
        }
    };
    let mut data = Vec::with_capacity(img.width() * img.height() * 4);
    for px in &img.pixels {
        data.extend_from_slice(&px.to_array());
    }
    if let Err(e) = writer.write_image_data(&data) {
        eprintln!("[!] PNG 数据写入失败: {e}");
        return;
    }
    println!("[+] {}", path.display());
}

/// 在临时目录里造一个演示库，返回（已解锁的 Vault, 数据）。
fn seed(dir: &Path) -> (Vault, VaultData) {
    let mut v = Vault::new(dir.join("vault.dat"));
    v.create(DEMO_MASTER).expect("创建演示库失败");

    // 一条信用卡示例，验证「类型 + 自定义字段（含隐藏）」的渲染
    {
        let mut card = Entry {
            id: String::new(),
            title: "招商银行信用卡".into(),
            username: String::new(),
            password: String::new(),
            url: String::new(),
            category: "金融".into(),
            notes: "线上支付用".into(),
            favorite: false,
            kind: keynest_core::kinds::CARD.to_string(),
            fields: vec![
                keynest_core::Field {
                    label: "持卡人".into(),
                    value: "ZHANG SAN".into(),
                    secret: false,
                },
                keynest_core::Field {
                    label: "卡号".into(),
                    value: "6225 1234 5678 9012".into(),
                    secret: true,
                },
                keynest_core::Field {
                    label: "有效期".into(),
                    value: "08/29".into(),
                    secret: false,
                },
            ],
            totp: None,
            password_changed_at: None,
            deleted_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        card.created_at = String::new();
        v.upsert_entry(card).expect("写入信用卡示例失败");
    }

    let now = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for (i, (title, user, pw, url, cat, notes, fav)) in SAMPLES.iter().enumerate() {
        let mut e = Entry {
            id: String::new(),
            title: (*title).into(),
            username: (*user).into(),
            password: (*pw).into(),
            url: (*url).into(),
            category: (*cat).into(),
            notes: (*notes).into(),
            favorite: *fav,
            // 给第一条配一个示例 TOTP，好让详情页的动态验证码出现在截图里
            kind: keynest_core::kinds::LOGIN.to_string(),
            fields: Vec::new(),
            totp: if i == 0 {
                Some(
                    "otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
                        .into(),
                )
            } else {
                None
            },
            password_changed_at: None,
            deleted_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        if i == 5 {
            // 让一条进回收站，好截图
            e.deleted_at = Some(now.clone());
        }
        v.upsert_entry(e).expect("写入演示条目失败");
    }

    let data = v.snapshot().expect("读取演示库失败");
    (v, data)
}

/// 每个场景的执行阶段。
///
/// 用显式阶段而不是「数帧」，是因为数帧一旦算错就会**静默产出同一张图**——
/// 第一版就是这么翻车的：7 张截图里 5 张字节完全相同。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    /// 应用场景状态
    Apply,
    /// 等布局/动画稳定（按**时间**等，不按帧数）
    Settle,
    /// 已请求截图，等像素回来
    Waiting,
}

struct Harness {
    app: App,
    /// 演示库。`Vault` 不能克隆，所以只在切到主界面时**取出一次**。
    seed: Option<(Vault, VaultData)>,
    scene: usize,
    stage: Stage,
    /// 场景切换后至少要等到这个时刻才能截图。
    ///
    /// 按时间等而不是按帧数：`App` 的状态切换有 0.24s 淡入，
    /// 按帧数等 3 帧只过了 ~50ms，截出来整屏都是半透明的——第一版就这么翻的。
    settle_until: Instant,
    /// 已发出截图请求，正在等像素回来。
    waiting: Arc<AtomicBool>,
    /// 截图回调已经写到磁盘。
    saved: Arc<AtomicBool>,
    finished: bool,
}

impl Harness {
    fn new(cc: &eframe::CreationContext<'_>, vault: Vault, data: VaultData) -> Self {
        let app = App::new(cc);
        Self {
            app,
            seed: Some((vault, data)),
            scene: 0,
            stage: Stage::Apply,
            settle_until: Instant::now(),
            waiting: Arc::new(AtomicBool::new(false)),
            saved: Arc::new(AtomicBool::new(false)),
            finished: false,
        }
    }

    /// 构造 SettingsState 并打开设置窗口。
    ///
    /// 提取成方法是因为「安全」「数据」「外观」三个场景都要先打开它，
    /// 之前只有 Settings 场景自己写了一遍，导致另外两个场景实际上什么都没截到。
    fn open_settings(&mut self) {
        let AppState::Unlocked { vault, data, .. } = &self.app.state else {
            return;
        };
        let security = SecuritySummary {
            total: data.entries.iter().filter(|e| !e.is_deleted()).count(),
            weak: data
                .entries
                .iter()
                .filter(|e| !e.is_deleted() && e.password.len() < 12)
                .count(),
            reused: 2,
            with_totp: data.entries.iter().filter(|e| e.totp.is_some()).count(),
            stale: 0,
        };
        let st = SettingsState::new(
            &data.settings,
            SettingsContext {
                categories: data.categories.clone(),
                types: data.types.clone(),
                legacy: vault.is_legacy(),
                kdf_algo: vault.kdf_algo().unwrap_or("-").to_string(),
                format: vault.format().unwrap_or("-").to_string(),
                key_locked: vault.key_memory_locked(),
                kdf_ok: vault.kdf_meets_floor(),
                security,
                font_note: None,
                dark: false,
                leftovers: Vec::new(),
                bridge_installed: false,
            },
        );
        self.app.settings = Some(st);
    }

    fn apply(&mut self) {
        let scene = SCENES[self.scene];
        match scene {
            Scene::Create => {
                self.app.state = AppState::NoVault;
                // 填一个偏弱的主密码，好让强度提示条出现在截图里
                self.app.create_master = Zeroizing::new("sunshine2026".to_string());
            }
            Scene::Lock => {
                // 故意带一条错误与错误码，好让「失败后该怎么办」的建议出现在截图里
                self.app.state = AppState::Locked {
                    password: Zeroizing::new(String::new()),
                    error: Some("主密码错误，或仓库文件已损坏".into()),
                    error_code: Some("INVALID_PASSWORD".into()),
                    busy: false,
                    restore: None,
                };
            }
            Scene::Main => {
                // 前两个场景已经把状态换成 NoVault / Locked，这里把演示库装回去
                if let Some((vault, data)) = self.seed.take() {
                    self.app.state = AppState::Unlocked {
                        vault,
                        data,
                        last_activity: Instant::now(),
                        reveal: None,
                        copy_banner: None,
                    };
                }
                self.app.filter = Filter::All;
                self.app.sort = SortBy::UpdatedDesc;
                self.app.settings = None;
                self.app.edit = None;
                self.app.search.clear();
            }
            Scene::Favorites => {
                self.app.filter = Filter::Favorites;
            }
            Scene::Trash => {
                self.app.filter = Filter::Trash;
            }
            Scene::Settings => {
                if let AppState::Unlocked { vault, data, .. } = &self.app.state {
                    self.app.settings = Some(SettingsState::new(
                        &data.settings,
                        SettingsContext {
                            kdf_ok: vault.kdf_meets_floor(),
                            categories: data.categories.clone(),
                            types: data.types.clone(),
                            legacy: vault.is_legacy(),
                            kdf_algo: vault.kdf_algo().unwrap_or("-").to_string(),
                            format: vault.format().unwrap_or("-").to_string(),
                            key_locked: vault.key_memory_locked(),
                            security: SecuritySummary {
                                total: data.entries.iter().filter(|e| !e.is_deleted()).count(),
                                weak: 1,
                                reused: 2,
                                with_totp: data.entries.iter().filter(|e| e.totp.is_some()).count(),
                                stale: 0,
                            },
                            font_note: None,
                            dark: false,
                            leftovers: Vec::new(),
                            bridge_installed: false,
                        },
                    ));
                    if let Some(st) = self.app.settings.as_mut() {
                        st.tab = Tab::Security;
                    }
                }
            }
            Scene::SettingsData => {
                if let AppState::Unlocked { vault, data, .. } = &self.app.state {
                    let mut st = SettingsState::new(
                        &data.settings,
                        SettingsContext {
                            kdf_ok: vault.kdf_meets_floor(),
                            categories: data.categories.clone(),
                            types: data.types.clone(),
                            legacy: vault.is_legacy(),
                            kdf_algo: vault.kdf_algo().unwrap_or("-").to_string(),
                            format: vault.format().unwrap_or("-").to_string(),
                            key_locked: vault.key_memory_locked(),
                            security: SecuritySummary {
                                total: data.entries.iter().filter(|e| !e.is_deleted()).count(),
                                weak: 1,
                                reused: 2,
                                with_totp: data.entries.iter().filter(|e| e.totp.is_some()).count(),
                                stale: 0,
                            },
                            font_note: None,
                            dark: false,
                            leftovers: Vec::new(),
                            bridge_installed: false,
                        },
                    );
                    // 直接切到「数据」分区：验证导入/导出不再需要滚动才能看到
                    st.tab = Tab::Data;
                    self.app.settings = Some(st);
                }
            }
            Scene::Reveal => {
                self.app.settings = None;
                // 回到正常列表，否则会截到「回收站里的密码被明文显示」这种怪画面
                self.app.filter = Filter::All;
                let selected = self.app.selected_id.clone();
                if let AppState::Unlocked { data, reveal, .. } = &mut self.app.state {
                    // 优先展示当前选中的条目，其次第一条未删除的
                    let id = selected.or_else(|| {
                        data.entries
                            .iter()
                            .find(|e| !e.is_deleted())
                            .map(|e| e.id.clone())
                    });
                    if let Some(id) = id {
                        if let Some(e) = data.entries.iter().find(|e| e.id == id) {
                            *reveal = Some((
                                Zeroizing::new(e.password.clone()),
                                Instant::now() + std::time::Duration::from_secs(14),
                            ));
                        }
                        self.app.selected_id = Some(id);
                    }
                }
            }
            Scene::Totp => {
                self.app.settings = None;
                self.app.filter = Filter::All;
                if let AppState::Unlocked { data, reveal, .. } = &mut self.app.state {
                    *reveal = None;
                    if let Some(e) = data.entries.iter().find(|e| e.totp.is_some()) {
                        self.app.selected_id = Some(e.id.clone());
                    }
                }
            }
            Scene::Card => {
                self.app.settings = None;
                self.app.filter = Filter::All;
                if let AppState::Unlocked { data, reveal, .. } = &mut self.app.state {
                    *reveal = None;
                    if let Some(e) = data
                        .entries
                        .iter()
                        .find(|e| e.kind == keynest_core::kinds::CARD)
                    {
                        self.app.selected_id = Some(e.id.clone());
                    }
                }
            }
            Scene::Appearance => {
                self.open_settings();
                if let Some(st) = self.app.settings.as_mut() {
                    st.tab = Tab::Appearance;
                }
            }
            Scene::Edit => {
                self.app.settings = None;
                if let AppState::Unlocked { data, .. } = &self.app.state {
                    let target = data
                        .entries
                        .iter()
                        .find(|e| !e.is_deleted())
                        .map(|e| e.id.clone());
                    if let Some(id) = target {
                        let e = data.entries.iter().find(|e| e.id == id).unwrap();
                        let mut st = EditState::from_entry(e);
                        st.gen.refresh();
                        self.app.edit = Some(st);
                        self.app.selected_id = Some(id);
                    }
                }
            }
        }
    }
}

impl eframe::App for Harness {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // 先让真实界面画完，再决定要不要截图
        self.app.ui(ui, _frame);
        if self.finished {
            return;
        }

        if self.stage == Stage::Apply {
            let name = SCENES[self.scene].name();
            println!("[*] 准备场景 {name}");
            self.apply();
            // 600ms 覆盖 0.42s 的入场动画与 0.24s 的状态淡入
            self.settle_until = Instant::now() + std::time::Duration::from_millis(600);
            self.stage = Stage::Settle;
            ui.ctx().request_repaint();
            return;
        }

        if self.stage == Stage::Settle {
            if Instant::now() < self.settle_until {
                ui.ctx().request_repaint();
                return;
            }

            let path = out_dir().join(format!("{}.png", SCENES[self.scene].name()));
            let saved = self.saved.clone();
            let waiting = self.waiting.clone();
            waiting.store(true, Ordering::SeqCst);
            ui.ctx()
                .request_screenshot(move |img: Arc<egui::ColorImage>| {
                    save_png(&path, &img);
                    saved.store(true, Ordering::SeqCst);
                    waiting.store(false, Ordering::SeqCst);
                });
            self.stage = Stage::Waiting;
            ui.ctx().request_repaint();
            return;
        }

        // Stage::Waiting
        if self.saved.swap(false, Ordering::SeqCst) {
            self.scene += 1;
            if self.scene >= SCENES.len() {
                self.finished = true;
                println!("[*] 全部截图完成：{}", out_dir().display());
                ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                return;
            }
            self.stage = Stage::Apply;
        }
        ui.ctx().request_repaint();
    }
}

fn main() -> eframe::Result<()> {
    // 演示库放到临时目录，绝不碰真实数据
    let data_dir = tempfile::tempdir().expect("临时数据目录");
    std::env::set_var("KEYNEST_DATA_DIR", data_dir.path());

    std::fs::create_dir_all(out_dir()).ok();
    println!("[*] 输出目录：{}", out_dir().display());

    let (vault, data) = seed(data_dir.path());

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size(SIZE)
            .with_min_inner_size([900.0, 600.0])
            .with_title("钥巢 · 截图"),
        ..Default::default()
    };

    eframe::run_native(
        "钥巢 · 截图",
        options,
        Box::new(move |cc| Ok(Box::new(Harness::new(cc, vault, data)))),
    )
}
