//! origin 规范化。
//!
//! 浏览器匹配的一切安全性质都建立在这个函数上：
//!
//! - `https://example.com` 与 `https://example.com/login` **同** origin
//! - `http://example.com` 与 `https://example.com` **不同**（协议不同）
//! - `https://example.com:8443` 与 `https://example.com` **不同**（端口不同）
//! - `https://example.com.evil.test` **绝不**匹配 `example.com`
//!
//! 所以这里**不做**任何"宽松"处理：不补默认端口以外的假设、不忽略子域、
//! 不做前缀/后缀比较。

/// 规范化后的 origin：`scheme://host[:port]`，全小写，去掉路径与查询。
///
/// 返回 `None` 表示这条 URL 不能用于匹配（非法、非 http/https、没有主机）。
pub fn normalize(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }

    let (scheme, rest) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }

    // 去掉路径 / 查询 / 片段
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");

    // 去掉 userinfo（user:pass@host）
    let host_port = match authority.rsplit_once('@') {
        Some((_userinfo, hp)) => hp,
        None => authority,
    };
    if host_port.is_empty() {
        return None;
    }

    // 拆端口。IPv6 字面量形如 [::1]:8443，单独处理。
    let (host, port) = if let Some(rest) = host_port.strip_prefix('[') {
        let (h, after) = rest.split_once(']')?;
        let port = after.strip_prefix(':');
        (format!("[{h}]"), port)
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (host_port.to_string(), None),
        }
    };

    if host.is_empty() {
        return None;
    }
    // 端口必须是纯数字，且不是空串
    if let Some(p) = port {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        // 默认端口归一：https:443 / http:80 不写进 origin，
        // 这样 `https://example.com:443` 与 `https://example.com` 视为同一个。
        let default = (scheme == "https" && p == "443") || (scheme == "http" && p == "80");
        if default {
            return Some(format!("{}://{}", scheme, host.to_ascii_lowercase()));
        }
        return Some(format!("{}://{}:{}", scheme, host.to_ascii_lowercase(), p));
    }

    Some(format!("{}://{}", scheme, host.to_ascii_lowercase()))
}

/// 是否允许自动填充（当前策略：只允许 https）。
pub fn is_fillable(origin: &str) -> bool {
    origin.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_scheme_host_port_only() {
        assert_eq!(
            normalize("https://example.com/login?x=1#frag").as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn lowercases_host_and_scheme() {
        assert_eq!(
            normalize("HTTPS://Example.COM/Path").as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn drops_default_ports() {
        assert_eq!(
            normalize("https://example.com:443").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            normalize("http://example.com:80").as_deref(),
            Some("http://example.com")
        );
    }

    #[test]
    fn keeps_non_default_ports() {
        assert_eq!(
            normalize("https://example.com:8443").as_deref(),
            Some("https://example.com:8443")
        );
    }

    #[test]
    fn scheme_change_changes_origin() {
        assert_ne!(
            normalize("http://example.com"),
            normalize("https://example.com")
        );
    }

    #[test]
    fn lookalike_domain_never_matches() {
        // 核心安全断言：evil 域名不能因为"包含 example.com"而匹配
        assert_ne!(
            normalize("https://example.com.evil.test"),
            normalize("https://example.com")
        );
        assert_ne!(
            normalize("https://notexample.com"),
            normalize("https://example.com")
        );
    }

    #[test]
    fn subdomain_is_a_different_origin() {
        assert_ne!(
            normalize("https://mail.example.com"),
            normalize("https://example.com")
        );
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(normalize("javascript:alert(1)").is_none());
        assert!(normalize("file:///etc/passwd").is_none());
        assert!(normalize("chrome://settings").is_none());
        assert!(normalize("mailto:a@b.c").is_none());
    }

    #[test]
    fn rejects_missing_host() {
        assert!(normalize("https://").is_none());
        assert!(normalize("https:///path").is_none());
        assert!(normalize("").is_none());
    }

    #[test]
    fn strips_userinfo() {
        assert_eq!(
            normalize("https://user:pass@example.com/").as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn handles_ipv6_literal() {
        assert_eq!(
            normalize("https://[::1]:8443/x").as_deref(),
            Some("https://[::1]:8443")
        );
    }

    #[test]
    fn only_https_is_fillable() {
        assert!(is_fillable("https://example.com"));
        assert!(!is_fillable("http://example.com"));
    }
}
