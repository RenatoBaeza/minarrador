//! `meeting-audio:` — a meeting's WAV as mono, by byte range.
//!
//! The player gets a mono file even when the recording is two channels (mic
//! left, call right is right for transcription and wrong in headphones). Each
//! Range request on the mono file the player sees is mapped back onto the
//! stereo file on disk and downmixed on the fly.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::wav::{build_header, downmix, parse_layout, WavLayout, BYTES_PER_SAMPLE, HEADER_BYTES};

/// The longest single response; the player asks again for the rest, so an hour
/// of audio is never read into memory for one request.
pub const MAX_RESPONSE: u64 = 2 * 1024 * 1024;

pub fn wav_layout(file: &Path) -> Option<WavLayout> {
    let mut f = File::open(file).ok()?;
    let size = f.metadata().ok()?.len();
    let mut head = vec![0u8; size.min(4096) as usize];
    f.read_exact(&mut head).ok()?;
    let mut layout = parse_layout(&head, size)?;
    if layout.bits != 16 || layout.channels == 0 || layout.sample_rate == 0 {
        return None;
    }
    let frame = layout.channels as u64 * BYTES_PER_SAMPLE as u64;
    layout.data_bytes -= layout.data_bytes % frame;
    Some(layout)
}

pub fn mono_size(layout: &WavLayout) -> u64 {
    HEADER_BYTES as u64 + layout.data_bytes / layout.channels as u64
}

#[derive(Debug, PartialEq)]
pub enum Range {
    Whole,
    Part(u64, u64),
    Invalid,
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n`; anything else is the whole file.
pub fn parse_range(header: Option<&str>, size: u64) -> Range {
    let Some(h) = header else { return Range::Whole };
    let Some(spec) = h.trim().strip_prefix("bytes=") else { return Range::Whole };
    let Some((a, b)) = spec.split_once('-') else { return Range::Whole };
    if a.contains(',') || b.contains(',') {
        return Range::Whole;
    }
    let (a, b) = (a.trim(), b.trim());
    let num = |s: &str| s.parse::<u64>().ok();
    let (start, end) = match (a.is_empty(), b.is_empty()) {
        (true, true) => return Range::Invalid,
        (true, false) => match num(b) {
            Some(n) if n > 0 => (size.saturating_sub(n), size.saturating_sub(1)),
            Some(_) => return Range::Invalid,
            None => return Range::Whole,
        },
        (false, _) => {
            let Some(start) = num(a) else { return Range::Whole };
            let end = if b.is_empty() { size.saturating_sub(1) } else { num(b).map(|e| e.min(size.saturating_sub(1))).unwrap_or(size.saturating_sub(1)) };
            (start, end)
        }
    };
    if start >= size || end < start {
        Range::Invalid
    } else {
        Range::Part(start, end)
    }
}

/// Bytes `start..=end` of the mono file the player sees.
pub fn mono_bytes(file: &Path, layout: &WavLayout, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let header = build_header((mono_size(layout) - HEADER_BYTES as u64) as u32, layout.sample_rate, 1);
    let mut out = Vec::with_capacity((end - start + 1) as usize);
    let h = HEADER_BYTES as u64;
    if start < h {
        out.extend_from_slice(&header[start as usize..(end + 1).min(h) as usize]);
    }
    if end < h {
        return Ok(out);
    }
    let from = start.max(h) - h;
    let to = end - h;
    let bps = BYTES_PER_SAMPLE as u64;
    let first_frame = from / bps;
    let last_frame = to / bps;
    let frame_bytes = layout.channels as u64 * bps;
    let mut f = File::open(file)?;
    f.seek(SeekFrom::Start(layout.data_offset + first_frame * frame_bytes))?;
    let mut raw = vec![0u8; ((last_frame - first_frame + 1) * frame_bytes) as usize];
    let mut read = 0;
    while read < raw.len() {
        match f.read(&mut raw[read..])? {
            0 => break,
            n => read += n,
        }
    }
    raw.truncate(read - read % frame_bytes as usize);
    let samples: Vec<i16> = raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
    let mono = downmix(&samples, layout.channels);
    let mut bytes: Vec<u8> = Vec::with_capacity(mono.len() * 2);
    for s in mono {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    let lo = (from - first_frame * bps) as usize;
    let hi = ((to - first_frame * bps + 1) as usize).min(bytes.len());
    if lo < hi {
        out.extend_from_slice(&bytes[lo..hi]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wav::build_wav;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-"), 100), Range::Part(0, 99));
        assert_eq!(parse_range(Some("bytes=10-20"), 100), Range::Part(10, 20));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Range::Part(90, 99));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Range::Invalid);
        assert_eq!(parse_range(Some("bytes=-"), 100), Range::Invalid);
        assert_eq!(parse_range(Some("items=1-2"), 100), Range::Whole);
    }

    #[test]
    fn serves_stereo_as_mono() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        std::fs::write(&path, build_wav(&[1, 2, 3, 4, 5, 6], 16000, 2)).unwrap();
        let layout = wav_layout(&path).unwrap();
        let size = mono_size(&layout);
        assert_eq!(size, 44 + 6);
        let all = mono_bytes(&path, &layout, 0, size - 1).unwrap();
        assert_eq!(&all[44..], &[3, 0, 7, 0, 11, 0]);
        assert_eq!(&all[0..4], b"RIFF");
        let middle = mono_bytes(&path, &layout, 45, 47).unwrap();
        assert_eq!(middle, vec![0, 7, 0]);
    }
}
