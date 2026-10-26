use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::ConnectInfo;
use axum::http::header::FORWARDED;
use axum::http::{HeaderMap, Request};
use tower_governor::GovernorError;
use tower_governor::key_extractor::KeyExtractor;
use tracing::warn;

static WARNED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    net: IpAddr,
    len: u8,
}

impl Cidr {
    fn parse(spec: &str) -> Option<Cidr> {
        let (addr, len) = match spec.split_once('/') {
            Some((addr, len)) => (addr, Some(len)),
            None => (spec, None),
        };
        let net = addr.trim().parse::<IpAddr>().ok()?.to_canonical();
        let max = match net {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        let len = match len {
            Some(len) => len.trim().parse::<u8>().ok().filter(|l| *l <= max)?,
            None => max,
        };
        Some(Cidr { net, len })
    }

    fn contains(&self, ip: IpAddr) -> bool {
        let (net, addr, width) = match (self.net, ip.to_canonical()) {
            (IpAddr::V4(n), IpAddr::V4(a)) => (u32::from(n) as u128, u32::from(a) as u128, 32),
            (IpAddr::V6(n), IpAddr::V6(a)) => (u128::from(n), u128::from(a), 128),
            (_, _) => return false,
        };
        (net ^ addr)
            .checked_shr(width - u32::from(self.len))
            .unwrap_or(0)
            == 0
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum ProxyTrust {
    #[default]
    Peer,
    Any,
    Listed(Arc<[Cidr]>),
}

impl ProxyTrust {
    pub fn from_config(trust_proxy: bool, trusted: Option<&str>) -> anyhow::Result<ProxyTrust> {
        let specs: Vec<&str> = trusted
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if specs.is_empty() {
            return Ok(match trust_proxy {
                true => ProxyTrust::Any,
                false => ProxyTrust::Peer,
            });
        }
        let mut cidrs = Vec::with_capacity(specs.len());
        for spec in specs {
            match Cidr::parse(spec) {
                Some(cidr) => cidrs.push(cidr),
                None => anyhow::bail!(
                    "TRUSTED_PROXIES entry {spec:?} is not an IP address or CIDR range (for example 10.0.0.0/8)"
                ),
            }
        }
        Ok(ProxyTrust::Listed(cidrs.into()))
    }

    pub fn trusts(&self, ip: IpAddr) -> bool {
        match self {
            ProxyTrust::Peer => false,
            ProxyTrust::Any => true,
            ProxyTrust::Listed(cidrs) => cidrs.iter().any(|c| c.contains(ip)),
        }
    }

    pub fn client(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        let peer = peer.to_canonical();
        if !self.trusts(peer) {
            if matches!(self, ProxyTrust::Listed(_))
                && !WARNED.load(Ordering::Relaxed)
                && !hops(headers).is_empty()
                && !WARNED.swap(true, Ordering::Relaxed)
            {
                warn!(
                    "ignoring forwarded client address headers from {peer}, which is not in TRUSTED_PROXIES (logged once)"
                );
            }
            return peer;
        }
        let mut client = peer;
        for hop in hops(headers).into_iter().rev() {
            match hop {
                Some(ip) => {
                    client = ip;
                    if !self.trusts(ip) {
                        break;
                    }
                }
                None => break,
            }
        }
        client
    }
}

fn hop(raw: &str) -> Option<IpAddr> {
    let raw = raw.trim().trim_matches('"');
    raw.parse::<IpAddr>()
        .ok()
        .or_else(|| raw.parse::<SocketAddr>().ok().map(|a| a.ip()))
        .or_else(|| {
            raw.strip_prefix('[')
                .and_then(|r| r.strip_suffix(']'))
                .and_then(|r| r.parse().ok())
        })
        .map(|ip: IpAddr| ip.to_canonical())
}

fn forwarded_for(element: &str) -> Option<IpAddr> {
    element.split(';').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        key.trim().eq_ignore_ascii_case("for").then(|| hop(value))
    })?
}

fn hops(headers: &HeaderMap) -> Vec<Option<IpAddr>> {
    let lines = |name: &str, parse: fn(&str) -> Option<IpAddr>| -> Vec<Option<IpAddr>> {
        headers
            .get_all(name)
            .iter()
            .flat_map(|value| match value.to_str() {
                Ok(line) => line.split(',').map(parse).collect(),
                Err(_) => vec![None],
            })
            .collect()
    };
    let xff = lines("x-forwarded-for", hop);
    if !xff.is_empty() {
        return xff;
    }
    if let Some(real) = headers.get("x-real-ip") {
        return vec![real.to_str().ok().and_then(hop)];
    }
    lines(FORWARDED.as_str(), forwarded_for)
}

#[derive(Clone)]
pub struct ClientIp(pub ProxyTrust);

impl KeyExtractor for ClientIp {
    type Key = IpAddr;

    fn extract<T>(&self, req: &Request<T>) -> Result<IpAddr, GovernorError> {
        let peer = req
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip())
            .or_else(|| req.extensions().get::<SocketAddr>().map(|a| a.ip()))
            .ok_or(GovernorError::UnableToExtractKey)?;
        Ok(self.0.client(peer, req.headers()))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn listed(spec: &str) -> ProxyTrust {
        ProxyTrust::from_config(false, Some(spec)).unwrap()
    }

    #[test]
    fn trust_settings_parse() {
        assert_eq!(
            ProxyTrust::from_config(false, None).unwrap(),
            ProxyTrust::Peer
        );
        assert_eq!(
            ProxyTrust::from_config(true, None).unwrap(),
            ProxyTrust::Any
        );
        assert_eq!(
            ProxyTrust::from_config(true, Some(" , ")).unwrap(),
            ProxyTrust::Any
        );
        let trust = ProxyTrust::from_config(true, Some("10.0.0.0/8, 192.0.2.7,fd00::/8")).unwrap();
        assert!(matches!(&trust, ProxyTrust::Listed(c) if c.len() == 3));
        assert!(trust.trusts(ip("10.255.0.1")) && trust.trusts(ip("192.0.2.7")));
        assert!(!trust.trusts(ip("192.0.2.8")) && !trust.trusts(ip("11.0.0.1")));
        assert!(trust.trusts(ip("fd12::1")) && !trust.trusts(ip("fe80::1")));
        assert!(trust.trusts(ip("::ffff:10.1.2.3")));
        assert!(listed("0.0.0.0/0").trusts(ip("203.0.113.1")));
        assert!(!listed("0.0.0.0/0").trusts(ip("2001:db8::1")));
        assert!(listed("::/0").trusts(ip("2001:db8::1")));
        for bad in ["10.0.0.0/33", "nope", "10.0.0.0/", "::/129", "10.0.0.0/8/1"] {
            assert!(ProxyTrust::from_config(false, Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn untrusted_peers_are_keyed_by_their_address() {
        let spoofed = headers(&[
            ("x-forwarded-for", "203.0.113.9"),
            ("x-real-ip", "203.0.113.10"),
            ("forwarded", "for=203.0.113.11"),
        ]);
        assert_eq!(
            ProxyTrust::Peer.client(ip("198.51.100.4"), &spoofed),
            ip("198.51.100.4")
        );
        let trust = listed("10.0.0.0/8");
        assert_eq!(
            trust.client(ip("198.51.100.4"), &spoofed),
            ip("198.51.100.4")
        );
        assert_eq!(
            trust.client(ip("::ffff:198.51.100.4"), &spoofed),
            ip("198.51.100.4")
        );
        assert_eq!(trust.client(ip("10.0.0.2"), &spoofed), ip("203.0.113.9"));
    }

    #[test]
    fn right_most_untrusted_hop_is_the_client() {
        let trust = listed("10.0.0.0/8");
        let chain = headers(&[("x-forwarded-for", "6.6.6.6, 203.0.113.9, 10.0.0.7")]);
        assert_eq!(trust.client(ip("10.0.0.2"), &chain), ip("203.0.113.9"));
        let lines = headers(&[
            ("x-forwarded-for", "6.6.6.6"),
            ("x-forwarded-for", "203.0.113.9"),
        ]);
        assert_eq!(trust.client(ip("10.0.0.2"), &lines), ip("203.0.113.9"));
        let inside = headers(&[("x-forwarded-for", "10.9.9.9, 10.0.0.7")]);
        assert_eq!(trust.client(ip("10.0.0.2"), &inside), ip("10.9.9.9"));
        assert_eq!(
            ProxyTrust::Any.client(ip("10.0.0.2"), &chain),
            ip("6.6.6.6")
        );
        assert_eq!(
            trust.client(ip("10.0.0.2"), &HeaderMap::new()),
            ip("10.0.0.2")
        );
    }

    #[test]
    fn malformed_hops_stop_the_walk() {
        let trust = listed("10.0.0.0/8");
        let peer = ip("10.0.0.2");
        let at = |value: &str| trust.client(peer, &headers(&[("x-forwarded-for", value)]));
        assert_eq!(at("203.0.113.9, garbage"), peer);
        assert_eq!(at("garbage, 203.0.113.9"), ip("203.0.113.9"));
        assert_eq!(at("203.0.113.9, , 10.0.0.7"), ip("10.0.0.7"));
        assert_eq!(at(""), peer);
        assert_eq!(at("unknown"), peer);
        assert_eq!(at("203.0.113.9:4711"), ip("203.0.113.9"));
        assert_eq!(at("[2001:db8::1]:443"), ip("2001:db8::1"));
        assert_eq!(at("[2001:db8::2]"), ip("2001:db8::2"));
        assert_eq!(at("::ffff:203.0.113.9"), ip("203.0.113.9"));
        let mut binary = HeaderMap::new();
        binary.append(
            "x-forwarded-for",
            HeaderValue::from_bytes(b"203.0.113.9\xff").unwrap(),
        );
        binary.append("x-forwarded-for", HeaderValue::from_static("203.0.113.10"));
        assert_eq!(trust.client(peer, &binary), ip("203.0.113.10"));
        binary.append("x-forwarded-for", HeaderValue::from_bytes(b"\xfe").unwrap());
        assert_eq!(trust.client(peer, &binary), peer);
    }

    #[test]
    fn real_ip_and_forwarded_headers() {
        let trust = listed("10.0.0.0/8");
        let peer = ip("10.0.0.2");
        let real = headers(&[("x-real-ip", "203.0.113.9")]);
        assert_eq!(trust.client(peer, &real), ip("203.0.113.9"));
        assert_eq!(trust.client(peer, &headers(&[("x-real-ip", "nope")])), peer);
        let forwarded = headers(&[(
            "forwarded",
            "for=6.6.6.6, for=\"[2001:db8:cafe::17]:4711\";proto=https, for=10.0.0.7;by=10.0.0.2",
        )]);
        assert_eq!(trust.client(peer, &forwarded), ip("2001:db8:cafe::17"));
        assert_eq!(
            trust.client(
                peer,
                &headers(&[("forwarded", "for=_hidden, for=10.0.0.7")])
            ),
            ip("10.0.0.7")
        );
        assert_eq!(
            trust.client(peer, &headers(&[("forwarded", "proto=https")])),
            peer
        );
        let both = headers(&[
            ("x-forwarded-for", "203.0.113.9"),
            ("forwarded", "for=6.6.6.6"),
        ]);
        assert_eq!(trust.client(peer, &both), ip("203.0.113.9"));
        let passed_through =
            headers(&[("x-forwarded-for", "6.6.6.6"), ("x-real-ip", "203.0.113.9")]);
        assert_eq!(trust.client(peer, &passed_through), ip("6.6.6.6"));
    }

    #[test]
    fn extractor_reads_the_connection_peer() {
        let key = ClientIp(listed("127.0.0.0/8"));
        let mut req = Request::builder()
            .header("x-forwarded-for", "203.0.113.9")
            .body(())
            .unwrap();
        assert!(key.extract(&req).is_err());
        req.extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5000))));
        assert_eq!(key.extract(&req).unwrap(), ip("203.0.113.9"));
        let mut direct = Request::builder()
            .header("x-forwarded-for", "203.0.113.9")
            .body(())
            .unwrap();
        direct
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([192, 0, 2, 1], 5000))));
        assert_eq!(key.extract(&direct).unwrap(), ip("192.0.2.1"));
    }
}
