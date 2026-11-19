use std::net::{IpAddr, TcpListener};
use std::ops::RangeInclusive;

pub const DEFAULT: u16 = 3470;
// Offered at setup when the default port is taken.
const SPARE: RangeInclusive<u16> = 3471..=3499;
const ALLOWED: RangeInclusive<u16> = 1024..=65535;

pub fn validate(port: u16) -> Result<(), String> {
    if ALLOWED.contains(&port) {
        Ok(())
    } else {
        Err(format!(
            "Pick a port from {} to {}.",
            ALLOWED.start(),
            ALLOWED.end()
        ))
    }
}

// Other people's apps depend on the port, so a taken one is an error and nothing moves.
pub fn in_use(port: u16) -> String {
    format!("Port {port} is in use. Pick another port.")
}

// Only a port something listens on counts as taken. Whatever else stops a listener here is
// left for the server to report.
pub fn is_free(host: &str, port: u16) -> bool {
    let Ok(ip) = host.parse::<IpAddr>() else {
        return true;
    };
    match TcpListener::bind((ip, port)) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::AddrInUse,
    }
}

pub fn first_free(host: &str, ports: impl IntoIterator<Item = u16>) -> Option<u16> {
    ports.into_iter().find(|port| is_free(host, *port))
}

// The port a new server gets.
pub fn propose(host: &str) -> Option<u16> {
    first_free(host, std::iter::once(DEFAULT).chain(SPARE))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: &str = "127.0.0.1";

    fn taken() -> (TcpListener, u16) {
        let listener = TcpListener::bind((LOCAL, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        (listener, port)
    }

    #[test]
    fn ports_below_1024_are_refused() {
        for port in [0, 1, 80, 443, 1023] {
            assert_eq!(
                validate(port),
                Err("Pick a port from 1024 to 65535.".to_string()),
                "{port}"
            );
        }
        for port in [1024, 3470, 65535] {
            assert_eq!(validate(port), Ok(()), "{port}");
        }
    }

    #[test]
    fn a_taken_port_is_named() {
        assert_eq!(in_use(3470), "Port 3470 is in use. Pick another port.");
    }

    #[test]
    fn a_port_is_free_until_something_listens_on_it() {
        let (listener, port) = taken();
        assert!(!is_free(LOCAL, port));
        drop(listener);
        assert!(is_free(LOCAL, port));
    }

    #[test]
    fn the_first_free_port_skips_taken_ones() {
        let (_first, a) = taken();
        let (second, b) = taken();
        let (_third, c) = taken();
        assert_eq!(first_free(LOCAL, [a, b, c]), None);
        drop(second);
        assert_eq!(first_free(LOCAL, [a, b, c]), Some(b));
    }

    #[test]
    fn a_host_that_is_no_address_counts_as_free() {
        assert!(is_free("not an address", 3470));
    }
}
