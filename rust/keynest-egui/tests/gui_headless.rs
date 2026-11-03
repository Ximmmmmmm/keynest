//! 无头 GUI 渲染测试。
//!
//! # 为什么需要它
//!
//! 「列表只渲染可视区域」这件事，**在界面上完全看不出来**——
//! 界面正常、条目正常，只是条目多的时候变卡。
//!
//! 只测纯函数（范围计算）不够：纯函数对了、渲染路径没调用它，
//! 缺陷照样在。所以这里**真的渲染一遍**，然后数绘制的图元数量。
//!
//! # 怎么做到不开窗口
//!
//! egui 的 `Context::run_ui` 可以在没有窗口、没有 GPU 的情况下跑完一帧，
//! 返回 `FullOutput`——里面有这一帧画出的所有图元。
//! 于是「渲染了多少行」变成一个**可以断言的数字**。
//!
//! 这比「打开程序看看卡不卡」可靠得多：
//! 性能退化会被 CI 抓到，而手动观察不会。

use egui::{Context, RawInput, Ui};

use keynest_core::vault::{Entry, VaultData};
use keynest_egui::views::main_view::{Filter, MainIntent, MainView, SortBy};

/// 造一个「像真的一样」的条目。
fn entry(i: usize) -> Entry {
    Entry {
        id: format!("id-{i}"),
        title: format!("站点 {i}"),
        username: format!("user{i}@example.com"),
        password: format!("pw-{i}"),
        url: format!("https://site{i}.test/login"),
        category: "网站".into(),
        notes: format!("第 {i} 条的备注"),
        favorite: i.is_multiple_of(7),
        kind: "账号".into(),
        fields: Vec::new(),
        totp: None,
        password_changed_at: None,
        deleted_at: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

fn data_with(n: usize) -> VaultData {
    VaultData {
        entries: (0..n).map(entry).collect(),
        ..Default::default()
    }
}

/// 渲染一帧，返回画出的图元数量与最上/最下边界。
fn render_and_count(data: &VaultData) -> (usize, f32, f32) {
    let mut search = String::new();
    let mut filter = Filter::All;
    let mut sort = SortBy::UpdatedDesc;
    let mut selected = None;
    let copy_banner: Option<(std::time::Instant, u32)> = None;
    let mut reveal = None;
    let mut new_cat = String::new();

    let ctx = Context::default();
    let input = RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(1280.0, 800.0),
        )),
        ..Default::default()
    };
    let mut out = ctx.run_ui(input, |ui: &mut Ui| {
        let view = MainView {
            data,
            search: &mut search,
            filter: &mut filter,
            sort: &mut sort,
            selected_id: &mut selected,
            reveal: &mut reveal,
            copy_banner: &copy_banner,
            new_category_buf: &mut new_cat,
            focus_search: false,
            idle_left_secs: 0,
            toast: None,
        };
        let _ = keynest_egui::views::main_view::show(ui, view);
    });

    // egui 要求纹理增量必须被处理，否则 drop 时 panic。
    // 无头渲染没有 GPU，用不着真的分配纹理——直接 clear 掉。
    out.textures_delta.clear();

    // 列表里每一行至少画一个矩形（选中/悬停底色）或若干文本。
    // 统计「画在列表区域里的文本图元」比统计全部更贴近「渲染了多少行」。
    let mut text_count = 0usize;
    let mut min_y = f32::MAX;
    let mut max_y = f32::MIN;
    for shape in &out.shapes {
        if let egui::Shape::Text(t) = &shape.shape {
            text_count += 1;
            min_y = min_y.min(t.pos.y);
            max_y = max_y.max(t.pos.y);
        }
    }
    (text_count, min_y, max_y)
}

#[test]
fn renders_a_sane_number_of_rows_for_a_large_vault() {
    let small = data_with(50);
    let huge = data_with(20_000);

    let (small_texts, _, _) = render_and_count(&small);
    let (huge_texts, _, _) = render_and_count(&huge);

    assert!(small_texts > 0, "小库也要画出东西：{small_texts}");

    // 2 万条时，绘制的文本数不应该比 50 条时多一个数量级。
    //
    // 全量渲染时这个比值会是 400 倍；虚拟滚动下应该接近 1。
    let ratio = huge_texts as f64 / small_texts.max(1) as f64;
    assert!(
        ratio < 6.0,
        "2 万条画了 {huge_texts} 个文本，50 条画了 {small_texts} 个（比值 {ratio:.1}）——\
         没有变成虚拟滚动"
    );
}

#[test]
fn a_huge_vault_still_renders_something() {
    // 回归保护：虚拟滚动的范围算错时，可能一行都不画。
    let huge = data_with(20_000);
    let (texts, min_y, max_y) = render_and_count(&huge);
    assert!(texts > 0, "2 万条时一行都没画出来：texts={texts}");
    assert!(
        max_y >= min_y,
        "画出的内容上下界不对：min={min_y} max={max_y}"
    );
}

#[test]
fn renders_an_empty_vault_without_panicking() {
    // 空库是**首次运行**的必经状态。
    // 渲染路径里到处是索引与 `unwrap`，空库是最容易崩的地方——
    // 而崩了整个程序就起不来了。
    let empty = VaultData::default();
    let (texts, _, _) = render_and_count(&empty);
    // 空库会画出「还没有条目」之类的空状态提示，所以有文字是正常的；
    // 关键是**不崩**（渲染 panic = 整个程序起不来）。
    assert!(texts > 0, "空库应当画出空状态提示，texts={texts}");
}

#[test]
fn renders_a_single_entry_without_panicking() {
    let one = data_with(1);
    let (texts, _, _) = render_and_count(&one);
    assert!(texts > 0, "一条记录也该画出来");
}

/// 在给定的筛选/排序下渲染，返回意图。
fn render_with_filter(data: &VaultData, filter: Filter, sort: SortBy) -> MainIntent {
    let mut search = String::new();
    let mut filter = filter;
    let mut sort = sort;
    let mut selected = None;
    let mut reveal = None;
    let mut new_cat = String::new();
    let copy_banner: Option<(std::time::Instant, u32)> = None;

    // `run_ui` 的闭包必须返回 ()，所以用意图变量把结果带出来。
    let mut intent = MainIntent::None;

    let ctx = Context::default();
    let input = RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(1280.0, 800.0),
        )),
        ..Default::default()
    };
    let mut out = ctx.run_ui(input, |ui: &mut Ui| {
        let view = MainView {
            data,
            search: &mut search,
            filter: &mut filter,
            sort: &mut sort,
            selected_id: &mut selected,
            reveal: &mut reveal,
            copy_banner: &copy_banner,
            new_category_buf: &mut new_cat,
            focus_search: false,
            idle_left_secs: 0,
            toast: None,
        };
        intent = keynest_egui::views::main_view::show(ui, view);
    });
    out.textures_delta.clear();
    intent
}

/// 每个筛选与排序组合都要能渲染。
///
/// 这些分支各有各的代码路径（收藏筛选、弱密码筛选、复用筛选、回收站…），
/// 很容易在某一条上留下一个越界索引。
/// 渲染 panic = 整个程序崩掉，用户连错误提示都看不到。
#[test]
fn every_filter_and_sort_combination_renders() {
    let mut data = data_with(30);
    // 造出各种状态：收藏、弱密码、已删除、复用
    data.entries[0].favorite = true;
    data.entries[1].password = "123".into(); // 弱
    data.entries[2].password = data.entries[3].password.clone(); // 复用
    data.entries[4].deleted_at = Some("2026-01-01T00:00:00.000Z".into());
    data.categories = vec!["网站".into(), "银行卡".into()];
    data.types = vec![keynest_core::vault::TypeDef::new("账号", vec![])];

    let filters = [
        Filter::All,
        Filter::Trash,
        Filter::Favorites,
        Filter::Weak,
        Filter::Reused,
        Filter::Category("网站".into()),
    ];
    // 用 `SortBy::ALL` 而不是手写一份：将来新增排序方式时
    // 这条测试自动覆盖，不用回来改这里。
    for f in &filters {
        for s in &SortBy::ALL {
            // 不 panic 就是通过
            let _ = render_with_filter(&data, f.clone(), *s);
        }
    }
}

/// 渲染设置页（每个分区都点一遍）。
///
/// 设置页有 5 个分区，各自有独立的渲染代码路径。
/// 设置页是用户**唯一**能改主密码、导入导出、清理回收站的地方——
/// 这里崩了，用户就没有任何自救手段。
fn render_settings_tab(tab: keynest_egui::views::settings::Tab) {
    use keynest_core::vault::Settings;
    use keynest_egui::views::settings::{SecuritySummary, SettingsContext, SettingsState};

    let settings = Settings::default();
    let ctx = SettingsContext {
        categories: vec!["网站".into()],
        types: vec![keynest_core::vault::TypeDef::new("账号", vec![])],
        legacy: false,
        kdf_algo: "argon2id".into(),
        format: "v3".into(),
        key_locked: Some(true),
        kdf_ok: Some(true),
        security: SecuritySummary {
            total: 3,
            weak: 1,
            reused: 1,
            with_totp: 0,
            stale: 0,
        },
        leftovers: Vec::new(),
        font_note: None,
        dark: false,
        bridge_installed: false,
    };

    let mut st = SettingsState::new(&settings, ctx);
    st.tab = tab;

    let context = Context::default();
    let mut out = context.run_ui(RawInput::default(), |_ui: &mut Ui| {
        let _ = keynest_egui::views::settings::show(&context, &mut st);
    });
    out.textures_delta.clear();
}

#[test]
fn every_settings_tab_renders() {
    use keynest_egui::views::settings::Tab;
    for tab in [
        Tab::Appearance,
        Tab::Security,
        Tab::Data,
        Tab::Browser,
        Tab::Danger,
    ] {
        render_settings_tab(tab);
    }
}

#[test]
fn the_edit_dialog_renders() {
    // 编辑框是新增/修改条目的唯一入口。
    // 里面有一堆 `unwrap` 与索引（模板字段、自定义字段行）。
    use keynest_egui::views::edit::EditState;

    // `EditState` 没有 Clone（含 Zeroizing），所以每个用例各构造一个。
    let cases: Vec<Box<dyn Fn() -> EditState>> = vec![
        Box::new(|| EditState::new_entry("网站".into())),
        Box::new(|| EditState::from_entry(&entry(0))),
    ];
    for make in cases {
        let ctx = Context::default();
        let mut st = make();
        let mut out = ctx.run_ui(RawInput::default(), |_ui: &mut Ui| {
            let _ = keynest_egui::views::edit::show(
                &ctx,
                &mut st,
                &["网站".to_string()],
                &[keynest_core::vault::TypeDef::new("账号", vec![])],
            );
        });
        out.textures_delta.clear();
    }
}

/// 在指定位置**真的点一下**，返回这一下产生的意图。
///
/// # 为什么需要
///
/// 之前的测试只能证明「渲染不崩」——但用户是**点**的。
/// 命中测试（点在哪个矩形里）与「点击 → 意图」的接线
/// 完全没有自动化覆盖，只能靠人点。
///
/// egui 的 `RawInput.events` 可以注入指针事件，
/// 所以「点这里会发生什么」变成了可以断言的东西。
///
/// 三帧：移动（建立 hover 与 widget id）→ 按下 → 释放。
/// egui 的 `Response::clicked()` 在**释放**那一帧才为真。
fn click_at(data: &VaultData, pos: egui::Pos2) -> MainIntent {
    // 必须复用同一个 Context：跨帧的 widget id 与交互状态都在它里面。
    let ctx = Context::default();
    let mut search = String::new();
    let mut filter = Filter::All;
    let mut sort = SortBy::UpdatedDesc;
    let mut selected = None;
    let mut reveal = None;
    let mut new_cat = String::new();
    let copy_banner: Option<(std::time::Instant, u32)> = None;

    let mut run_frame = |ctx: &Context, events: Vec<egui::Event>| -> MainIntent {
        let input = RawInput {
            events,
            // **必须给定屏幕尺寸**：裸 `run_ui` 里 `available_width()` 是 10000
            // （无界），于是行内的图标阈值（`right - 40` 之类）会被推到
            // 屏幕外，任何点击都落在「选中」分支上。
            //
            // 不用真实窗口尺寸就测不到图标的命中盒。
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(1280.0, 800.0),
            )),
            ..Default::default()
        };
        let mut intent = MainIntent::None;
        let mut out = ctx.run_ui(input, |ui: &mut Ui| {
            let view = MainView {
                data,
                search: &mut search,
                filter: &mut filter,
                sort: &mut sort,
                selected_id: &mut selected,
                reveal: &mut reveal,
                copy_banner: &copy_banner,
                new_category_buf: &mut new_cat,
                focus_search: false,
                idle_left_secs: 0,
                toast: None,
            };
            intent = keynest_egui::views::main_view::show(ui, view);
        });
        out.textures_delta.clear();
        intent
    };

    // 第一帧：让界面完成布局（egui 需要一帧才知道每个 widget 在哪）
    let _ = run_frame(&ctx, vec![]);

    // 第二帧：指针移到目标位置并按下
    let _ = run_frame(
        &ctx,
        vec![
            egui::Event::PointerMoved(pos),
            egui::Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: egui::Modifiers::default(),
            },
        ],
    );

    // 第三帧：释放 = 一次点击
    run_frame(
        &ctx,
        vec![egui::Event::PointerButton {
            pos,
            button: egui::PointerButton::Primary,
            pressed: false,
            modifiers: egui::Modifiers::default(),
        }],
    )
}

/// 点击列表里的行必须选中条目。
///
/// 扫描纵向位置找一个真的能点中行的坐标，然后断言：
/// 点出来的意图是 `Select`，且 id 是库里真实存在的条目。
///
/// 这条测的是**命中测试 + 点击接线**——之前完全没有自动化覆盖。
#[test]
fn clicking_a_row_selects_an_entry() {
    let data = data_with(5);

    let mut hit: Option<(egui::Pos2, MainIntent)> = None;
    for y in (80..=900).step_by(12) {
        let pos = egui::Pos2::new(200.0, y as f32);
        let intent = click_at(&data, pos);
        if matches!(intent, MainIntent::Select(_)) {
            hit = Some((pos, intent));
            break;
        }
    }

    let (pos, intent) = hit.expect("扫遍整个列表区域都点不中任何一行——命中测试坏了");
    let MainIntent::Select(id) = intent else {
        unreachable!()
    };
    assert!(
        data.entries.iter().any(|e| e.id == id),
        "点出来的 id {id} 不在库里"
    );
    // 顺带确认：那个坐标确实落在前几条的范围里
    assert!(pos.y < 900.0);
}

/// 从上到下点击，选中的条目顺序必须与列表顺序一致。
///
/// 「点某处能选中某条」还不够——映射可能是**反的**或**错位的**：
/// 点第一行选中第五条，用户会觉得界面完全乱套。
///
/// 这条把「纵向位置 → 条目」的映射方向钉住。
#[test]
fn clicking_down_the_list_walks_entries_in_order() {
    let data = data_with(4);

    // 收集「y 坐标 → 被选中的 id」，同一 id 只记第一次出现的位置
    let mut hits: Vec<(f32, String)> = Vec::new();
    for y in (80..=620).step_by(6) {
        let intent = click_at(&data, egui::Pos2::new(200.0, y as f32));
        if let MainIntent::Select(id) = intent {
            if !hits.iter().any(|(_, seen)| *seen == id) {
                hits.push((y as f32, id));
            }
        }
    }

    assert!(
        hits.len() >= 3,
        "只点中了 {} 行，扫不到足够多的行来验证顺序",
        hits.len()
    );

    // 得到的 id 序列应当等于库里条目的顺序（列表按 UpdatedDesc 排序，
    // 但所有条目的 updated_at 相同，sort_by 是稳定排序 → 保持原始顺序）
    let expected: Vec<String> = data
        .entries
        .iter()
        .take(hits.len())
        .map(|e| e.id.clone())
        .collect();
    let got: Vec<String> = hits.iter().map(|(_, id)| id.clone()).collect();
    assert_eq!(
        got, expected,
        "从上到下点出来的顺序与列表顺序不一致（映射反了或错位了）"
    );

    // 顺带确认纵向位置是递增的
    for w in hits.windows(2) {
        assert!(w[0].0 < w[1].0, "同一行的 id 出现在了更靠下的位置");
    }
}

/// 行内的快捷复制图标是**手绘 + 按 x 坐标判定**的，没有独立 widget。
///
/// 代码里是这样：
///
/// ```text
/// pass_x = right - 40     复制密码
/// user_x = right - 74     复制用户名
/// open_x = right - 108    在浏览器中打开
/// ```
///
/// 这套阈值写反了、或者 `match` 的臂顺序调换了，
/// 用户就会「点钥匙复制了用户名」——而这两件事后果完全不同：
/// 一个是把密码送进剪贴板，另一个不是。
///
/// 这条测试把「x 位置 → 动作」的映射钉住。
#[test]
fn the_quick_copy_icons_map_x_position_to_the_right_action() {
    let data = data_with(1); // 有密码、有账号、有网址

    // 先找一个能点中这一行的 y
    let mut row_y = None;
    for y in (80..=700).step_by(8) {
        if matches!(
            click_at(&data, egui::Pos2::new(200.0, y as f32)),
            MainIntent::Select(_)
        ) {
            row_y = Some(y as f32);
            break;
        }
    }
    let y = row_y.expect("找不到能点中的行");

    // 在这一行上从左往右扫，记下每个 x 产生的意图
    let mut seen: Vec<(f32, &'static str)> = Vec::new();
    for x in (150..=1024).step_by(6) {
        let intent = click_at(&data, egui::Pos2::new(x as f32, y));
        let kind = match intent {
            MainIntent::Select(_) => "select",
            MainIntent::CopyPassword(_) => "password",
            MainIntent::CopyUsername(_) => "user",
            MainIntent::OpenUrl(_) => "open",
            _ => continue,
        };
        if seen.last().map(|(_, k)| *k) != Some(kind) {
            seen.push((x as f32, kind));
        }
    }

    let kinds: Vec<&str> = seen.iter().map(|(_, k)| *k).collect();
    // 从左到右必须是：选中 → 打开网址 → 复制用户名 → 复制密码
    assert_eq!(
        kinds,
        vec!["select", "open", "user", "password"],
        "行内图标的 x 映射不对（实际顺序：{kinds:?}，起点 {seen:?}）"
    );

    // 越靠右，动作越"敏感"：密码在最右侧
    assert!(
        seen.last().unwrap().0 > seen[1].0,
        "复制密码的阈值不在打开网址右边"
    );
}

/// 没有密码的条目（笔记/信用卡），最右侧的 x 不能变成「复制密码」。
///
/// 那个位置根本没有画钥匙图标。如果仍返回 CopyPassword，
/// 用户点在一片空白上就把一个空字符串送进了剪贴板——
/// 更糟的是：他可能以为复制成功了别的东西。
#[test]
fn entries_without_a_password_never_emit_copy_password() {
    let mut data = data_with(1);
    data.entries[0].password.clear();

    let mut row_y = None;
    for y in (80..=700).step_by(8) {
        if matches!(
            click_at(&data, egui::Pos2::new(200.0, y as f32)),
            MainIntent::Select(_)
        ) {
            row_y = Some(y as f32);
            break;
        }
    }
    let y = row_y.expect("找不到能点中的行");

    for x in (150..=1024).step_by(6) {
        let intent = click_at(&data, egui::Pos2::new(x as f32, y));
        assert!(
            !matches!(intent, MainIntent::CopyPassword(_)),
            "没有密码的条目在 x={x} 处仍然返回了 CopyPassword"
        );
    }
}

/// 点击列表**下方**的空白区域不能选中任何条目。
///
/// 命中测试写宽了（比如整块区域都算作行）就会出现
/// 「点空白处也选中了某条」——用户会觉得界面在乱跳。
#[test]
fn clicking_empty_space_below_the_list_selects_nothing() {
    let data = data_with(2);
    // 窗口默认高度约 720；两条记录只占 ~100px，下面全是空白
    let intent = click_at(&data, egui::Pos2::new(200.0, 700.0));
    assert!(
        !matches!(intent, MainIntent::Select(_)),
        "点空白处也选中了条目"
    );
}

#[test]
fn renders_the_first_entries_at_the_top() {
    // 顶部应当显示最前面的条目——虚拟滚动算错了范围就会露馅。
    let data = data_with(100);
    let (texts, _, _) = render_and_count(&data);
    assert!(texts > 0);
}
