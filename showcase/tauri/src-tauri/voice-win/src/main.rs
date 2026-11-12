// Voice helper for Roamies on Windows and Linux: the twin of voice/main.swift, with the same JSON lines in and out.
// Watches the talk chord (GetAsyncKeyState on Windows, the X server on Linux X11 sessions; neither needs a
// permission), records the default microphone and
// transcribes on this PC with NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX via parakeet-rs). Parakeet isn't a
// streaming model, so live text comes from re-reading the take about once a second.
// When the settings name a speech server on this computer (remote.rs), the finished take is read by that instead,
// for accents Parakeet mishears; Parakeet still does the live text, and the whole job if the server is off.
// Hold the chord = push-to-talk (release sends). Quick tap = hands-free (ends on a pause or another tap).
// While the chord is held, moving the cursor round something circles it (ink.rs); the circled area goes out with
// what was said, as on macOS (Windows only). On Wayland no app can watch the keyboard, so there {"cmd":"toggle"}
// (sent for `roamies --talk`, which people bind to a key) starts a take, and sends it when it comes again or on a
// pause. Exits when stdin closes.
//
// roamies-voice --model <dir> [--chord control,option]   normal use (Roamies starts it)
// roamies-voice --perms                                   prints {"type":"perms","mic":…}
// roamies-voice --devices                                 prints {"type":"devices",…}: every mic, the default, formats
// roamies-voice --model <dir> --transcribe <wav>          dev: transcribe a file and exit (also through the speech server, if set)
// roamies-voice --model <dir> --test-audio <wav>          dev: a file stands in for the mic ({"cmd":"listen"} starts)

mod audio;
mod ink;
mod keys;
mod remote;

use audio::{MicError, Sink, Source};
use parakeet_rs::{ExecutionConfig, ParakeetTDT, Transcriber};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;

pub fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn log(s: &str) {
    eprintln!("[voice] {s}");
}

/// The error the app shows when the microphone can't be used; `reason` picks what the Roamie says.
fn mic_error(e: &MicError) -> Value {
    json!({ "type": "error", "code": "no_input", "reason": e.reason, "message": e.detail })
}

pub enum Ev {
    Cmd(Value),
    StdinClosed,
    Level(f64),
    AudioFailed(MicError),
    Text { take: u64, text: String, last: bool },
    EngineFailed(String),
}

// ---------- transcription (its own thread: loading and reading never stall the hotkey loop) ----------

struct Job {
    take: u64,
    audio: Vec<f32>,
    last: bool,
}

fn model_present(dir: &Path) -> bool {
    dir.join("vocab.txt").is_file() && dir.join("encoder-model.int8.onnx").is_file() && dir.join("decoder_joint-model.int8.onnx").is_file()
}

fn load_model(dir: &Path) -> Result<ParakeetTDT, String> {
    // Half the cores: quick enough to read a minute of speech in a second or two, without starving the PC.
    let threads = thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 8);
    let t0 = Instant::now();
    let env = parakeet_rs::ort::init().with_name("roamies-voice").build().map_err(|e| e.to_string())?;
    let config = ExecutionConfig::new().with_environment(env).with_intra_threads(threads);
    let mut asr = ParakeetTDT::from_pretrained(dir, Some(config)).map_err(|e| e.to_string())?;
    // One short warm-up run, so the first real request doesn't pay for ONNX Runtime's setup.
    let _ = asr.transcribe_samples(vec![0.0; RATE as usize / 2], RATE, 1, None);
    log(&format!("model ready in {:.1}s ({threads} threads)", t0.elapsed().as_secs_f64()));
    Ok(asr)
}

fn transcribe(asr: &mut ParakeetTDT, audio: Vec<f32>) -> String {
    if audio.len() < RATE as usize / 5 {
        return String::new();
    }
    match asr.transcribe_samples(audio, RATE, 1, None) {
        Ok(r) => r.text.split_whitespace().collect::<Vec<_>>().join(" "),
        Err(e) => {
            log(&format!("transcribe: {e}"));
            String::new()
        }
    }
}

fn spawn_engine(dir: PathBuf, tx: Sender<Ev>) -> (Sender<Job>, thread::JoinHandle<()>) {
    let (jtx, jrx) = mpsc::channel::<Job>();
    let handle = thread::spawn(move || {
        let mut asr = match load_model(&dir) {
            Ok(a) => a,
            Err(e) => {
                log(&format!("model failed to load: {e}"));
                let _ = tx.send(Ev::EngineFailed(e));
                return;
            }
        };
        while let Ok(first) = jrx.recv() {
            // Only the newest live read matters; a closing read always runs.
            let mut jobs = vec![first];
            jobs.extend(jrx.try_iter());
            let job = match jobs.iter().rposition(|j| j.last) {
                Some(i) => jobs.swap_remove(i),
                None => jobs.pop().expect("at least one job"),
            };
            // The finished take goes to the speech server when one is set; Parakeet reads it otherwise, or if that fails.
            let served = if job.last { remote::transcribe(&dir, &job.audio) } else { None };
            let text = match served {
                Some(text) => text,
                None => transcribe(&mut asr, job.audio),
            };
            if tx.send(Ev::Text { take: job.take, text, last: job.last }).is_err() {
                return;
            }
        }
    });
    (jtx, handle)
}

// ---------- the talk session (port of the Voice class in voice/main.swift) ----------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Idle,
    Armed,
    Holding,
    HandsFree,
    Finishing,
}

const TAP_LIMIT: f64 = 0.25;
// A release must last this long to count, so one glitchy frame of key state can't end a session.
const RELEASE_DEBOUNCE: f64 = 0.09;
const PAUSE_ENDS: f64 = 1.5;
const MAX_SESSION: f64 = 60.0;
// Keep the mic open a moment after release so a word said while letting go isn't clipped.
const TAIL: f64 = 0.3;
const FINAL_TIMEOUT: f64 = 30.0;
const READ_EVERY: f64 = 0.8;
// Parakeet makes up words ("Thank you.") from silence, so a take is only read once the mic heard a voice:
// about -49 dBFS, above room noise and below quiet speech.
const SPEECH_LEVEL: f64 = 0.15;

struct Voice {
    phase: Phase,
    chord: u8,
    chord_at: f64,
    listen_at: f64,
    heard_at: f64,
    voice_at: f64,
    level_at: f64,
    released_at: Option<f64>,
    blocked: bool,
    prev_chord: bool,
    report_empty: bool,
    spoke: bool,
    best: String,
    // Each session gets a new take number; results for older takes are ignored.
    take: u64,
    buf: Arc<Mutex<Vec<f32>>>,
    source: Option<Source>,
    engine: Option<Sender<Job>>,
    engine_error: Option<String>,
    reading: bool,
    read_at: f64,
    read_len: usize,
    tail_until: Option<f64>,
    final_until: Option<f64>,
    test_audio: Option<PathBuf>,
    ink: ink::Ink,
    tx: Sender<Ev>,
    t0: Instant,
}

impl Voice {
    fn new(engine: Option<Sender<Job>>, test_audio: Option<PathBuf>, tx: Sender<Ev>) -> Voice {
        Voice {
            phase: Phase::Idle,
            chord: keys::mask(&["control".into(), "option".into()]).expect("default chord"),
            chord_at: 0.0,
            listen_at: 0.0,
            heard_at: 0.0,
            voice_at: 0.0,
            level_at: 0.0,
            released_at: None,
            blocked: false,
            prev_chord: false,
            report_empty: false,
            spoke: false,
            best: String::new(),
            take: 0,
            buf: Arc::new(Mutex::new(Vec::new())),
            source: None,
            engine,
            engine_error: None,
            reading: false,
            read_at: 0.0,
            read_len: 0,
            tail_until: None,
            final_until: None,
            test_audio,
            ink: ink::Ink::default(),
            tx,
            t0: Instant::now(),
        }
    }

    fn now(&self) -> f64 {
        self.t0.elapsed().as_secs_f64()
    }

    fn set_chord(&mut self, names: &[String]) {
        let Some(m) = keys::mask(names) else { return log(&format!("ignored chord {names:?}")) };
        if self.phase != Phase::Idle {
            self.cancel();
        }
        self.chord = m;
        self.blocked = true;
        log(&format!("talk chord: {}", names.join("+")));
    }

    fn tick(&mut self) {
        let now = self.now();
        self.tick_keys(now);
        self.ink.set_armed(matches!(self.phase, Phase::Armed | Phase::Holding), now);
        self.ink.follow(now);
        match self.phase {
            Phase::Holding | Phase::HandsFree => self.maybe_read(now),
            Phase::Finishing => {
                if self.tail_until.is_some_and(|t| now >= t) {
                    self.tail_until = None;
                    self.close_take(now);
                } else if self.final_until.is_some_and(|t| now >= t) {
                    log("final read timed out");
                    self.finalize();
                }
            }
            _ => {}
        }
    }

    fn tick_keys(&mut self, now: f64) {
        let f = keys::held();
        let held = f.mods & self.chord;
        let down = held == self.chord; // once talking, a stray extra modifier doesn't count as letting go
        let extra = f.mods & !self.chord != 0 || f.altgr;
        let chord = down && !extra;
        let prev = self.prev_chord;
        self.prev_chord = chord;
        if held == 0 {
            self.blocked = false;
        }
        let released = if down {
            self.released_at = None;
            false
        } else {
            let at = *self.released_at.get_or_insert(now);
            now - at >= RELEASE_DEBOUNCE
        };

        match self.phase {
            Phase::Idle => {
                if chord && !prev && !self.blocked {
                    self.arm(now);
                }
            }
            Phase::Armed => {
                // Only the first moment decides shortcut vs. talk: the chord plus a key or another modifier is a shortcut.
                if down && (extra || keys::other_key_down()) {
                    log("not a talk: the chord was part of a shortcut");
                    self.cancel();
                    self.blocked = true;
                } else if released {
                    self.phase = Phase::HandsFree;
                    self.show_listening("handsfree", now);
                } else if down && now - self.chord_at >= TAP_LIMIT {
                    self.phase = Phase::Holding;
                    self.show_listening("hold", now);
                }
            }
            Phase::Holding => {
                if released {
                    self.end("released", now);
                    self.finish();
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish();
                }
            }
            Phase::HandsFree => {
                // Pressing again switches to push-to-talk; letting go then sends.
                if chord && !prev && !self.blocked {
                    self.phase = Phase::Holding;
                    self.released_at = None;
                    return;
                }
                let quiet = now - self.heard_at.max(self.voice_at);
                if !self.best.is_empty() && quiet > PAUSE_ENDS {
                    self.end("pause", now);
                    self.finish();
                } else if self.best.is_empty() && !self.reading && now - self.listen_at > 8.0 && now - self.voice_at > PAUSE_ENDS {
                    self.end("nothing heard", now);
                    self.cancel();
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish();
                }
            }
            Phase::Finishing => {}
        }
    }

    fn end(&self, why: &str, now: f64) {
        log(&format!("session end: {why} after {:.1}s", now - self.listen_at));
    }

    fn arm(&mut self, now: f64) {
        self.phase = Phase::Armed;
        self.chord_at = now;
        self.best.clear();
        self.spoke = false;
        self.take += 1;
        self.reading = false;
        self.read_len = 0;
        // Start the mic now so the first word isn't lost (a shortcut cancels it a moment later).
        if self.engine.is_some() && keys::mic_allowed() {
            self.start_audio();
        }
    }

    fn show_listening(&mut self, mode: &str, now: f64) {
        self.listen_at = now;
        self.heard_at = now;
        self.voice_at = now;
        self.read_at = now;
        if self.engine.is_none() {
            let code = if self.engine_error.is_some() { "recognition" } else { "model_missing" };
            emit(json!({ "type": "error", "code": code, "message": self.engine_error.clone().unwrap_or_default() }));
            return self.cancel();
        }
        if !keys::mic_allowed() {
            emit(json!({ "type": "error", "code": "permission", "what": "microphone" }));
            return self.cancel();
        }
        if self.source.is_none() {
            self.start_audio();
            if self.phase == Phase::Idle {
                return;
            }
        }
        emit(json!({ "type": "state", "state": "listening", "mode": mode }));
        if !self.best.is_empty() {
            emit(json!({ "type": "partial", "text": self.best }));
        }
    }

    fn start_audio(&mut self) {
        self.buf.lock().unwrap().clear();
        let sink = Sink::new(self.buf.clone(), self.tx.clone());
        let started = match &self.test_audio {
            Some(p) => audio::play_file(p, sink).map_err(|e| MicError::new("failed", e)),
            None => audio::open_mic(sink),
        };
        match started {
            Ok(s) => self.source = Some(s),
            Err(e) => {
                log(&format!("audio: {} ({})", e.detail, e.reason));
                emit(mic_error(&e));
                self.cancel();
            }
        }
    }

    fn stop_audio(&mut self) {
        self.source = None;
    }

    // While listening: re-read the whole take now and then, for live text and pause detection.
    fn maybe_read(&mut self, now: f64) {
        let Some(engine) = &self.engine else { return };
        if !self.spoke || self.reading || now - self.read_at < READ_EVERY {
            return;
        }
        let audio = self.buf.lock().unwrap().clone();
        if audio.len() < RATE as usize / 2 || audio.len() < self.read_len + RATE as usize * 3 / 10 {
            return;
        }
        self.read_at = now;
        self.read_len = audio.len();
        self.reading = engine.send(Job { take: self.take, audio, last: false }).is_ok();
    }

    fn finish(&mut self) {
        if !matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
            return;
        }
        let shown = self.phase != Phase::Armed;
        self.report_empty = shown;
        self.phase = Phase::Finishing;
        self.ink.capture(self.now());
        if shown {
            emit(json!({ "type": "state", "state": "processing" }));
        }
        if self.source.is_none() {
            return self.finalize();
        }
        self.tail_until = Some(self.now() + TAIL);
    }

    // Mic off, then one last read of the whole take; its result ends the session.
    fn close_take(&mut self, now: f64) {
        self.stop_audio();
        let audio = std::mem::take(&mut *self.buf.lock().unwrap());
        match &self.engine {
            Some(engine) if self.spoke && engine.send(Job { take: self.take, audio, last: true }).is_ok() => self.final_until = Some(now + FINAL_TIMEOUT),
            _ => self.finalize(),
        }
    }

    fn on_text(&mut self, take: u64, text: String, last: bool) {
        if take != self.take {
            return;
        }
        if !last {
            self.reading = false;
        }
        // A closing read that came back empty keeps whatever the live reads heard.
        if !text.is_empty() && text != self.best {
            self.best = text;
            self.heard_at = self.now();
            if !matches!(self.phase, Phase::Idle | Phase::Armed) {
                emit(json!({ "type": "partial", "text": self.best }));
            }
        }
        if last && self.phase == Phase::Finishing {
            self.finalize();
        }
    }

    fn on_level(&mut self, v: f64) {
        let now = self.now();
        if v > 0.2 {
            self.voice_at = now;
        }
        if v > SPEECH_LEVEL && self.phase != Phase::Idle {
            self.spoke = true;
        }
        if !matches!(self.phase, Phase::Holding | Phase::HandsFree) || now - self.level_at < 0.05 {
            return;
        }
        self.level_at = now;
        emit(json!({ "type": "level", "v": (v * 100.0).round() / 100.0 }));
    }

    fn finalize(&mut self) {
        if self.phase != Phase::Finishing {
            return;
        }
        self.stop_audio();
        self.tail_until = None;
        self.final_until = None;
        self.take += 1;
        self.phase = Phase::Idle;
        let text = self.best.trim().to_string();
        let area = self.ink.take();
        if !text.is_empty() {
            // What was circled on screen while talking rides along with the words.
            let mut msg = json!({ "type": "final", "text": text });
            if let Some(a) = area {
                msg["area"] = a;
                log("sent what was said, with the circled area");
            }
            emit(msg);
        } else if let Some(f) = area.as_ref().and_then(|a| a["file"].as_str()) {
            // Circled something but said nothing: drop it quietly (no "I didn't hear you").
            let _ = std::fs::remove_file(f);
            log("nothing said, dropped the circled area");
            self.report_empty = false;
        }
        emit(json!({ "type": "state", "state": "idle" }));
        // Listened but got no words: say so instead of closing silently.
        if text.is_empty() && self.report_empty {
            emit(json!({ "type": "error", "code": "nothing_heard", "spoke": self.voice_at > self.listen_at + 0.05 }));
        }
        self.report_empty = false;
    }

    fn cancel(&mut self) {
        self.stop_audio();
        self.buf.lock().unwrap().clear();
        self.tail_until = None;
        self.final_until = None;
        self.take += 1;
        self.reading = false;
        self.phase = Phase::Idle;
        self.report_empty = false;
        let now = self.now();
        self.ink.clear(now);
        emit(json!({ "type": "state", "state": "idle", "cancelled": true }));
    }

    /// Start listening hands-free without a key press (after an area snap). Ends on a pause or a tap.
    fn listen_now(&mut self) {
        if self.phase != Phase::Idle {
            return;
        }
        let now = self.now();
        self.arm(now);
        self.phase = Phase::HandsFree;
        self.blocked = true; // the snap shortcut's keys may still be held: don't read them as a tap
        self.show_listening("handsfree", now);
    }

    /// The talk shortcut where the keys can't be watched (`roamies --talk`): the first one starts listening
    /// hands-free, the next one sends what was said (so does a pause).
    fn toggle(&mut self) {
        match self.phase {
            Phase::Idle => self.listen_now(),
            Phase::Armed | Phase::Holding | Phase::HandsFree => {
                let now = self.now();
                self.end("toggled", now);
                self.finish();
            }
            Phase::Finishing => {}
        }
    }

    /// Roamies saw its show/hide shortcut: that chord press was a shortcut, not a request to talk.
    fn external_cancel(&mut self) {
        if matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
            self.cancel();
        }
        self.blocked = true;
    }

    /// Returns true when Roamies has gone (stdin closed) and the helper should exit.
    fn handle(&mut self, ev: Ev) -> bool {
        match ev {
            Ev::Cmd(msg) => match msg.get("cmd").and_then(Value::as_str) {
                Some("cancel") => self.external_cancel(),
                Some("listen") => self.listen_now(),
                Some("toggle") => self.toggle(),
                Some("chord") => {
                    let mods: Vec<String> = msg.get("mods").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                    self.set_chord(&mods);
                }
                // Muting the speakers while listening is macOS-only for now.
                _ => {}
            },
            Ev::StdinClosed => return true,
            Ev::Level(v) => self.on_level(v),
            Ev::AudioFailed(e) => {
                log(&format!("audio stream: {} ({})", e.detail, e.reason));
                if matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
                    emit(mic_error(&e));
                    self.cancel();
                }
            }
            Ev::Text { take, text, last } => self.on_text(take, text, last),
            Ev::EngineFailed(e) => {
                self.engine = None;
                self.engine_error = Some(e);
            }
        }
        false
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--perms") {
        emit(json!({ "type": "perms", "mic": if keys::mic_allowed() { "granted" } else { "denied" }, "input": audio::has_input() }));
        return;
    }
    if args.iter().any(|a| a == "--devices") {
        let mut v = audio::devices();
        v["mic_allowed"] = json!(keys::mic_allowed());
        emit(v);
        return;
    }
    let model = arg(&args, "--model").map(PathBuf::from);
    // Cursor positions and captures in real pixels on every monitor (ink.rs turns them into screen points).
    #[cfg(windows)]
    // SAFETY: a plain call at startup, before any window or thread exists.
    unsafe {
        windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    if let Some(wav) = arg(&args, "--transcribe") {
        let dir = model.expect("--transcribe needs --model <dir>");
        let mut asr = load_model(&dir).unwrap_or_else(|e| panic!("model: {e}"));
        let (samples, rate) = audio::read_wav(Path::new(&wav)).unwrap_or_else(|e| panic!("{wav}: {e}"));
        let t0 = Instant::now();
        let text = transcribe(&mut asr, samples.clone());
        // With a speech server set, what it makes of the same file is shown beside Parakeet's.
        let served = remote::transcribe(&dir, &samples);
        emit(json!({ "text": text, "server": served, "seconds": (t0.elapsed().as_secs_f64() * 100.0).round() / 100.0, "audio": samples.len() as f64 / rate as f64 }));
        return;
    }

    let (tx, rx): (Sender<Ev>, Receiver<Ev>) = mpsc::channel();
    let (engine, engine_thread) = match &model {
        Some(dir) if model_present(dir) => {
            let (jobs, handle) = spawn_engine(dir.clone(), tx.clone());
            (Some(jobs), Some(handle))
        }
        _ => {
            log("speech model not downloaded yet");
            (None, None)
        }
    };
    let mut voice = Voice::new(engine, arg(&args, "--test-audio").map(PathBuf::from), tx.clone());
    if let Some(c) = arg(&args, "--chord") {
        voice.set_chord(&c.split(',').map(str::to_owned).collect::<Vec<_>>());
    }

    let stdin_tx = tx.clone();
    thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = stdin_tx.send(Ev::Cmd(v));
            }
        }
        let _ = stdin_tx.send(Ev::StdinClosed);
    });

    emit(json!({ "type": "ready", "engine": "parakeet", "model": voice.engine.is_some() }));
    loop {
        let quit = match rx.recv_timeout(Duration::from_millis(16)) {
            Ok(ev) => {
                let mut quit = voice.handle(ev);
                while let Ok(ev) = rx.try_recv() {
                    quit |= voice.handle(ev);
                }
                quit
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => true,
        };
        if quit {
            break;
        }
        voice.tick();
    }
    // Let the engine thread finish (a model still loading included) before exiting: tearing ONNX Runtime
    // down under it crashes.
    drop(voice);
    if let Some(h) = engine_thread {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A Voice with a stand-in engine (the test reads its jobs) and a short WAV in place of the microphone.
    fn voice() -> (Voice, Receiver<Job>, PathBuf) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let wav = std::env::temp_dir().join(format!("roamies-voice-test-{}-{}.wav", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let spec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&wav, spec).expect("test wav");
        for i in 0..RATE / 2 {
            w.write_sample(((i as f32 * 0.2).sin() * 8000.0) as i16).expect("sample");
        }
        w.finalize().expect("wav written");
        let (jobs, jrx) = mpsc::channel();
        let (tx, _events) = mpsc::channel();
        (Voice::new(Some(jobs), Some(wav.clone()), tx), jrx, wav)
    }

    #[test]
    fn toggle_starts_a_take_and_the_next_one_sends_it() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree, "the first toggle listens hands-free");
        assert!(v.source.is_some(), "the microphone is on");
        v.on_level(0.5);
        v.on_text(v.take, "hello there".into(), false);
        v.toggle();
        assert_eq!(v.phase, Phase::Finishing, "the second toggle ends the take");
        v.toggle();
        assert_eq!(v.phase, Phase::Finishing, "a third one while it finishes changes nothing");
        // The mic's tail is over: the whole take goes for one last read.
        v.tail_until = Some(0.0);
        v.tick();
        let job = jobs.try_recv().expect("a closing read");
        assert!(job.last && job.take == v.take);
        assert!(v.source.is_none(), "the microphone is off");
        v.on_text(job.take, "hello there friend".into(), true);
        assert_eq!(v.phase, Phase::Idle);
        assert_eq!(v.best, "hello there friend");
        // And it's ready to go again.
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn toggle_without_a_speech_model_stays_idle() {
        let (tx, _events) = mpsc::channel();
        let mut v = Voice::new(None, None, tx);
        v.toggle();
        assert_eq!(v.phase, Phase::Idle);
        assert!(v.source.is_none());
    }

    #[test]
    fn a_toggled_take_with_nothing_said_ends_without_a_read() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        v.toggle();
        v.tail_until = Some(0.0);
        v.tick();
        assert!(jobs.try_recv().is_err(), "silence isn't read (Parakeet makes words up from it)");
        assert_eq!(v.phase, Phase::Idle);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_mic_error_tells_the_app_why() {
        let v = mic_error(&MicError::new("busy", "device in use"));
        assert_eq!(v["code"], "no_input", "the code older app builds already handle");
        assert_eq!(v["reason"], "busy");
        assert_eq!(v["message"], "device in use");
    }

    #[test]
    fn losing_the_mic_mid_take_ends_it_and_idle_ignores_it() {
        let (mut v, _jobs, wav) = voice();
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(v.phase, Phase::Idle, "nothing to end while idle");
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(v.phase, Phase::Idle, "the take ends");
        assert!(v.source.is_none(), "the microphone is off");
        let _ = std::fs::remove_file(wav);
    }
}
