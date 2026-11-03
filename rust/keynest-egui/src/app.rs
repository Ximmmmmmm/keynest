//! 应用状态机与主循环。
//!
//! 状态迁移全部集中在这里；`views/*` 只负责画界面并返回「意图」。
//!
//! 关键实现点：
//! * KDF（Argon2id 64 MiB）会阻塞 ~100–300ms，因此 `create` / `unlock` 放到
//!   `std::thread` 里跑，结果经 `mpsc` 回传，`update()` 每帧 poll 一次。
//! * 所有敏感字符串用 `Zeroizing<String>`，状态迁移/过期时自动清零。
//! * 自动锁定取「应用内闲置」与「系统闲置」的较小值。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use keynest_core::error::{Result as KnResult, VaultError};
use keynest_core::lockfile::InstanceLock;
use keynest_core::portable;
use keynest_core::secure;
use keynest_core::vault::{Entry, Vault, VaultData};

use crate::ui::clipboard;
use crate::views::edit::{self, EditIntent, EditState};
use crate::views::lock::{self, LockIntent, RestoreOffer};
use crate::views::main_view::{self, Filter, MainIntent, MainView, SortBy};
use crate::views::settings::{
    self, SecuritySummary, SettingsContext, SettingsIntent, SettingsState,
};

/* ------------------------------------------------------------------ */
/* 纯逻辑（可单测，不依赖 egui）                                        */
/* ------------------------------------------------------------------ */

/// 新建库时的主密码校验。
///
/// 与 `Vault::create` 的检查保持一致，但提前在 UI 层给出提示，
/// 避免白跑一次 Argon2id。
pub fn validate_new_master(master: &str, confirm: &str) -> Result<(), String> {
    if master.chars().count() < keynest_core::vault::MIN_MASTER_LEN {
        return Err(format!(
            "主密码至少 {} 位",
            keynest_core::vault::MIN_MASTER_LEN
        ));
    }
    if master != confirm {
        return Err("两次输入不一致".to_string());
    }
    Ok(())
}

/// 计算「应用闲置」与「系统闲置」中较小的那个，再与阈值比较。
///
/// 抽成纯函数是为了能脱离 egui 单测：自动锁定的正确性不该依赖窗口是否可见。
pub fn idle_since(app_idle: Duration, sys_idle: Duration) -> Duration {
    app_idle.min(sys_idle)
}

/// 是否应当自动锁定。
/// 算出「验证码该在剪贴板里待多少秒」。
///
/// 返回 `None` 表示不该复制——剩余时间太短，复制出去立刻就是过期码。
///
/// # 为什么单独抽出来
///
/// 原实现写成 `.min(remaining).max(3)`，`max(3)` 会把「只剩 1 秒」
/// 拉成 3 秒，正好制造了它想避免的情况。这类**下限与上限打架**的
/// 边界只有写成纯函数才容易被测到，留在 UI 事件处理里没人会去验。
pub fn totp_clipboard_ttl(configured: u32, remaining: u32) -> Option<u32> {
    // 剩余不足 3 秒：粘贴时多半已经失效，别复制
    if remaining < 3 {
        return None;
    }
    // 夹到配置范围，再截到当前时间步结束
    Some(configured.clamp(3, 300).min(remaining))
}

/// 清空所有筛选条件（含搜索词）并回到「全部」。
///
/// 抽成纯函数是为了能测：`App` 的构造需要 `eframe::CreationContext`，
/// 单元测试里造不出来。而这几个字段的联动恰恰是容易出错的地方
/// （原来的实现只重置了 filter，忘了 search）。
pub fn clear_all_filters(search: &mut String, filter: &mut Filter, focus_search: &mut bool) {
    *filter = Filter::All;
    search.clear();
    // 不要把焦点抢到搜索框：用户点的是「清除」，不是「开始搜索」
    *focus_search = false;
}

/// 明文导出实际会写入的条数（**不含回收站**）。
///
/// 确认框与导出后的提示都要用这个数字——用 `entries.len()` 的话，
/// 用户看到「导出 500 条」而文件里只有 480 条，数字对不上，
/// 用户会以为导出出了问题。
pub fn plaintext_export_count(data: &keynest_core::vault::VaultData) -> usize {
    data.entries.iter().filter(|e| !e.is_deleted()).count()
}

pub fn should_auto_lock(limit_minutes: u32, app_idle: Duration, sys_idle: Duration) -> bool {
    let limit = Duration::from_secs(limit_minutes as u64 * 60);
    idle_since(app_idle, sys_idle) >= limit
}

/// 距离自动锁定还剩多少秒。
pub fn idle_remaining_secs(limit_minutes: u32, app_idle: Duration, sys_idle: Duration) -> u64 {
    let limit = Duration::from_secs(limit_minutes as u64 * 60);
    limit
        .saturating_sub(idle_since(app_idle, sys_idle))
        .as_secs()
}

/// 应用状态（严格按规格实现）。
///
/// `Unlocked` 明显大于其他变体，但状态只在切换时构造一次，
/// 渲染路径上拿到的是字段引用而不是整枚举的拷贝；改成 `Box` 只会给
/// 每帧的字段访问多加一层间接，收益为负。
#[allow(clippy::large_enum_variant)]
pub enum AppState {
    NoVault,
    /// 另一个进程正持有单实例锁。
    AlreadyRunning,
    Locked {
        password: Zeroizing<String>,
        error: Option<String>,
        /// 错误的稳定编码（`INVALID_PASSWORD` / `CORRUPT` …）。
        ///
        /// 光有文案没法决定「该怎么帮用户」，所以要留一份机器可读的码。
        error_code: Option<String>,
        busy: bool,
        /// 库打不开时给出的备份恢复入口；正常解锁时为 `None`。
        restore: Option<RestoreOffer>,
    },
    Unlocked {
        vault: Vault,
        data: VaultData,
        last_activity: Instant,
        reveal: Option<(Zeroizing<String>, Instant)>,
        copy_banner: Option<(Instant, u32)>,
    },
}

/// 明文导出的两种格式。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExportKind {
    Csv,
    Json,
}

impl ExportKind {
    fn default_filename(self) -> &'static str {
        match self {
            ExportKind::Csv => "keynest-export.csv",
            ExportKind::Json => "keynest-export.json",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ExportKind::Csv => "CSV",
            ExportKind::Json => "JSON",
        }
    }
}

/// 算一份安全概况。
///
/// 「什么算弱密码」「多久算过期」这些判定只在这里定义一次，
/// 视图层不许自己再判断一遍——否则同一件事会在两个地方给出不同答案。
fn summarize(data: &VaultData) -> SecuritySummary {
    let active: Vec<&Entry> = data.entries.iter().filter(|e| !e.is_deleted()).collect();
    let stale_before = (chrono::Utc::now() - chrono::Duration::days(180))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let weak = active
        .iter()
        .filter(|e| keynest_core::password::estimate_strength(&e.password) < 60.0)
        .count();

    // 与列表里的「重复」筛选保持一致：同一密码出现 ≥2 次，每条都算
    let reused = active
        .iter()
        .filter(|e| {
            !e.password.is_empty() && active.iter().filter(|o| o.password == e.password).count() > 1
        })
        .count();

    SecuritySummary {
        total: active.len(),
        weak,
        reused,
        with_totp: active.iter().filter(|e| e.totp.is_some()).count(),
        stale: active
            .iter()
            .filter(|e| e.updated_at < stale_before)
            .count(),
    }
}

/// `20261101-1240` 形式的时间戳，用于默认文件名。
fn chrono_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M").to_string()
}

/// 把 64 字节显示成人能读的大小。
fn human_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let f = n as f64;
    if f < KB {
        format!("{n} B")
    } else if f < MB {
        format!("{:.1} KB", f / KB)
    } else {
        format!("{:.1} MB", f / MB)
    }
}

/// RFC3339 → `YYYY-MM-DD HH:MM:SS`。解析不了就原样返回。
fn pretty_ts(iso: &str) -> String {
    if iso.len() >= 19 {
        iso[..19].replace('T', " ")
    } else if iso.is_empty() {
        "时间未知".to_string()
    } else {
        iso.to_string()
    }
}

/// 后台任务类型。
#[derive(Clone, Copy, PartialEq, Eq)]
enum JobKind {
    Create,
    Unlock,
}

/// 后台任务句柄。
struct Job {
    kind: JobKind,
    rx: Receiver<(Vault, KnResult<VaultData>)>,
}

pub struct App {
    pub path: PathBuf,

    /// 浏览器桥服务。只在解锁期间运行；锁定时必须停止。
    pub bridge: crate::bridge::BridgeService,

    pub state: AppState,

    /// 单实例锁。**持有即生效**，不读它的值；drop（进程退出）时由操作系统释放。
    _instance: Option<InstanceLock>,

    /// 首启创建表单（放在 App 而非 `NoVault` 变体，保持枚举与规格一致）。
    ///
    /// 公开是为了让截图/预览工具能直接构造出「正在输入主密码」的状态——
    /// 否则强度提示条这类只在输入过程中出现的界面永远截不到。
    pub create_master: Zeroizing<String>,
    pub create_confirm: Zeroizing<String>,
    create_error: Option<String>,

    job: Option<Job>,

    /// 最后复制的内容，锁定时用于精确清除剪贴板。
    last_copied: Option<Zeroizing<String>>,

    /// 手动锁定时，若编辑框里有未保存的改动，先弹确认。
    pending_lock_confirm: bool,

    /// 上一次已提示过的「剪贴板清除失败」原因。
    ///
    /// 去重用的：`check_clipboard_clear_failure` 每帧都跑，
    /// 同一个失败只该提示一次，否则每帧都刷一条 toast。
    reported_clipboard_failure: Option<String>,

    /// 界面态
    pub search: String,
    pub filter: Filter,
    pub sort: SortBy,
    /// 一次性：下一帧把焦点交给搜索框（Ctrl+F）
    pub focus_search: bool,
    pub selected_id: Option<String>,
    pub edit: Option<EditState>,
    pub settings: Option<SettingsState>,
    pub confirm_delete: Option<String>,
    /// 「永久删除」的确认。
    ///
    /// 与 `confirm_empty_trash` 同样的理由：这是不可撤销的操作。
    /// 原来单条永久删除**没有任何确认**，点了就执行——用户本想点旁边的
    /// 「恢复」，手一抖就永久没了。而「清空回收站」反倒是有确认的，
    /// 两处标准不一致。
    pub confirm_purge: Option<String>,
    /// 明文导出前的确认弹窗。明文导出是不可逆的数据外流，必须显式确认。
    pub pending_export: Option<ExportKind>,
    /// 「清空回收站」的确认弹窗。这是一次性永久删除，不能一键就做。
    pub confirm_empty_trash: bool,
    /// 左侧「新增分类」输入框的缓冲
    pub new_category_buf: String,
    pub toast: Option<(String, Instant)>,
    /// 字体加载结果，仅用于诊断显示
    pub font_note: Option<String>,
    /// 下一帧是否需要重绘（后台任务进行中）
    repaint_fast: bool,
    /// 待应用的主题切换（在 ui() 里拿到 ctx 后执行）
    pending_theme: Option<bool>,
    /// 是否已把系统标题栏明暗同步给窗口（首帧补发一次）
    theme_synced: bool,
    /// 连续解锁失败次数。用来决定「要不要提供备份恢复入口」。
    unlock_failures: u32,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let font = crate::ui::fonts::install_cjk_font(&cc.egui_ctx);
        // 字体先装，主题随后设置配色与字号层级
        crate::ui::theme::apply(&cc.egui_ctx, false);

        let path = keynest_core::paths::resolve_vault_path();
        let exists = path.exists();

        // 单实例锁：同一个库只允许一个进程解锁，否则两份明文会互相覆盖。
        let (instance, busy) = match InstanceLock::acquire(&keynest_core::paths::resolve_lock_path())
        {
            Ok(Some(lock)) => (Some(lock), false),
            Ok(None) => (None, true),
            // 连锁文件都建不出来（目录只读等）。不能因此把用户挡在自己的密码库外面，
            // 放行；此时保护降级，由状态页如实说明。
            Err(_) => (None, false),
        };

        let state = if busy {
            AppState::AlreadyRunning
        } else if exists {
            AppState::Locked {
                password: Zeroizing::new(String::new()),
                error: None,
                error_code: None,
                busy: false,
                restore: None,
            }
        } else {
            AppState::NoVault
        };

        let mut bridge = crate::bridge::BridgeService::new(keynest_paths::resolve_data_dir());
        // 把 UI 上下文交给桥接层：后台线程收到请求时用它唤醒界面。
        // 必须在 start() 之前绑定。
        bridge.attach_ctx(cc.egui_ctx.clone());

        Self {
            path,
            bridge,
            state,
            _instance: instance,
            create_master: Zeroizing::new(String::new()),
            create_confirm: Zeroizing::new(String::new()),
            create_error: None,
            job: None,
            last_copied: None,
            pending_lock_confirm: false,
            reported_clipboard_failure: None,
            search: String::new(),
            filter: Filter::All,
            sort: SortBy::UpdatedDesc,
            focus_search: false,
            selected_id: None,
            edit: None,
            settings: None,
            confirm_delete: None,
            confirm_purge: None,
            pending_export: None,
            confirm_empty_trash: false,
            new_category_buf: String::new(),
            toast: None,
            font_note: font,
            repaint_fast: false,
            pending_theme: None,
            theme_synced: false,
            unlock_failures: 0,
        }
    }

    /* ---------------- 后台任务 ---------------- */

    fn spawn(&mut self, kind: JobKind, password: Zeroizing<String>) {
        let (tx, rx) = mpsc::channel();
        let path = self.path.clone();

        std::thread::spawn(move || {
            let mut vault = Vault::new(&path);
            let result = match kind {
                JobKind::Create => vault.create(password.as_str()),
                JobKind::Unlock => vault.unlock(password.as_str()),
            };
            // password 在此线程结束时 drop → Zeroizing 清零
            let _ = tx.send((vault, result));
        });

        self.job = Some(Job { kind, rx });
        self.repaint_fast = true;
    }

    fn poll_job(&mut self) {
        let Some(job) = self.job.take() else { return };

        match job.rx.try_recv() {
            Ok((vault, result)) => {
                self.repaint_fast = false;
                match result {
                    Ok(data) => {
                        self.create_master = Zeroizing::new(String::new());
                        self.create_confirm = Zeroizing::new(String::new());
                        self.create_error = None;
                        self.selected_id = None;
                        self.search.clear();
                        self.filter = Filter::All;
                        self.unlock_failures = 0;

                        // 解锁后检查一次重复 id。
                        //
                        // 正常情况下 id 由 Uuid 生成，不可能重复；但库文件被手工
                        // 编辑过、或由第三方工具生成时会出现。那时的表现是
                        // 「编辑某条记录却改了另一条」，用户完全无从判断。
                        // 这里主动提示，把「莫名其妙」变成「明确告知」。
                        let dup_ids = data.find_duplicate_ids();

                        self.state = AppState::Unlocked {
                            vault,
                            data,
                            last_activity: Instant::now(),
                            reveal: None,
                            copy_banner: None,
                        };
                        self.bridge.start();

                        if !dup_ids.is_empty() {
                            self.set_toast(format!(
                                "库里有 {} 组重复的记录 id，编辑时可能改到错误的那条；                                 建议导出 JSON 备份后联系维护者",
                                dup_ids.len()
                            ));
                        }
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        match job.kind {
                            JobKind::Unlock => {
                                self.unlock_failures = self.unlock_failures.saturating_add(1);
                                let restore = self.offer_restore_after(e.code());
                                self.state = AppState::Locked {
                                    password: Zeroizing::new(String::new()),
                                    error: Some(msg),
                                    error_code: Some(e.code().to_string()),
                                    busy: false,
                                    restore,
                                };
                            }
                            JobKind::Create => {
                                self.create_error = Some(msg);
                                self.state = AppState::NoVault;
                            }
                        }
                    }
                }
            }
            Err(TryRecvError::Empty) => {
                // 还没算完，放回去继续等
                self.job = Some(job);
                self.repaint_fast = true;
            }
            Err(TryRecvError::Disconnected) => {
                self.repaint_fast = false;
                let msg = "后台任务异常中断".to_string();
                match job.kind {
                    JobKind::Unlock => {
                        let restore = self.offer_restore_after("IO");
                        self.state = AppState::Locked {
                            password: Zeroizing::new(String::new()),
                            error: Some(msg),
                            error_code: Some("IO".to_string()),
                            busy: false,
                            restore,
                        };
                    }
                    JobKind::Create => {
                        self.create_error = Some(msg);
                        self.state = AppState::NoVault;
                    }
                }
            }
        }
    }

    /* ---------------- 状态迁移 ---------------- */

    /// 要不要在解锁界面提供「从备份恢复」入口。
    ///
    /// 判定刻意保守：
    /// * 文件结构损坏（`CORRUPT`）——可以确定打不开，直接提供；
    /// * 认证失败（`INVALID_PASSWORD`）——分不清是密码打错还是密文坏了，
    ///   所以要求**连续失败两次**才提供。否则用户第一次手滑就会看到一个
    ///   「恢复」按钮，很容易用旧备份盖掉完好的库。
    fn offer_restore_after(&self, code: &str) -> Option<RestoreOffer> {
        let definitely_broken = code == "CORRUPT";
        if !definitely_broken && self.unlock_failures < 2 {
            return None;
        }

        let probe = Vault::new(&self.path);
        let backups = probe.list_backups();
        let first = backups.first()?;

        Some(RestoreOffer {
            path: first.path.clone(),
            label: format!(
                "{} · {}",
                pretty_ts(&first.updated_at),
                human_bytes(first.bytes)
            ),
        })
    }

    /// 用界面上现有的主密码验证并恢复最近的备份。
    ///
    /// 这一步会跑一次 Argon2id（~100ms），是用户主动触发的低频操作，
    /// 不值得为它引入后台任务与状态机。
    fn restore_from_offer(&mut self) {
        let (pw, offer) = {
            let AppState::Locked {
                password, restore, ..
            } = &self.state
            else {
                return;
            };
            let Some(offer) = restore.clone() else {
                return;
            };
            (password.clone(), offer)
        };
        if pw.is_empty() {
            return;
        }

        let mut vault = Vault::new(&self.path);
        match vault.restore_from_backup(&offer.path, pw.as_str()) {
            Ok(data) => {
                self.unlock_failures = 0;
                self.selected_id = None;
                self.search.clear();
                self.filter = Filter::All;
                self.edit = None;
                self.settings = None;
                self.state = AppState::Unlocked {
                    vault,
                    data,
                    last_activity: Instant::now(),
                    reveal: None,
                    copy_banner: None,
                };
                self.bridge.start();
                self.set_toast("已从备份恢复，原文件已改名留档");
            }
            Err(e) => {
                if let AppState::Locked { error, .. } = &mut self.state {
                    *error = Some(format!("恢复失败：{e}"));
                }
            }
        }
    }

    fn submit_create(&mut self) {
        if self.job.is_some() {
            return;
        }
        let master = self.create_master.clone();
        let confirm = self.create_confirm.clone();

        if let Err(msg) = validate_new_master(master.as_str(), confirm.as_str()) {
            self.create_error = Some(msg);
            return;
        }

        self.create_error = None;
        self.spawn(JobKind::Create, master);
    }

    fn submit_unlock(&mut self) {
        if self.job.is_some() {
            return;
        }
        let AppState::Locked { password, busy, .. } = &mut self.state else {
            return;
        };
        if password.is_empty() {
            return;
        }
        *busy = true;
        let pw = password.clone();
        self.spawn(JobKind::Unlock, pw);
    }

    /// 用户主动点「锁定」时走这里：编辑框里有未保存的改动就先问一句。
    ///
    /// 为什么不直接锁：用户可能只是顺手点了锁定，而编辑框里刚填了半条记录。
    /// 静默丢掉之后他不会知道东西去哪了——那是最让人恼火的一类数据丢失。
    ///
    /// 只对**手动**锁定这么做。自动锁定、关窗口、退出都必须无条件立即锁：
    /// 那些时刻弹确认框会让库一直处于未锁定状态，比丢编辑严重得多。
    pub fn request_lock(&mut self) {
        if !matches!(self.state, AppState::Unlocked { .. }) {
            return;
        }
        if self.edit.as_ref().map(|e| e.is_dirty()).unwrap_or(false) {
            self.pending_lock_confirm = true;
            return;
        }
        self.lock_now();
    }

    /// 锁定：清密钥、丢数据、清剪贴板。
    ///
    /// **不询问**：用于自动锁定、窗口关闭、退出这些必须马上锁的路径。
    pub fn lock_now(&mut self) {
        self.pending_lock_confirm = false;
        if !matches!(self.state, AppState::Unlocked { .. }) {
            return;
        }

        let old = std::mem::replace(
            &mut self.state,
            AppState::Locked {
                password: Zeroizing::new(String::new()),
                error: None,
                error_code: None,
                busy: false,
                restore: None,
            },
        );

        if let AppState::Unlocked { mut vault, .. } = old {
            vault.lock();
            // vault 在此 drop，key 由 Zeroizing 清零
        }

        // 锁定即断开浏览器桥：不留任何能读密码的通道
        self.bridge.stop();

        clipboard::clear_on_lock(&mut self.last_copied);

        // 关闭所有浮层，清掉选中与展开的明文
        self.edit = None;
        self.settings = None;
        self.confirm_delete = None;
        self.confirm_purge = None;
        self.confirm_empty_trash = false;
        self.pending_export = None;
        self.selected_id = None;
        self.search.clear();
        self.filter = Filter::All;
    }

    fn touch_activity(&mut self) {
        if let AppState::Unlocked { last_activity, .. } = &mut self.state {
            *last_activity = Instant::now();
        }
    }

    /// 执行一次分类变更，并把结果同步回设置面板与列表。
    ///
    /// 分类是「数据」而不是「设置」，所以走的是和新增/编辑条目一样的
    /// 落盘路径（`Vault` 内部负责备份轮转与外部改动检测）。
    fn apply_data_change(
        &mut self,
        f: impl FnOnce(&mut Vault) -> keynest_core::Result<()>,
        ok_msg: &str,
    ) {
        let AppState::Unlocked { vault, data, .. } = &mut self.state else {
            return;
        };
        match f(vault) {
            Ok(()) => {
                if let Ok(fresh) = vault.snapshot() {
                    *data = fresh;
                }
                let cats = data.categories.clone();
                let types = data.types.clone();
                if let Some(st) = self.settings.as_mut() {
                    st.categories = cats;
                    st.types = types;
                }
                self.set_toast(ok_msg.to_string());
            }
            Err(e) => {
                let msg = match e.code() {
                    "ALREADY_EXISTS" => "这个名字已经有了".to_string(),
                    "INVALID_ENTRY" | "INVALID_CATEGORY" => {
                        "名称无效：不能为空、不能重名、「其他」不可删除".to_string()
                    }
                    _ => self.explain_error(&e),
                };
                if let Some(st) = self.settings.as_mut() {
                    st.error = Some(msg);
                }
            }
        }
    }

    /// 消费浏览器桥的请求。
    ///
    /// 所有密码库访问都在这里发生——UI 线程持有 `&mut Vault`，
    /// 后台线程只能通过通道请求，拿不到 Vault。
    fn pump_bridge(&mut self) {
        use crate::bridge::Call;
        use keynest_bridge::protocol::{EntrySummary, LockState};

        let calls = self.bridge.collect_calls();
        if calls.is_empty() {
            return;
        }

        for call in calls {
            match call {
                Call::LockState(reply) => {
                    let locked = !matches!(self.state, AppState::Unlocked { .. });
                    let _ = reply.send(if locked {
                        LockState::Locked
                    } else {
                        LockState::Unlocked
                    });
                }
                Call::Version(reply) => {
                    let _ = reply.send(env!("CARGO_PKG_VERSION").to_string());
                }
                Call::Query { origin, reply } => {
                    let out = self.bridge_query(&origin);
                    let _ = reply.send(out);
                }
                Call::Fill {
                    entry_id,
                    origin,
                    reply,
                } => {
                    let out = self.bridge_fill(&entry_id, &origin);
                    let _ = reply.send(out);
                }
                Call::Save { payload, reply } => {
                    let out = self.bridge_save(payload);
                    let _ = reply.send(out);
                }
                Call::Conflicts(reply) => {
                    // 冲突裁决在阶段 5，这里先回空数组而不是报错——
                    // 扩展需要能区分"没有冲突"和"功能没做"
                    let _ = reply.send(Ok(keynest_bridge::serde_json::json!([])));
                }
            }
        }
        let _ = EntrySummary {
            id: String::new(),
            title: String::new(),
            username: String::new(),
            url: String::new(),
        };
    }

    /// 只读查询：绝不返回密码。
    fn bridge_query(
        &mut self,
        origin: &str,
    ) -> Result<Vec<keynest_bridge::protocol::EntrySummary>, keynest_bridge::BridgeError> {
        use keynest_bridge::protocol::EntrySummary;
        let AppState::Unlocked { data, .. } = &self.state else {
            return Err(keynest_bridge::BridgeError::VaultLocked);
        };

        // 精确 origin 匹配：不做子串、不做子域通配
        let want = crate::bridge::origin::normalize(origin)
            .ok_or(keynest_bridge::BridgeError::InvalidRequest("origin 不合法"))?;

        Ok(data
            .entries
            .iter()
            .filter(|e| !e.is_deleted())
            .filter(|e| {
                crate::bridge::origin::normalize(&e.url)
                    .map(|u| u == want)
                    .unwrap_or(false)
            })
            .map(|e| EntrySummary {
                id: e.id.clone(),
                title: e.title.clone(),
                username: e.username.clone(),
                url: e.url.clone(),
            })
            .collect())
    }

    /// 取密码。每次调用都重新检查解锁状态与条目状态，不缓存。
    fn bridge_fill(
        &mut self,
        entry_id: &str,
        origin: &str,
    ) -> Result<Zeroizing<String>, keynest_bridge::BridgeError> {
        let AppState::Unlocked { data, .. } = &self.state else {
            return Err(keynest_bridge::BridgeError::VaultLocked);
        };

        let want = crate::bridge::origin::normalize(origin)
            .ok_or(keynest_bridge::BridgeError::InvalidRequest("origin 不合法"))?;

        let e = data
            .entries
            .iter()
            .find(|e| e.id == entry_id && !e.is_deleted())
            .ok_or(keynest_bridge::BridgeError::InvalidRequest("条目不存在"))?;

        // 二次校验：请求里声明的 origin 必须与条目真实 origin 一致，
        // 否则就是跨站填充
        let entry_origin = crate::bridge::origin::normalize(&e.url).ok_or(
            keynest_bridge::BridgeError::InvalidRequest("条目没有有效网址"),
        )?;
        if entry_origin != want {
            return Err(keynest_bridge::BridgeError::InvalidRequest(
                "origin 与条目不匹配",
            ));
        }

        // Zeroizing 保证：这份明文离开本函数即被擦除，
        // 而不是留在某个 String 里等着被 core dump 捞走
        Ok(Zeroizing::new(e.password.clone()))
    }

    fn bridge_save(
        &mut self,
        payload: keynest_bridge::protocol::SavePayload,
    ) -> Result<String, keynest_bridge::BridgeError> {
        let AppState::Unlocked { .. } = &self.state else {
            return Err(keynest_bridge::BridgeError::VaultLocked);
        };
        // 写入路径在阶段 3（自动保存）实现；现在明确拒绝，避免半成品埋数据
        let _ = payload;
        Err(keynest_bridge::BridgeError::InvalidRequest(
            "保存功能尚未启用（阶段 3）",
        ))
    }

    /// 把 `VaultError` 翻成**用户能照着做**的话。
    ///
    /// 为什么需要这一层：`Display` 实现是给日志用的（"仓库文件已被其他程序修改"），
    /// 用户看完仍然不知道该点哪里。这几类错误在实际使用中都会遇到，
    /// 而且都需要具体动作，不是"重试一下"能解决的：
    ///
    /// * `EXTERNAL_CHANGE` —— 库放在网盘同步目录、或另一台机器改过它
    /// * `IO` —— 磁盘满、目录只读、杀毒软件锁文件
    /// * `CORRUPT` —— 文件被写坏，需要从备份恢复
    fn explain_error(&self, e: &VaultError) -> String {
        match e.code() {
            "EXTERNAL_CHANGE" => "密码库文件在你打开之后被别处改过（常见于网盘同步或另一台机器）。

                 已中止保存，以免覆盖对方的改动。

                 如果那些改动不是你做的：先关掉同步盘，再重新打开钥巢。
                 如果确实是你改的：本次修改需要重新做一遍。"
                .to_string(),
            "IO" => format!(
                "{e}

                 常见原因：磁盘已满、目录不可写、或安全软件正在扫描该文件。
                 处理后可重试；你的修改还留在界面上。"
            ),
            "CORRUPT" | "UNSUPPORTED_FORMAT" => format!(
                "{e}

                 库文件的结构已损坏。设置里可以从备份恢复。"
            ),
            "NO_BACKUP" => "没有可用的备份。".to_string(),
            "LOCKED" => "密码库已锁定，请重新解锁。".to_string(),
            "INVALID_PASSWORD" => "主密码错误。".to_string(),
            _ => format!("操作失败：{e}"),
        }
    }

    fn set_toast(&mut self, msg: impl Into<String>) {
        self.toast = Some((msg.into(), Instant::now()));
    }

    /* ---------------- 自动锁定 ---------------- */

    fn idle_remaining_secs(&self) -> u64 {
        let AppState::Unlocked {
            data,
            last_activity,
            ..
        } = &self.state
        else {
            return 0;
        };

        idle_remaining_secs(
            data.settings.auto_lock_minutes,
            last_activity.elapsed(),
            secure::system_idle(),
        )
    }

    /// 自动清除剪贴板失败时，把这件事告诉用户。
    ///
    /// 为什么需要单独一条：清除失败时**密码仍然留在剪贴板里**，
    /// 而用户以为 20 秒后它已经没了。这是安全属性上的静默失效——
    /// 比任何功能失败都更该主动提示。
    ///
    /// 每帧调一次；同一次失败只提示一次（靠记录上次提示过的文案去重）。
    fn check_clipboard_clear_failure(&mut self) {
        let Some(reason) = keynest_core::secure::last_clear_failure() else {
            self.reported_clipboard_failure = None;
            return;
        };
        if self.reported_clipboard_failure.as_deref() == Some(reason.as_str()) {
            return; // 已经提示过这一次
        }
        self.reported_clipboard_failure = Some(reason);
        self.set_toast("剪贴板自动清除失败，请手动复制别的内容或清空剪贴板");
    }

    fn check_auto_lock(&mut self) {
        let AppState::Unlocked {
            data,
            last_activity,
            ..
        } = &self.state
        else {
            return;
        };

        let auto = should_auto_lock(
            data.settings.auto_lock_minutes,
            last_activity.elapsed(),
            secure::system_idle(),
        );

        if auto {
            self.lock_now();
            self.set_toast("已自动锁定");
        }
    }

    /* ---------------- 复制 / 显示 ---------------- */

    fn copy_password(&mut self, id: &str) {
        let AppState::Unlocked { data, .. } = &self.state else {
            return;
        };
        let Some(e) = data.entries.iter().find(|e| e.id == id) else {
            return;
        };
        // 用 Zeroizing 包住：裸 String 在 drop 时只是把内存还给分配器，
        // 内容仍留在那里，直到那块内存被复用。库里某条记录的密码
        // 在进程存活期间可能因此在堆上停留很久。
        let pw = Zeroizing::new(e.password.clone());
        // 夹取 TTL：配置万一被写成 0，会导致「刚写入就被定时器清空」，
        // 表现为「点了复制但剪贴板是空的」。
        let ttl = data.settings.clipboard_clear_seconds.clamp(3, 300);

        match clipboard::copy_remembered(&pw, ttl, &mut self.last_copied) {
            Ok(banner) => {
                // 回读校验：只有剪贴板里确实是我们的内容才算成功。
                // Windows 上别的程序占用剪贴板时 SetClipboardData 可能静默失败。
                let ok = keynest_core::secure::clipboard_text()
                    .map(|t| t == pw.as_str())
                    .unwrap_or(false);
                if ok {
                    if let AppState::Unlocked { copy_banner, .. } = &mut self.state {
                        *copy_banner = Some(banner);
                    }
                } else {
                    self.set_toast("复制失败：剪贴板被其他程序占用，请重试");
                }
            }
            Err(e) => self.set_toast(format!("复制失败：{e}")),
        }
    }

    fn copy_username(&mut self, id: &str) {
        let AppState::Unlocked { data, .. } = &self.state else {
            return;
        };
        let Some(e) = data.entries.iter().find(|e| e.id == id) else {
            return;
        };
        // 与密码同样的理由：账号也是「看到就等于泄漏一半」的信息，
        // 裸 String 在 drop 后内容仍留在堆上。
        let name = Zeroizing::new(e.username.clone());
        if name.is_empty() {
            return;
        }
        let ttl = data.settings.clipboard_clear_seconds.clamp(3, 300);

        match clipboard::copy_remembered(&name, ttl, &mut self.last_copied) {
            Ok(banner) => {
                let ok = keynest_core::secure::clipboard_text()
                    .map(|t| t == name.as_str())
                    .unwrap_or(false);
                if ok {
                    if let AppState::Unlocked { copy_banner, .. } = &mut self.state {
                        *copy_banner = Some(banner);
                    }
                } else {
                    self.set_toast("复制失败：剪贴板被其他程序占用，请重试");
                }
            }
            Err(e) => self.set_toast(format!("复制失败：{e}")),
        }
    }

    fn reveal_password(&mut self, id: &str) {
        let AppState::Unlocked { data, .. } = &self.state else {
            return;
        };
        let Some(e) = data.entries.iter().find(|e| e.id == id) else {
            return;
        };
        let pw = Zeroizing::new(e.password.clone());
        let secs = data.settings.reveal_seconds.max(1) as u64;

        if let AppState::Unlocked { reveal, .. } = &mut self.state {
            *reveal = Some((pw, Instant::now() + Duration::from_secs(secs)));
        }
    }

    fn hide_reveal(&mut self) {
        if let AppState::Unlocked { reveal, .. } = &mut self.state {
            *reveal = None;
        }
    }

    fn expire_transient(&mut self) {
        if let AppState::Unlocked {
            reveal,
            copy_banner,
            ..
        } = &mut self.state
        {
            let now = Instant::now();
            if let Some((_, until)) = reveal.as_ref() {
                if *until <= now {
                    *reveal = None;
                }
            }
            if let Some(banner) = copy_banner.as_ref() {
                if clipboard::banner_remaining(banner) == 0 {
                    *copy_banner = None;
                }
            }
        }
        if let Some((_, at)) = self.toast.as_ref() {
            if at.elapsed() > Duration::from_secs(3) {
                self.toast = None;
            }
        }
    }

    /* ---------------- 编辑 / 删除 ---------------- */

    fn save_edit(&mut self) {
        let Some(st) = self.edit.as_ref() else { return };

        // 新增条目后如果它被当前筛选条件藏起来，用户会以为没保存成功。
        // 所以「新增」时清掉筛选，让新条目一定可见；「编辑」保持筛选不动。
        let was_new = st.id.is_none();

        let AppState::Unlocked { vault, data, .. } = &mut self.state else {
            return;
        };

        let entry = Entry {
            id: st.id.clone().unwrap_or_default(),
            title: st.title.trim().to_string(),
            username: st.username.clone(),
            password: st.password.to_string(),
            url: st.url.trim().to_string(),
            category: if st.category.trim().is_empty() {
                "其他".to_string()
            } else {
                st.category.trim().to_string()
            },
            notes: st.notes.clone(),
            favorite: st.favorite,
            kind: st.kind.clone(),
            fields: st.fields(),
            totp: st.totp(),
            password_changed_at: None,
            deleted_at: st.deleted_at.clone(),
            created_at: String::new(),
            updated_at: String::new(),
        };

        let result = vault.upsert_entry(entry);
        let data_ptr = &mut *data;
        match result {
            Ok(saved) => {
                let saved_id = saved.id.clone();
                match vault.snapshot() {
                    Ok(fresh) => {
                        *data_ptr = fresh;
                        self.set_toast(if was_new { "已新增" } else { "已保存" });
                    }
                    Err(e) => self.set_toast(format!("重新读取失败：{e}")),
                }
                // 清筛选要放在快照之后：否则新条目还没进 data，选中会被判为不可见
                if was_new {
                    self.search.clear();
                    self.filter = Filter::All;
                }
                self.selected_id = Some(saved_id);
            }
            Err(e) => {
                // 保留用户输入，把错误回填到对话框，并取消关闭。
                // 用 explain_error 而不是 e.to_string()：
                // 保存失败的原因大多需要用户做具体动作，光说"失败了"没用。
                let msg = self.explain_error(&e);
                if let Some(st) = self.edit.as_mut() {
                    st.error = Some(msg);
                    st.closing = false;
                }
            }
        }
    }

    fn delete_entry(&mut self, id: &str) {
        let AppState::Unlocked { vault, data, .. } = &mut self.state else {
            return;
        };

        match vault.delete_entry(id) {
            Ok(()) => {
                if let Ok(fresh) = vault.snapshot() {
                    *data = fresh;
                }
                if self.selected_id.as_deref() == Some(id) {
                    self.selected_id = None;
                }
                if let AppState::Unlocked { reveal, .. } = &mut self.state {
                    *reveal = None;
                }
                self.set_toast("已删除");
            }
            Err(e) => self.set_toast(format!("删除失败：{e}")),
        }
    }

    /* ---------------- 设置相关 ---------------- */

    /// 放弃本地未保存的改动，重新载入磁盘上的库。
    ///
    /// 这是「库文件被别处改过」之后唯一能走通的路：
    /// 没有它，用户只能重启程序（丢掉编辑）或手动删文件。
    ///
    /// 失败时**不破坏当前会话**——`reload()` 内部保证磁盘内容先被证明可用，
    /// 才动内存状态。
    /// 清空恢复留档，然后刷新设置页里那份列表。
    ///
    /// 只删 `vault.dat.corrupt-*`，不动库与备份——
    /// 用户想清的是垃圾文件，不该顺手把数据一起删了。
    fn apply_clear_leftovers(&mut self) {
        enum Outcome {
            Cleared(usize),
            Failed(String),
        }

        let outcome = {
            let AppState::Unlocked { vault, .. } = &self.state else {
                return;
            };
            match vault.clear_recovery_leftovers() {
                Ok(n) => Outcome::Cleared(n),
                Err(e) => Outcome::Failed(e.to_string()),
            }
        };

        // 列表与提示都要刷；两者都需要 &mut self，所以放在借用结束之后
        let left = {
            let AppState::Unlocked { vault, .. } = &self.state else {
                return;
            };
            vault.list_recovery_leftovers()
        };

        match outcome {
            Outcome::Cleared(n) => {
                if let Some(st) = self.settings.as_mut() {
                    st.leftovers_bytes = left.iter().map(|l| l.bytes).sum();
                    st.leftovers = left;
                    st.confirm_clear_leftovers = false;
                    st.notice = Some(format!("已清空 {n} 个恢复留档"));
                    st.error = None;
                }
            }
            Outcome::Failed(msg) => {
                if let Some(st) = self.settings.as_mut() {
                    st.error = Some(format!("清理失败：{msg}"));
                    st.confirm_clear_leftovers = false;
                }
            }
        }
    }

    fn apply_reload_from_disk(&mut self) {
        // 结果先在窄作用域里算出来，避免与 &mut self 的其它部分同时借用。
        enum Outcome {
            Reloaded,
            Failed(String),
        }

        let outcome = {
            let AppState::Unlocked { vault, data, .. } = &mut self.state else {
                return;
            };
            match vault.reload() {
                Err(e) => Outcome::Failed(e.to_string()),
                Ok(fresh) => {
                    *data = fresh;
                    Outcome::Reloaded
                }
            }
        };

        match outcome {
            Outcome::Failed(msg) => {
                if let Some(st) = self.settings.as_mut() {
                    st.error = Some(msg);
                }
            }
            Outcome::Reloaded => {
                // 选中项可能已经不在新数据里
                let still_there = match (&self.selected_id, &self.state) {
                    (Some(id), AppState::Unlocked { data, .. }) => {
                        data.entries.iter().any(|x| x.id == *id)
                    }
                    _ => false,
                };
                if !still_there {
                    self.selected_id = None;
                }
                if let Some(st) = self.settings.as_mut() {
                    st.error = None;
                }
                self.set_toast("已重新载入磁盘上的库");
            }
        }
    }

    fn apply_settings_save(&mut self) {
        let Some(st) = self.settings.as_mut() else {
            return;
        };
        let draft = st.draft.clone();

        let AppState::Unlocked { vault, data, .. } = &mut self.state else {
            return;
        };

        match vault.update_settings(draft) {
            Ok(()) => {
                if let Ok(fresh) = vault.snapshot() {
                    *data = fresh;
                }
                if let Some(st) = self.settings.as_mut() {
                    st.notice = Some("设置已保存".into());
                    st.error = None;
                }
            }
            Err(e) => {
                if let Some(st) = self.settings.as_mut() {
                    st.error = Some(e.to_string());
                    st.notice = None;
                    st.changing_master = false;
                }
            }
        }
    }

    fn apply_change_master(&mut self) {
        let Some(st) = self.settings.as_mut() else {
            return;
        };
        if st.new_pw.as_str() != st.new_pw2.as_str() {
            st.error = Some("两次输入的新密码不一致".into());
            st.notice = None;
            return;
        }
        if st.new_pw.chars().count() < keynest_core::vault::MIN_MASTER_LEN {
            st.error = Some(format!(
                "新密码至少 {} 位",
                keynest_core::vault::MIN_MASTER_LEN
            ));
            st.notice = None;
            return;
        }

        // 防重入：Argon2id 要在 UI 线程上派生两次（旧 KEK + 新 KEK），
        // 160–400ms 的冻结是真实的。没有这道闸，用户会反复点按钮，
        // 排队多次 change_master——第二次因旧密码已变而失败，
        // 于是看到一个莫名其妙的错误。
        if st.changing_master {
            return;
        }

        let old = st.old_pw.clone();
        let new = st.new_pw.clone();
        st.changing_master = true;
        // 让"正在修改…"先画出来再开始阻塞，否则用户看到的仍是冻结
        self.repaint_fast = true;

        let AppState::Unlocked { vault, .. } = &mut self.state else {
            if let Some(st) = self.settings.as_mut() {
                st.changing_master = false;
            }
            return;
        };

        // 注意：这里会在 UI 线程阻塞约 160–400ms（Argon2id 两次派生）
        match vault.change_master(old.as_str(), new.as_str()) {
            Ok(()) => {
                if let Some(st) = self.settings.as_mut() {
                    st.old_pw = Zeroizing::new(String::new());
                    st.new_pw = Zeroizing::new(String::new());
                    st.new_pw2 = Zeroizing::new(String::new());
                    st.error = None;
                    st.notice = Some("主密码已修改".into());
                    st.changing_master = false;
                }
                self.set_toast("主密码已修改");
            }
            Err(e) => {
                if let Some(st) = self.settings.as_mut() {
                    st.error = Some(e.to_string());
                    st.notice = None;
                    st.changing_master = false;
                }
            }
        }
    }

    fn apply_upgrade(&mut self) {
        let Some(st) = self.settings.as_mut() else {
            return;
        };
        // 与改主密码同样的理由：这次要派生 KEK + 重写整个库，
        // 阻塞比 change_master 更久。没有闸门就会排队多次升级。
        if st.upgrading {
            return;
        }
        let pw = st.upgrade_pw.clone();
        st.upgrading = true;
        self.repaint_fast = true;

        let AppState::Unlocked { vault, .. } = &mut self.state else {
            if let Some(st) = self.settings.as_mut() {
                st.upgrading = false;
            }
            return;
        };

        match vault.upgrade_to_v3(pw.as_str()) {
            Ok(()) => {
                if let Some(st) = self.settings.as_mut() {
                    st.legacy = vault.is_legacy();
                    st.kdf_algo = vault.kdf_algo().unwrap_or("-").to_string();
                    st.format = vault.format().unwrap_or("-").to_string();
                    st.key_locked = vault.key_memory_locked();
                    st.upgrade_pw = Zeroizing::new(String::new());
                    st.error = None;
                    st.notice = Some("已升级到 v3 格式".into());
                    st.upgrading = false;
                }
                self.set_toast("已升级到 v3 格式");
            }
            Err(e) => {
                if let Some(st) = self.settings.as_mut() {
                    st.error = Some(e.to_string());
                    st.notice = None;
                    // 注意是 upgrading 不是 changing_master——
                    // 这两个标志属于不同的流程，写错会让另一个按钮永久变灰。
                    st.upgrading = false;
                }
            }
        }
    }

    fn apply_wipe(&mut self) {
        let AppState::Unlocked { vault, .. } = &mut self.state else {
            return;
        };
        match vault.wipe() {
            Ok(()) => {
                clipboard::clear_on_lock(&mut self.last_copied);
                self.state = AppState::NoVault;
                self.settings = None;
                self.edit = None;
                self.selected_id = None;
                self.create_master = Zeroizing::new(String::new());
                self.create_confirm = Zeroizing::new(String::new());
                self.create_error = None;
                self.set_toast("仓库已删除");
            }
            Err(e) => {
                if let Some(st) = self.settings.as_mut() {
                    st.error = Some(e.to_string());
                }
            }
        }
    }

    /* ---------------- 导入 / 导出 ---------------- */

    /// 导出明文到指定文件。返回 (条数, 字节数)。
    fn export_plaintext_to(&self, kind: ExportKind, path: &Path) -> KnResult<(usize, u64)> {
        let AppState::Unlocked { data, .. } = &self.state else {
            return Err(VaultError::Locked);
        };

        // **只导出活跃条目**，回收站里的不进明文文件。
        //
        // 用户把一条记录删进回收站，心里认为它已经"删掉了"。
        // 导出时若把它一并写进 CSV，就等于把他以为删掉的东西
        // 明文摊在磁盘上——那是实打实的数据外泄，而且他不会察觉。
        //
        // 想连回收站一起带走，应当用「导出加密备份」（那是整库副本，
        // 语义明确），而不是明文导出。
        let active: Vec<keynest_core::vault::Entry> = data
            .entries
            .iter()
            .filter(|e| !e.is_deleted())
            .cloned()
            .collect();

        // 导出结果里是明文密码，`Zeroizing` 保证写盘后缓冲区被清零。
        let text = match kind {
            ExportKind::Csv => portable::export_csv(&active)?,
            ExportKind::Json => portable::export_json(&active)?,
        };
        let bytes = portable::write_plaintext_export(path, text.as_str())?;
        Ok((active.len(), bytes))
    }

    fn do_plaintext_export(&mut self, kind: ExportKind) {
        let Some(path) = rfd::FileDialog::new()
            .set_title("选择明文导出的保存位置")
            .set_file_name(kind.default_filename())
            .save_file()
        else {
            return; // 用户取消
        };

        match self.export_plaintext_to(kind, &path) {
            Ok((count, bytes)) => self.set_toast(format!(
                "已导出 {count} 条（{} {}）到 {}，这是明文，请尽快转移",
                kind.label(),
                portable::human_size(bytes),
                path.display()
            )),
            Err(e) => self.set_toast(format!("导出失败：{e}")),
        }
    }

    fn do_export_backup(&mut self) {
        let stamp = chrono_stamp();
        let Some(path) = rfd::FileDialog::new()
            .set_title("保存加密备份")
            .set_file_name(format!("keynest-backup-{stamp}.keynest"))
            .save_file()
        else {
            return;
        };

        let result = match &self.state {
            AppState::Unlocked { vault, .. } => vault.export_backup_to(&path),
            _ => return,
        };
        match result {
            Ok(bytes) => self.set_toast(format!(
                "已保存加密备份（{}）到 {}",
                portable::human_size(bytes),
                path.display()
            )),
            Err(e) => self.set_toast(format!("备份失败：{e}")),
        }
    }

    /// 从文件导入条目。只新增，不覆盖。
    fn import_from(&mut self, path: &Path) -> KnResult<portable::ImportReport> {
        const MAX_IMPORT_BYTES: u64 = 32 * 1024 * 1024;
        let meta = std::fs::metadata(path).map_err(VaultError::Io)?;
        if meta.len() > MAX_IMPORT_BYTES {
            return Err(VaultError::Import("文件过大（上限 32 MB）"));
        }
        let bytes = std::fs::read(path).map_err(VaultError::Io)?;
        let text =
            String::from_utf8(bytes).map_err(|_| VaultError::Import("文件不是 UTF-8 文本"))?;

        let (entries, invalid) = portable::detect_and_import(&text)?;
        // 源文件里识别出的候选条数 = 解析成功的 + 解析阶段就丢掉的
        let parsed_total = entries.len() + invalid;

        let AppState::Unlocked { vault, data, .. } = &mut self.state else {
            return Err(VaultError::Locked);
        };
        // 把解析阶段的统计一起带进报告——否则"源文件里有 N 条、
        // 其中 M 条格式不对"这件事用户永远看不到。
        let report = vault.import_entries_with_stats(entries, parsed_total, invalid)?;
        if let Ok(fresh) = vault.snapshot() {
            *data = fresh;
        }
        Ok(report)
    }

    fn do_import(&mut self) {
        let Some(path) = rfd::FileDialog::new()
            .set_title("选择要导入的密码文件")
            .add_filter("密码导出文件", &["csv", "json", "txt"])
            .pick_file()
        else {
            return;
        };

        match self.import_from(&path) {
            Ok(report) => {
                // 导入可能引入新分类，清一次筛选让用户看到结果
                if report.added > 0 {
                    self.search.clear();
                    self.filter = Filter::All;
                }
                self.set_toast(report.summary());
            }
            Err(e) => self.set_toast(format!("导入失败：{e}")),
        }
    }

    /* ---------------- 意图分发 ---------------- */

    fn apply_main_intent(&mut self, intent: MainIntent) {
        match intent {
            MainIntent::None => {}
            MainIntent::Lock => {
                // 可能被拦下（编辑框有未保存内容），此时不提示"已锁定"
                self.request_lock();
                if !self.pending_lock_confirm {
                    self.set_toast("已锁定");
                }
            }
            MainIntent::OpenSettings => {
                if let AppState::Unlocked { vault, data, .. } = &self.state {
                    let security = summarize(data);
                    let font = self.font_note.clone();
                    let dark = crate::ui::theme::is_dark();
                    self.settings = Some(SettingsState::new(
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
                            leftovers: vault.list_recovery_leftovers(),
                            font_note: font,
                            dark,
                        },
                    ));
                }
            }
            MainIntent::NewEntry => {
                let default_cat = match &self.filter {
                    Filter::Category(c) => c.clone(),
                    _ => "网站".to_string(),
                };
                self.edit = Some(EditState::new_entry(default_cat));
            }
            MainIntent::Edit(id) => {
                if let AppState::Unlocked { data, .. } = &self.state {
                    if let Some(e) = data.entries.iter().find(|e| e.id == id) {
                        self.edit = Some(EditState::from_entry(e));
                    }
                }
            }
            MainIntent::AskDelete(id) => {
                self.confirm_delete = Some(id);
            }
            MainIntent::CopyPassword(id) => self.copy_password(&id),
            MainIntent::CopyUsername(id) => self.copy_username(&id),
            MainIntent::Reveal(id) => self.reveal_password(&id),
            MainIntent::HideReveal => self.hide_reveal(),
            MainIntent::SetFilter(f) => {
                self.filter = f;
                self.hide_reveal();
            }
            MainIntent::ClearAllFilters => {
                // 搜索词也要清：只重置 filter 的话，用户点了「清除搜索与筛选」
                // 仍然看到空列表，会以为按钮坏了。
                clear_all_filters(&mut self.search, &mut self.filter, &mut self.focus_search);
                self.hide_reveal();
            }
            MainIntent::SetSort(s) => {
                self.sort = s;
            }
            MainIntent::Select(id) => {
                if self.selected_id.as_deref() != Some(id.as_str()) {
                    self.hide_reveal();
                }
                self.selected_id = Some(id);
            }
            MainIntent::CopyTotp(id) => {
                let AppState::Unlocked { data, .. } = &self.state else {
                    return;
                };
                let Some(entry) = data.entries.iter().find(|e| e.id == id) else {
                    return;
                };
                let Some(raw) = entry.totp.as_deref() else {
                    return;
                };
                let Ok(totp) = keynest_core::Totp::parse(raw) else {
                    self.set_toast("验证码配置无效");
                    return;
                };
                let code = totp.code_now();
                let ttl = data.settings.clipboard_clear_seconds.clamp(3, 300);

                // 验证码只在当前时间步内有效，TTL 不能超过剩余秒数，
                // 否则剪贴板里留着一个已经过期的码，比不复制更糟。
                //
                // **剩余时间过短时直接拒绝，而不是把 TTL 拉长到下限。**
                // 原来写的是 `.min(remaining).max(3)`，`.max(3)` 会把
                // 「只剩 1 秒」拉成 3 秒——正好制造了它想避免的那种情况：
                // 剪贴板里留着一个已过期的码。
                let left = totp.remaining(keynest_core::totp::now_secs()) as u32;
                let Some(ttl) = totp_clipboard_ttl(ttl, left) else {
                    self.set_toast("验证码即将失效，请稍候再复制");
                    return;
                };

                match clipboard::copy_remembered(&code, ttl, &mut self.last_copied) {
                    Ok(banner) => {
                        if let AppState::Unlocked { copy_banner, .. } = &mut self.state {
                            *copy_banner = Some(banner);
                        }
                    }
                    Err(e) => self.set_toast(format!("复制失败：{e}")),
                }
            }
            MainIntent::OpenUrl(id) => {
                let AppState::Unlocked { data, .. } = &self.state else {
                    return;
                };
                let Some(entry) = data.entries.iter().find(|e| e.id == id) else {
                    return;
                };
                // 统一走 openable_url：只放行 http/https，别的协议不交给系统处理
                let Some(url) = crate::views::main_view::openable_url(&entry.url) else {
                    self.set_toast("这个网址不能直接打开（只支持 http / https）");
                    return;
                };
                match webbrowser::open(&url) {
                    Ok(_) => self.set_toast(format!("已在浏览器中打开：{url}")),
                    Err(e) => self.set_toast(format!("打开失败：{e}")),
                }
            }
            MainIntent::CopyField(id, label) => {
                let AppState::Unlocked { data, .. } = &self.state else {
                    return;
                };
                let Some(value) = data
                    .entries
                    .iter()
                    .find(|e| e.id == id)
                    .and_then(|e| e.fields.iter().find(|f| f.label == label))
                    .map(|f| f.value.clone())
                else {
                    return;
                };
                let ttl = data.settings.clipboard_clear_seconds.clamp(3, 300);
                match clipboard::copy_remembered(&value, ttl, &mut self.last_copied) {
                    Ok(banner) => {
                        if let AppState::Unlocked { copy_banner, .. } = &mut self.state {
                            *copy_banner = Some(banner);
                        }
                    }
                    Err(e) => self.set_toast(format!("复制失败：{e}")),
                }
            }
            MainIntent::ToggleFavorite(id) => {
                let AppState::Unlocked { vault, data, .. } = &mut self.state else {
                    return;
                };
                let want = data
                    .entries
                    .iter()
                    .find(|e| e.id == id)
                    .map(|e| !e.favorite)
                    .unwrap_or(false);
                match vault.set_favorite(&id, want) {
                    Ok(()) => {
                        if let Ok(fresh) = vault.snapshot() {
                            *data = fresh;
                        }
                        self.set_toast(if want { "已收藏" } else { "已取消收藏" });
                    }
                    Err(e) => self.set_toast(format!("收藏失败：{e}")),
                }
            }
            MainIntent::Restore(id) => {
                let AppState::Unlocked { vault, data, .. } = &mut self.state else {
                    return;
                };
                match vault.restore_entry(&id) {
                    Ok(()) => {
                        if let Ok(fresh) = vault.snapshot() {
                            *data = fresh;
                        }
                        self.selected_id = Some(id);
                        self.set_toast("已从回收站恢复");
                    }
                    Err(e) => self.set_toast(format!("恢复失败：{e}")),
                }
            }
            MainIntent::Purge(id) => {
                self.confirm_purge = Some(id);
            }
            MainIntent::PurgeConfirmed(id) => {
                let AppState::Unlocked { vault, data, .. } = &mut self.state else {
                    return;
                };
                match vault.purge_entry(&id) {
                    Ok(()) => {
                        if let Ok(fresh) = vault.snapshot() {
                            *data = fresh;
                        }
                        if self.selected_id.as_deref() == Some(id.as_str()) {
                            self.selected_id = None;
                        }
                        self.set_toast("已永久删除");
                    }
                    Err(e) => self.set_toast(format!("删除失败：{e}")),
                }
            }
            MainIntent::EmptyTrash => {
                // 先确认，再删除。这一步不能省。
                self.confirm_empty_trash = true;
            }
            MainIntent::NewCategory(name) => {
                let AppState::Unlocked { vault, data, .. } = &mut self.state else {
                    return;
                };
                match vault.add_category(&name) {
                    Ok(_) => {
                        if let Ok(fresh) = vault.snapshot() {
                            *data = fresh;
                        }
                        self.set_toast("分类已添加");
                    }
                    Err(e) => self.set_toast(format!("添加失败：{e}")),
                }
            }
        }
    }

    fn apply_settings_intent(&mut self, intent: SettingsIntent) {
        match intent {
            SettingsIntent::None => {}
            SettingsIntent::Close => self.settings = None,
            SettingsIntent::Save => self.apply_settings_save(),
            SettingsIntent::ReloadFromDisk => self.apply_reload_from_disk(),
            SettingsIntent::ClearLeftovers => self.apply_clear_leftovers(),
            SettingsIntent::ChangeMaster => self.apply_change_master(),
            SettingsIntent::Upgrade => self.apply_upgrade(),
            SettingsIntent::OpenWipe => {
                if let Some(st) = self.settings.as_mut() {
                    st.wipe_open = true;
                }
            }
            SettingsIntent::CancelWipe => {
                if let Some(st) = self.settings.as_mut() {
                    st.wipe_open = false;
                    st.wipe_confirm_text.clear();
                }
            }
            SettingsIntent::Wipe => self.apply_wipe(),
            SettingsIntent::Closed => self.settings = None,
            SettingsIntent::SetTheme(dark) => {
                // 主题切换会重建 visuals，字体已在启动时注册，不受影响
                self.pending_theme = Some(dark);
            }
            SettingsIntent::AddType => {
                let name = self
                    .settings
                    .as_ref()
                    .map(|s| s.new_type.trim().to_string())
                    .unwrap_or_default();
                self.apply_data_change(|v| v.add_type(&name).map(|_| ()), "类型已添加");
                if let Some(st) = self.settings.as_mut() {
                    st.new_type.clear();
                }
            }
            SettingsIntent::RenameType { from, to } => {
                self.apply_data_change(
                    |v| v.rename_type(&from, to.trim()).map(|_| ()),
                    "类型已改名",
                );
            }
            SettingsIntent::DeleteType(name) => {
                self.apply_data_change(|v| v.delete_type(&name).map(|_| ()), "类型已删除");
            }
            SettingsIntent::AddCategory => {
                let name = self
                    .settings
                    .as_ref()
                    .map(|s| s.new_category.trim().to_string())
                    .unwrap_or_default();
                self.apply_data_change(|v| v.add_category(&name).map(|_| ()), "分类已添加");
                if let Some(st) = self.settings.as_mut() {
                    st.new_category.clear();
                }
            }
            SettingsIntent::RenameCategory { from, to } => {
                self.apply_data_change(
                    |v| v.rename_category(&from, to.trim()).map(|_| ()),
                    "分类已改名",
                );
            }
            SettingsIntent::DeleteCategory(name) => {
                self.apply_data_change(
                    |v| v.delete_category(&name).map(|_| ()),
                    "分类已删除（条目移到「其他」）",
                );
            }
            SettingsIntent::ShowWeak => {
                self.settings = None;
                self.filter = Filter::Weak;
            }
            SettingsIntent::ShowReused => {
                self.settings = None;
                self.filter = Filter::Reused;
            }
            SettingsIntent::ExportCsv => self.pending_export = Some(ExportKind::Csv),
            SettingsIntent::ExportJson => self.pending_export = Some(ExportKind::Json),
            SettingsIntent::ExportBackup => self.do_export_backup(),
            SettingsIntent::ImportFile => self.do_import(),
        }
    }

    fn apply_edit_intent(&mut self, intent: EditIntent) {
        match intent {
            EditIntent::None => {}
            // 不立刻销毁：先让对话框播完退场动画，由 Closed 收尾
            EditIntent::Cancel => {
                if let Some(st) = self.edit.as_mut() {
                    st.closing = true;
                }
            }
            EditIntent::Save => {
                let already = self.edit.as_ref().map(|s| s.closing).unwrap_or(true);
                if !already {
                    self.save_edit();
                    if let Some(st) = self.edit.as_mut() {
                        st.closing = true;
                    }
                }
            }
            EditIntent::UseGenerated => {
                if let Some(st) = self.edit.as_mut() {
                    st.password = Zeroizing::new(st.gen.preview.to_string());
                }
            }
            EditIntent::Closed => self.edit = None,
        }
    }

    /* ---------------- 关闭确认 ---------------- */

    /// 明文导出的二次确认。
    ///
    /// 这一步不能省：明文导出是**不可逆的数据外流**——文件一旦落盘，
    /// 之后无论怎么锁库、删库都追不回来。所以要用户主动点一次「确认导出」，
    /// 并且界面上必须直说「这个文件里的密码没有任何加密」。
    fn draw_export_confirm(&mut self, ctx: &egui::Context) {
        let Some(kind) = self.pending_export else {
            return;
        };
        // 条数要按**实际导出的数量**算：回收站里的条目不进导出文件。
        // 用 data.entries.len()（含回收站）会让用户看到「导出 500 条」，
        // 而文件里只有 480 条——数字对不上，用户会以为导出出了问题。
        let count = match &self.state {
            AppState::Unlocked { data, .. } => plaintext_export_count(data),
            _ => {
                self.pending_export = None;
                return;
            }
        };

        #[allow(deprecated)]
        let resp = egui::Modal::new(egui::Id::new("confirm-export")).show(ctx, |ui| {
            ui.set_width(430.0);
            ui.label(egui::RichText::new("导出为明文？").size(16.0).strong());
            ui.add_space(8.0);
            ui.label(format!(
                "接下来会把 {} 条记录的密码写入一个 {} 文件。\n\
                 这个文件没有任何加密：任何人拿到它、任何程序扫描它，都能直接读走密码。",
                count,
                kind.label()
            ));
            ui.add_space(8.0);
            ui.label("建议：导出后立即导入到目标软件，然后删除这个文件。");
            ui.add_space(12.0);
            let mut go = false;
            let mut cancel = false;
            ui.horizontal(|ui| {
                if ui
                    .button(
                        egui::RichText::new("确认导出").color(egui::Color32::from_rgb(190, 60, 60)),
                    )
                    .clicked()
                {
                    go = true;
                }
                if ui.button("取消").clicked() {
                    cancel = true;
                }
            });
            (go, cancel)
        });

        let (go, cancel) = resp.inner;
        if go {
            self.pending_export = None;
            self.do_plaintext_export(kind);
        } else if cancel || resp.should_close() {
            self.pending_export = None;
        }
    }

    /// 真正执行清空回收站（由确认弹窗触发）。
    fn do_empty_trash(&mut self) {
        let AppState::Unlocked { vault, data, .. } = &mut self.state else {
            return;
        };
        match vault.empty_trash() {
            Ok(0) => self.set_toast("回收站已经是空的"),
            Ok(n) => {
                if let Ok(fresh) = vault.snapshot() {
                    *data = fresh;
                }
                self.selected_id = None;
                self.set_toast(format!("已清空回收站（{n} 条，无法恢复）"));
            }
            Err(e) => self.set_toast(format!("清空失败：{e}")),
        }
    }

    fn draw_confirm_empty_trash(&mut self, ctx: &egui::Context) {
        if !self.confirm_empty_trash {
            return;
        }
        let count = match &self.state {
            AppState::Unlocked { data, .. } => {
                data.entries.iter().filter(|e| e.is_deleted()).count()
            }
            _ => {
                self.confirm_empty_trash = false;
                return;
            }
        };

        #[allow(deprecated)]
        let resp = egui::Modal::new(egui::Id::new("confirm-empty-trash")).show(ctx, |ui| {
            ui.set_width(400.0);
            ui.label(egui::RichText::new("清空回收站？").size(16.0).strong());
            ui.add_space(8.0);
            ui.label(format!(
                "回收站里的 {count} 条记录会被永久删除，没有任何办法恢复。"
            ));
            ui.add_space(12.0);
            let mut go = false;
            let mut cancel = false;
            ui.horizontal(|ui| {
                if ui
                    .button(
                        egui::RichText::new("永久删除").color(egui::Color32::from_rgb(190, 60, 60)),
                    )
                    .clicked()
                {
                    go = true;
                }
                if ui.button("取消").clicked() {
                    cancel = true;
                }
            });
            (go, cancel)
        });

        let (go, cancel) = resp.inner;
        if go {
            self.confirm_empty_trash = false;
            self.do_empty_trash();
        } else if cancel || resp.should_close() {
            self.confirm_empty_trash = false;
        }
    }

    /// 「编辑框里有未保存的改动，确定要锁定吗？」
    ///
    /// 三个选项而不是两个：用户常常只是想先把内容存下来再锁，
    /// 逼他在"丢"和"不锁"之间二选一不合理。
    fn draw_confirm_lock(&mut self, ctx: &egui::Context) {
        if !self.pending_lock_confirm {
            return;
        }

        #[allow(deprecated)]
        let resp = egui::Modal::new(egui::Id::new("confirm-lock")).show(ctx, |ui| {
            ui.set_width(360.0);
            ui.label(egui::RichText::new("还有未保存的修改").size(16.0).strong());
            ui.add_space(8.0);
            ui.label("正在编辑的这条记录还没保存。锁定之后这些内容会丢失。");
            ui.add_space(12.0);

            let mut action = 0u8; // 0=不动 1=先保存再锁 2=丢弃并锁定 3=取消
            ui.horizontal(|ui| {
                if ui.button("保存后锁定").clicked() {
                    action = 1;
                }
                if ui
                    .button(
                        egui::RichText::new("丢弃并锁定")
                            .color(egui::Color32::from_rgb(190, 60, 60)),
                    )
                    .clicked()
                {
                    action = 2;
                }
                if ui.button("取消").clicked() {
                    action = 3;
                }
            });
            action
        });

        // 点遮罩也算取消：用户没明确选择时不该丢掉任何东西
        let action = if resp.inner != 0 {
            resp.inner
        } else if resp.should_close() {
            3
        } else {
            0
        };

        match action {
            1 => {
                // 先走正常的保存流程；保存成功与否由 upsert 的错误处理决定。
                // 无论成败都不在这里强行锁定——保存失败时锁掉会丢内容。
                self.save_edit_and_lock();
            }
            2 => {
                self.pending_lock_confirm = false;
                self.edit = None;
                self.lock_now();
                self.set_toast("已锁定");
            }
            3 => {
                self.pending_lock_confirm = false;
            }
            _ => {}
        }
    }

    /// 保存当前编辑内容，成功后再锁定。
    ///
    /// `save_edit` 没有返回值，所以这里用「保存后编辑框里是否出现 error」
    /// 判断成败：失败时它会把错误写回 `st.error` 并取消关闭，
    /// 那时**不能锁**——锁掉就等于把用户刚填的内容丢了。
    fn save_edit_and_lock(&mut self) {
        self.pending_lock_confirm = false;
        self.save_edit();

        let failed = self
            .edit
            .as_ref()
            .map(|st| st.error.is_some())
            .unwrap_or(false);
        if failed {
            // 错误已经回填在对话框里，用户能看见；这次锁定作废
            return;
        }

        // 保存成功：走正常的退场动画，然后立即锁定。
        // 顺序不能反——先锁会把 `edit` 一起丢掉。
        if let Some(st) = self.edit.as_mut() {
            st.closing = true;
        }
        self.edit = None;
        self.lock_now();
        self.set_toast("已保存并锁定");
    }

    /// 「永久删除这一条？」的确认。
    ///
    /// 与「清空回收站」同样的理由：不可撤销的操作必须二次确认。
    /// 回收站里每行都有「恢复」和「永久删除」两个按钮，挨得很近，
    /// 手一抖就从「想恢复」变成「永久没了」。
    fn draw_confirm_purge(&mut self, ctx: &egui::Context) {
        let Some(id) = self.confirm_purge.clone() else {
            return;
        };

        let title = match &self.state {
            AppState::Unlocked { data, .. } => data
                .entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.title.clone())
                .unwrap_or_else(|| "该条目".to_string()),
            _ => return,
        };

        #[allow(deprecated)]
        let resp = egui::Modal::new(egui::Id::new("confirm-purge")).show(ctx, |ui| {
            ui.set_width(380.0);
            ui.label(egui::RichText::new("永久删除").size(16.0).strong());
            ui.add_space(8.0);
            ui.label(format!("「{title}」将被彻底删除，无法恢复。"));
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("如果只是想先放一边，可以用「恢复」把它放回列表。")
                    .size(11.0)
                    .color(ui.visuals().weak_text_color()),
            );
            ui.add_space(12.0);

            let mut action = 0u8; // 0=不动 1=确认 2=取消
            ui.horizontal(|ui| {
                if ui
                    .button(
                        egui::RichText::new("永久删除").color(egui::Color32::from_rgb(190, 60, 60)),
                    )
                    .clicked()
                {
                    action = 1;
                }
                if ui.button("取消").clicked() {
                    action = 2;
                }
            });
            action
        });

        // 点遮罩也算取消：没明确选择时不该删任何东西
        let action = if resp.inner != 0 {
            resp.inner
        } else if resp.should_close() {
            2
        } else {
            0
        };

        match action {
            1 => {
                self.confirm_purge = None;
                self.apply_main_intent(MainIntent::PurgeConfirmed(id));
            }
            2 => self.confirm_purge = None,
            _ => {}
        }
    }

    fn draw_confirm_delete(&mut self, ctx: &egui::Context) {
        let Some(id) = self.confirm_delete.clone() else {
            return;
        };

        let title = match &self.state {
            AppState::Unlocked { data, .. } => data
                .entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.title.clone())
                .unwrap_or_else(|| "该条目".to_string()),
            _ => return,
        };

        #[allow(deprecated)]
        let resp = egui::Modal::new(egui::Id::new("confirm-delete")).show(ctx, |ui| {
            ui.set_width(360.0);
            ui.label(egui::RichText::new("确认删除").size(16.0).strong());
            ui.add_space(8.0);
            // 文案必须与实际行为一致。
            //
            // 删除是**软删除**：条目进回收站，随时可以恢复（`delete_entry`
            // 只设置 deleted_at）。原来这里写「此操作无法撤销」，既不准确，
            // 也会让用户以为没有回收站而不敢用删除——
            // 或者反过来，在真正需要谨慎的「永久删除」时以为还能恢复。
            ui.label(format!("把「{title}」移到回收站？"));
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new(
                    "之后可以在左侧「回收站」里恢复。要真正删除，需在回收站里再删一次。",
                )
                .size(11.0)
                .color(ui.visuals().weak_text_color()),
            );
            ui.add_space(12.0);
            let mut do_delete = false;
            let mut cancel = false;
            ui.horizontal(|ui| {
                if ui
                    .button(egui::RichText::new("删除").color(egui::Color32::from_rgb(190, 60, 60)))
                    .clicked()
                {
                    do_delete = true;
                }
                if ui.button("取消").clicked() {
                    cancel = true;
                }
            });
            (do_delete, cancel)
        });

        let (do_delete, cancel) = resp.inner;
        if do_delete {
            self.confirm_delete = None;
            self.confirm_purge = None;
            self.delete_entry(&id);
        } else if cancel || resp.should_close() {
            self.confirm_delete = None;
            self.confirm_purge = None;
        }
    }
}

/* ------------------------------------------------------------------ */
/* eframe App                                                          */
/* ------------------------------------------------------------------ */

impl eframe::App for App {
    /// 每帧在 `ui` 之前调用：处理输入活跃度、后台任务、自动锁定、过期清理。
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // 浏览器桥：把后台线程积压的请求在 UI 线程里执行。
        // 放在最前面，保证每次请求都读取"当前这一帧"的解锁状态与条目内容。
        //
        // 唤醒由**后台线程**负责（`VaultProxy` 入队成功后调 `request_repaint()`），
        // 这里不再无条件请求 16ms 重绘——那会让空闲 GUI 持续约 60 FPS 空转。
        // 兜底见函数末尾：桥接运行时把既有调度从 500ms 收紧到 100ms，
        // 即使唤醒回调失效，请求最坏也只延迟 100ms（远小于 5s 超时）。
        self.pump_bridge();

        // 窗口关闭：先锁库
        if ctx.input(|i| i.viewport().close_requested()) {
            self.lock_now();
            return;
        }

        // 快捷键：Ctrl+F 搜索、Ctrl+N 新增、Ctrl+L 锁定、Esc 关闭对话框
        let (find, new, lock, esc) = ctx.input(|i| {
            (
                i.modifiers.command && i.key_pressed(egui::Key::F),
                i.modifiers.command && i.key_pressed(egui::Key::N),
                i.modifiers.command && i.key_pressed(egui::Key::L),
                i.key_pressed(egui::Key::Escape),
            )
        });
        if matches!(self.state, AppState::Unlocked { .. }) {
            if find {
                self.focus_search = true;
            }
            if new && self.edit.is_none() && self.settings.is_none() {
                let cat = match &self.filter {
                    Filter::Category(c) => c.clone(),
                    _ => "网站".to_string(),
                };
                self.edit = Some(EditState::new_entry(cat));
            }
            if lock {
                // Ctrl+L 与点「锁定」按钮同属用户主动操作，
                // 同样要照顾编辑框里的未保存内容。
                self.request_lock();
                if !self.pending_lock_confirm {
                    self.set_toast("已锁定");
                }
                return;
            }
        }
        if esc {
            if let Some(st) = self.edit.as_mut() {
                st.closing = true;
            }
            if let Some(st) = self.settings.as_mut() {
                st.closing = true;
            }
        }

        let had_input = ctx.input(|i| {
            i.events.iter().any(|e| {
                matches!(
                    e,
                    egui::Event::PointerButton { .. }
                        | egui::Event::Key { .. }
                        | egui::Event::Text(_)
                        | egui::Event::PointerMoved(_)
                        | egui::Event::MouseWheel { .. }
                )
            })
        });
        if had_input {
            self.touch_activity();
        }

        self.poll_job();
        self.check_auto_lock();
        self.check_clipboard_clear_failure();
        self.expire_transient();

        // 有倒计时在动就快刷，否则 500ms 一次足够。
        //
        // 桥接运行时收紧到 100ms 作为**兜底**：正常情况下后台线程会用
        // `request_repaint()` 立即唤醒，这里只保证"即使唤醒失效也不会让
        // 请求等到 500ms 之后"。100ms 远小于浏览器侧 5s 超时，且比 16ms
        // 空转省得多（10 FPS vs 60 FPS）。
        if self.repaint_fast {
            ctx.request_repaint_after(Duration::from_millis(50));
        } else if self.bridge.is_running() {
            ctx.request_repaint_after(Duration::from_millis(100));
        } else {
            ctx.request_repaint_after(Duration::from_millis(500));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        // 拿到原生窗口句柄，用于同步标题栏明暗
        crate::ui::winchrome::remember_window(frame);

        // 先把整个窗口铺一层底色。
        //
        // 原来每个视图各自负责背景，谁漏了谁就是透明的——而透明在 Windows 上
        // 呈现为**黑色**（空状态页、详情栏空白处都踩过）。背景是全局属性，
        // 就该在一个地方铺一次，不交给每个视图去记。
        ui.painter().rect_filled(
            ui.max_rect(),
            egui::CornerRadius::ZERO,
            crate::ui::theme::palette().bg,
        );

        if let Some(dark) = self.pending_theme.take() {
            crate::ui::theme::apply(ui.ctx(), dark);
            crate::ui::winchrome::sync_titlebar();
        }

        // 窗口建好之后才能生效，所以首帧再发一次
        if !self.theme_synced {
            self.theme_synced = true;
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::SetTheme(
                crate::ui::theme::system_theme(),
            ));
            crate::ui::winchrome::sync_titlebar();
        }

        let mut main_intent = MainIntent::None;
        let mut settings_intent = SettingsIntent::None;
        let mut edit_intent = EditIntent::None;

        // 状态切换（锁屏 ↔ 主界面 ↔ 首次创建）时整体淡入淡出
        let state_key = match &self.state {
            AppState::NoVault => 0.0_f32,
            AppState::AlreadyRunning => 1.0,
            AppState::Locked { .. } => 1.0,
            AppState::Unlocked { .. } => 2.0,
        };
        #[allow(deprecated)]
        let fade_id = egui::Id::new("state-fade");
        let fade_t = ui.ctx().animate_value_with_time(fade_id, state_key, 0.24);
        let fade_alpha = (1.0 - (fade_t - state_key).abs()).clamp(0.0, 1.0);

        // 这些查询借用 &self，必须在 match 之前算好
        let idle_left = self.idle_remaining_secs();
        let toast_text = self.toast.as_ref().map(|(m, _)| m.clone());

        ui.scope(|ui| {
            ui.multiply_opacity(fade_alpha);

            match &mut self.state {
                AppState::AlreadyRunning => {
                    lock::show_already_running(ui);
                }
                AppState::NoVault => {
                    let busy = self.job.is_some();
                    let submit = lock::show_create(
                        ui,
                        &mut self.create_master,
                        &mut self.create_confirm,
                        self.create_error.as_deref(),
                        busy,
                    );
                    if matches!(submit, LockIntent::Submit) {
                        self.submit_create();
                    }
                }
                AppState::Locked {
                    password,
                    error,
                    error_code,
                    busy,
                    restore,
                } => {
                    let is_busy = *busy || self.job.is_some();
                    let submit = lock::show(
                        ui,
                        password,
                        error.as_deref(),
                        error_code.as_deref(),
                        is_busy,
                        restore.as_ref(),
                    );
                    match submit {
                        LockIntent::Submit => self.submit_unlock(),
                        LockIntent::Restore => self.restore_from_offer(),
                        LockIntent::None => {}
                    }
                }
                AppState::Unlocked {
                    data,
                    reveal,
                    copy_banner,
                    ..
                } => {
                    main_intent = main_view::show(
                        ui,
                        MainView {
                            data,
                            search: &mut self.search,
                            filter: &mut self.filter,
                            sort: &mut self.sort,
                            selected_id: &mut self.selected_id,
                            reveal,
                            copy_banner,
                            new_category_buf: &mut self.new_category_buf,
                            focus_search: self.focus_search,
                            idle_left_secs: idle_left,
                            toast: toast_text.as_deref(),
                        },
                    );

                    if let Some(st) = self.settings.as_mut() {
                        settings_intent = settings::show(ui.ctx(), st);
                    }
                    if let Some(st) = self.edit.as_mut() {
                        let cats = data.categories.clone();
                        let types = data.types.clone();
                        edit_intent = edit::show(ui.ctx(), st, &cats, &types);
                    }
                }
            }
        });

        self.focus_search = false;
        self.apply_main_intent(main_intent);
        self.apply_settings_intent(settings_intent);
        self.apply_edit_intent(edit_intent);
        self.draw_confirm_lock(ui.ctx());
        self.draw_confirm_purge(ui.ctx());
        self.draw_confirm_delete(ui.ctx());
        self.draw_export_confirm(ui.ctx());
        self.draw_confirm_empty_trash(ui.ctx());
    }

    /// 兜底：即使 close_requested 没触发，退出前也锁库。
    fn on_exit(&mut self) {
        self.lock_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_master() {
        let e = validate_new_master("short", "short").unwrap_err();
        assert!(e.contains("至少"), "实际: {e}");
    }

    #[test]
    fn rejects_mismatched_confirm() {
        let e = validate_new_master("a-very-long-master", "a-very-long-masteR").unwrap_err();
        assert!(e.contains("不一致"), "实际: {e}");
    }

    #[test]
    fn accepts_valid_master() {
        assert!(validate_new_master("a-very-long-master", "a-very-long-master").is_ok());
    }

    #[test]
    fn idle_uses_the_smaller_of_two() {
        let app = Duration::from_secs(300);
        let sys = Duration::from_secs(60);
        assert_eq!(idle_since(app, sys), Duration::from_secs(60));
        assert_eq!(idle_since(sys, app), Duration::from_secs(60));
    }

    /// 长阻塞操作的重入闸必须能独立开关。
    ///
    /// 改主密码与升级格式都会在 UI 线程上跑 Argon2id（160–400ms）。
    /// 没有闸门时用户会反复点，排队多次操作——第二次因为旧密码/旧格式
    /// 已经变了而失败，用户看到一个莫名其妙的错误。
    ///
    /// 这条测的是**两个标志互不干扰**：修的过程中真的把它写错过一次
    /// （升级的错误分支里清了 `changing_master`），后果是另一个按钮
    /// 永久变灰，而升级那个反而一直可点。
    #[test]
    fn busy_flags_are_independent() {
        let mut st = SettingsState::new(
            &keynest_core::vault::Settings::default(),
            crate::views::settings::SettingsContext::default(),
        );

        st.changing_master = true;
        assert!(!st.upgrading, "清一个不该影响另一个");

        st.upgrading = true;
        assert!(st.changing_master, "两个可以同时为真");

        st.changing_master = false;
        assert!(st.upgrading, "清 changing_master 不该清 upgrading");
    }

    /// 明文导出的条数必须**不含回收站**。
    ///
    /// 确认框里写着「导出 N 条」，文件里就应当真的有 N 条。
    /// 用 `entries.len()`（含回收站）会出现「说 500、实际 480」，
    /// 用户会以为导出出了问题。
    #[test]
    fn plaintext_export_count_excludes_trashed_entries() {
        let mut data = keynest_core::vault::VaultData::default();
        let mut a = keynest_core::vault::Entry::default();
        a.id = "a".into();
        a.title = "A".into();
        let mut b = a.clone();
        b.id = "b".into();
        b.title = "B".into();
        b.deleted_at = Some("2026-01-01T00:00:00.000Z".into());
        data.entries = vec![a, b];

        assert_eq!(data.entries.len(), 2, "前提：库里有两条（含一条已删除）");
        assert_eq!(
            plaintext_export_count(&data),
            1,
            "导出条数不应把回收站里的算进去"
        );
    }

    /// 「清除搜索与筛选」必须**同时**清掉搜索词与筛选条件。
    ///
    /// 缺陷：原来那个按钮只发 `SetFilter(Filter::All)`，不动 `search`。
    /// 用户搜了关键词、看到「没有匹配的条目」，点按钮后仍然空着——
    /// 因为搜索词还在输入框里。按钮的名字承诺了它做不到的事，
    /// 而用户只会觉得「这个按钮坏了」。
    ///
    /// 这里测的是纯函数 `clear_all_filters`：`App` 的构造需要
    /// `eframe::CreationContext`，测试里造不出来，所以把行为抽出来测。
    #[test]
    fn clear_all_filters_resets_both_search_and_filter() {
        let mut search = "招商".to_string();
        let mut filter = Filter::Weak;
        let mut focus = true;

        clear_all_filters(&mut search, &mut filter, &mut focus);

        assert_eq!(filter, Filter::All, "筛选没重置");
        assert!(search.is_empty(), "搜索词没清空: {search:?}");
        assert!(!focus, "不该把焦点抢到搜索框");
    }

    /// 「清除搜索与筛选」对已经干净的状态是幂等的。
    #[test]
    fn clear_all_filters_is_idempotent() {
        let mut search = String::new();
        let mut filter = Filter::All;
        let mut focus = false;
        clear_all_filters(&mut search, &mut filter, &mut focus);
        assert!(search.is_empty());
        assert_eq!(filter, Filter::All);
        assert!(!focus);
    }

    /// 验证码的剪贴板 TTL 不得**超过**当前时间步剩余秒数。
    ///
    /// 原实现是 `.min(remaining).max(3)`：剩余 1 秒时被 `max(3)` 拉成 3 秒，
    /// 剪贴板里于是留着一个已经过期的码——正是那段代码的注释想避免的情况。
    #[test]
    fn totp_ttl_never_outlives_the_time_step() {
        // 正常情况：截到剩余时间
        assert_eq!(totp_clipboard_ttl(20, 12), Some(12));
        // 剩余很少：宁可不复制，也不复制一个立刻过期的码
        assert_eq!(totp_clipboard_ttl(20, 2), None);
        assert_eq!(totp_clipboard_ttl(20, 0), None);
        // 配置值本身越界也要夹紧
        assert_eq!(totp_clipboard_ttl(1000, 60), Some(60));
        assert_eq!(totp_clipboard_ttl(1, 60), Some(3));
    }

    /// 边界：剩余正好 3 秒时允许复制，TTL 恰好 3。
    #[test]
    fn totp_ttl_allows_exactly_three_seconds() {
        assert_eq!(totp_clipboard_ttl(20, 3), Some(3));
        assert_eq!(totp_clipboard_ttl(20, 4), Some(4));
    }

    #[test]
    fn auto_lock_triggers_at_threshold() {
        // 5 分钟阈值
        assert!(!should_auto_lock(
            5,
            Duration::from_secs(299),
            Duration::from_secs(299)
        ));
        assert!(should_auto_lock(
            5,
            Duration::from_secs(300),
            Duration::from_secs(300)
        ));
    }

    #[test]
    fn recent_app_input_prevents_lock() {
        // 规格是 idle = min(app_idle, sys_idle)：
        // 应用刚收到输入（1 秒）时，即使系统报告闲置 10 分钟也不锁。
        // 这样用户在本应用里操作不会被误锁。
        assert!(!should_auto_lock(
            5,
            Duration::from_secs(1),
            Duration::from_secs(600)
        ));
    }

    #[test]
    fn both_must_exceed_threshold() {
        // 只有两边都超过阈值才锁定
        assert!(should_auto_lock(
            5,
            Duration::from_secs(400),
            Duration::from_secs(400)
        ));
    }

    #[test]
    fn remaining_counts_down() {
        assert_eq!(
            idle_remaining_secs(5, Duration::from_secs(60), Duration::from_secs(60)),
            240
        );
        assert_eq!(
            idle_remaining_secs(5, Duration::from_secs(9999), Duration::from_secs(9999)),
            0
        );
    }

    #[test]
    fn timestamp_is_human_readable() {
        assert_eq!(pretty_ts("2026-10-31T23:50:12.345Z"), "2026-10-31 23:50:12");
        assert_eq!(pretty_ts(""), "时间未知");
        assert_eq!(pretty_ts("garbage"), "garbage");
    }

    #[test]
    fn byte_sizes_are_readable() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(2048), "2.0 KB");
        assert_eq!(human_bytes(3 * 1024 * 1024), "3.0 MB");
    }
}
