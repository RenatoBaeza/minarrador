//! The desktop wallpaper: reading which picture Windows shows, setting
//! another, and drawing the open to-do tasks over it.
//!
//! The registry is read and written directly (`HKCU\Control Panel\Desktop`)
//! and the picture is set with `SystemParametersInfo`, the same call the
//! Settings app makes. The panel is drawn natively — the wallpaper composed in
//! its Fill/Fit/Tile style, a blurred, darkened card in the bottom-right
//! corner, Segoe UI text — so no window is ever needed to photograph a page.

use std::path::Path;

use chrono::{Datelike, NaiveDate};
use image::{imageops, Rgba, RgbaImage};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

use crate::types::Todo;

pub const DESKTOP_MAX_TASKS: usize = 12;

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WallpaperState {
    /// The picture's path; `""` for a solid colour.
    pub path: String,
    /// `WallpaperStyle`: 10 fill, 6 fit, 2 stretch, 0 centre or tile, 22 span.
    pub style: String,
    /// `TileWallpaper`: 1 repeats a style-0 picture.
    pub tile: String,
    /// `Colors\Background`, "R G B".
    pub background: String,
}

fn digits(value: &str, fallback: &str) -> String {
    let v = value.trim();
    if !v.is_empty() && v.len() <= 3 && v.chars().all(|c| c.is_ascii_digit()) { v.into() } else { fallback.into() }
}

pub fn read_wallpaper() -> Result<WallpaperState, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let desk = hkcu.open_subkey_with_flags("Control Panel\\Desktop", KEY_READ).map_err(|e| e.to_string())?;
    let get = |k: &RegKey, name: &str| k.get_value::<String, _>(name).unwrap_or_default();
    let background = hkcu.open_subkey_with_flags("Control Panel\\Colors", KEY_READ).map(|c| get(&c, "Background")).unwrap_or_default();
    Ok(WallpaperState {
        path: get(&desk, "WallPaper").trim().to_string(),
        style: digits(&get(&desk, "WallpaperStyle"), "10"),
        tile: digits(&get(&desk, "TileWallpaper"), "0"),
        background: background.trim().to_string(),
    })
}

pub fn set_wallpaper(file: &Path, style: &str, tile: &str) -> Result<(), String> {
    let desk = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Control Panel\\Desktop", KEY_SET_VALUE)
        .map_err(|e| e.to_string())?;
    desk.set_value("WallpaperStyle", &digits(style, "10")).map_err(|e| e.to_string())?;
    desk.set_value("TileWallpaper", &digits(tile, "0")).map_err(|e| e.to_string())?;
    crate::win::set_desk_wallpaper(file)
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopTask {
    pub title: String,
    pub project: String,
    pub priority: String,
    pub due: String,
    pub urgency: &'static str,
}

/// How a due date reads on the desktop, and how loudly.
pub fn due_text(due: &str, today: NaiveDate) -> (String, &'static str) {
    let Ok(date) = NaiveDate::parse_from_str(due, "%Y-%m-%d") else { return (String::new(), "") };
    let days = (date - today).num_days();
    let short = if date.year() == today.year() { date.format("%-d %b").to_string() } else { date.format("%-d %b %Y").to_string() };
    match days {
        d if d < 0 => (format!("Overdue · {short}"), "overdue"),
        0 => ("Today".into(), "today"),
        1 => ("Tomorrow".into(), "soon"),
        d if d < 7 => (date.format("%A").to_string(), "soon"),
        _ => (short, ""),
    }
}

/// The first open tasks in manual order, gathered under their projects; tasks
/// with no project come last.
pub fn desktop_tasks(todos: &[Todo], today: NaiveDate) -> (Vec<DesktopTask>, usize) {
    let open: Vec<&Todo> = todos.iter().filter(|t| !t.done).collect();
    let shown: Vec<DesktopTask> = open
        .iter()
        .take(DESKTOP_MAX_TASKS)
        .map(|t| {
            let (due, urgency) = due_text(&t.due, today);
            DesktopTask { title: t.title.clone(), project: t.project.clone(), priority: t.priority.clone(), due, urgency }
        })
        .collect();
    let mut projects: Vec<String> = vec![];
    for t in shown.iter().filter(|t| !t.project.is_empty()) {
        if !projects.contains(&t.project) {
            projects.push(t.project.clone());
        }
    }
    let mut tasks: Vec<DesktopTask> = vec![];
    for p in &projects {
        tasks.extend(shown.iter().filter(|t| &t.project == p).cloned());
    }
    tasks.extend(shown.iter().filter(|t| t.project.is_empty()).cloned());
    let more = open.len() - tasks.len();
    (tasks, more)
}

pub fn background_rgb(value: &str) -> [u8; 3] {
    let parts: Vec<u8> = value.split_whitespace().filter_map(|p| p.parse::<u8>().ok()).collect();
    if parts.len() == 3 && value.split_whitespace().count() == 3 { [parts[0], parts[1], parts[2]] } else { [0, 0, 0] }
}

// ---------------------------------------------------------------- drawing

pub struct Fonts {
    regular: fontdue::Font,
    bold: fontdue::Font,
}

impl Fonts {
    pub fn load() -> Result<Fonts, String> {
        let dir = std::env::var("WINDIR").map(|w| Path::new(&w).join("Fonts")).unwrap_or_else(|_| "C:\\Windows\\Fonts".into());
        let read = |names: &[&str]| -> Result<fontdue::Font, String> {
            for n in names {
                if let Ok(bytes) = std::fs::read(dir.join(n)) {
                    return fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).map_err(|e| e.to_string());
                }
            }
            Err(format!("none of {names:?} is installed"))
        };
        let regular = read(&["segoeui.ttf", "arial.ttf"])?;
        let bold = read(&["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"]).or_else(|_| read(&["segoeui.ttf", "arial.ttf"]))?;
        Ok(Fonts { regular, bold })
    }
}

#[derive(Clone, Copy)]
struct Paint {
    rgb: [u8; 3],
    alpha: f32,
}

fn blend(img: &mut RgbaImage, x: i32, y: i32, paint: Paint, coverage: f32) {
    if x < 0 || y < 0 || x >= img.width() as i32 || y >= img.height() as i32 {
        return;
    }
    let a = (paint.alpha * coverage).clamp(0.0, 1.0);
    if a <= 0.0 {
        return;
    }
    let px = img.get_pixel_mut(x as u32, y as u32);
    for c in 0..3 {
        px[c] = (paint.rgb[c] as f32 * a + px[c] as f32 * (1.0 - a)).round() as u8;
    }
}

#[allow(clippy::too_many_arguments)]
fn rounded_rect(img: &mut RgbaImage, x: f32, y: f32, w: f32, h: f32, r: f32, paint: Paint, stroke: Option<Paint>) {
    for py in y.floor() as i32..(y + h).ceil() as i32 {
        for px in x.floor() as i32..(x + w).ceil() as i32 {
            let (cx, cy) = (px as f32 + 0.5, py as f32 + 0.5);
            let qx = (cx - (x + w / 2.0)).abs() - (w / 2.0 - r);
            let qy = (cy - (y + h / 2.0)).abs() - (h / 2.0 - r);
            let dist = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r;
            let cover = (0.5 - dist).clamp(0.0, 1.0);
            blend(img, px, py, paint, cover);
            if let Some(s) = stroke {
                blend(img, px, py, s, (1.0 - (dist + 0.5).abs()).clamp(0.0, 1.0));
            }
        }
    }
}

fn circle(img: &mut RgbaImage, cx: f32, cy: f32, r: f32, fill: Option<Paint>, stroke: Option<(Paint, f32)>) {
    for py in (cy - r - 2.0) as i32..(cy + r + 2.0) as i32 {
        for px in (cx - r - 2.0) as i32..(cx + r + 2.0) as i32 {
            let d = ((px as f32 + 0.5 - cx).powi(2) + (py as f32 + 0.5 - cy).powi(2)).sqrt() - r;
            if let Some(f) = fill {
                blend(img, px, py, f, (0.5 - d).clamp(0.0, 1.0));
            }
            if let Some((s, width)) = stroke {
                let inner = d + width;
                blend(img, px, py, s, ((0.5 - d).clamp(0.0, 1.0) - (0.5 - inner).clamp(0.0, 1.0)).max(0.0));
            }
        }
    }
}

fn hline(img: &mut RgbaImage, x: f32, y: f32, w: f32, paint: Paint) {
    for px in x as i32..(x + w) as i32 {
        blend(img, px, y as i32, paint, 1.0);
    }
}

fn text_width(font: &fontdue::Font, text: &str, size: f32, spacing: f32) -> f32 {
    text.chars().map(|c| font.metrics(c, size).advance_width + spacing).sum()
}

/// Draws one line with its baseline at `y`, returning the advance.
#[allow(clippy::too_many_arguments)]
fn draw_text(img: &mut RgbaImage, font: &fontdue::Font, text: &str, x: f32, y: f32, size: f32, paint: Paint, spacing: f32) -> f32 {
    let shadow = Paint { rgb: [0, 0, 0], alpha: 0.45 * paint.alpha.min(1.0) };
    let mut pen = x;
    for c in text.chars() {
        let (m, bitmap) = font.rasterize(c, size);
        let gx = pen.round() as i32 + m.xmin;
        let gy = y.round() as i32 - m.height as i32 - m.ymin;
        for row in 0..m.height {
            for col in 0..m.width {
                let cover = bitmap[row * m.width + col] as f32 / 255.0;
                if cover > 0.0 {
                    blend(img, gx + col as i32, gy + row as i32 + 1, shadow, cover);
                    blend(img, gx + col as i32, gy + row as i32, paint, cover);
                }
            }
        }
        pen += m.advance_width + spacing;
    }
    pen - x
}

/// Word-wraps to `max` width in at most `lines` lines, the last ellipsised.
fn wrap(font: &fontdue::Font, text: &str, size: f32, max: f32, lines: usize) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut current = String::new();
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut i = 0;
    while i < words.len() {
        let candidate = if current.is_empty() { words[i].to_string() } else { format!("{current} {}", words[i]) };
        if text_width(font, &candidate, size, 0.0) <= max || current.is_empty() && text_width(font, words[i], size, 0.0) <= max {
            current = candidate;
            i += 1;
        } else if current.is_empty() {
            // One word wider than the line: break it by characters.
            let mut part = String::new();
            for c in words[i].chars() {
                if text_width(font, &format!("{part}{c}"), size, 0.0) > max {
                    break;
                }
                part.push(c);
            }
            if part.is_empty() {
                part = words[i].chars().take(1).collect();
            }
            let rest: String = words[i].chars().skip(part.chars().count()).collect();
            out.push(part);
            if rest.is_empty() {
                i += 1;
            } else {
                return finish_wrap(font, out, Some(rest), &words[i + 1..], size, max, lines);
            }
        } else {
            out.push(std::mem::take(&mut current));
        }
        if out.len() == lines {
            let remaining: Vec<&str> = words[i..].to_vec();
            return finish_wrap(font, out, (!current.is_empty()).then(|| current.clone()), &remaining, size, max, lines);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    if out.len() > lines {
        return finish_wrap(font, out[..lines].to_vec(), None, &["…"], size, max, lines);
    }
    out
}

fn finish_wrap(font: &fontdue::Font, mut out: Vec<String>, pending: Option<String>, rest: &[&str], size: f32, max: f32, lines: usize) -> Vec<String> {
    let overflow = pending.is_some() || !rest.is_empty();
    if out.len() < lines {
        if let Some(p) = pending {
            out.push(p);
        }
    }
    out.truncate(lines);
    if overflow {
        if let Some(last) = out.last_mut() {
            while !last.is_empty() && text_width(font, &format!("{last}…"), size, 0.0) > max {
                last.pop();
            }
            *last = format!("{}…", last.trim_end());
        }
    }
    out
}

/// Lays the wallpaper out in its own style on a canvas of the screen's size.
fn compose(canvas: &mut RgbaImage, picture: &RgbaImage, style: &str, tile: &str) {
    let (w, h) = canvas.dimensions();
    let (pw, ph) = picture.dimensions();
    if pw == 0 || ph == 0 {
        return;
    }
    let place = |canvas: &mut RgbaImage, img: &RgbaImage, x: i64, y: i64| imageops::overlay(canvas, img, x, y);
    match (style, tile) {
        ("0", "1") => {
            let own = picture;
            let mut y = 0;
            while y < h {
                let mut x = 0;
                while x < w {
                    place(canvas, own, x as i64, y as i64);
                    x += own.width();
                }
                y += own.height();
            }
        }
        ("0", _) => place(canvas, picture, (w as i64 - pw as i64) / 2, (h as i64 - ph as i64) / 2),
        ("2", _) => {
            let img = imageops::resize(picture, w, h, imageops::FilterType::CatmullRom);
            place(canvas, &img, 0, 0);
        }
        ("6", _) => {
            let k = (w as f32 / pw as f32).min(h as f32 / ph as f32);
            let (nw, nh) = (((pw as f32 * k).round() as u32).max(1), ((ph as f32 * k).round() as u32).max(1));
            let img = imageops::resize(picture, nw, nh, imageops::FilterType::CatmullRom);
            place(canvas, &img, (w as i64 - nw as i64) / 2, (h as i64 - nh as i64) / 2);
        }
        _ => {
            let k = (w as f32 / pw as f32).max(h as f32 / ph as f32);
            let (nw, nh) = (((pw as f32 * k).round() as u32).max(1), ((ph as f32 * k).round() as u32).max(1));
            let img = imageops::resize(picture, nw, nh, imageops::FilterType::CatmullRom);
            place(canvas, &img, (w as i64 - nw as i64) / 2, (h as i64 - nh as i64) / 2);
        }
    }
}

pub struct DesktopPage<'a> {
    pub tasks: &'a [DesktopTask],
    pub more: usize,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    /// Taskbar and friends: (top, right, bottom, left), physical pixels.
    pub insets: (i32, i32, i32, i32),
    pub background: [u8; 3],
    pub picture: Option<&'a RgbaImage>,
    pub style: &'a str,
    pub tile: &'a str,
}

const WHITE: [u8; 3] = [255, 255, 255];

fn priority_colour(p: &str) -> Option<[u8; 3]> {
    match p {
        "high" => Some([0xff, 0x6b, 0x6b]),
        "medium" => Some([0xff, 0xb5, 0x47]),
        "low" => Some([0x6a, 0xa8, 0xff]),
        _ => None,
    }
}

enum Row<'a> {
    Heading(&'a str, bool),
    Task(&'a DesktopTask, Vec<String>),
    Note(String),
}

pub fn render(page: &DesktopPage, fonts: &Fonts) -> RgbaImage {
    let s = page.scale.max(0.5);
    let bg = page.background;
    let mut img = RgbaImage::from_pixel(page.width, page.height, Rgba([bg[0], bg[1], bg[2], 255]));
    if let Some(p) = page.picture {
        compose(&mut img, p, page.style, page.tile);
    }

    let panel_w = 380.0 * s;
    let pad_x = 14.0 * s;
    let inner = panel_w - 2.0 * pad_x;
    let title_size = 15.0 * s;
    let grouped = page.tasks.iter().any(|t| !t.project.is_empty());

    let mut rows: Vec<Row> = vec![];
    let mut last_project: Option<&str> = None;
    for t in page.tasks {
        if grouped && last_project != Some(t.project.as_str()) {
            rows.push(Row::Heading(if t.project.is_empty() { "No project" } else { &t.project }, t.project.is_empty()));
            last_project = Some(&t.project);
        }
        rows.push(Row::Task(t, wrap(&fonts.regular, &t.title, title_size, inner - 19.0 * s, 2)));
    }
    if page.tasks.is_empty() {
        rows.push(Row::Note("Nothing on the list.".into()));
    } else if page.more > 0 {
        rows.push(Row::Note(format!("+ {} more", page.more)));
    }

    let line_h = title_size * 1.35;
    let row_height = |r: &Row| -> f32 {
        match r {
            Row::Heading(..) => 12.0 * s * 1.6 + 4.0 * s,
            Row::Task(t, lines) => 12.0 * s + lines.len() as f32 * line_h + if t.due.is_empty() { 0.0 } else { 17.0 * s },
            Row::Note(_) => 8.0 * s + 16.0 * s,
        }
    };
    let header_h = 10.0 * s + 13.0 * s * 1.3 + 10.0 * s;
    let (top, right, bottom, _left) = page.insets;
    let max_h = page.height as f32 - (top + bottom) as f32 - 80.0 * s;
    let mut content_h = header_h + 8.0 * s;
    let mut fit = 0;
    for (i, r) in rows.iter().enumerate() {
        let extra = row_height(r) + if matches!(r, Row::Heading(..)) && i > 0 { 16.0 * s } else { 0.0 };
        if content_h + extra > max_h {
            break;
        }
        content_h += extra;
        fit += 1;
    }
    let panel_h = content_h.max(60.0 * s);
    let px = page.width as f32 - right as f32 - 40.0 * s - panel_w;
    let py = page.height as f32 - bottom as f32 - 40.0 * s - panel_h;

    // Frosted glass: blur what is behind the card, then darken it.
    let (bx, by) = (px.max(0.0) as u32, py.max(0.0) as u32);
    let (bw, bh) = ((panel_w as u32).min(page.width.saturating_sub(bx)), (panel_h as u32).min(page.height.saturating_sub(by)));
    if bw > 0 && bh > 0 {
        let region = imageops::crop_imm(&img, bx, by, bw, bh).to_image();
        let blurred = imageops::blur(&region, 9.0 * s);
        let r = 12.0 * s;
        for y in 0..bh {
            for x in 0..bw {
                let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
                let qx = (cx - bw as f32 / 2.0).abs() - (bw as f32 / 2.0 - r);
                let qy = (cy - bh as f32 / 2.0).abs() - (bh as f32 / 2.0 - r);
                let d = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r;
                let cover = (0.5 - d).clamp(0.0, 1.0);
                if cover > 0.0 {
                    let b = blurred.get_pixel(x, y);
                    blend(&mut img, (bx + x) as i32, (by + y) as i32, Paint { rgb: [b[0], b[1], b[2]], alpha: 1.0 }, cover);
                }
            }
        }
    }
    rounded_rect(
        &mut img,
        px,
        py,
        panel_w,
        panel_h,
        12.0 * s,
        Paint { rgb: [12, 14, 18], alpha: 0.78 },
        Some(Paint { rgb: WHITE, alpha: 0.10 }),
    );

    let mut y = py + 10.0 * s + 13.0 * s;
    let x = px + pad_x;
    let head = Paint { rgb: WHITE, alpha: 0.8 };
    let w = draw_text(&mut img, &fonts.bold, "TO-DO", x, y, 13.0 * s, head, 1.0 * s);
    let count = page.tasks.len() + page.more;
    if count > 0 {
        draw_text(&mut img, &fonts.bold, &count.to_string(), x + w + 6.0 * s, y, 13.0 * s, Paint { rgb: WHITE, alpha: 0.48 }, 0.0);
    }
    y += 13.0 * s * 0.3 + 10.0 * s;

    let mut prev_task = false;
    for (i, r) in rows.iter().take(fit).enumerate() {
        match r {
            Row::Heading(name, none) => {
                if i > 0 {
                    y += 8.0 * s;
                    hline(&mut img, x, y, inner, Paint { rgb: WHITE, alpha: 0.16 });
                    y += 8.0 * s;
                }
                let paint = if *none { Paint { rgb: WHITE, alpha: 0.6 } } else { Paint { rgb: [0x9c, 0xc3, 0xff], alpha: 1.0 } };
                let font = if *none { &fonts.regular } else { &fonts.bold };
                let label = wrap(font, name, 12.0 * s, inner, 1).pop().unwrap_or_default();
                y += 2.0 * s + 12.0 * s;
                draw_text(&mut img, font, &label, x, y, 12.0 * s, paint, 0.0);
                y += 12.0 * s * 0.6 + 2.0 * s;
                prev_task = false;
            }
            Row::Task(t, lines) => {
                if prev_task {
                    hline(&mut img, x, y, inner, Paint { rgb: WHITE, alpha: 0.08 });
                }
                y += 6.0 * s;
                let dot_y = y + 6.0 * s + 4.5 * s;
                match priority_colour(&t.priority) {
                    Some(c) => circle(&mut img, x + 4.5 * s, dot_y, 4.5 * s, Some(Paint { rgb: c, alpha: 1.0 }), None),
                    None => circle(&mut img, x + 4.5 * s, dot_y, 4.5 * s, None, Some((Paint { rgb: WHITE, alpha: 0.55 }, 1.5 * s))),
                }
                let tx = x + 19.0 * s;
                for line in lines {
                    draw_text(&mut img, &fonts.regular, line, tx, y + title_size * 1.05, title_size, Paint { rgb: WHITE, alpha: 1.0 }, 0.0);
                    y += line_h;
                }
                if !t.due.is_empty() {
                    let (font, paint) = match t.urgency {
                        "overdue" => (&fonts.bold, Paint { rgb: [0xff, 0x8f, 0x8f], alpha: 1.0 }),
                        "today" => (&fonts.bold, Paint { rgb: [0xff, 0xd2, 0x7a], alpha: 1.0 }),
                        _ => (&fonts.regular, Paint { rgb: WHITE, alpha: 0.72 }),
                    };
                    draw_text(&mut img, font, &t.due, tx, y + 13.0 * s, 12.0 * s, paint, 0.0);
                    y += 17.0 * s;
                }
                y += 6.0 * s;
                prev_task = true;
            }
            Row::Note(text) => {
                y += 8.0 * s + 12.0 * s;
                draw_text(&mut img, &fonts.regular, text, x, y, 12.0 * s, Paint { rgb: WHITE, alpha: 0.65 }, 0.0);
                y += 4.0 * s;
            }
        }
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(title: &str, project: &str, due: &str, done: bool) -> Todo {
        Todo {
            id: title.into(),
            title: title.into(),
            description: String::new(),
            project: project.into(),
            priority: "high".into(),
            due: due.into(),
            done,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn due_labels() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 10).unwrap();
        assert_eq!(due_text("2026-03-09", today), ("Overdue · 9 Mar".into(), "overdue"));
        assert_eq!(due_text("2026-03-10", today).1, "today");
        assert_eq!(due_text("2026-03-11", today).0, "Tomorrow");
        assert_eq!(due_text("2026-03-13", today).0, "Friday");
        assert_eq!(due_text("2027-01-01", today).0, "1 Jan 2027");
        assert_eq!(due_text("", today).0, "");
    }

    #[test]
    fn groups_by_project_in_manual_order() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 10).unwrap();
        let todos = vec![todo("a", "", "", false), todo("b", "X", "", false), todo("c", "Y", "", false), todo("d", "X", "", false), todo("e", "", "", true)];
        let (tasks, more) = desktop_tasks(&todos, today);
        let titles: Vec<&str> = tasks.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["b", "d", "c", "a"]);
        assert_eq!(more, 0);
        let many: Vec<Todo> = (0..20).map(|i| todo(&i.to_string(), "", "", false)).collect();
        assert_eq!(desktop_tasks(&many, today).1, 8);
    }

    #[test]
    fn colours() {
        assert_eq!(background_rgb("10 20 30"), [10, 20, 30]);
        assert_eq!(background_rgb("10 20"), [0, 0, 0]);
        assert_eq!(background_rgb("300 1 1"), [0, 0, 0]);
    }

    #[test]
    fn renders_a_panel_when_fonts_exist() {
        let Ok(fonts) = Fonts::load() else { return };
        let today = NaiveDate::from_ymd_opt(2026, 3, 10).unwrap();
        let (tasks, more) = desktop_tasks(&[todo("Write the quarterly report for the board and the investors", "Work", "2026-03-09", false)], today);
        let page = DesktopPage { tasks: &tasks, more, width: 800, height: 600, scale: 1.0, insets: (0, 0, 40, 0), background: [40, 80, 120], picture: None, style: "10", tile: "0" };
        let img = render(&page, &fonts);
        assert_eq!(img.dimensions(), (800, 600));
        assert_eq!(img.get_pixel(5, 5), &Rgba([40, 80, 120, 255]));
        assert_ne!(img.get_pixel(800 - 40 - 200, 600 - 40 - 40 - 10), &Rgba([40, 80, 120, 255]), "the panel darkens its corner");
        let lines = wrap(&fonts.regular, &"word ".repeat(40), 15.0, 300.0, 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].ends_with('…'));
    }
}

#[cfg(test)]
mod preview {
    use super::*;

    /// Draws sample tasks over the current wallpaper into
    /// `MINARRADOR_RENDER_OUT`, for eyeballing the panel. Never sets anything.
    #[test]
    #[ignore]
    fn render_preview() {
        let Some(out) = std::env::var_os("MINARRADOR_RENDER_OUT") else { return };
        let today = chrono::Local::now().date_naive();
        let t = |title: &str, project: &str, priority: &str, due: chrono::NaiveDate| Todo {
            id: title.into(), title: title.into(), description: String::new(), project: project.into(),
            priority: priority.into(), due: due.format("%Y-%m-%d").to_string(), done: false,
            created_at: String::new(), updated_at: String::new(),
        };
        let todos = vec![
            t("Send the Q4 budget to finance", "Work", "high", today - chrono::Duration::days(1)),
            t("Review the onboarding deck and leave comments for the design team before the offsite", "Work", "medium", today),
            t("Book dentist", "", "none", today + chrono::Duration::days(1)),
            t("Renew passport", "Home", "low", today + chrono::Duration::days(20)),
        ];
        let (tasks, more) = desktop_tasks(&todos, today);
        let current = read_wallpaper().unwrap_or_default();
        let picture = image::open(&current.path).ok().map(|i| i.to_rgba8());
        let m = crate::win::primary_monitor().unwrap();
        let page = DesktopPage {
            tasks: &tasks, more, width: m.bounds.2 as u32, height: m.bounds.3 as u32, scale: 1.0,
            insets: (0, 0, m.bounds.3 - m.work.3, 0), background: background_rgb(&current.background),
            picture: picture.as_ref(), style: &current.style, tile: &current.tile,
        };
        render(&page, &Fonts::load().unwrap()).save(out).unwrap();
    }
}
