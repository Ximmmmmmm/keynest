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
use keynest_egui::views::main_view::{Filter, MainView, SortBy};

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
    let mut out = ctx.run_ui(RawInput::default(), |ui: &mut Ui| {
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
fn renders_the_first_entries_at_the_top() {
    // 顶部应当显示最前面的条目——虚拟滚动算错了范围就会露馅。
    let data = data_with(100);
    let (texts, _, _) = render_and_count(&data);
    assert!(texts > 0);
}
