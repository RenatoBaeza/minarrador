//! Disk usage: what is taking the space inside a folder the user picked.
//!
//! No path ever crosses into the page. The scan hands out opaque numeric ids and
//! keeps the path behind each; an id from a previous scan resolves to nothing.
//! The tree is walked once — every directory's total is recorded on the way —
//! so expanding a level is one `read_dir` plus lookups. Symlinks and junctions
//! are counted as the link and never followed: Windows keeps junctions that loop
//! back up their own tree.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::types::{DiskEntry, DiskProgress};

const PROGRESS_MIN: Duration = Duration::from_millis(120);
const CLUSTER: u64 = 4096;

/// Size on disk, rounded up to a 4 KB cluster.
pub fn size_on_disk(len: u64) -> u64 {
    if len == 0 { 0 } else { len.div_ceil(CLUSTER) * CLUSTER }
}

/// Whether `child` is `parent` or inside it, case-insensitively.
pub fn is_within(parent: &Path, child: &Path) -> bool {
    let p = parent.to_string_lossy().to_lowercase().trim_end_matches(['\\', '/']).to_string();
    let c = child.to_string_lossy().to_lowercase();
    c == p || c.starts_with(&format!("{p}\\")) || c.starts_with(&format!("{p}/"))
}

#[derive(Debug, Clone)]
pub struct DiskNode {
    pub path: PathBuf,
    pub is_directory: bool,
    pub size: u64,
}

/// Cancelled is the only way a walk fails; unreadable folders count as empty.
#[derive(Debug)]
pub struct Cancelled;

pub struct DiskScan {
    pub root: PathBuf,
    dir_sizes: HashMap<PathBuf, u64>,
    ids: HashMap<u64, DiskNode>,
    next_id: u64,
}

fn is_real_dir(entry: &fs::DirEntry) -> bool {
    entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false)
}

impl DiskScan {
    pub fn new(root: PathBuf) -> DiskScan {
        DiskScan { root, dir_sizes: HashMap::new(), ids: HashMap::new(), next_id: 1 }
    }

    /// Walks the whole tree. Errs only when cancelled.
    pub fn walk(&mut self, cancel: &CancellationToken, mut on_progress: impl FnMut(DiskProgress)) -> Result<(u64, u64), Cancelled> {
        let mut counts = (0u64, 0u64);
        let mut last = Instant::now() - PROGRESS_MIN;
        let root = self.root.clone();
        self.visit(&root, cancel, &mut counts, &mut last, &mut on_progress)?;
        on_progress(DiskProgress { files: counts.0, dirs: counts.1, current: String::new() });
        Ok(counts)
    }

    fn visit(&mut self, dir: &Path, cancel: &CancellationToken, counts: &mut (u64, u64), last: &mut Instant, on_progress: &mut impl FnMut(DiskProgress)) -> Result<u64, Cancelled> {
        if cancel.is_cancelled() {
            return Err(Cancelled);
        }
        counts.1 += 1;
        if last.elapsed() >= PROGRESS_MIN {
            *last = Instant::now();
            on_progress(DiskProgress { files: counts.0, dirs: counts.1, current: dir.to_string_lossy().into_owned() });
        }
        let Ok(items) = fs::read_dir(dir) else {
            self.dir_sizes.insert(dir.to_path_buf(), 0);
            return Ok(0);
        };
        let mut total = 0;
        for item in items.filter_map(|e| e.ok()) {
            if is_real_dir(&item) {
                total += self.visit(&item.path(), cancel, counts, last, on_progress)?;
            } else {
                counts.0 += 1;
                total += fs::symlink_metadata(item.path()).map(|m| size_on_disk(m.len())).unwrap_or(0);
            }
        }
        self.dir_sizes.insert(dir.to_path_buf(), total);
        Ok(total)
    }

    fn issue(&mut self, path: PathBuf, is_directory: bool, size: u64) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.ids.insert(id, DiskNode { path, is_directory, size });
        id
    }

    pub fn root_entry(&mut self) -> DiskEntry {
        let size = self.dir_sizes.get(&self.root).copied().unwrap_or(0);
        let name = self.root.to_string_lossy().into_owned();
        let id = self.issue(self.root.clone(), true, size);
        DiskEntry { id, name, is_directory: true, size, has_children: None, inaccessible: None }
    }

    /// One level of a directory this scan issued, largest first.
    pub fn list(&mut self, id: u64) -> Option<Vec<DiskEntry>> {
        let node = self.ids.get(&id)?.clone();
        if !node.is_directory {
            return None;
        }
        let Ok(items) = fs::read_dir(&node.path) else { return Some(vec![]) };
        let mut out = vec![];
        for item in items.filter_map(|e| e.ok()) {
            let full = item.path();
            let name = item.file_name().to_string_lossy().into_owned();
            let dir = is_real_dir(&item);
            let (size, inaccessible) = if dir {
                (self.dir_sizes.get(&full).copied().unwrap_or(0), None)
            } else {
                match fs::symlink_metadata(&full) {
                    Ok(m) => (size_on_disk(m.len()), None),
                    Err(e) => (0, Some(e.kind().to_string())),
                }
            };
            let id = self.issue(full, dir, size);
            out.push(DiskEntry { id, name, is_directory: dir, size, has_children: dir.then_some(true), inaccessible });
        }
        out.sort_by_key(|e| std::cmp::Reverse(e.size));
        Some(out)
    }

    pub fn resolve(&self, id: u64) -> Option<DiskNode> {
        self.ids.get(&id).cloned()
    }

    /// Takes a trashed entry's weight off every folder above it.
    pub fn forget(&mut self, id: u64) {
        let Some(node) = self.ids.remove(&id) else { return };
        let mut dir = node.path.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if !is_within(&self.root, &d) {
                break;
            }
            if let Some(total) = self.dir_sizes.get_mut(&d) {
                *total = total.saturating_sub(node.size);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        if node.is_directory {
            self.dir_sizes.retain(|d, _| !is_within(&node.path, d));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_lists_and_forgets() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        fs::create_dir_all(r.join("big/inner")).unwrap();
        fs::write(r.join("big/inner/a.bin"), vec![0u8; 10_000]).unwrap();
        fs::write(r.join("small.txt"), b"hi").unwrap();
        let mut scan = DiskScan::new(r.to_path_buf());
        let counts = scan.walk(&CancellationToken::new(), |_| {}).unwrap();
        assert_eq!(counts, (2, 3));
        let root_entry = scan.root_entry();
        assert_eq!(root_entry.size, 12288 + 4096);
        let top = scan.list(root_entry.id).unwrap();
        assert_eq!(top[0].name, "big");
        assert_eq!(top[0].size, 12288);
        let big = top[0].id;
        scan.forget(big);
        assert_eq!(scan.root_entry().size, 4096);
        assert!(scan.resolve(big).is_none());
        assert!(scan.list(999).is_none());
    }

    #[test]
    fn helpers() {
        assert_eq!(size_on_disk(1), 4096);
        assert_eq!(size_on_disk(0), 0);
        assert!(is_within(Path::new("C:\\A"), Path::new("c:\\a\\b")));
        assert!(!is_within(Path::new("C:\\A"), Path::new("C:\\AB")));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(DiskScan::new(std::env::temp_dir()).walk(&cancel, |_| {}).is_err());
    }
}
