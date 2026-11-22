//! Port of `src/backend/pathManager.js`.

use serde_json::{Value, json};

use super::nodefs::{self as nfs, NResult};

pub const AUDIO_EXTENSIONS: [&str; 6] = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

#[derive(Debug, Clone)]
pub struct PathManager {
    pub data_dir: String,
    pub audio_dir: String,
    pub cues_dir: String,
    pub config_dir: String,
    pub temp_dir: String,
    pub waveforms_dir: String,
    pub pcm_cache_dir: String,
}

/// One entry of `getAudioFiles`.
#[derive(Debug, Clone)]
pub struct AudioFileEntry {
    pub name: String,
    pub path: String,
    pub relative_path: Option<String>,
    pub size: u64,
    pub modified_ms: f64,
    pub extension: String,
}

/// `getFileInfo`.
#[derive(Debug, Clone)]
pub struct FileInfo {
    pub path: String,
    pub relative_path: Option<String>,
    pub name: String,
    pub size: u64,
    pub created_ms: f64,
    pub modified_ms: f64,
    pub extension: String,
}

impl PathManager {
    /// The constructor; the original starts `ensureDirectories()` without awaiting it.
    pub fn new(data_dir: &str) -> Self {
        // Absolute from the start (WO-023), as `path.resolve(dataDir)` in the original.
        let resolved = nfs::resolve(&[data_dir]);
        let data_dir = resolved.as_str();
        let pm = PathManager {
            data_dir: data_dir.to_string(),
            audio_dir: nfs::join2(data_dir, "audio"),
            cues_dir: nfs::join2(data_dir, "cues"),
            config_dir: nfs::join2(data_dir, "config"),
            temp_dir: nfs::join2(data_dir, "temp"),
            waveforms_dir: nfs::join(&[data_dir, "temp", "waveforms"]),
            pcm_cache_dir: nfs::join2(data_dir, "pcm-cache"),
        };
        let _ = pm.ensure_directories();
        pm
    }

    pub fn ensure_directories(&self) -> NResult<()> {
        let dirs = [
            self.data_dir.clone(),
            self.audio_dir.clone(),
            nfs::join2(&self.audio_dir, "imported"),
            nfs::join2(&self.audio_dir, "user"),
            self.cues_dir.clone(),
            nfs::join2(&self.cues_dir, "workspaces"),
            nfs::join2(&self.cues_dir, "backups"),
            nfs::join2(&self.cues_dir, "templates"),
            self.config_dir.clone(),
            self.temp_dir.clone(),
            self.waveforms_dir.clone(),
            self.pcm_cache_dir.clone(),
        ];
        for d in &dirs {
            nfs::ensure_dir(d)?;
        }
        Ok(())
    }

    pub fn is_path_within(resolved_path: &str, resolved_base: &str) -> bool {
        let p = nfs::resolve1(resolved_path);
        let b = nfs::resolve1(resolved_base);
        p == b || p.starts_with(&format!("{b}/"))
    }

    /// `toRelativePath(absolutePath, basePath = audioDir)`.
    pub fn to_relative_path(&self, absolute: &str) -> Option<String> {
        self.to_relative_path_in(absolute, &self.audio_dir)
    }

    pub fn to_relative_path_in(&self, absolute: &str, base: &str) -> Option<String> {
        if absolute.is_empty() {
            return None;
        }
        let rp = nfs::resolve1(absolute);
        let rb = nfs::resolve1(base);
        if Self::is_path_within(&rp, &rb) {
            Some(nfs::relative(&rb, &rp))
        } else {
            None
        }
    }

    /// `resolvePath(relativePath, basePath = audioDir)`.
    pub fn resolve_path(&self, relative: &str) -> Option<String> {
        self.resolve_path_in(relative, &self.audio_dir)
    }

    pub fn resolve_path_in(&self, relative: &str, base: &str) -> Option<String> {
        if relative.is_empty() {
            return None;
        }
        let rb = nfs::resolve1(base);
        let rp = if nfs::is_absolute(relative) {
            nfs::resolve1(relative)
        } else {
            nfs::resolve(&[base, relative])
        };
        if !Self::is_path_within(&rp, &rb) {
            return None;
        }
        Some(rp)
    }

    pub fn resolve_within_data_dir(&self, p: &str) -> Option<String> {
        self.resolve_path_in(p, &self.data_dir)
    }

    pub fn resolve_within_audio_dir(&self, p: &str) -> Option<String> {
        self.resolve_path_in(p, &self.audio_dir)
    }

    /// `validateFile(filePath)`.
    pub fn validate_file(&self, file_path: &str) -> Value {
        if file_path.is_empty() {
            return json!({ "valid": false, "error": "No file path provided" });
        }
        let Some(resolved) = self.resolve_path(file_path) else {
            return json!({ "valid": false, "error": "Could not resolve file path" });
        };
        match nfs::stat(&resolved) {
            Ok(st) if !st.is_file => json!({ "valid": false, "error": "Path is not a file" }),
            Ok(st) => json!({
                "valid": true,
                "path": resolved,
                "size": st.size,
                "modified": nfs::date_json(st.mtime_ms),
            }),
            Err(e) => json!({ "valid": false, "error": e.message, "path": file_path }),
        }
    }

    /// `getAudioFiles(directory = audioDir)`: recursive, in readdir order.
    pub fn get_audio_files(&self, directory: &str) -> Vec<AudioFileEntry> {
        self.audio_files_in(directory).unwrap_or_default()
    }

    fn audio_files_in(&self, directory: &str) -> NResult<Vec<AudioFileEntry>> {
        let mut out = Vec::new();
        for entry in nfs::readdir_types(directory)? {
            if entry.is_file {
                let ext = nfs::extname(&entry.name).to_lowercase();
                if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                    let full = nfs::join2(directory, &entry.name);
                    let st = nfs::stat(&full)?;
                    out.push(AudioFileEntry {
                        name: entry.name.clone(),
                        relative_path: self.to_relative_path(&full),
                        path: full,
                        size: st.size,
                        modified_ms: st.mtime_ms,
                        extension: ext,
                    });
                }
            } else if entry.is_dir {
                // Each level catches its own errors: a failing subdirectory adds nothing.
                out.extend(self.get_audio_files(&nfs::join2(directory, &entry.name)));
            }
        }
        Ok(out)
    }

    /// `getFileInfo(filePath)`.
    pub fn get_file_info(&self, file_path: &str) -> Option<FileInfo> {
        let resolved = self.resolve_path(file_path)?;
        let st = nfs::stat(&resolved).ok()?;
        Some(FileInfo {
            relative_path: self.to_relative_path(&resolved),
            name: nfs::basename(&resolved, None),
            size: st.size,
            created_ms: st.birthtime_ms,
            modified_ms: st.mtime_ms,
            extension: nfs::extname(&resolved).to_lowercase(),
            path: resolved,
        })
    }

    pub fn metadata_dir(&self) -> String {
        nfs::join2(&self.audio_dir, "metadata")
    }
}
