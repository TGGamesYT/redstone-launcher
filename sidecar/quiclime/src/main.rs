//! A quiclime host, for a launcher that cannot speak QUIC.
//!
//! e4mc shares a world over the internet without port forwarding: the host
//! dials a relay, the relay hands back a public hostname, and each player who
//! connects to that hostname arrives back down the same QUIC connection as a
//! new stream. This program is the host side of that, and nothing else.
//!
//! It exists because Electron cannot do it. Node ships QUIC as a build-time
//! option that is off in every release build, so there is no `node:quic` to
//! use, and Chromium's WebTransport only offers HTTP/3's ALPN, which the relay
//! will not accept. So the launcher runs this, tells it a relay and a local
//! port, and reads what happened on stdout.
//!
//! ## Talking to it
//!
//! Arguments: `--relay <host:port> --local-port <n>` and optionally
//! `--sni <name>` when the name to validate the certificate against is not the
//! one being dialled.
//!
//! stdout is one JSON object per line, and nothing else is ever written there:
//!
//! ```text
//! {"type":"connected","relay":"eu.e4mc.link:25575"}
//! {"type":"capabilities","caps":["dialtone_sidecar"]}
//! {"type":"domain","domain":"abcde.e4mc.link"}
//! {"type":"broadcast","message":"..."}
//! {"type":"player","state":"login","address":"abcde.e4mc.link"}
//! {"type":"closed","reason":"..."}
//! {"type":"error","error":"..."}
//! ```
//!
//! Anything else -- logs, warnings -- goes to stderr, so the launcher can
//! parse stdout line by line without having to tell the two apart.
//!
//! It stops when its stdin closes. That is how it notices the launcher has
//! gone: a tunnel outliving the thing that opened it would leave a world
//! published with nobody able to close it.
//!
//! ## The wire format
//!
//! The first bidirectional stream the host opens is the control stream. The
//! host's messages on it are a varint length then JSON; the relay's are ONE
//! RAW BYTE of length then JSON. Each player is a bidirectional stream the
//! relay opens, beginning with the Minecraft handshake packet that player
//! sent, after which it is raw bytes in both directions -- so a stream is
//! spliced straight onto a TCP connection to the game.
//!
//! Written from the relay's own source (vgskye/e4mc-quiclime, Apache-2.0 OR
//! MIT) and the mod's client (MIT). The protocol is theirs; this code is not
//! a copy of either.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use quinn::{ClientConfig, Connection, Endpoint, RecvStream, SendStream, TransportConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// How often to send `probe_capabilities` so the relay knows we are here, and
/// how many may go unanswered before the connection is treated as dead. The
/// relay answers every probe, so silence means it has gone.
const KEEPALIVE: Duration = Duration::from_secs(15);
const MISSED_ALLOWED: u32 = 3;

/// The relay refuses a message longer than this, and a reply is length-
/// prefixed with a single byte, so one can never exceed 255.
const MAX_REPLY: usize = 255;

/// One JSON object per line on stdout. Serialising by hand keeps this to one
/// dependency fewer and the shapes are fixed.
fn emit(value: serde_json::Value) {
    println!("{value}");
    use std::io::Write;
    let _ = std::io::stdout().flush();
}

fn fail(message: &str) -> ! {
    emit(serde_json::json!({ "type": "error", "error": message }));
    std::process::exit(1);
}

// ── the wire format ────────────────────────────────────────────────────────

fn write_varint(out: &mut Vec<u8>, mut value: u32) {
    loop {
        if value & !0x7f == 0 {
            out.push(value as u8);
            return;
        }
        out.push(((value & 0x7f) | 0x80) as u8);
        value >>= 7;
    }
}

/// A control message for the relay: varint length, then the JSON.
fn control_frame(json: &str) -> Vec<u8> {
    let body = json.as_bytes();
    let mut out = Vec::with_capacity(body.len() + 5);
    write_varint(&mut out, body.len() as u32);
    out.extend_from_slice(body);
    out
}

const PROBE: &str = r#"{"kind":"probe_capabilities"}"#;
const REQUEST_DOMAIN: &str = r#"{"kind":"request_domain_assignment"}"#;

/// Read one reply: a single unsigned byte of length, then that many bytes of
/// JSON. The byte is a length, not a varint and not a signed number -- both
/// existing clients get that wrong, and a reply of 128 bytes or more is
/// misread by both.
async fn read_reply(recv: &mut RecvStream) -> std::io::Result<Option<serde_json::Value>> {
    let mut len = [0u8; 1];
    match recv.read_exact(&mut len).await {
        Ok(()) => {}
        Err(_) => return Ok(None), // the stream ended
    }
    let want = len[0] as usize;
    if want == 0 {
        return Ok(Some(serde_json::Value::Null));
    }
    let mut body = vec![0u8; want.min(MAX_REPLY)];
    if recv.read_exact(&mut body).await.is_err() {
        return Ok(None);
    }
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => Ok(Some(v)),
        // Not something to close the connection over; the relay said something
        // we do not understand and the rest of the stream is still good.
        Err(_) => Ok(Some(serde_json::json!({ "kind": "__unparseable" }))),
    }
}

/// Read the handshake packet a player's stream opens with, far enough to say
/// who arrived and whether this is a join or the server list asking for a
/// ping. The bytes are handed on untouched either way -- the game is what
/// actually parses them.
/// Read a varint at `*at`, moving it past what was read.
fn take_varint(buf: &[u8], at: &mut usize) -> Option<u32> {
    let mut value: u32 = 0;
    for i in 0..5 {
        let byte = *buf.get(*at + i)?;
        value |= ((byte & 0x7f) as u32) << (7 * i);
        if byte & 0x80 == 0 {
            *at += i + 1;
            return Some(value);
        }
    }
    None
}

fn peek_handshake(buf: &[u8]) -> Option<(String, &'static str)> {
    let mut at = 0usize;
    let _total = take_varint(buf, &mut at)?;
    if take_varint(buf, &mut at)? != 0 {
        return None; // not a handshake packet
    }
    let _protocol = take_varint(buf, &mut at)?;
    let addr_len = take_varint(buf, &mut at)? as usize;
    let addr = buf.get(at..at + addr_len)?;
    at += addr_len;
    at = at.checked_add(2)?; // the port, big-endian, which we do not need
    let state = take_varint(buf, &mut at)?;
    let mut address = String::from_utf8_lossy(addr).to_string();
    // Forge appends one of three markers to the address it sends.
    for marker in ["\0FML3\0", "\0FML2\0", "\0FML\0"] {
        if let Some(stripped) = address.strip_suffix(marker) {
            address = stripped.to_string();
            break;
        }
    }
    Some((address, if state == 1 { "status" } else { "login" }))
}

// ── one player ─────────────────────────────────────────────────────────────

/// Splice a relay-opened stream onto a connection to the game.
///
/// The first bytes are the player's handshake packet, which is read only to
/// report the arrival; everything, that packet included, is written to the
/// game untouched. Getting that wrong by even a byte would break the session,
/// so nothing is reconstructed -- what arrived is what is forwarded.
async fn serve_player(mut send: SendStream, mut recv: RecvStream, local_port: u16) {
    let mut opening = Vec::new();
    let mut chunk = [0u8; 2048];

    // Enough of the stream to find the end of the handshake packet, or a
    // couple of reads, whichever comes first. A handshake is well under 512
    // bytes; the relay caps it there too.
    for _ in 0..4 {
        match recv.read(&mut chunk).await {
            Ok(Some(0)) | Ok(None) => break,
            Ok(Some(n)) => {
                opening.extend_from_slice(&chunk[..n]);
                if peek_handshake(&opening).is_some() || opening.len() >= 512 {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    match peek_handshake(&opening) {
        Some((address, state)) => emit(serde_json::json!({
            "type": "player", "state": state, "address": address
        })),
        None => emit(serde_json::json!({ "type": "player", "state": "unknown" })),
    }

    let target: SocketAddr = ([127, 0, 0, 1], local_port).into();
    let mut game = match TcpStream::connect(target).await {
        Ok(s) => s,
        Err(e) => {
            emit(serde_json::json!({
                "type": "refused", "error": format!("the game is not listening on {local_port}: {e}")
            }));
            let _ = send.finish();
            return;
        }
    };
    let _ = game.set_nodelay(true);
    if !opening.is_empty() && game.write_all(&opening).await.is_err() {
        return;
    }

    // Both directions until one of them ends. A player leaving is ordinary, so
    // nothing is reported about how it finished.
    let joined = tokio::io::join(recv, send);
    let mut joined = std::pin::pin!(joined);
    let _ = tokio::io::copy_bidirectional(&mut *joined, &mut game).await;
}

// ── the connection ─────────────────────────────────────────────────────────

/// `extra_ca` ADDS a certificate authority to the public ones; it never
/// replaces them and there is deliberately no way to turn verification off.
/// The relay is somebody else's machine on the open internet, so an
/// unverified connection to it is worth nothing. It exists because the relay
/// is open source and can be self-hosted, and because it is what makes the
/// transport testable against a relay of one's own.
fn client_config(extra_ca: Option<&str>) -> ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(path) = extra_ca {
        let pem = match std::fs::read(path) {
            Ok(p) => p,
            Err(e) => fail(&format!("{path} could not be read: {e}")),
        };
        let mut added = 0usize;
        for cert in rustls_pemfile::certs(&mut pem.as_slice()) {
            match cert {
                Ok(c) => {
                    if roots.add(c).is_ok() {
                        added += 1;
                    }
                }
                Err(e) => fail(&format!("{path} is not a certificate: {e}")),
            }
        }
        if added == 0 {
            fail(&format!("{path} held no certificates"));
        }
    }

    let mut crypto = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // The one thing that has to be right, or the relay drops the handshake.
    crypto.alpn_protocols = vec![b"quiclime".to_vec()];

    let quic_crypto = match quinn::crypto::rustls::QuicClientConfig::try_from(crypto) {
        Ok(c) => c,
        Err(e) => fail(&format!("TLS could not be set up: {e}")),
    };
    let mut config = ClientConfig::new(Arc::new(quic_crypto));

    let mut transport = TransportConfig::default();
    // The relay opens a stream per player, so the limit that matters is ours,
    // not theirs. It only ever opens one towards us.
    transport.max_concurrent_bidi_streams(512u32.into());
    transport.max_concurrent_uni_streams(0u32.into());
    transport.keep_alive_interval(Some(Duration::from_secs(5)));
    transport.max_idle_timeout(Some(Duration::from_secs(15).try_into().unwrap()));
    config.transport_config(Arc::new(transport));
    config
}

async fn run(relay: String, sni: String, local_port: u16, extra_ca: Option<String>) -> Result<(), String> {
    let addr = tokio::net::lookup_host(&relay)
        .await
        .map_err(|e| format!("{relay} could not be looked up: {e}"))?
        .next()
        .ok_or_else(|| format!("{relay} resolved to nothing"))?;

    // Bind to whatever the OS gives us, on the same family as the relay.
    let bind: SocketAddr = if addr.is_ipv6() {
        "[::]:0".parse().unwrap()
    } else {
        "0.0.0.0:0".parse().unwrap()
    };
    let mut endpoint = Endpoint::client(bind).map_err(|e| format!("no local UDP socket: {e}"))?;
    endpoint.set_default_client_config(client_config(extra_ca.as_deref()));

    let connection: Connection = endpoint
        .connect(addr, &sni)
        .map_err(|e| format!("could not start the connection: {e}"))?
        .await
        .map_err(|e| format!("the relay refused the connection: {e}"))?;
    emit(serde_json::json!({ "type": "connected", "relay": relay }));

    // The FIRST stream we open is the control stream; the relay treats it as
    // such and accepts no other from us.
    let (send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|e| format!("the control stream could not be opened: {e}"))?;
    let send = Arc::new(Mutex::new(send));

    // Both at once and without waiting, which is what the mod does: the relay
    // answers each in turn.
    {
        let mut guard = send.lock().await;
        let mut first = control_frame(PROBE);
        first.extend_from_slice(&control_frame(REQUEST_DOMAIN));
        guard
            .write_all(&first)
            .await
            .map_err(|e| format!("the relay would not take the request: {e}"))?;
    }

    let missed = Arc::new(std::sync::atomic::AtomicU32::new(0));

    // Keep saying hello. The relay replies to every probe, so this is also how
    // a connection that has quietly died gets noticed.
    {
        let send = Arc::clone(&send);
        let missed = Arc::clone(&missed);
        let connection = connection.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(KEEPALIVE);
            ticker.tick().await; // the first tick is immediate
            loop {
                ticker.tick().await;
                if missed.load(std::sync::atomic::Ordering::Relaxed) >= MISSED_ALLOWED {
                    connection.close(0u32.into(), b"relay stopped answering");
                    return;
                }
                let frame = control_frame(PROBE);
                let mut guard = send.lock().await;
                if guard.write_all(&frame).await.is_err() {
                    return;
                }
                missed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }

    // What the relay says.
    {
        let missed = Arc::clone(&missed);
        let connection = connection.clone();
        tokio::spawn(async move {
            loop {
                match read_reply(&mut recv).await {
                    Ok(Some(value)) => {
                        // Anything at all means it is still there.
                        missed.store(0, std::sync::atomic::Ordering::Relaxed);
                        match value.get("kind").and_then(|k| k.as_str()) {
                            Some("domain_assignment_complete") => emit(serde_json::json!({
                                "type": "domain",
                                "domain": value.get("domain").and_then(|d| d.as_str()).unwrap_or("")
                            })),
                            Some("has_capabilities") => emit(serde_json::json!({
                                "type": "capabilities",
                                "caps": value.get("caps").cloned().unwrap_or(serde_json::json!([]))
                            })),
                            Some("request_message_broadcast") => emit(serde_json::json!({
                                "type": "broadcast",
                                "message": value.get("message").and_then(|m| m.as_str()).unwrap_or("")
                            })),
                            Some("ticket_registered") => {
                                emit(serde_json::json!({ "type": "ticket_registered" }))
                            }
                            // `unknown_message` means the relay did not
                            // understand US, which is worth hearing about.
                            Some(other) => {
                                emit(serde_json::json!({ "type": "control", "kind": other }))
                            }
                            None => {}
                        }
                    }
                    Ok(None) | Err(_) => {
                        connection.close(0u32.into(), b"control stream ended");
                        return;
                    }
                }
            }
        });
    }

    // And each player, until the connection goes.
    loop {
        match connection.accept_bi().await {
            Ok((send, recv)) => {
                tokio::spawn(serve_player(send, recv, local_port));
            }
            Err(e) => {
                emit(serde_json::json!({ "type": "closed", "reason": e.to_string() }));
                return Ok(());
            }
        }
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    // rustls needs to be told which crypto to use before anything uses it.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let relay = match arg(&args, "--relay") {
        Some(r) => r,
        None => fail("no --relay was given"),
    };
    let local_port: u16 = match arg(&args, "--local-port").and_then(|p| p.parse().ok()) {
        Some(p) if p > 0 => p,
        _ => fail("no usable --local-port was given"),
    };
    // The certificate is checked against the name being dialled unless told
    // otherwise, which is only useful when testing against a relay of one's
    // own.
    let sni = arg(&args, "--sni").unwrap_or_else(|| {
        relay
            .rsplit_once(':')
            .map(|(h, _)| h.to_string())
            .unwrap_or_else(|| relay.clone())
    });

    // Stdin closing means the launcher has gone. A published world outliving
    // the thing that published it is a world nobody can un-publish.
    tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buf = [0u8; 256];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) | Err(_) => {
                    std::process::exit(0);
                }
                Ok(_) => { /* nothing is sent to us yet; this only watches */ }
            }
        }
    });

    if let Err(e) = run(relay, sni, local_port, arg(&args, "--ca")).await {
        fail(&e);
    }
}
