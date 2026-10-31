fn main() {
    // Tauri 2：build 阶段会读取 tauri.conf.json 的 frontendDist，
    // 把该目录下的文件嵌入到二进制里（通过 include_dir 宏）。
    tauri_build::build()
}
