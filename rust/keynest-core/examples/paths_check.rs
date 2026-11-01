use keynest_core::paths;

fn main() {
    println!(
        "LOCALAPPDATA 默认目录: {}",
        paths::local_data_dir().display()
    );
    println!(
        "APPDATA 旧目录:        {}",
        paths::roaming_data_dir().display()
    );
    println!(
        "实际解析结果:          {}",
        paths::resolve_data_dir().display()
    );
    println!(
        "库文件路径:            {}",
        paths::resolve_vault_path().display()
    );
    println!("仍在漫游目录?          {}", paths::is_on_roaming_profile());
    println!(
        "旧库是否存在:          {}",
        paths::roaming_data_dir().join("vault.dat").exists()
    );
}
