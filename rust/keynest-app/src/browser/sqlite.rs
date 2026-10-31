//! 最小 SQLite 只读解析器。
//!
//! 为什么不用 rusqlite：它的 `bundled` 特性需要 C 编译器编译 SQLite 源码，
//! 而本机只有 MSVC 的 link.exe、没有 cl.exe。
//!
//! 这里直接读 SQLite 文件格式（只读、只查一张表、只取一个 BLOB 列），
//! 足够读浏览器的 `Login Data`。不支持索引、不支持 UPDATE、不支持加密库。

use std::path::Path;

/// SQLite 文件头魔数
const MAGIC: &[u8; 16] = b"SQLite format 3\0";

#[derive(Debug)]
pub struct SqliteFile {
    data: Vec<u8>,
    page_size: usize,
}

impl SqliteFile {
    pub fn open(path: &Path) -> Result<Self, String> {
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        if data.len() < 100 {
            return Err("文件太小，不是 SQLite".into());
        }
        if &data[..16] != MAGIC {
            return Err("不是 SQLite 文件".into());
        }

        // 页大小在 header 偏移 16 处（2 字节，大端；值 1 表示 65536）
        let raw = u16::from_be_bytes([data[16], data[17]]) as usize;
        let page_size = if raw == 1 { 65536 } else { raw };
        if page_size == 0 || page_size % 512 != 0 {
            return Err(format!("非法页大小: {page_size}"));
        }

        Ok(Self { data, page_size })
    }

    fn page_count(&self) -> usize {
        self.data.len() / self.page_size
    }

    fn page(&self, no: usize) -> Option<&[u8]> {
        if no == 0 || no > self.page_count() {
            return None;
        }
        let start = (no - 1) * self.page_size;
        self.data.get(start..start + self.page_size)
    }

    /// 从指定页的 cell 指针数组读 cell 偏移。
    fn cell_pointers(&self, page: &[u8], header_offset: usize) -> Vec<usize> {
        let cells = u16::from_be_bytes([page[header_offset + 3], page[header_offset + 4]]) as usize;
        let mut out = Vec::with_capacity(cells);
        let base = header_offset + 8; // 跳过 8 字节头（leaf 页）
        for i in 0..cells {
            let pos = base + i * 2;
            if pos + 2 > page.len() {
                break;
            }
            let ptr = u16::from_be_bytes([page[pos], page[pos + 1]]) as usize;
            if ptr < page.len() {
                out.push(ptr);
            }
        }
        out
    }

    /// 遍历所有表的叶子页，对每个 cell 调用回调。
    /// 简化：只处理 leaf table page（type 0x0D），b-tree 内部页也递归。
    fn walk_pages<F: FnMut(&[u8])>(&self, page_no: usize, visit: &mut F) {
        let Some(page) = self.page(page_no) else { return };
        let page_type = page[0];

        match page_type {
            // 内部表页：递归子页
            0x05 => {
                let cells = u16::from_be_bytes([page[3], page[4]]) as usize;
                for i in 0..cells {
                    let pos = 12 + i * 2;
                    if pos + 2 > page.len() {
                        break;
                    }
                    let child = u32::from_be_bytes([
                        0,
                        0,
                        page[pos],
                        page[pos + 1],
                    ]) as usize;
                    if child != 0 {
                        self.walk_pages(child, visit);
                    }
                }
                // 最右子页
                if let Some(ptr) = page.get(8..12) {
                    let right = u32::from_be_bytes([0, 0, ptr[2], ptr[3]]) as usize;
                    if right != 0 {
                        self.walk_pages(right, visit);
                    }
                }
            }
            // 叶子表页
            0x0D => {
                for ptr in self.cell_pointers(page, 0) {
                    visit(&page[ptr..]);
                }
            }
            _ => {}
        }
    }

    /// 把一条 record 解析成字符串列（只处理 TEXT 与 BLOB）。
    fn parse_record(cell: &[u8]) -> Vec<ColumnValue> {
        // cell 结构：payload_len(varint) + rowid(varint) + payload
        let mut idx = 0usize;
        let payload_len = read_varint(cell, &mut idx);
        let _rowid = read_varint(cell, &mut idx);
        let payload = match cell.get(idx..idx + payload_len) {
            Some(p) => p,
            None => return Vec::new(),
        };

        // record 头：总长度(varint) + 各列 serial type(varint)...
        let mut hidx = 0usize;
        let header_len = read_varint(payload, &mut hidx);
        let mut types = Vec::new();
        while hidx < header_len && hidx < payload.len() {
            types.push(read_varint(payload, &mut hidx));
        }

        let mut values = Vec::new();
        let mut body = header_len;
        for st in types {
            match st {
                0 => values.push(ColumnValue::Null),
                1..=6 => {
                    let n = match st {
                        1 => 1,
                        2 => 2,
                        3 => 3,
                        4 => 4,
                        5 => 6,
                        _ => 8,
                    };
                    body += n;
                    values.push(ColumnValue::Int);
                }
                7 => {
                    body += 8;
                    values.push(ColumnValue::Int);
                }
                8 => values.push(ColumnValue::Int),
                9 => values.push(ColumnValue::Int),
                12 | 13 => {
                    // BLOB
                    let n = (st - 12) / 2;
                    if let Some(slice) = payload.get(body..body + n) {
                        values.push(ColumnValue::Blob(slice.to_vec()));
                    } else {
                        values.push(ColumnValue::Null);
                    }
                    body += n;
                }
                _ if st >= 13 => {
                    // TEXT
                    let n = (st - 13) / 2;
                    if let Some(slice) = payload.get(body..body + n) {
                        values.push(ColumnValue::Text(slice.to_vec()));
                    } else {
                        values.push(ColumnValue::Null);
                    }
                    body += n;
                }
                _ => values.push(ColumnValue::Null),
            }
        }
        values
    }

    /// 找出所有 BLOB 列（用于统计 v10/v20）。
    pub fn blob_columns(&self) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut visit = |cell: &[u8]| {
            for v in Self::parse_record(cell) {
                if let ColumnValue::Blob(bytes) = v {
                    out.push(bytes);
                }
            }
        };
        // 从 page 1 开始（page 1 含 sqlite_master）
        for p in 1..=self.page_count().min(64) {
            self.walk_pages(p, &mut visit);
        }
        out
    }
}

#[derive(Debug, Clone)]
pub enum ColumnValue {
    Null,
    Int,
    Text(Vec<u8>),
    Blob(Vec<u8>),
}

fn read_varint(buf: &[u8], idx: &mut usize) -> usize {
    let mut value = 0usize;
    for _ in 0..9 {
        if *idx >= buf.len() {
            break;
        }
        let byte = buf[*idx];
        *idx += 1;
        if value == 0 && byte >= 0x80 && byte <= 0x8f {
            // 9 字节变体，简化处理
            value = byte as usize;
            continue;
        }
        value = (value << 7) | (byte & 0x7f) as usize;
        if byte & 0x80 == 0 {
            break;
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_sqlite() {
        let dir = std::env::temp_dir().join("kn-sqlite-test");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("fake.db");
        std::fs::write(&p, b"not a database at all").unwrap();
        assert!(SqliteFile::open(&p).is_err());
    }

    #[test]
    fn varint_decodes_small() {
        let buf = [0x05u8];
        let mut i = 0;
        assert_eq!(read_varint(&buf, &mut i), 5);
    }
}
