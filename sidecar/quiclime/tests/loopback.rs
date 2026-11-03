//! The whole transport, against a relay that speaks quiclime.
//!
//! The protocol framing is checked in the launcher's own test suite, where it
//! needs no network. What cannot be checked there is the part that only exists
//! here: that the QUIC handshake is accepted with the right ALPN, that the
//! first stream opened is the control stream and carries the two messages the
//! relay expects, that an assigned domain is reported, and -- the point of the
//! whole program -- that a stream the relay opens is spliced onto a TCP
//! connection to the game with the player's first bytes intact.
//!
//! So this is a relay. A small one, standing in for e4mc's: its own
//! certificate, the same ALPN, the same framing in both directions, and the
//! same one-bidirectional-stream-towards-the-host limit the real one sets. The
//! sidecar is run as the launcher runs it, as a child process read line by
//! line.
//!
//! Nothing here touches e4mc. Their relays are somebody else's machines and
//! are not a test fixture.

use std::io::{BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A control message as the HOST sends them: varint length, then JSON.
fn read_host_frame(buf: &[u8], at: &mut usize) -> Option<String> {
    let mut len: u32 = 0;
    for i in 0..5 {
        let byte = *buf.get(*at + i)?;
        len |= ((byte & 0x7f) as u32) << (7 * i);
        if byte & 0x80 == 0 {
            *at += i + 1;
            let end = *at + len as usize;
            let body = buf.get(*at..end)?;
            *at = end;
            return Some(String::from_utf8_lossy(body).to_string());
        }
    }
    None
}

/// A reply as the RELAY sends them: one raw byte of length, then JSON.
fn relay_frame(json: &str) -> Vec<u8> {
    let body = json.as_bytes();
    assert!(body.len() <= 255, "a relay reply cannot exceed one byte of length");
    let mut out = Vec::with_capacity(body.len() + 1);
    out.push(body.len() as u8);
    out.extend_from_slice(body);
    out
}

fn varint(mut value: u32) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        if value & !0x7f == 0 {
            out.push(value as u8);
            return out;
        }
        out.push(((value & 0x7f) | 0x80) as u8);
        value >>= 7;
    }
}

/// The handshake packet the relay replays onto a player's stream.
fn handshake(address: &str, port: u16, next_state: u32) -> Vec<u8> {
    let addr = address.as_bytes();
    let mut body = Vec::new();
    body.extend_from_slice(&varint(0)); // packet id
    body.extend_from_slice(&varint(767)); // protocol version
    body.extend_from_slice(&varint(addr.len() as u32));
    body.extend_from_slice(addr);
    body.extend_from_slice(&port.to_be_bytes());
    body.extend_from_slice(&varint(next_state));
    let mut out = varint(body.len() as u32);
    out.extend_from_slice(&body);
    out
}

struct Sidecar {
    child: Child,
    lines: mpsc::Receiver<String>,
    _stdin: std::process::ChildStdin,
}

impl Sidecar {
    /// Wait for a line whose "type" is `want`, reporting everything seen if it
    /// does not arrive.
    fn wait_for(&mut self, want: &str, within: Duration) -> serde_json::Value {
        let mut seen = Vec::new();
        let deadline = std::time::Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                panic!("never saw a {want:?} line. What it did say: {seen:?}");
            }
            match self.lines.recv_timeout(left) {
                Ok(line) => {
                    let value: serde_json::Value = serde_json::from_str(&line)
                        .unwrap_or_else(|e| panic!("stdout is meant to be one JSON object per line, got {line:?} ({e})"));
                    if value.get("type").and_then(|t| t.as_str()) == Some("error") {
                        panic!("the sidecar failed: {line}");
                    }
                    if value.get("type").and_then(|t| t.as_str()) == Some(want) {
                        return value;
                    }
                    seen.push(line);
                }
                Err(_) => panic!("never saw a {want:?} line. What it did say: {seen:?}"),
            }
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_sidecar(relay: SocketAddr, game_port: u16, ca: &std::path::Path) -> Sidecar {
    let mut child = Command::new(env!("CARGO_BIN_EXE_quiclime"))
        .args([
            "--relay", &relay.to_string(),
            "--sni", "localhost",
            "--ca", ca.to_str().unwrap(),
            "--local-port", &game_port.to_string(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the sidecar should be built before this runs");

    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if tx.send(l).is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(_) => return,
            }
        }
    });
    // Held open: the sidecar stops when its stdin closes, which is how it
    // notices the launcher has gone.
    let stdin = child.stdin.take().unwrap();
    Sidecar { child, lines: rx, _stdin: stdin }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_player_reaches_the_game() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    // ── a relay of our own ──
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert_pem = issued.cert.pem();
    let key_pem = issued.key_pair.serialize_pem();
    let dir = std::env::temp_dir().join(format!("quiclime-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ca_path = dir.join("ca.pem");
    std::fs::write(&ca_path, cert_pem.as_bytes()).unwrap();

    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes()).unwrap().unwrap();

    let mut crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .unwrap();
    // The one thing that has to match, or the handshake is refused.
    crypto.alpn_protocols = vec![b"quiclime".to_vec()];

    let mut server = quinn::ServerConfig::with_crypto(Arc::new(
        quinn::crypto::rustls::QuicServerConfig::try_from(crypto).unwrap(),
    ));
    // Exactly what the real relay allows towards itself: one stream, which is
    // the control stream, and no unidirectional ones at all.
    let mut transport = quinn::TransportConfig::default();
    transport.max_concurrent_bidi_streams(1u32.into());
    transport.max_concurrent_uni_streams(0u32.into());
    server.transport_config(Arc::new(transport));

    let endpoint = quinn::Endpoint::server(server, "127.0.0.1:0".parse().unwrap()).unwrap();
    let relay_addr = endpoint.local_addr().unwrap();

    // ── and a game for players to land on ──
    let game = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let game_port = game.local_addr().unwrap().port();

    let mut side = spawn_sidecar(relay_addr, game_port, &ca_path);

    // ── the connection ──
    let incoming = tokio::time::timeout(Duration::from_secs(20), endpoint.accept())
        .await
        .expect("the sidecar never dialled us")
        .expect("no connection");
    let conn = incoming.await.expect("the QUIC handshake failed");
    assert_eq!(
        conn.handshake_data()
            .unwrap()
            .downcast::<quinn::crypto::rustls::HandshakeData>()
            .unwrap()
            .protocol
            .as_deref(),
        Some(&b"quiclime"[..]),
        "the relay only accepts the quiclime ALPN"
    );
    side.wait_for("connected", Duration::from_secs(5));

    // ── the control stream is the first one it opens ──
    let (mut ctl_send, mut ctl_recv) = tokio::time::timeout(Duration::from_secs(10), conn.accept_bi())
        .await
        .expect("no control stream")
        .expect("control stream failed");

    // Both messages arrive together: the host writes them back to back.
    let mut buf = vec![0u8; 512];
    let mut filled = 0usize;
    let mut asked = Vec::new();
    while asked.len() < 2 {
        let n = tokio::time::timeout(Duration::from_secs(10), ctl_recv.read(&mut buf[filled..]))
            .await
            .expect("the host said nothing")
            .expect("control read failed")
            .expect("control stream ended");
        filled += n;
        let mut at = 0usize;
        asked.clear();
        while let Some(frame) = read_host_frame(&buf[..filled], &mut at) {
            asked.push(frame);
        }
    }
    assert_eq!(
        asked[0], r#"{"kind":"probe_capabilities"}"#,
        "the host asks what the relay can do first"
    );
    assert_eq!(
        asked[1], r#"{"kind":"request_domain_assignment"}"#,
        "and then asks for a hostname"
    );

    // ── and it is told one ──
    ctl_send
        .write_all(&relay_frame(r#"{"kind":"has_capabilities","caps":["dialtone_sidecar"]}"#))
        .await
        .unwrap();
    ctl_send
        .write_all(&relay_frame(r#"{"kind":"domain_assignment_complete","domain":"abcde.e4mc.link"}"#))
        .await
        .unwrap();

    let caps = side.wait_for("capabilities", Duration::from_secs(10));
    assert_eq!(caps["caps"][0], "dialtone_sidecar");
    let domain = side.wait_for("domain", Duration::from_secs(10));
    assert_eq!(
        domain["domain"], "abcde.e4mc.link",
        "the assigned hostname is what the launcher shows people"
    );

    // ── a broadcast long enough to set the top bit of the length byte ──
    //
    // 0xC8 is 200. Read signed it is -56, and read as a varint it swallows the
    // next byte -- which is what both existing clients do.
    let padding = "x".repeat(200 - r#"{"kind":"request_message_broadcast","message":""}"#.len());
    let long = format!(r#"{{"kind":"request_message_broadcast","message":"{padding}"}}"#);
    assert_eq!(long.len(), 200);
    ctl_send.write_all(&relay_frame(&long)).await.unwrap();
    let broadcast = side.wait_for("broadcast", Duration::from_secs(10));
    assert_eq!(
        broadcast["message"].as_str().unwrap().len(),
        padding.len(),
        "a reply of 128 bytes or more is a length, not a negative number"
    );

    // ── a player ──
    let (mut p_send, mut p_recv) = conn.open_bi().await.expect("the relay opens a stream per player");
    let opening = handshake("abcde.e4mc.link", 25565, 2);
    p_send.write_all(&opening).await.unwrap();
    p_send.write_all(b"hello from the player").await.unwrap();

    let (mut sock, _) = tokio::time::timeout(Duration::from_secs(15), game.accept())
        .await
        .expect("the player never reached the game")
        .unwrap();

    // Everything the player sent, the handshake packet included and unaltered.
    let mut want = opening.clone();
    want.extend_from_slice(b"hello from the player");
    let mut got = vec![0u8; want.len()];
    tokio::time::timeout(Duration::from_secs(15), sock.read_exact(&mut got))
        .await
        .expect("the game never got the player's bytes")
        .unwrap();
    assert_eq!(
        got, want,
        "the handshake is forwarded byte for byte -- a byte out and the session is broken"
    );

    let arrival = side.wait_for("player", Duration::from_secs(10));
    assert_eq!(arrival["state"], "login", "this one is somebody joining, not a server-list ping");
    assert_eq!(arrival["address"], "abcde.e4mc.link");

    // ── and the game answering ──
    sock.write_all(b"welcome").await.unwrap();
    let mut back = [0u8; 7];
    tokio::time::timeout(Duration::from_secs(15), p_recv.read_exact(&mut back))
        .await
        .expect("the game's answer never came back down the stream")
        .unwrap();
    assert_eq!(&back, b"welcome", "and the other direction carries too");

    std::fs::remove_dir_all(&dir).ok();
}

/// A relay that offers a different ALPN is not a quiclime relay, and the
/// sidecar must not quietly carry on with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_wrong_alpn_is_refused() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert_pem = issued.cert.pem();
    let key_pem = issued.key_pair.serialize_pem();
    let dir = std::env::temp_dir().join(format!("quiclime-alpn-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ca_path = dir.join("ca.pem");
    std::fs::write(&ca_path, cert_pem.as_bytes()).unwrap();

    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes()).unwrap().unwrap();
    let mut crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .unwrap();
    crypto.alpn_protocols = vec![b"h3".to_vec()]; // not quiclime

    let server = quinn::ServerConfig::with_crypto(Arc::new(
        quinn::crypto::rustls::QuicServerConfig::try_from(crypto).unwrap(),
    ));
    let endpoint = quinn::Endpoint::server(server, "127.0.0.1:0".parse().unwrap()).unwrap();
    let relay_addr = endpoint.local_addr().unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_quiclime"))
        .args([
            "--relay", &relay_addr.to_string(),
            "--sni", "localhost",
            "--ca", ca_path.to_str().unwrap(),
            "--local-port", "25565",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    tokio::spawn(async move {
        if let Some(incoming) = endpoint.accept().await {
            let _ = incoming.await;
        }
    });

    let mut said = String::new();
    let mut reader = BufReader::new(stdout);
    // It should say it failed rather than report a connection.
    let _ = reader.read_line(&mut said);
    let value: serde_json::Value = serde_json::from_str(said.trim()).unwrap_or(serde_json::json!({}));
    assert_eq!(
        value.get("type").and_then(|t| t.as_str()),
        Some("error"),
        "a relay that will not speak quiclime is an error, not something to continue with. It said: {said:?}"
    );

    let _ = stdin.write_all(b"\n");
    let _ = child.kill();
    let _ = child.wait();
    std::fs::remove_dir_all(&dir).ok();
}
