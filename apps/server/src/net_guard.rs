use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::redirect::Policy as Redirects;
use url::{Host, Url};

fn v4_blocked(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || a >= 240
}

/// The IPv4 address an IPv6 address stands for: IPv4-mapped (`::ffff:a.b.c.d`),
/// IPv4-translated (`::ffff:0:a.b.c.d`), NAT64 (`64:ff9b::a.b.c.d`) and 6to4 (`2002:aabb:ccdd::`).
pub(crate) fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    let o = ip.octets();
    let tail = Ipv4Addr::new(o[12], o[13], o[14], o[15]);
    match s {
        [0, 0, 0, 0, 0, 0xffff, _, _] => Some(tail),
        [0, 0, 0, 0, 0xffff, 0, _, _] => Some(tail),
        [0x64, 0xff9b, 0, 0, 0, 0, _, _] => Some(tail),
        [0x2002, _, _, _, _, _, _, _] => Some(Ipv4Addr::new(o[2], o[3], o[4], o[5])),
        _ => None,
    }
}

fn v6_blocked(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let global_unicast = s[0] & 0xe000 == 0x2000;
    !global_unicast
        || s[0] == 0x2001 && s[1] < 0x0200
        || s[0] == 0x2001 && s[1] == 0x0db8
        || s[0] == 0x3fff && s[1] < 0x1000
        || s[0] == 0x2002 && embedded_v4(ip).is_none_or(v4_blocked)
}

/// True when the instance must not talk to this address on anyone's behalf: loopback, private
/// (RFC 1918, ULA), link-local, CGNAT, multicast, unspecified, documentation, reserved and
/// cloud metadata addresses, including IPv4 written as IPv6. Shared by the relay, link
/// previews, identity discovery and outgoing webhooks.
pub fn blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_blocked(v4),
        IpAddr::V6(v6) => match embedded_v4(v6) {
            Some(v4) if v6.segments()[0] != 0x2002 => v4_blocked(v4),
            Some(_) | None => v6_blocked(v6),
        },
    }
}

/// Which URL schemes a request may use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Http {
    /// `http` and `https` for any host.
    Always,
    /// `https` for any host, `http` only for an allowlisted host.
    AllowedHostsOnly,
    /// `https` only.
    Never,
}

/// A host the operator lets through the address check, optionally only on one port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedHost {
    host: String,
    port: Option<u16>,
}

impl AllowedHost {
    /// `host`, `host:port`, `ip`, `ip:port` or `[v6]:port`.
    pub fn parse(spec: &str) -> Option<AllowedHost> {
        let spec = spec.trim().to_lowercase();
        if spec.is_empty() || spec.contains(['/', '@', '?', '#', ' ']) {
            return None;
        }
        if let Ok(ip) = spec.parse::<IpAddr>() {
            return Some(AllowedHost {
                host: ip.to_string(),
                port: None,
            });
        }
        let (host, port) = match spec.strip_prefix('[') {
            Some(rest) => {
                let (inside, after) = rest.split_once(']')?;
                let port = match after {
                    "" => None,
                    p => Some(p.strip_prefix(':')?),
                };
                (format!("[{inside}]"), port)
            }
            None => match spec.split_once(':') {
                Some((h, p)) => (h.to_string(), Some(p)),
                None => (spec.clone(), None),
            },
        };
        let port = match port {
            Some(p) => Some(p.parse::<u16>().ok().filter(|p| *p != 0)?),
            None => None,
        };
        let host = match Host::parse(&host).ok()? {
            Host::Domain(d) => d.trim_end_matches('.').to_string(),
            Host::Ipv4(ip) => ip.to_string(),
            Host::Ipv6(ip) => ip.to_string(),
        };
        Some(AllowedHost { host, port })
    }

    /// Whether the entry lets every port of the host through.
    pub fn any_port(&self) -> bool {
        self.port.is_none()
    }

    fn matches(&self, host: &str, port: u16) -> bool {
        self.host == host && self.port.is_none_or(|p| p == port)
    }
}

impl std::fmt::Display for AllowedHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.port {
            Some(p) => write!(f, "{}:{p}", self.host),
            None => f.write_str(&self.host),
        }
    }
}

/// What outbound requests of one kind may reach.
#[derive(Clone, Debug)]
pub struct Policy {
    pub http: Http,
    /// Only ports 80 and 443.
    pub web_ports_only: bool,
    /// Hosts that skip the address check (and may use `http` under `AllowedHostsOnly`).
    pub allowed: Vec<AllowedHost>,
    /// The instance's own public addresses, refused like private ones.
    pub own: Vec<IpAddr>,
    /// The instance's own host names (lowercase, no trailing dot), refused like its addresses.
    pub own_hosts: Vec<String>,
}

impl Policy {
    /// Link previews: http or https on the web ports, public addresses only.
    pub fn previews() -> Policy {
        Policy {
            http: Http::Always,
            web_ports_only: true,
            allowed: Vec::new(),
            own: Vec::new(),
            own_hosts: Vec::new(),
        }
    }

    fn allowed_host(&self, host: &str, port: u16) -> bool {
        self.allowed.iter().any(|a| a.matches(host, port))
    }

    fn address_ok(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        !blocked(ip) && !self.own.iter().any(|o| o.to_canonical() == ip)
    }
}

/// Why a URL was refused. The texts are plain ASCII and safe to show to whoever entered the URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Scheme,
    Port,
    Address,
    Lookup,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::Scheme => "URL must use https",
            Refusal::Port => "Port not allowed",
            Refusal::Address => "Address not allowed",
            Refusal::Lookup => "Host could not be resolved",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for Refusal {}

/// The addresses a checked URL may be fetched from. A domain is pinned to exactly these, so
/// a second DNS answer can never point the request somewhere else.
#[derive(Clone, Debug)]
pub struct Checked {
    domain: Option<String>,
    addrs: Vec<SocketAddr>,
}

fn host_key(url: &Url) -> Option<String> {
    match url.host()? {
        Host::Domain(d) => Some(d.trim_end_matches('.').to_lowercase()),
        Host::Ipv4(ip) => Some(ip.to_string()),
        Host::Ipv6(ip) => Some(ip.to_string()),
    }
}

/// Checks `url` against `policy` and resolves it once. Every resolved address must pass (an
/// allowlisted host skips the address check).
pub async fn check(url: &Url, policy: &Policy) -> Result<Checked, Refusal> {
    let host = host_key(url).ok_or(Refusal::Address)?;
    let port = url.port_or_known_default().ok_or(Refusal::Port)?;
    let allowed = policy.allowed_host(&host, port);
    match (url.scheme(), policy.http, allowed) {
        ("https", _, _) => {}
        ("http", Http::Always, _) | ("http", Http::AllowedHostsOnly, true) => {}
        (_, _, _) => return Err(Refusal::Scheme),
    }
    if policy.web_ports_only && port != 80 && port != 443 {
        return Err(Refusal::Port);
    }
    if port == 0 {
        return Err(Refusal::Port);
    }
    if !allowed && policy.own_hosts.contains(&host) {
        return Err(Refusal::Address);
    }
    let ok = |ip: IpAddr| allowed || policy.address_ok(ip);
    match url.host() {
        Some(Host::Ipv4(ip)) if ok(IpAddr::V4(ip)) => Ok(Checked {
            domain: None,
            addrs: Vec::new(),
        }),
        Some(Host::Ipv6(ip)) if ok(IpAddr::V6(ip)) => Ok(Checked {
            domain: None,
            addrs: Vec::new(),
        }),
        Some(Host::Domain(domain)) => {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((domain, port))
                .await
                .map_err(|_| Refusal::Lookup)?
                .collect();
            match !addrs.is_empty() && addrs.iter().all(|a| ok(a.ip())) {
                true => Ok(Checked {
                    domain: Some(domain.to_string()),
                    addrs,
                }),
                false => Err(Refusal::Address),
            }
        }
        _ => Err(Refusal::Address),
    }
}

impl Checked {
    /// A client that reaches only the checked addresses, follows no redirects and uses no proxy.
    pub fn client(&self, timeout: Duration, connect: Duration) -> reqwest::Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .redirect(Redirects::none())
            .no_proxy()
            .connect_timeout(connect)
            .timeout(timeout);
        if let Some(domain) = &self.domain {
            builder = builder.resolve_to_addrs(domain, &self.addrs);
        }
        builder.build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn webhooks(allowed: &[&str], http: Http) -> Policy {
        Policy {
            http,
            web_ports_only: false,
            allowed: allowed
                .iter()
                .map(|a| AllowedHost::parse(a).expect("host"))
                .collect(),
            own: vec!["203.0.113.7".parse().expect("ip")],
            own_hosts: vec!["chat.example.org".to_string()],
        }
    }

    async fn verdict(url: &str, policy: &Policy) -> Result<(), Refusal> {
        check(&Url::parse(url).expect("url"), policy)
            .await
            .map(|_| ())
    }

    #[tokio::test]
    async fn the_outbound_guard_table() {
        let strict = webhooks(&[], Http::Never);
        let cases: &[(&str, Result<(), Refusal>)] = &[
            ("https://93.184.216.34/hook", Ok(())),
            ("https://93.184.216.34:8443/hook", Ok(())),
            ("http://93.184.216.34/hook", Err(Refusal::Scheme)),
            ("ftp://93.184.216.34/hook", Err(Refusal::Scheme)),
            ("https://127.0.0.1/hook", Err(Refusal::Address)),
            ("https://10.0.0.1/hook", Err(Refusal::Address)),
            ("https://192.168.1.1/hook", Err(Refusal::Address)),
            ("https://172.16.0.1/hook", Err(Refusal::Address)),
            ("https://169.254.169.254/latest", Err(Refusal::Address)),
            ("https://100.64.0.1/", Err(Refusal::Address)),
            ("https://0.0.0.0/", Err(Refusal::Address)),
            ("https://[::1]/", Err(Refusal::Address)),
            ("https://[fe80::1]/", Err(Refusal::Address)),
            ("https://[fd00::1]/", Err(Refusal::Address)),
            ("https://[::ffff:127.0.0.1]/", Err(Refusal::Address)),
            ("https://[::ffff:0:7f00:1]/", Err(Refusal::Address)),
            ("https://[64:ff9b::a9fe:a9fe]/", Err(Refusal::Address)),
            ("https://[2002:7f00:1::1]/", Err(Refusal::Address)),
            ("https://203.0.113.7/", Err(Refusal::Address)),
            (
                "https://chat.example.org/api/webhooks/1/x",
                Err(Refusal::Address),
            ),
            ("https://CHAT.example.org./x", Err(Refusal::Address)),
            ("https://[2606:4700::1111]/", Ok(())),
            ("https://localhost/hook", Err(Refusal::Address)),
        ];
        for (url, want) in cases {
            assert_eq!(verdict(url, &strict).await, *want, "{url}");
        }
        let local = webhooks(&["127.0.0.1:3442"], Http::AllowedHostsOnly);
        assert_eq!(verdict("http://127.0.0.1:3442/in", &local).await, Ok(()));
        assert_eq!(verdict("https://127.0.0.1:3442/in", &local).await, Ok(()));
        assert_eq!(
            verdict("http://127.0.0.1:3443/in", &local).await,
            Err(Refusal::Scheme)
        );
        assert_eq!(
            verdict("https://127.0.0.1:3443/in", &local).await,
            Err(Refusal::Address)
        );
        assert_eq!(
            verdict("http://93.184.216.34/hook", &local).await,
            Err(Refusal::Scheme)
        );
        let https_only = webhooks(&["127.0.0.1"], Http::Never);
        assert_eq!(
            verdict("http://127.0.0.1:3442/in", &https_only).await,
            Err(Refusal::Scheme)
        );
        assert_eq!(verdict("https://127.0.0.1:9/in", &https_only).await, Ok(()));
        let previews = Policy::previews();
        assert_eq!(verdict("http://93.184.216.34/", &previews).await, Ok(()));
        assert_eq!(
            verdict("https://93.184.216.34:8443/", &previews).await,
            Err(Refusal::Port)
        );
    }

    #[test]
    fn allowlist_entries_parse() {
        let a = AllowedHost::parse("Hooks.Example.COM").expect("domain");
        assert!(a.matches("hooks.example.com", 443));
        assert!(a.matches("hooks.example.com", 8080));
        let b = AllowedHost::parse("127.0.0.1:3442").expect("ip port");
        assert!(b.matches("127.0.0.1", 3442));
        assert!(!b.matches("127.0.0.1", 3443));
        let c = AllowedHost::parse("[::1]:8080").expect("v6 port");
        assert!(c.matches("::1", 8080));
        let d = AllowedHost::parse("::1").expect("bare v6");
        assert!(d.matches("::1", 1));
        assert!(AllowedHost::parse("").is_none());
        assert!(AllowedHost::parse("a/b").is_none());
        assert!(AllowedHost::parse("user@host").is_none());
    }
}
