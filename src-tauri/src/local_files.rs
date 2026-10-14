//! Native bounded file IO. No SSH, shell, Perl, or platform-specific commands.
pub use crate::local_file_reader::ReverseRecords;
use std::{
    collections::VecDeque,
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::SystemTime,
};

#[derive(Clone, Debug)]
pub struct LocalFile {
    pub relative: String,
    pub absolute: PathBuf,
    pub size: u64,
    pub modified: u128,
    pub identity: String,
}
pub type Cancel = Arc<AtomicBool>;
pub fn check(cancel: &Cancel) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("查询已取消".into())
    } else {
        Ok(())
    }
}
fn identity(info: &Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", info.dev(), info.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}", info.created().ok())
    }
}
pub fn metadata(root: &Path, absolute: &Path) -> Result<LocalFile, String> {
    let canonical = fs::canonicalize(absolute)
        .map_err(|e| format!("无法读取本地日志 {}：{e}", absolute.display()))?;
    if !canonical.starts_with(root) {
        return Err("日志路径超出应用目录".into());
    }
    let info = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !info.is_file() {
        return Err("日志路径不是文件".into());
    }
    Ok(LocalFile {
        relative: absolute
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/"),
        absolute: absolute.into(),
        size: info.len(),
        modified: info
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        identity: identity(&info),
    })
}
pub fn root(directory: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(directory)
        .map_err(|e| format!("本地应用目录不存在或不可访问：{directory}（{e}）"))?;
    if !root.is_dir() {
        return Err(format!("本地应用路径不是目录：{directory}"));
    }
    Ok(root)
}
pub fn discover(root: &Path, cancel: &Cancel) -> Result<Vec<LocalFile>, String> {
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut files = Vec::new();
    let mut count = 0;
    while let Some(directory) = queue.pop_front() {
        check(cancel)?;
        for entry in fs::read_dir(&directory)
            .map_err(|e| format!("无法读取目录 {}：{e}", directory.display()))?
        {
            check(cancel)?;
            count += 1;
            if count > 100_000 {
                return Err("本地目录条目超过 100000，请缩小应用根目录".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            if !fs::canonicalize(entry.path())
                .map_err(|e| e.to_string())?
                .starts_with(root)
            {
                continue;
            }
            if kind.is_dir() {
                queue.push_back(entry.path());
            }
            if kind.is_file() {
                files.push(metadata(root, &entry.path())?);
            }
        }
    }
    files.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then(a.relative.cmp(&b.relative))
    });
    Ok(files)
}
pub fn open(root: &Path, snapshot: &LocalFile) -> Result<File, String> {
    let current = metadata(root, &snapshot.absolute)?;
    let file = File::open(&current.absolute).map_err(|e| e.to_string())?;
    let info = file.metadata().map_err(|e| e.to_string())?;
    if current.identity != snapshot.identity
        || identity(&info) != snapshot.identity
        || info.len() < snapshot.size
    {
        return Err("日志文件已轮转或截断，请重新查询首页".into());
    }
    Ok(file)
}

pub fn sample_records(
    root: &Path,
    file: &LocalFile,
    cancel: &Cancel,
) -> Result<Vec<String>, String> {
    check(cancel)?;
    let length = file.size.min(256 * 1024) as usize;
    let mut bytes = vec![0; length];
    open(root, file)?
        .read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    let complete = if file.size <= length as u64 {
        length
    } else {
        bytes.iter().rposition(|byte| *byte == b'\n').unwrap_or(0)
    };
    let head = String::from_utf8_lossy(&bytes[..complete])
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(6)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if file.size <= length as u64 && head.len() < 6 {
        return Ok(head);
    }
    let mut reader = ReverseRecords::new(root, file, "newline", cancel)?;
    let mut tail = Vec::new();
    while let Some(record) = reader.next()? {
        if !record.is_empty() {
            tail.push(record);
        }
        if tail.len() >= 3 {
            break;
        }
    }
    tail.reverse();
    Ok(head.into_iter().take(3).chain(tail).collect())
}
// Dropping an aborted async invoke signals its blocking reader to stop too.
struct CancelOnDrop(Cancel);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce(&Cancel) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let guard = CancelOnDrop(cancel.clone());
    let result = tokio::task::spawn_blocking(move || work(&cancel))
        .await
        .map_err(|e| e.to_string())?;
    drop(guard);
    result
}
