use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{header::LOCATION, redirect::Policy, Client, Url};

const MAX_IMAGE_BYTES: usize = 5_000_000;
const MAX_REDIRECTS: usize = 3;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5);

/// Embeds an image referenced by a user-pasted snapshot, including images without CORS headers.
#[tauri::command]
pub async fn read_snapshot_image(url: String) -> Result<String, String> {
    let url = parse_image_url(&url)?;
    tokio::time::timeout(DOWNLOAD_TIMEOUT, download_image(url))
        .await
        .map_err(|_| "Snapshot image download timed out.".to_string())?
}

fn parse_image_url(value: &str) -> Result<Url, String> {
    if value.len() > 8192 {
        return Err("Snapshot image URL is too long.".into());
    }
    let mut url = Url::parse(value).map_err(|_| "Invalid snapshot image URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Snapshot images must use HTTP or HTTPS without credentials.".into());
    }
    let host = url
        .host_str()
        .ok_or("Snapshot image URL has no hostname.")?
        .trim_end_matches('.');
    if let Some(ip) = literal_ip(host) {
        if !is_public_ip(ip) {
            return Err("Snapshot images cannot access local or reserved addresses.".into());
        }
    } else if !host.contains('.')
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err("Snapshot images must use a public hostname.".into());
    }
    url.set_fragment(None);
    Ok(url)
}

fn literal_ip(host: &str) -> Option<IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127 | 224..=255)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && matches!(c, 0 | 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && matches!(b, 18 | 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let [a, b, ..] = ip.segments();
            // Accept global unicast only, excluding protocol, transition and documentation ranges.
            (a & 0xe000) == 0x2000
                && !(a == 0x2001 && (b <= 0x01ff || b == 0x0db8))
                && a != 0x2002
                && !(a == 0x3fff && b <= 0x0fff)
        }
    }
}

fn validate_addresses(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("Snapshot images cannot resolve to local or reserved addresses.".into());
    }
    Ok(())
}

async fn download_image(mut url: Url) -> Result<String, String> {
    for redirects in 0..=MAX_REDIRECTS {
        let host = url
            .host_str()
            .ok_or("Snapshot image URL has no hostname.")?;
        let port = url
            .port_or_known_default()
            .ok_or("Invalid image URL port.")?;
        let addresses = if let Some(ip) = literal_ip(host) {
            vec![SocketAddr::new(ip, port)]
        } else {
            tokio::net::lookup_host((host, port))
                .await
                .map_err(|_| "Could not resolve the snapshot image hostname.".to_string())?
                .collect::<Vec<_>>()
        };
        validate_addresses(&addresses)?;
        // Pin the checked DNS answer and disable automatic redirects/proxies to prevent a
        // captured URL from reaching local services through DNS rebinding or a redirect.
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .referer(false)
            .resolve_to_addrs(host, &addresses)
            .timeout(DOWNLOAD_TIMEOUT)
            .build()
            .map_err(|_| "Could not initialize the snapshot image download.".to_string())?;
        let mut response = client
            .get(url.clone())
            .header(
                "Accept",
                "image/png,image/jpeg,image/webp,image/gif,image/avif",
            )
            .send()
            .await
            .map_err(|_| "Could not download the snapshot image.".to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Snapshot image redirect has no valid location.")?;
            url = redirect_url(&url, location, redirects)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "Snapshot image returned HTTP {}.",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_IMAGE_BYTES as u64)
        {
            return Err("Snapshot images are limited to 5 MB each.".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read the snapshot image.".to_string())?
        {
            append_chunk(&mut bytes, &chunk)?;
        }
        return encode_raster(&bytes);
    }
    Err("Snapshot image has too many redirects.".into())
}

fn redirect_url(current: &Url, location: &str, redirects: usize) -> Result<Url, String> {
    if redirects >= MAX_REDIRECTS {
        return Err("Snapshot image has too many redirects.".into());
    }
    let next = current
        .join(location)
        .map_err(|_| "Snapshot image redirect has an invalid URL.".to_string())?;
    parse_image_url(next.as_str())
}

fn append_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
        return Err("Snapshot images are limited to 5 MB each.".into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn encode_raster(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Snapshot images are limited to 5 MB each.".into());
    }
    // Detect the body itself; an HTML or SVG response must not become an image via its MIME header.
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.get(4..8) == Some(b"ftyp")
        && (bytes.get(8..12) == Some(b"avif") || bytes.get(8..12) == Some(b"avis"))
    {
        "image/avif"
    } else {
        return Err("Snapshot images must be PNG, JPEG, GIF, WebP or AVIF raster images.".into());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_credentials_and_local_urls() {
        for value in [
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "https://user:pass@example.com/a",
            "http://localhost/a",
            "http://example.local/a",
            "http://example.localhost./a",
            "http://127.1/a",
            "http://2130706433/a",
            "http://0x7f000001/a",
            "http://10.1.2.3/a",
            "http://169.254.169.254/a",
            "http://192.168.0.1/a",
            "http://[::1]/a",
            "http://[::ffff:127.0.0.1]/a",
            "http://[fd00::1]/a",
            "http://[fe80::1]/a",
        ] {
            assert!(
                parse_image_url(value).is_err(),
                "unexpectedly accepted {value}"
            );
        }
    }

    #[test]
    fn accepts_public_image_urls() {
        for value in [
            "https://www.gstatic.com/inputtools/images/tia.png",
            "https://yt3.ggpht.com/avatar=image",
            "https://8.8.8.8/image.png",
            "https://[2606:4700:4700::1111]/image.png",
        ] {
            assert!(
                parse_image_url(value).is_ok(),
                "unexpectedly rejected {value}"
            );
        }
    }

    #[test]
    fn rejects_reserved_and_documentation_addresses() {
        for value in [
            "0.1.2.3",
            "100.64.1.1",
            "172.31.255.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "2001:db8::1",
            "2002::1",
            "64:ff9b::a00:1",
            "3fff::1",
            "ff02::1",
        ] {
            assert!(
                !is_public_ip(value.parse().unwrap()),
                "unexpectedly accepted {value}"
            );
        }
    }

    #[test]
    fn rejects_mixed_public_and_private_dns_answers() {
        let addresses = [
            "8.8.8.8:443".parse().unwrap(),
            "10.0.0.1:443".parse().unwrap(),
        ];
        assert!(validate_addresses(&addresses).is_err());
    }

    #[test]
    fn rejects_redirects_to_local_addresses() {
        let current = Url::parse("https://example.com/a.png").unwrap();
        assert!(redirect_url(&current, "//127.0.0.1/private", 0).is_err());
    }

    #[test]
    fn limits_redirect_chain_and_supports_relative_locations() {
        let current = Url::parse("https://example.com/a.png").unwrap();
        assert_eq!(
            redirect_url(&current, "/b.png", 2).unwrap().path(),
            "/b.png"
        );
        assert!(redirect_url(&current, "/b.png", 3).is_err());
    }

    #[test]
    fn refuses_a_chunk_crossing_the_byte_limit_without_appending() {
        let mut bytes = vec![0; MAX_IMAGE_BYTES - 1];
        assert!(append_chunk(&mut bytes, &[1, 2]).is_err());
        assert_eq!(bytes.len(), MAX_IMAGE_BYTES - 1);
    }

    #[test]
    fn accepts_a_body_at_the_byte_limit() {
        let mut bytes = vec![0; MAX_IMAGE_BYTES - 1];
        assert!(append_chunk(&mut bytes, &[1]).is_ok());
    }

    #[test]
    fn embeds_each_supported_raster_mime() {
        for (body, mime) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            (&[0xff, 0xd8, 0xff], "image/jpeg"),
            (b"GIF89a", "image/gif"),
            (b"RIFF1234WEBP", "image/webp"),
            (b"\0\0\0\x18ftypavif\0\0\0\0", "image/avif"),
        ] {
            assert_eq!(
                encode_raster(body).unwrap(),
                format!("data:{mime};base64,{}", STANDARD.encode(body))
            );
        }
    }

    #[test]
    fn rejects_svg_html_and_unknown_bodies() {
        for body in [b"<svg></svg>".as_slice(), b"<!doctype html>", b"", b"RIFF"] {
            assert!(encode_raster(body).is_err());
        }
    }
}
