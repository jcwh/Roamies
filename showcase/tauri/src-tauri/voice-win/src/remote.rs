// A speech server on this computer, for accents the built-in model mishears (a Whisper tuned for Singapore English,
// say). When Roamies' settings name one, the finished take is sent to it the way OpenAI's /v1/audio/transcriptions
// is asked (a WAV file in a form), and its text is used; if it's off, slow or answers nonsense, the caller falls
// back to Parakeet, so talking never depends on it. Live text while speaking stays with Parakeet.
//
// The address is the first line of speech-server.txt beside the model folder (the sidecar writes it, and removes it
// when the setting is cleared). It's read again for every take, so a change needs no restart. Only plain http to
// this computer is ever contacted (127.x.x.x, localhost or [::1]), whatever the file says.
//
// Std only: no HTTP or JSON crate, so this file also compiles and tests by itself (rustc --test remote.rs).

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

const RATE: u32 = 16_000;
const CONNECT: Duration = Duration::from_millis(1500);
// Parakeet still has to read the take if this fails, inside the session's own 30 s limit.
const DEADLINE: Duration = Duration::from_secs(20);
const MAX_REPLY: usize = 1 << 20;
pub const SETTING: &str = "speech-server.txt";

#[derive(Debug, PartialEq)]
pub struct Target {
    pub addrs: Vec<SocketAddr>,
    pub host: String,
    pub path: String,
}

/// "http://127.0.0.1:8123/v1/audio/transcriptions" → where to connect. None for anything that isn't plain http
/// to this computer.
pub fn parse_url(url: &str) -> Option<Target> {
    let rest = url.trim().strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/v1/audio/transcriptions"),
    };
    if authority.is_empty() || authority.contains('@') || path.contains(|c: char| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let end = v6.find(']')?;
        let port = match &v6[end + 1..] {
            "" => 80,
            p => p.strip_prefix(':')?.parse::<u16>().ok()?,
        };
        (&v6[..end], port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse::<u16>().ok()?),
            None => (authority, 80),
        }
    };
    let ips: Vec<IpAddr> = if host.eq_ignore_ascii_case("localhost") {
        vec![IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)]
    } else {
        let ip: IpAddr = host.parse().ok()?;
        if !ip.is_loopback() {
            return None;
        }
        vec![ip]
    };
    Some(Target { addrs: ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect(), host: authority.to_string(), path: path.to_string() })
}

/// The address in the setting file beside the model folder, if there is one.
pub fn setting(model_dir: &Path) -> Option<String> {
    let file = model_dir.parent()?.join(SETTING);
    let text = std::fs::read_to_string(file).ok()?;
    let line = text.lines().next()?.trim().trim_start_matches('\u{feff}').to_string();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

/// 16 kHz mono samples as a 16-bit WAV file.
pub fn wav(audio: &[f32]) -> Vec<u8> {
    let data = (audio.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + audio.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in audio {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    out
}

const BOUNDARY: &str = "----roamies-voice-7f3a9c1e5b2d4860";

fn form(wav: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len() + 600);
    for (name, value) in [("model", "whisper-1"), ("response_format", "json"), ("language", "en")] {
        body.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    body
}

/// A JSON string starting at s[at] == '"': its text and the index just past its closing quote.
fn json_string(s: &[char], at: usize) -> Option<(String, usize)> {
    if s.get(at) != Some(&'"') {
        return None;
    }
    let mut out = String::new();
    let mut i = at + 1;
    let hex4 = |i: usize| -> Option<u32> {
        let h: String = s.get(i..i + 4)?.iter().collect();
        u32::from_str_radix(&h, 16).ok()
    };
    while i < s.len() {
        match s[i] {
            '"' => return Some((out, i + 1)),
            '\\' => {
                i += 1;
                match *s.get(i)? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    'u' => {
                        let mut code = hex4(i + 1)?;
                        i += 4;
                        // Two \u escapes in a row can be one character (a surrogate pair).
                        if (0xD800..0xDC00).contains(&code) && s.get(i + 1) == Some(&'\\') && s.get(i + 2) == Some(&'u') {
                            if let Some(low) = hex4(i + 3).filter(|l| (0xDC00..0xE000).contains(l)) {
                                code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                                i += 6;
                            }
                        }
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    c => out.push(c), // \" \\ \/
                }
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

/// The value of the first "text" key in a JSON reply ({"text": "…"}), with runs of spaces made one.
pub fn text_of(json: &str) -> Option<String> {
    let s: Vec<char> = json.chars().collect();
    let mut i = 0;
    while i < s.len() {
        if s[i] != '"' {
            i += 1;
            continue;
        }
        // Every string is read whole, so the word "text" inside some other value is never taken for the key.
        let (key, mut j) = json_string(&s, i)?;
        while s.get(j).is_some_and(|c| c.is_whitespace()) {
            j += 1;
        }
        if key == "text" && s.get(j) == Some(&':') {
            j += 1;
            while s.get(j).is_some_and(|c| c.is_whitespace()) {
                j += 1;
            }
            let (value, _) = json_string(&s, j)?;
            return Some(value.split_whitespace().collect::<Vec<_>>().join(" "));
        }
        i = j;
    }
    None
}

/// The body of a "Transfer-Encoding: chunked" reply.
fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = body.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if body.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
}

/// A whole HTTP reply → its status and body.
pub fn split_reply(raw: &[u8]) -> Option<(u16, Vec<u8>)> {
    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..head_end]).ok()?;
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = &raw[head_end + 4..];
    Some((status, if chunked { dechunk(body)? } else { body.to_vec() }))
}

fn connect(target: &Target) -> std::io::Result<TcpStream> {
    let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "no address");
    for addr in &target.addrs {
        match TcpStream::connect_timeout(addr, CONNECT) {
            Ok(s) => return Ok(s),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Sends the take to the server at `url`. Err says why in a few words (for the log).
pub fn ask(url: &str, audio: &[f32]) -> Result<String, String> {
    let target = parse_url(url).ok_or("not an http address on this computer")?;
    let started = Instant::now();
    let left = || DEADLINE.checked_sub(started.elapsed()).filter(|d| !d.is_zero());
    let mut stream = connect(&target).map_err(|e| format!("can't connect ({e})"))?;
    let _ = stream.set_nodelay(true);
    let body = form(&wav(audio));
    let head = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        target.path,
        target.host,
        body.len()
    );
    stream.set_write_timeout(left()).map_err(|e| e.to_string())?;
    stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&body)).and_then(|_| stream.flush()).map_err(|e| format!("sending failed ({e})"))?;
    let mut raw = Vec::new();
    let mut piece = [0u8; 8192];
    loop {
        let wait = left().ok_or("took too long")?;
        stream.set_read_timeout(Some(wait)).map_err(|e| e.to_string())?;
        match stream.read(&mut piece) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&piece[..n]);
                if raw.len() > MAX_REPLY {
                    return Err("reply too large".into());
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Err("took too long".into()),
            // Some servers reset the connection once the reply is out: what arrived is still a reply.
            Err(e) if raw.is_empty() => return Err(format!("no reply ({e})")),
            Err(_) => break,
        }
    }
    let (status, body) = split_reply(&raw).ok_or("reply wasn't HTTP")?;
    let body = String::from_utf8_lossy(&body);
    if status != 200 {
        return Err(format!("status {status}: {}", body.chars().take(120).collect::<String>().replace(['\r', '\n'], " ")));
    }
    text_of(&body).ok_or_else(|| "reply had no text".to_string())
}

/// The take's text from the speech server named in the settings, or None to let Parakeet read it: no server set,
/// too little audio, or the server failed (logged).
pub fn transcribe(model_dir: &Path, audio: &[f32]) -> Option<String> {
    let url = setting(model_dir)?;
    if audio.len() < RATE as usize / 5 {
        return None;
    }
    let t0 = Instant::now();
    match ask(&url, audio) {
        Ok(text) => {
            eprintln!("[voice] speech server read {:.1}s of audio in {:.1}s", audio.len() as f64 / RATE as f64, t0.elapsed().as_secs_f64());
            Some(text)
        }
        Err(why) => {
            eprintln!("[voice] speech server: {why}; using the built-in model");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    #[test]
    fn only_plain_http_to_this_computer() {
        let t = parse_url(" http://127.0.0.1:8123/v1/audio/transcriptions ").expect("loopback");
        assert_eq!(t.addrs, vec!["127.0.0.1:8123".parse().unwrap()]);
        assert_eq!(t.host, "127.0.0.1:8123");
        assert_eq!(t.path, "/v1/audio/transcriptions");
        let t = parse_url("http://localhost:9000").expect("localhost");
        assert_eq!(t.addrs, vec!["127.0.0.1:9000".parse().unwrap(), "[::1]:9000".parse().unwrap()]);
        assert_eq!(t.path, "/v1/audio/transcriptions");
        assert_eq!(parse_url("http://[::1]:8123/inference").expect("v6").addrs, vec!["[::1]:8123".parse().unwrap()]);
        assert_eq!(parse_url("http://127.5.6.7/x").expect("any 127").addrs, vec!["127.5.6.7:80".parse().unwrap()]);
        for bad in [
            "", "127.0.0.1:8123", "https://127.0.0.1:8123/x", "http://192.168.1.5:8123/x", "http://example.com/x", "http://127.0.0.1.evil.com/x",
            "http://localhost.evil.com/x", "http://user@127.0.0.1/x", "http://127.0.0.1:99999/x", "http://127.0.0.1:80/a b", "http://[::2]:80/x", "ftp://127.0.0.1/x",
            "http://0.0.0.0:8123/x", "http://10.0.0.1/x",
        ] {
            assert_eq!(parse_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_wav_is_16k_mono_16_bit() {
        let w = wav(&[0.0, 1.0, -1.0, 0.5, 2.0]);
        assert_eq!(w.len(), 44 + 10);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 36 + 10);
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes(w[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(w[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(w[34..36].try_into().unwrap()), 16);
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 10);
        let s: Vec<i16> = w[44..].chunks(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        assert_eq!(s, vec![0, 32767, -32767, 16384, 32767], "loud samples are clipped, not wrapped");
    }

    #[test]
    fn reads_the_text_out_of_a_json_reply() {
        assert_eq!(text_of(r#"{"text": " Can lah,  no problem. "}"#).as_deref(), Some("Can lah, no problem."));
        assert_eq!(text_of(r#"{"task":"transcribe","note":"the \"text\" key: here","text":"real one","segments":[{"text":"other"}]}"#).as_deref(), Some("real one"));
        assert_eq!(text_of(r#"{"text":"a \"quote\", a \\ slash, caf\u00e9, \ud83d\ude00 and a\nnew line"}"#).as_deref(), Some("a \"quote\", a \\ slash, café, 😀 and a new line"));
        assert_eq!(text_of(r#"{"text":""}"#).as_deref(), Some(""));
        assert_eq!(text_of(r#"{"error":"model not loaded"}"#), None);
        assert_eq!(text_of(r#"{"text": 5}"#), None);
        assert_eq!(text_of(r#"{"text":"cut off"#), None);
        assert_eq!(text_of("<html>502 Bad Gateway</html>"), None);
    }

    #[test]
    fn splits_replies_chunked_or_not() {
        let (status, body) = split_reply(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"text\":\"hi\"}").unwrap();
        assert_eq!((status, body.as_slice()), (200, &b"{\"text\":\"hi\"}"[..]));
        let (status, body) = split_reply(b"HTTP/1.1 200 OK\r\ntransfer-encoding: Chunked\r\n\r\n7\r\n{\"text\"\r\n6;x=1\r\n:\"hi\"}\r\n0\r\n\r\n").unwrap();
        assert_eq!((status, body.as_slice()), (200, &b"{\"text\":\"hi\"}"[..]));
        assert_eq!(split_reply(b"HTTP/1.1 503 Service Unavailable\r\n\r\nloading").unwrap().0, 503);
        assert_eq!(split_reply(b"not http at all"), None);
        assert_eq!(split_reply(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nshort"), None);
    }

    // A stand-in server on a free port: answers one request with `reply`, and hands back what it was sent.
    fn serve_once(reply: &'static [u8], delay: Duration) -> (String, std::thread::JoinHandle<(String, Vec<u8>)>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://127.0.0.1:{}/v1/audio/transcriptions", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream);
            let mut head = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).expect("header line");
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().expect("length");
                }
                head.push_str(&line);
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).expect("body");
            std::thread::sleep(delay);
            let mut stream = reader.into_inner();
            let _ = stream.write_all(reply);
            (head, body)
        });
        (url, handle)
    }

    #[test]
    fn sends_the_take_as_a_form_and_takes_the_text() {
        let (url, server) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 34\r\nConnection: close\r\n\r\n{\"text\":\" Eh, the MRT how to go? \"}", Duration::ZERO);
        let audio: Vec<f32> = (0..RATE as usize).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        assert_eq!(ask(&url, &audio).as_deref(), Ok("Eh, the MRT how to go?"));
        let (head, body) = server.join().unwrap();
        assert!(head.starts_with("POST /v1/audio/transcriptions HTTP/1.1\r\n"), "{head}");
        assert!(head.contains("Host: 127.0.0.1:") && head.contains(&format!("multipart/form-data; boundary={BOUNDARY}")) && head.contains("Connection: close"), "{head}");
        let text = String::from_utf8_lossy(&body);
        for part in ["name=\"model\"\r\n\r\nwhisper-1\r\n", "name=\"response_format\"\r\n\r\njson\r\n", "name=\"language\"\r\n\r\nen\r\n", "name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF"] {
            assert!(text.contains(part), "the form has {part:?}");
        }
        assert!(body.ends_with(format!("\r\n--{BOUNDARY}--\r\n").as_bytes()));
        let at = body.windows(4).position(|w| w == b"RIFF").unwrap();
        assert_eq!(&body[at..at + 44 + audio.len() * 2], wav(&audio).as_slice(), "the whole take, as a WAV");
    }

    #[test]
    fn a_server_that_fails_is_reported_not_trusted() {
        let (url, server) = serve_once(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 13\r\n\r\nstill loading", Duration::ZERO);
        assert_eq!(ask(&url, &[0.1; 4000]), Err("status 503: still loading".into()));
        server.join().unwrap();
        let (url, server) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", Duration::ZERO);
        assert_eq!(ask(&url, &[0.1; 4000]), Err("reply had no text".into()));
        server.join().unwrap();
        // Nothing listening there.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(ask(&format!("http://127.0.0.1:{port}/x"), &[0.1; 4000]).unwrap_err().starts_with("can't connect"));
        assert_eq!(ask("http://192.168.1.9:8000/x", &[0.1; 4000]), Err("not an http address on this computer".into()));
    }

    #[test]
    fn the_setting_file_names_the_server_and_no_file_means_parakeet() {
        let root = std::env::temp_dir().join(format!("roamies-remote-test-{}", std::process::id()));
        let model = root.join("parakeet-tdt-0.6b-v3-int8");
        std::fs::create_dir_all(&model).unwrap();
        let audio = vec![0.2f32; RATE as usize];
        assert_eq!(setting(&model), None);
        assert_eq!(transcribe(&model, &audio), None, "no server set");
        let (url, server) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{\"text\":\"from file\"}", Duration::ZERO);
        std::fs::write(root.join(SETTING), format!("\u{feff}{url}\r\nanything after the first line is ignored\r\n")).unwrap();
        assert_eq!(setting(&model).as_deref(), Some(url.as_str()));
        assert_eq!(transcribe(&model, &audio[..100]), None, "too short to be worth sending");
        assert_eq!(transcribe(&model, &audio).as_deref(), Some("from file"));
        server.join().unwrap();
        // The server has gone: Parakeet reads it instead.
        assert_eq!(transcribe(&model, &audio), None);
        std::fs::write(root.join(SETTING), "\r\n").unwrap();
        assert_eq!(setting(&model), None, "an empty file is no setting");
        let _ = std::fs::remove_dir_all(&root);
    }
}
