//! A request to an address that somebody else chose: the one place the server asks a host it
//! has no reason to trust (another server's keys, `origin_keys`, and its attestation of a post
//! this server holds a repost of, the compactor's origin sweep). Whoever names the address
//! could name one that only this server can reach (the cloud's metadata service, the
//! database's host, a neighbour in its network), and have the server ask it for them. So a
//! request is made only:
//!
//! - over https, to a certificate that is the host's, on the port https has (443) and no
//!   other: a server answers for itself there, and the request is no way to try a host's
//!   other ports;
//! - to an address on the public internet, checked on the addresses the name resolves to,
//!   which are the ones the connection is then made to, so that a name can't resolve to one
//!   address when it is checked and to another when it is connected to;
//! - once: a redirect isn't followed, since where it leads was checked by nobody;
//! - for a short time, and a small answer.
//!
//! This is the one implementation of it: the compactor's process asks with it, and the API
//! does through its addon.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use url::{Host, Url};

/// How long a request may take, from the name being resolved to the last byte of the answer.
const TIMEOUT: Duration = Duration::from_millis(3000);

/// The largest answer that is read, unless the caller says. A longer one is given up on.
pub const MAX_BYTES: usize = 64 * 1024;

/// The port of https, which is the only one asked.
const HTTPS_PORT: u16 = 443;

/// The IPv4 addresses that aren't the public internet's, as IANA's registry of special-purpose
/// addresses lists them, each as an address and the length of its prefix: this host, private
/// networks, link-local (where clouds keep their metadata services), carrier-grade NAT,
/// documentation, multicast, and what is reserved.
const NOT_PUBLIC_V4: [(Ipv4Addr, u32); 15] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 0, 0, 0), 24),
    (Ipv4Addr::new(192, 0, 2, 0), 24),
    (Ipv4Addr::new(192, 88, 99, 0), 24),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
    (Ipv4Addr::new(198, 51, 100, 0), 24),
    (Ipv4Addr::new(203, 0, 113, 0), 24),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
];

/// The IPv6 addresses that aren't: the ranges that carry an IPv4 address inside them, which
/// could carry a private one (IPv4-compatible, ::/96, which this host's own :: and ::1 are in;
/// IPv4-translated; NAT64; 6to4; Teredo), discard-only, documentation, private networks,
/// link-local, site-local (IPv6's private range before fc00::/7) and multicast. An IPv4
/// address written as IPv6 (::ffff:10.0.0.1) is held to the IPv4 ranges.
const NOT_PUBLIC_V6: [(Ipv6Addr, u32); 12] = [
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 0), 96),
    (Ipv6Addr::new(0, 0, 0, 0, 0xffff, 0, 0, 0), 96),
    (Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), 96),
    (Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48),
    (Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0), 64),
    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32),
    (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xfec0, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
];

/// Whether an IPv4 address is on the public internet.
fn is_public_v4(address: Ipv4Addr) -> bool {
    let bits = address.to_bits();
    !NOT_PUBLIC_V4.iter().any(|(range, prefix)| (bits ^ range.to_bits()) >> (32 - prefix) == 0)
}

/// Whether an IP address is on the public internet.
pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => match address.to_ipv4_mapped() {
            Some(inside) => is_public_v4(inside),
            None => {
                let bits = address.to_bits();
                !NOT_PUBLIC_V6.iter().any(|(range, prefix)| (bits ^ range.to_bits()) >> (128 - prefix) == 0)
            }
        },
    }
}

/// Whether `address` is an IP address on the public internet. One that isn't an IP address
/// is not.
pub fn is_public_address(address: &str) -> bool {
    address.parse::<IpAddr>().is_ok_and(is_public_ip)
}

/// What a server answered: the status, and the body, read as JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

/// What the server at `address` answers a GET with, read as JSON, under the rules above. An
/// error for an address that isn't https, names a port or isn't public, an answer that isn't
/// 200 (a redirect among them), that is too long or too late, or that isn't JSON.
pub async fn fetch_public_json(address: &str) -> Result<Value> {
    Ok(fetch_public_answer(address, &[200], MAX_BYTES).await?.body)
}

/// The same, for an answer whose status says something too: the status, which must be one of
/// `statuses` (a redirect is never taken, whatever they are), and the body, read as JSON, of
/// up to `max_bytes`.
pub async fn fetch_public_answer(address: &str, statuses: &[u16], max_bytes: usize) -> Result<Answer> {
    let url = Url::parse(address).map_err(|_| anyhow!("what was to be asked is not an address"))?;
    let origin = url.origin().ascii_serialization();
    if url.scheme() != "https" {
        bail!("{origin} is not an https address");
    }
    // The URL parser leaves out the port that is https's own, so one that is there is another.
    if url.port().is_some() {
        bail!("{origin} is not on the port of https, which is the only one asked");
    }
    match tokio::time::timeout(TIMEOUT, ask(&url, &origin, statuses, max_bytes)).await {
        Ok(answer) => answer,
        Err(_) => bail!("{origin} did not answer in time"),
    }
}

/// Asks, once the address is known to be https's own: resolves its host, checks what it
/// resolves to, and reads the answer of one of those addresses.
async fn ask(url: &Url, origin: &str, statuses: &[u16], max_bytes: usize) -> Result<Answer> {
    let builder = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        // A connection of its own, which is closed with the request: none is kept to be used again.
        .pool_max_idle_per_host(0)
        .no_proxy();
    // The host as the URL parser writes it, which is how it is named to whoever reads why it was refused.
    let written = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
    let builder = match url.host() {
        // A host written as an address is connected to as it is, with no name to resolve: it is checked here.
        Some(Host::Ipv4(address)) if !is_public_v4(address) => bail!("{written} is not an address on the public internet"),
        Some(Host::Ipv6(address)) if !is_public_ip(IpAddr::V6(address)) => bail!("{written} is not an address on the public internet"),
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => builder,
        Some(Host::Domain(name)) => {
            let resolved = tokio::net::lookup_host((name, HTTPS_PORT))
                .await
                .map_err(|err| anyhow!("{name} could not be resolved: {err}"))?;
            let addresses: Vec<SocketAddr> = resolved.collect();
            if addresses.is_empty() || !addresses.iter().all(|address| is_public_ip(address.ip())) {
                bail!("{name} resolves to an address that isn't on the public internet");
            }
            // The connection is made to the addresses that were checked, and to no other.
            builder.resolve_to_addrs(name, &addresses)
        }
        None => bail!("{origin} names no host"),
    };
    let client = builder.build().map_err(|err| anyhow!("could not ask {origin}: {}", err.without_url()))?;
    let mut response = client
        .get(url.clone())
        .header("accept", "application/json")
        .header("user-agent", "evieverse")
        .send()
        .await
        .map_err(|err| anyhow!("{origin} could not be asked: {}", cause(&err.without_url())))?;
    let status = response.status().as_u16();
    if !statuses.contains(&status) || (300..400).contains(&status) {
        bail!("{origin} answered {status}");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("{origin} closed the connection before its answer ended"))?
    {
        if body.len() + chunk.len() > max_bytes {
            bail!("{origin} answered with more than {max_bytes} bytes");
        }
        body.extend_from_slice(&chunk);
    }
    let body = crate::json::from_slice(&body).map_err(|_| anyhow!("{origin} did not answer with JSON"))?;
    Ok(Answer { status, body })
}

/// What went wrong with a request, down to what caused it: the error itself says only that
/// the request failed.
fn cause(err: &reqwest::Error) -> String {
    let mut text = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(inner) = source {
        text = format!("{text}: {inner}");
        source = inner.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_addresses_that_are_not_the_public_internet() {
        let public = [
            "93.184.215.14",
            "1.1.1.1",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700:4700::1111",
            "2a00:1450:4001:81b::200e",
            "::ffff:8.8.8.8",
        ];
        for address in public {
            assert!(is_public_address(address), "{address}");
        }
        let not = [
            "127.0.0.1",
            "0.0.0.0",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "198.18.0.1",
            "198.19.255.255",
            "192.0.2.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::10.0.0.1",
            "::ffff:0:10.0.0.1",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "100::1",
            "2001::1",
            "2001:db8::1",
            "2002:a00:1::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "",
            "example.com",
            "1.1.1",
            "1.1.1.1 ",
        ];
        for address in not {
            assert!(!is_public_address(address), "{address}");
        }
    }

    #[tokio::test]
    async fn asks_nothing_but_an_https_address_on_its_own_port_that_is_public() {
        let refused = |address: &'static str| async move { fetch_public_json(address).await.unwrap_err().to_string() };
        assert_eq!(
            refused("http://other.example/repost/keys").await,
            "http://other.example is not an https address"
        );
        assert_eq!(refused("ftp://other.example/repost/keys").await, "ftp://other.example is not an https address");
        assert_eq!(refused("file:///etc/passwd").await, "null is not an https address");
        assert_eq!(
            refused("https://other.example:8443/repost/keys").await,
            "https://other.example:8443 is not on the port of https, which is the only one asked"
        );
        assert_eq!(
            refused("https://127.0.0.1/repost/keys").await,
            "127.0.0.1 is not an address on the public internet"
        );
        assert_eq!(
            refused("https://169.254.169.254/latest/meta-data").await,
            "169.254.169.254 is not an address on the public internet"
        );
        assert_eq!(refused("https://[::1]/repost/keys").await, "::1 is not an address on the public internet");
        assert_eq!(
            refused("https://[::ffff:10.0.0.1]/repost/keys").await,
            "::ffff:a00:1 is not an address on the public internet"
        );
        assert_eq!(
            refused("https://[::10.0.0.1]/repost/keys").await,
            "::a00:1 is not an address on the public internet"
        );
        assert_eq!(
            refused("https://93.184.216.34:22/repost/keys").await,
            "https://93.184.216.34:22 is not on the port of https, which is the only one asked"
        );
        // An address written as a number is the address the URL parser makes of it.
        assert_eq!(
            refused("https://2130706433/repost/keys").await,
            "127.0.0.1 is not an address on the public internet"
        );
        assert_eq!(
            refused("https://0x7f.1/repost/keys").await,
            "127.0.0.1 is not an address on the public internet"
        );
        // A name that resolves to this host is refused as it is resolved.
        assert_eq!(
            refused("https://localhost/repost/keys").await,
            "localhost resolves to an address that isn't on the public internet"
        );
        // The port of https written out is left out by the URL parser: it is the one asked.
        assert_eq!(
            refused("https://127.0.0.1:443/repost/keys").await,
            "127.0.0.1 is not an address on the public internet"
        );
        assert!(fetch_public_json("nowhere").await.is_err());
    }
}
