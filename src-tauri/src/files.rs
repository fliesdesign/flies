use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: u64 = 100 * 1024 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub revision: u64,
    pub nodes: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    id: String,
    name: String,
    updated_at: u64,
    node_count: usize,
}

#[derive(Serialize)]
pub struct FileLibrary {
    files: Vec<FileSummary>,
    warnings: Vec<String>,
    directory: String,
}

pub struct FileStore {
    root: PathBuf,
}
pub struct LocalFiles(pub Arc<Mutex<FileStore>>);

fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .map_err(|_| "System clock is unavailable.".into())
}

fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err("Choose a file name between 1 and 120 characters.".into());
    }
    Ok(name.into())
}

fn validate_nodes(nodes: &[Value]) -> Result<()> {
    if nodes.len() > 100_000 {
        return Err("This file contains too many nodes.".into());
    }
    let mut by_id = HashMap::new();
    for node in nodes {
        let id = node["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("A node has no ID.")?;
        if by_id.insert(id, node).is_some() {
            return Err("Duplicate node IDs.".into());
        }
        if !node["name"].is_string() {
            return Err("A node has no name.".into());
        }
        let kind = node.get("kind").and_then(Value::as_str).unwrap_or("frame");
        if !matches!(
            kind,
            "frame" | "group" | "rectangle" | "text" | "image" | "pen"
        ) {
            return Err("Unsupported node type.".into());
        }
        for key in ["x", "y", "width", "height"] {
            let value = node[key]
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or("Invalid node geometry.")?;
            if matches!(key, "width" | "height") && value < 1.0 {
                return Err("Invalid node size.".into());
            }
        }
    }
    // Memoized ancestor walks keep ordinary large trees linear and reject cycles.
    let mut checked = HashSet::new();
    for id in by_id.keys() {
        let mut chain = HashSet::new();
        let mut current = *id;
        while !checked.contains(current) {
            if !chain.insert(current) {
                return Err("Node hierarchy contains a cycle.".into());
            }
            let node = by_id[current];
            let Some(parent) = node.get("parentId") else {
                break;
            };
            let parent = parent.as_str().ok_or("Invalid parent ID.")?;
            let parent_node = by_id.get(parent).ok_or("A parent node is missing.")?;
            if !matches!(
                parent_node
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("frame"),
                "frame" | "group"
            ) {
                return Err("Only frames and groups can contain nodes.".into());
            }
            current = parent;
        }
        checked.extend(chain);
    }
    Ok(())
}

pub fn read_json(path: &Path) -> Result<String> {
    let file = File::open(path).map_err(|error| format!("Could not open file: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read file: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Files must be smaller than 100 MB.".into());
    }
    String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 JSON.".into())
}

impl FileStore {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)
            .map_err(|e| format!("Could not create local file library: {e}"))?;
        Ok(Self { root })
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
        {
            return Err("Invalid file ID.".into());
        }
        let path = self.root.join(format!("{id}.json"));
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("Linked files cannot be used as library files.".into());
        }
        Ok(path)
    }
    fn write(&self, file: &ProjectFile, new: bool) -> Result<()> {
        let bytes =
            serde_json::to_vec_pretty(file).map_err(|e| format!("Could not encode file: {e}"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Files must be smaller than 100 MB.".into());
        }
        let path = self.path(&file.id)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)
            .map_err(|e| format!("Could not prepare save: {e}"))?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|e| format!("Could not write file: {e}"))?;
        if new {
            temporary.persist_noclobber(&path)
        } else {
            temporary.persist(&path)
        }
        .map_err(|e| format!("Could not finish save. Previous file was kept: {e}"))?;
        Ok(())
    }
    pub fn create(&self, name: &str, nodes: Vec<Value>) -> Result<ProjectFile> {
        let name = valid_name(name)?;
        validate_nodes(&nodes)?;
        let timestamp = now()?;
        let file = ProjectFile {
            format: "flies".into(),
            version: 1,
            id: format!(
                "{:x}-{:x}-{:x}",
                timestamp,
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ),
            name,
            created_at: timestamp,
            updated_at: timestamp,
            revision: 0,
            nodes,
        };
        self.write(&file, true)?;
        Ok(file)
    }
    pub fn open(&self, id: &str) -> Result<ProjectFile> {
        let file: ProjectFile = serde_json::from_str(&read_json(&self.path(id)?)?)
            .map_err(|e| format!("This file contains invalid JSON: {e}"))?;
        if file.format != "flies" || file.version != 1 || file.id != id {
            return Err("This file format is not supported.".into());
        }
        valid_name(&file.name)?;
        validate_nodes(&file.nodes)?;
        Ok(file)
    }
    pub fn save(
        &self,
        id: &str,
        revision: u64,
        name: &str,
        nodes: Vec<Value>,
    ) -> Result<ProjectFile> {
        let mut file = self.open(id)?;
        if file.revision != revision {
            return Err("This file changed in another window. Your edits are still here; reopen the file before saving again.".into());
        }
        file.name = valid_name(name)?;
        validate_nodes(&nodes)?;
        file.nodes = nodes;
        file.revision = file
            .revision
            .checked_add(1)
            .ok_or("File revision limit reached.")?;
        file.updated_at = now()?.max(file.updated_at.saturating_add(1));
        self.write(&file, false)?;
        Ok(file)
    }
    pub fn list(&self) -> Result<FileLibrary> {
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        for entry in
            fs::read_dir(&self.root).map_err(|e| format!("Could not read local files: {e}"))?
        {
            let entry = entry.map_err(|e| format!("Could not read local file: {e}"))?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            match self.open(id) {
                Ok(file) => files.push(FileSummary {
                    id: file.id,
                    name: file.name,
                    updated_at: file.updated_at,
                    node_count: file.nodes.len(),
                }),
                Err(error) => {
                    warnings.push(format!("{}: {error}", entry.file_name().to_string_lossy()))
                }
            }
        }
        files.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(FileLibrary {
            files,
            warnings,
            directory: self.root.to_string_lossy().into_owned(),
        })
    }
}

async fn with_store<T: Send + 'static>(
    state: State<'_, LocalFiles>,
    action: impl FnOnce(&FileStore) -> Result<T> + Send + 'static,
) -> Result<T> {
    let store = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store
            .lock()
            .map_err(|_| "Local file storage is unavailable.".to_string())?;
        action(&store)
    })
    .await
    .map_err(|e| format!("File operation failed: {e}"))?
}

#[tauri::command]
pub async fn list_files(state: State<'_, LocalFiles>) -> Result<FileLibrary> {
    with_store(state, FileStore::list).await
}
#[tauri::command]
pub async fn create_file(
    state: State<'_, LocalFiles>,
    name: String,
    nodes: Vec<Value>,
) -> Result<ProjectFile> {
    with_store(state, move |store| store.create(&name, nodes)).await
}
#[tauri::command]
pub async fn open_file(state: State<'_, LocalFiles>, id: String) -> Result<ProjectFile> {
    with_store(state, move |store| store.open(&id)).await
}
#[tauri::command]
pub async fn save_file(
    state: State<'_, LocalFiles>,
    id: String,
    revision: u64,
    name: String,
    nodes: Vec<Value>,
) -> Result<ProjectFile> {
    with_store(state, move |store| store.save(&id, revision, &name, nodes)).await
}
#[tauri::command]
pub async fn choose_project_json(app: tauri::AppHandle) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Flies JSON", &["json", "lra"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        read_json(
            &file
                .into_path()
                .map_err(|e| format!("Could not access this file: {e}"))?,
        )
        .map(Some)
    })
    .await
    .map_err(|e| format!("File picker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn node() -> Value {
        json!({"id":"node", "name":"Frame", "x":0,"y":0,"width":100,"height":100})
    }
    #[test]
    fn create_save_reopen_retains_metadata_and_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().into()).unwrap();
        let file = store.create(" First file ", vec![node()]).unwrap();
        let saved = store.save(&file.id, 0, "Renamed", vec![]).unwrap();
        let reloaded = FileStore::new(dir.path().into())
            .unwrap()
            .open(&file.id)
            .unwrap();
        assert_eq!(reloaded.name, "Renamed");
        assert_eq!(reloaded.created_at, file.created_at);
        assert_eq!(reloaded.revision, 1);
        assert_eq!(reloaded.updated_at, saved.updated_at);
        assert!(reloaded.nodes.is_empty());
    }
    #[test]
    fn failed_save_keeps_previous_json_and_rejects_stale_writers() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().into()).unwrap();
        let file = store.create("File", vec![node()]).unwrap();
        let before = fs::read(store.path(&file.id).unwrap()).unwrap();
        assert!(store
            .save(&file.id, 0, "File", vec![node(), node()])
            .is_err());
        assert_eq!(fs::read(store.path(&file.id).unwrap()).unwrap(), before);
        store.save(&file.id, 0, "File", vec![]).unwrap();
        assert!(store.save(&file.id, 0, "Stale", vec![]).is_err());
        assert_eq!(store.open(&file.id).unwrap().name, "File");
    }
    #[test]
    fn invalid_ids_cycles_and_names_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().into()).unwrap();
        assert!(store.open("../secret").is_err());
        assert!(store.create("   ", vec![]).is_err());
        let mut cyclic = node();
        cyclic["parentId"] = json!("node");
        assert!(store.create("Cycle", vec![cyclic]).is_err());
    }
    #[test]
    fn corrupt_files_are_reported_without_hiding_healthy_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().into()).unwrap();
        store.create("Healthy", vec![]).unwrap();
        fs::write(dir.path().join("bad.json"), "broken").unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.files.len(), 1);
        assert_eq!(list.warnings.len(), 1);
    }
}
