//! One address: the server binary with default settings listens on one TCP port and holds no UDP
//! socket. The relay's own switch is what opens more.
#![cfg(target_os = "linux")]

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const LISTEN: &str = "0A";

struct Server {
    child: Child,
    dir: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[derive(Debug)]
struct Open {
    listeners: Vec<u16>,
    udp: Vec<u16>,
}

/// The local ports of the sockets in a `/proc/<pid>/net` table that `pid` holds, in `state` when
/// one is given.
fn ports(pid: u32, table: &str, held: &HashSet<u64>, state: Option<&str>) -> Vec<u16> {
    let rows = fs::read_to_string(format!("/proc/{pid}/net/{table}")).unwrap_or_default();
    rows.lines()
        .skip(1)
        .filter_map(|row| {
            let cols: Vec<&str> = row.split_whitespace().collect();
            let inode: u64 = cols.get(9)?.parse().ok()?;
            let wanted = match state {
                Some(state) => cols.get(3) == Some(&state),
                None => true,
            };
            let (_, port) = cols.get(1)?.rsplit_once(':')?;
            match held.contains(&inode) && wanted {
                true => u16::from_str_radix(port, 16).ok(),
                false => None,
            }
        })
        .collect()
}

fn open(server: &Server) -> Open {
    let pid = server.child.id();
    let held: HashSet<u64> = fs::read_dir(format!("/proc/{pid}/fd"))
        .expect("the server's descriptors")
        .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
        .filter_map(|link| {
            link.to_str()?
                .strip_prefix("socket:[")?
                .strip_suffix(']')?
                .parse()
                .ok()
        })
        .collect();
    let mut listeners = ports(pid, "tcp", &held, Some(LISTEN));
    listeners.extend(ports(pid, "tcp6", &held, Some(LISTEN)));
    let mut udp = ports(pid, "udp", &held, None);
    udp.extend(ports(pid, "udp6", &held, None));
    listeners.sort_unstable();
    udp.sort_unstable();
    Open { listeners, udp }
}

fn healthy(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let asked = stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    asked.is_ok() && answer.starts_with("HTTP/1.1 200")
}

/// The server binary with only a database path, a free port and `settings`, once it answers.
fn start(name: &str, settings: &[(&str, &str)]) -> Server {
    let dir = std::env::temp_dir().join(format!("rchat-one-port-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a scratch directory");
    let log = fs::File::create(dir.join("log")).expect("a log file");
    let child = Command::new(env!("CARGO_BIN_EXE_server"))
        .current_dir(&dir)
        .env_clear()
        .env("DATABASE_URL", dir.join("one.db"))
        .env("SERVER_PORT", "0")
        .envs(settings.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .expect("the server binary starts");
    let mut server = Server { child, dir };
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let said = || fs::read_to_string(server.dir.join("log")).unwrap_or_default();
        match server.child.try_wait().expect("the server's state") {
            Some(status) => panic!("the server ended with {status}: {}", said()),
            None if Instant::now() > deadline => panic!("the server never answered: {}", said()),
            None => {}
        }
        if open(&server).listeners.iter().any(|port| healthy(*port)) {
            return server;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn free_udp_port() -> u16 {
    loop {
        let socket = UdpSocket::bind("0.0.0.0:0").expect("udp");
        let port = socket.local_addr().expect("addr").port();
        if !(rust_next::relay::DEFAULT_MIN_PORT..=rust_next::relay::DEFAULT_MAX_PORT)
            .contains(&port)
        {
            return port;
        }
    }
}

#[test]
fn a_default_server_listens_on_one_tcp_port_and_only_the_relay_opens_more() {
    let server = start("default", &[]);
    let Open { listeners, udp } = open(&server);
    assert_eq!(listeners.len(), 1, "TCP listeners: {listeners:?}");
    assert_eq!(udp, Vec::<u16>::new(), "UDP sockets");
    drop(server);

    // The other switches of an instance open nothing: only the relay's own does.
    let server = start(
        "switches",
        &[
            ("PUBLIC_URL", "https://chat.example.com"),
            ("PUBLIC_STUN", "true"),
            ("PEERJS_PORT", "9001"),
            ("RELAY_PUBLIC_IP", "203.0.113.10"),
        ],
    );
    let Open { listeners, udp } = open(&server);
    assert_eq!(listeners.len(), 1, "TCP listeners: {listeners:?}");
    assert_eq!(udp, Vec::<u16>::new(), "UDP sockets");
    drop(server);

    let relay = free_udp_port();
    let server = start(
        "relay",
        &[
            ("RELAY_ENABLED", "true"),
            ("RELAY_PUBLIC_IP", "203.0.113.10"),
            ("RELAY_PORT", &relay.to_string()),
        ],
    );
    let Open { listeners, udp } = open(&server);
    assert_eq!(listeners.len(), 1, "TCP listeners: {listeners:?}");
    assert_eq!(udp, [relay], "the relay's UDP port");
}
