use crate::local_files::{self, Cancel, LocalFile, check};
use std::{
    collections::VecDeque,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub struct ReverseRecords {
    file: File,
    position: u64,
    separator: Vec<u8>,
    carry: Vec<u8>,
    records: VecDeque<String>,
    cancel: Cancel,
}
impl ReverseRecords {
    pub fn new(
        root: &Path,
        snapshot: &LocalFile,
        record_end: &str,
        cancel: &Cancel,
    ) -> Result<Self, String> {
        Ok(Self {
            file: local_files::open(root, snapshot)?,
            position: snapshot.size,
            separator: if record_end == "newline" {
                b"\n".to_vec()
            } else {
                record_end.as_bytes().to_vec()
            },
            carry: Vec::new(),
            records: VecDeque::new(),
            cancel: cancel.clone(),
        })
    }
    pub fn next(&mut self) -> Result<Option<String>, String> {
        loop {
            check(&self.cancel)?;
            if let Some(record) = self.records.pop_front() {
                if !record.is_empty() {
                    return Ok(Some(record));
                }
                continue;
            }
            if self.position == 0 {
                return Ok(if self.carry.is_empty() {
                    None
                } else {
                    Some(
                        String::from_utf8_lossy(&std::mem::take(&mut self.carry))
                            .trim()
                            .into(),
                    )
                });
            }
            let length = self.position.min(64 * 1024) as usize;
            self.position -= length as u64;
            self.file
                .seek(SeekFrom::Start(self.position))
                .map_err(|e| e.to_string())?;
            let mut buffer = vec![0; length];
            self.file
                .read_exact(&mut buffer)
                .map_err(|e| e.to_string())?;
            buffer.append(&mut self.carry);
            let mut end = buffer.len();
            while let Some(split) = buffer[..end]
                .windows(self.separator.len())
                .rposition(|bytes| bytes == self.separator)
            {
                let record = String::from_utf8_lossy(&buffer[split + self.separator.len()..end])
                    .trim()
                    .to_string();
                if !record.is_empty() {
                    self.records.push_back(record);
                }
                end = split;
            }
            self.carry = buffer[..end].to_vec();
            if self.carry.len() > 16 * 1024 * 1024 {
                return Err("单条日志超过 16 MB".into());
            }
        }
    }
}
