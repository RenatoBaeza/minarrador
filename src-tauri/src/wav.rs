//! 16-bit PCM WAV helpers.
//!
//! The app records at 16 kHz because that is what the transcription engines
//! want, which keeps an hour of mono meeting under ~115 MB. A meeting with both
//! sources live is two channels — left the microphone, right everything the
//! system played — so everything here is channel-aware: `deinterleave` pulls the
//! sides apart for transcription, `downmix` folds them back for the jobs that
//! only want to know whether anyone was talking.

use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const SAMPLE_RATE: u32 = 16_000;
pub const HEADER_BYTES: usize = 44;
pub const BYTES_PER_SAMPLE: usize = 2;

pub fn build_header(data_bytes: u32, sample_rate: u32, channels: u16) -> [u8; HEADER_BYTES] {
    let mut h = [0u8; HEADER_BYTES];
    let byte_rate = sample_rate * channels as u32 * BYTES_PER_SAMPLE as u32;
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&(channels * BYTES_PER_SAMPLE as u16).to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

pub fn samples_to_bytes(pcm: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pcm.len() * 2);
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Wraps PCM into a self-contained WAV file buffer.
pub fn build_wav(pcm: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_BYTES + pcm.len() * 2);
    out.extend_from_slice(&build_header((pcm.len() * 2) as u32, sample_rate, channels));
    out.extend_from_slice(&samples_to_bytes(pcm));
    out
}

/// What a finished (or abandoned) writer reports about its file.
#[derive(Debug, Clone, Default)]
pub struct WavCloseResult {
    pub bytes: u64,
    pub seconds: f64,
    pub error: String,
    pub channels: u16,
}

/// Streams PCM to disk as it arrives, so a crash mid-meeting still leaves a
/// playable file (the reader recovers a header that was never patched).
pub struct WavWriter {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub data_bytes: u64,
    /// What stopped the file being written, or `""` while it still is.
    pub error: String,
    file: Option<File>,
}

impl WavWriter {
    pub fn create(path: &Path, sample_rate: u32, channels: u16) -> std::io::Result<WavWriter> {
        let mut file = File::create(path)?;
        file.write_all(&build_header(0, sample_rate, channels))?;
        Ok(WavWriter {
            path: path.to_path_buf(),
            sample_rate,
            channels,
            data_bytes: 0,
            error: String::new(),
            file: Some(file),
        })
    }

    /// Appends PCM, and gives up on the file rather than failing loudly if it
    /// cannot: a full disk fails this write and every one after it, so the
    /// minutes already on disk are sealed with a correct header and `error` is
    /// left for the caller to notice. A truncated meeting that plays beats a
    /// longer one that does not.
    pub fn write(&mut self, pcm: &[i16]) {
        if pcm.is_empty() {
            return;
        }
        let Some(file) = self.file.as_mut() else { return };
        match file.write_all(&samples_to_bytes(pcm)) {
            Ok(()) => self.data_bytes += (pcm.len() * 2) as u64,
            Err(err) => {
                self.error = err.to_string();
                self.close();
            }
        }
    }

    pub fn seconds(&self) -> f64 {
        self.data_bytes as f64 / (self.sample_rate as f64 * self.channels as f64 * BYTES_PER_SAMPLE as f64)
    }

    pub fn is_open(&self) -> bool {
        self.file.is_some()
    }

    pub fn close(&mut self) -> WavCloseResult {
        if let Some(mut file) = self.file.take() {
            let header = build_header(self.data_bytes.min(u32::MAX as u64) as u32, self.sample_rate, self.channels);
            let patched = file.seek(SeekFrom::Start(0)).and_then(|_| file.write_all(&header)).and_then(|_| file.flush());
            if let Err(err) = patched {
                if self.error.is_empty() {
                    self.error = err.to_string();
                }
            }
        }
        WavCloseResult { bytes: self.data_bytes, seconds: self.seconds(), error: self.error.clone(), channels: self.channels }
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Debug, Clone)]
pub struct WavData {
    pub pcm: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
    pub seconds: f64,
}

/// Where the PCM lives in a WAV file, found by walking the chunk list.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WavLayout {
    pub data_offset: u64,
    pub data_bytes: u64,
    pub channels: u16,
    pub sample_rate: u32,
    pub bits: u16,
}

/// Walks the chunk list of a WAV header rather than assuming 44 bytes. `size`
/// is the whole file's size, used when a writer died before patching lengths.
pub fn parse_layout(head: &[u8], size: u64) -> Option<WavLayout> {
    if head.len() < 12 || &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return None;
    }
    let (mut channels, mut sample_rate, mut bits) = (1u16, SAMPLE_RATE, 16u16);
    let mut off = 12usize;
    while off + 8 <= head.len() {
        let id = &head[off..off + 4];
        let chunk = u32::from_le_bytes(head[off + 4..off + 8].try_into().ok()?) as u64;
        let body = off + 8;
        if id == b"fmt " && body + 16 <= head.len() {
            channels = u16::from_le_bytes([head[body + 2], head[body + 3]]);
            sample_rate = u32::from_le_bytes(head[body + 4..body + 8].try_into().ok()?);
            bits = u16::from_le_bytes([head[body + 14], head[body + 15]]);
        } else if id == b"data" {
            let avail = size.saturating_sub(body as u64);
            let bytes = if chunk > 0 && chunk <= avail { chunk } else { avail };
            return Some(WavLayout { data_offset: body as u64, data_bytes: bytes, channels, sample_rate, bits });
        }
        off = body + chunk as usize + (chunk as usize % 2);
    }
    None
}

pub fn read_wav(path: &Path) -> Result<WavData, String> {
    let buf = fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let layout = parse_layout(&buf, buf.len() as u64).ok_or_else(|| format!("Not a RIFF/WAVE file: {}", path.display()))?;
    if layout.bits != 16 {
        return Err(format!("Expected 16-bit PCM, got {}-bit", layout.bits));
    }
    if layout.channels == 0 || layout.sample_rate == 0 {
        return Err(format!("Malformed WAV header: {}", path.display()));
    }
    let start = layout.data_offset as usize;
    let end = (start + layout.data_bytes as usize).min(buf.len());
    let pcm: Vec<i16> = buf[start..end].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
    let seconds = pcm.len() as f64 / (layout.sample_rate as f64 * layout.channels as f64);
    Ok(WavData { pcm, sample_rate: layout.sample_rate, channels: layout.channels, seconds })
}

/// Pulls interleaved PCM apart into one mono buffer per channel.
pub fn deinterleave(pcm: &[i16], channels: u16) -> Vec<Vec<i16>> {
    let c = channels.max(1) as usize;
    if c == 1 {
        return vec![pcm.to_vec()];
    }
    let frames = pcm.len() / c;
    let mut out = vec![Vec::with_capacity(frames); c];
    for frame in pcm.chunks_exact(c) {
        for (ch, s) in frame.iter().enumerate() {
            out[ch].push(*s);
        }
    }
    out
}

/// Folds interleaved PCM down to one channel — summed and clamped, not
/// averaged: each side is near-silence while the other talks, so averaging
/// would halve every voice to guard against an overlap that is mostly rare.
pub fn downmix(pcm: &[i16], channels: u16) -> Vec<i16> {
    let c = channels.max(1) as usize;
    if c == 1 {
        return pcm.to_vec();
    }
    pcm.chunks_exact(c)
        .map(|frame| frame.iter().map(|&s| s as i32).sum::<i32>().clamp(-32768, 32767) as i16)
        .collect()
}

/// Root-mean-square of PCM, normalised to 0..1.
pub fn rms(pcm: &[i16]) -> f64 {
    if pcm.is_empty() {
        return 0.0;
    }
    let sum: f64 = pcm.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    (sum / pcm.len() as f64).sqrt()
}

/// RMS of one channel of interleaved PCM, without pulling the buffer apart.
pub fn channel_rms(pcm: &[i16], channels: u16, channel: usize) -> f64 {
    let c = channels.max(1) as usize;
    if c == 1 {
        return rms(pcm);
    }
    let frames = pcm.len() / c;
    if frames == 0 {
        return 0.0;
    }
    let sum: f64 = pcm.chunks_exact(c).map(|f| (f[channel] as f64 / 32768.0).powi(2)).sum();
    (sum / frames as f64).sqrt()
}

#[derive(Debug, Clone, PartialEq)]
pub struct PcmChunk {
    /// Frame offsets into the mono buffer the chunks were cut from.
    pub start: usize,
    pub end: usize,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// Splits mono PCM into ~`target_seconds` pieces, nudging each cut to the
/// quietest spot within `search_seconds` so a word is rarely sliced in half.
///
/// A stereo recording is chunked once, on the downmix — so both channels are
/// cut at a moment when nobody was talking — and the frame offsets let each
/// channel be sliced at the boundaries that decision produced.
pub fn split_into_chunks(pcm: &[i16], sample_rate: u32, target_seconds: f64, search_seconds: f64) -> Vec<PcmChunk> {
    let per_sec = sample_rate as f64;
    let target = ((target_seconds * per_sec).round() as usize).max(1);
    let search = (search_seconds * per_sec).round() as usize;
    let window = ((0.1 * per_sec).round() as usize).max(1);
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < pcm.len() {
        let mut end = start + target;
        if end >= pcm.len() {
            end = pcm.len();
        } else {
            let lo = (start + target / 2).max(end.saturating_sub(search));
            let hi = pcm.len().min(end + search);
            let mut best = end;
            let mut best_energy = f64::INFINITY;
            let mut p = lo;
            while p + window <= hi {
                let e = rms(&pcm[p..p + window]);
                if e < best_energy {
                    best_energy = e;
                    best = p + window / 2;
                }
                p += window;
            }
            end = best.max(start + 1);
        }
        chunks.push(PcmChunk {
            start,
            end,
            start_seconds: start as f64 / per_sec,
            end_seconds: end as f64 / per_sec,
        });
        start = end;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_round_trips_and_patches_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        let mut w = WavWriter::create(&path, 16000, 2).unwrap();
        w.write(&[1, -1, 2, -2]);
        let result = w.close();
        assert_eq!(result.bytes, 8);
        let data = read_wav(&path).unwrap();
        assert_eq!(data.channels, 2);
        assert_eq!(data.pcm, vec![1, -1, 2, -2]);
    }

    #[test]
    fn reads_unpatched_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.wav");
        let mut bytes = build_header(0, 16000, 1).to_vec();
        bytes.extend_from_slice(&samples_to_bytes(&[5, 6, 7]));
        fs::write(&path, bytes).unwrap();
        assert_eq!(read_wav(&path).unwrap().pcm, vec![5, 6, 7]);
    }

    #[test]
    fn channel_helpers() {
        let pcm = [100i16, 200, 30000, 30000];
        assert_eq!(deinterleave(&pcm, 2), vec![vec![100, 30000], vec![200, 30000]]);
        assert_eq!(downmix(&pcm, 2), vec![300, 32767]);
        assert!((channel_rms(&[0, 32767, 0, 32767], 2, 1) - 1.0).abs() < 0.001);
        assert_eq!(channel_rms(&[0, 32767, 0, 32767], 2, 0), 0.0);
    }

    #[test]
    fn chunks_cover_everything_and_prefer_quiet_cuts() {
        let rate = 1000;
        let mut pcm = vec![10000i16; 10_000];
        for s in &mut pcm[4900..5100] {
            *s = 0;
        }
        let chunks = split_into_chunks(&pcm, rate, 5.0, 1.0);
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, pcm.len());
        for pair in chunks.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        assert!((4900..=5100).contains(&chunks[0].end));
    }
}
