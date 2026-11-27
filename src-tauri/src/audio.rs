//! Native audio sources: the microphone, and WASAPI loopback of whatever the
//! default output device plays — the two things the Electron build needed a
//! hidden Chromium window and `getDisplayMedia` for.
//!
//! Every source is converted to 16 kHz mono f32 on the audio thread and pushed
//! into a [`SampleQueue`] that knows *when* its samples were heard. That
//! matters because the two sources run on different clocks, and WASAPI
//! loopback delivers nothing at all while nothing is playing: the mixer lines
//! the queues up on a shared timeline rather than by counting samples, so a
//! silent call is silence on the right channel, not a channel that slides
//! out of step with the left.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};

use crate::types::AudioDevice;

pub const RATE: u32 = 16_000;
/// How far a queue's idea of "now" may drift from the wall clock before it is
/// re-anchored (100 ms).
const DRIFT_FRAMES: i64 = RATE as i64 / 10;
/// Longest a queue holds if nobody drains it (30 s).
const MAX_QUEUE: usize = RATE as usize * 30;

/// Frames since `epoch` at 16 kHz.
pub fn frames_since(epoch: Instant) -> i64 {
    (epoch.elapsed().as_secs_f64() * RATE as f64) as i64
}

/// Converts any device rate to 16 kHz: a windowed-sinc low-pass at 0.45 of the
/// output rate, then linear interpolation at the output spacing.
pub struct Resampler {
    step: f64,
    taps: Vec<f32>,
    hist: Vec<f32>,
    hpos: usize,
    buf: Vec<f32>,
    t: f64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Resampler {
        let step = in_rate as f64 / out_rate as f64;
        let taps = if in_rate > out_rate {
            let n = 47usize;
            let m = (n - 1) as f64 / 2.0;
            let fc = 0.45 * out_rate as f64 / in_rate as f64;
            let mut h: Vec<f64> = (0..n)
                .map(|k| {
                    let x = k as f64 - m;
                    let sinc = if x == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * x) };
                    let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (n - 1) as f64).cos()
                        + 0.08 * (4.0 * std::f64::consts::PI * k as f64 / (n - 1) as f64).cos();
                    sinc * w
                })
                .collect();
            let sum: f64 = h.iter().sum();
            h.iter_mut().for_each(|v| *v /= sum);
            h.into_iter().map(|v| v as f32).collect()
        } else {
            vec![1.0]
        };
        let n = taps.len();
        Resampler { step, taps, hist: vec![0.0; n], hpos: 0, buf: Vec::new(), t: 0.0 }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let n = self.taps.len();
        for &x in input {
            let y = if n == 1 {
                x
            } else {
                self.hist[self.hpos] = x;
                let mut acc = 0.0f32;
                let mut idx = self.hpos;
                for &tap in &self.taps {
                    acc += tap * self.hist[idx];
                    idx = if idx == 0 { n - 1 } else { idx - 1 };
                }
                self.hpos = (self.hpos + 1) % n;
                acc
            };
            self.buf.push(y);
        }
        while self.t + 1.0 < self.buf.len() as f64 {
            let i = self.t.floor() as usize;
            let frac = (self.t - i as f64) as f32;
            out.push(self.buf[i] * (1.0 - frac) + self.buf[i + 1] * frac);
            self.t += self.step;
        }
        let k = (self.t.floor() as usize).min(self.buf.len());
        self.buf.drain(..k);
        self.t -= k as f64;
    }
}

struct QueueInner {
    samples: VecDeque<f32>,
    /// Timeline frame of `samples[0]`.
    head: i64,
}

/// 16 kHz mono samples, each with a place on the shared timeline.
pub struct SampleQueue {
    epoch: Instant,
    inner: Mutex<QueueInner>,
}

impl SampleQueue {
    pub fn new(epoch: Instant) -> SampleQueue {
        SampleQueue { epoch, inner: Mutex::new(QueueInner { samples: VecDeque::new(), head: 0 }) }
    }

    /// Appends samples that have just arrived, so they end at "now". A queue
    /// whose sample count has drifted from the clock is re-anchored.
    pub fn push(&self, data: &[f32]) {
        self.push_at(data, frames_since(self.epoch));
    }

    pub fn push_at(&self, data: &[f32], now: i64) {
        if data.is_empty() {
            return;
        }
        let mut q = self.inner.lock().unwrap();
        let n = data.len() as i64;
        if q.samples.is_empty() {
            q.head = now - n;
        } else {
            let drift = q.head + q.samples.len() as i64 + n - now;
            if drift.abs() > DRIFT_FRAMES {
                q.head -= drift;
            }
        }
        q.samples.extend(data.iter().copied());
        while q.samples.len() > MAX_QUEUE {
            q.samples.pop_front();
            q.head += 1;
        }
    }

    /// Fills `out` with the samples at timeline frames `from..from+out.len()`
    /// (silence where there are none) and drops everything before the end.
    pub fn take_range(&self, from: i64, out: &mut [f32]) {
        let mut q = self.inner.lock().unwrap();
        while q.head < from && !q.samples.is_empty() {
            q.samples.pop_front();
            q.head += 1;
        }
        for (i, slot) in out.iter_mut().enumerate() {
            let idx = from + i as i64;
            if q.head == idx {
                if let Some(s) = q.samples.pop_front() {
                    *slot = s;
                    q.head += 1;
                    continue;
                }
            }
            *slot = 0.0;
        }
    }

    /// Everything queued, regardless of timeline.
    pub fn take_all(&self) -> Vec<f32> {
        let mut q = self.inner.lock().unwrap();
        let n = q.samples.len() as i64;
        q.head += n;
        q.samples.drain(..).collect()
    }
}

/// An open input. The stream must stay on the thread that opened it.
pub struct Source {
    pub stream: cpal::Stream,
    pub queue: Arc<SampleQueue>,
    pub label: String,
    /// Set by the stream's error callback — the device went away.
    pub failed: Arc<AtomicBool>,
}

impl Source {
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }
}

fn device_name(d: &cpal::Device) -> String {
    d.name().unwrap_or_else(|_| "Unnamed input".into())
}

/// The audio inputs on this machine. A device's id is its name: it is what
/// Windows shows, and what survives a restart.
pub fn list_inputs() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|it| {
            it.map(|d| {
                let name = device_name(&d);
                AudioDevice { id: name.clone(), label: name }
            })
            .collect()
        })
        .unwrap_or_default()
}

pub fn default_output_name() -> Option<String> {
    cpal::default_host().default_output_device().map(|d| device_name(&d))
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, queue: Arc<SampleQueue>, failed: Arc<AtomicBool>) -> Result<cpal::Stream, String>
where
    T: SizedSample + cpal::Sample,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let mut resampler = Resampler::new(config.sample_rate.0, RATE);
    let mut mono: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::new();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                mono.clear();
                for frame in data.chunks(channels) {
                    let sum: f32 = frame.iter().map(|s| <f32 as cpal::FromSample<T>>::from_sample_(*s)).sum();
                    mono.push(sum / frame.len() as f32);
                }
                out.clear();
                resampler.process(&mono, &mut out);
                queue.push(&out);
            },
            move |err| {
                crate::log_warn!("audio stream error: {err}");
                failed.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| e.to_string())
}

fn open(device: &cpal::Device, loopback: bool, epoch: Instant) -> Result<Source, String> {
    let supported = if loopback { device.default_output_config() } else { device.default_input_config() }.map_err(|e| e.to_string())?;
    let config: cpal::StreamConfig = supported.config();
    let queue = Arc::new(SampleQueue::new(epoch));
    let failed = Arc::new(AtomicBool::new(false));
    let (q, f) = (queue.clone(), failed.clone());
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(device, &config, q, f),
        SampleFormat::I16 => build::<i16>(device, &config, q, f),
        SampleFormat::I32 => build::<i32>(device, &config, q, f),
        SampleFormat::U16 => build::<u16>(device, &config, q, f),
        SampleFormat::U8 => build::<u8>(device, &config, q, f),
        SampleFormat::F64 => build::<f64>(device, &config, q, f),
        other => Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(Source { stream, queue, label: device_name(device), failed })
}

/// Opens the chosen microphone: by id, then by label, then the Windows
/// default — and says so when it had to fall back.
pub fn open_mic(id: &str, label: &str, epoch: Instant) -> Result<(Source, Option<String>), String> {
    let host = cpal::default_host();
    let mut fallback_note = None;
    let chosen = if id.is_empty() {
        None
    } else {
        let found = host
            .input_devices()
            .ok()
            .and_then(|mut it| it.find(|d| device_name(d) == id).or_else(|| host.input_devices().ok()?.find(|d| !label.is_empty() && device_name(d) == label)));
        if found.is_none() {
            fallback_note = Some(format!("{} is not available; using the system default.", if label.is_empty() { "The chosen microphone" } else { label }));
        }
        found
    };
    if let Some(device) = chosen {
        match open(&device, false, epoch) {
            Ok(s) => return Ok((s, None)),
            Err(e) => {
                crate::log_warn!("could not open {}: {e}", device_name(&device));
                fallback_note = Some(format!("{} is not available; using the system default.", if label.is_empty() { "The chosen microphone" } else { label }));
            }
        }
    }
    let device = host.default_input_device().ok_or_else(|| "No microphone was found.".to_string())?;
    let source = open(&device, false, epoch)?;
    Ok((source, fallback_note))
}

/// Opens WASAPI loopback on the default output device.
pub fn open_loopback(epoch: Instant) -> Result<Source, String> {
    let device = cpal::default_host().default_output_device().ok_or_else(|| "No output device to capture from.".to_string())?;
    open(&device, true, epoch).map_err(|e| format!("System audio could not be captured: {e}"))
}

pub fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_keeps_rate_and_tone() {
        let mut r = Resampler::new(48_000, 16_000);
        let input: Vec<f32> = (0..48_000).map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin() * 0.5).collect();
        let mut out = vec![];
        for chunk in input.chunks(480) {
            r.process(chunk, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 2, "{}", out.len());
        let rms = (out[1000..].iter().map(|s| s * s).sum::<f32>() / (out.len() - 1000) as f32).sqrt();
        assert!((rms - 0.3535).abs() < 0.02, "{rms}");
    }

    #[test]
    fn resampler_filters_above_nyquist() {
        let mut r = Resampler::new(48_000, 16_000);
        let input: Vec<f32> = (0..48_000).map(|i| (2.0 * std::f32::consts::PI * 12_000.0 * i as f32 / 48_000.0).sin() * 0.5).collect();
        let mut out = vec![];
        r.process(&input, &mut out);
        let rms = (out[1000..].iter().map(|s| s * s).sum::<f32>() / (out.len() - 1000) as f32).sqrt();
        assert!(rms < 0.02, "{rms}");
    }

    #[test]
    fn queue_aligns_on_timeline() {
        let q = SampleQueue::new(Instant::now());
        q.push_at(&[1.0, 2.0, 3.0], 103);
        let mut out = [9.0f32; 6];
        q.take_range(99, &mut out);
        assert_eq!(out, [0.0, 1.0, 2.0, 3.0, 0.0, 0.0]);
        q.push_at(&[4.0, 5.0], 200);
        q.push_at(&[6.0], 201);
        let mut late = [0.0f32; 2];
        q.take_range(199, &mut late);
        assert_eq!(late, [5.0, 6.0], "frames before the range are dropped as late");
        q.push_at(&[1.0; 10], 1000);
        q.push_at(&[2.0; 10], 1010);
        q.push_at(&[3.0; 10], 5000);
        assert_eq!(q.take_all().len(), 30);
    }

    #[test]
    fn converts_samples() {
        assert_eq!(to_i16(2.0), 32767);
        assert_eq!(to_i16(-2.0), -32767);
        assert_eq!(to_i16(0.0), 0);
    }
}
