use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
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
    created_at: u64,
    updated_at: u64,
    node_count: usize,
    preview: Vec<Value>,
}

#[derive(Serialize)]
pub struct FileLibrary {
    files: Vec<FileSummary>,
    warnings: Vec<String>,
    directory: String,
}

pub struct FileStore {
    root: PathBuf,
    db: Connection,
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
    let mut reader = BufReader::new(file);
    let compressed = reader
        .fill_buf()
        .map_err(|e| e.to_string())?
        .starts_with(&[0x1f, 0x8b]);
    let reader: Box<dyn Read> = if compressed {
        Box::new(GzDecoder::new(reader))
    } else {
        Box::new(reader)
    };
    let mut bytes = Vec::new();
    reader
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read file: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Files must be smaller than 100 MB.".into());
    }
    String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 JSON.".into())
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Local library: {error}")
}
fn new_id() -> Result<String> {
    Ok(format!(
        "{:x}-{:x}-{:x}",
        now()?,
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}
fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("Invalid file ID.".into());
    }
    Ok(())
}

// Small geometry previews are indexed separately; embedded image payloads stay in the document.
fn preview(nodes: &[Value]) -> Vec<Value> {
    nodes
        .iter()
        .filter(|node| node["hidden"] != true)
        .take(300)
        .map(|node| {
            let mut value = serde_json::Map::new();
            for key in [
                "id",
                "parentId",
                "kind",
                "x",
                "y",
                "width",
                "height",
                "fill",
                "color",
                "fontSize",
                "cornerRadius",
                "opacity",
                "clipContent",
            ] {
                if let Some(field) = node.get(key) {
                    value.insert(key.into(), field.clone());
                }
            }
            if let Some(text) = node["text"].as_str() {
                value.insert(
                    "text".into(),
                    Value::String(text.chars().take(150).collect()),
                );
            }
            Value::Object(value)
        })
        .collect()
}

impl FileStore {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)
            .map_err(|e| format!("Could not create local file library: {e}"))?;
        let db = Connection::open(root.join("library.sqlite3")).map_err(db_error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        db.execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP INDEX IF EXISTS documents_folder;
             DROP INDEX IF EXISTS folders_parent;
             DROP TABLE IF EXISTS folders;",
        )
        .map_err(db_error)?;
        let _ = db.execute_batch("ALTER TABLE documents DROP COLUMN folder_id");
        db.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS documents(
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               revision INTEGER NOT NULL,
               node_count INTEGER NOT NULL,
               blob TEXT NOT NULL,
               preview TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS documents_updated ON documents(updated_at);
             PRAGMA user_version=1;",
        )
        .map_err(db_error)?;
        let store = Self { root, db };
        Ok(store)
    }
    fn safe_path(&self, filename: &str) -> Result<PathBuf> {
        if filename.contains(['/', '\\']) || filename.starts_with('.') {
            return Err("Invalid document path.".into());
        }
        let path = self.root.join(filename);
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("Linked files cannot be used as library files.".into());
        }
        Ok(path)
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        valid_id(id)?;
        let blob: Option<String> = self
            .db
            .query_row("SELECT blob FROM documents WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)?;
        self.safe_path(&blob.unwrap_or_else(|| format!("{id}.json")))
    }
    fn transaction(&self) -> Result<Transaction<'_>> {
        Transaction::new_unchecked(&self.db, TransactionBehavior::Immediate).map_err(db_error)
    }
    fn validate_file(&self, file: &ProjectFile, id: &str) -> Result<()> {
        if file.format != "flies" || file.version != 1 || file.id != id {
            return Err("This file format is not supported.".into());
        }
        valid_name(&file.name)?;
        validate_nodes(&file.nodes)
    }
    // Publish a new immutable compressed snapshot before committing its index pointer.
    // A crash before commit leaves the previous indexed snapshot untouched.
    fn write(&self, tx: &Transaction<'_>, file: &ProjectFile) -> Result<()> {
        let bytes = serde_json::to_vec(file).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Files must be smaller than 100 MB.".into());
        }
        let blob = format!("{}-{}.json.gz", file.id, new_id()?);
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
        {
            let mut encoder = GzEncoder::new(temporary.as_file_mut(), Compression::default());
            encoder.write_all(&bytes).map_err(|e| e.to_string())?;
            encoder.finish().map_err(|e| e.to_string())?;
        }
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary
            .persist_noclobber(self.safe_path(&blob)?)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        File::open(&self.root)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO documents(id,name,created_at,updated_at,revision,node_count,blob,preview) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at, revision=excluded.revision,node_count=excluded.node_count,blob=excluded.blob,preview=excluded.preview",
            params![file.id, file.name, i64::try_from(file.created_at).map_err(|e| e.to_string())?, i64::try_from(file.updated_at).map_err(|e| e.to_string())?, i64::try_from(file.revision).map_err(|e| e.to_string())?, file.nodes.len() as i64, blob, serde_json::to_string(&preview(&file.nodes)).map_err(|e| e.to_string())?]).map_err(db_error)?;
        Ok(())
    }
    pub fn create(&self, name: &str, nodes: Vec<Value>) -> Result<ProjectFile> {
        let name = valid_name(name)?;
        validate_nodes(&nodes)?;
        let timestamp = now()?;
        let file = ProjectFile {
            format: "flies".into(),
            version: 1,
            id: new_id()?,
            name,
            created_at: timestamp,
            updated_at: timestamp,
            revision: 0,
            nodes,
        };
        let tx = self.transaction()?;
        self.write(&tx, &file)?;
        tx.commit().map_err(db_error)?;
        Ok(file)
    }
    pub fn open(&self, id: &str) -> Result<ProjectFile> {
        let file: ProjectFile = serde_json::from_str(&read_json(&self.path(id)?)?)
            .map_err(|e| format!("This file contains invalid JSON: {e}"))?;
        self.validate_file(&file, id)?;
        Ok(file)
    }
    pub fn save(
        &self,
        id: &str,
        revision: u64,
        name: &str,
        nodes: Vec<Value>,
    ) -> Result<ProjectFile> {
        let tx = self.transaction()?;
        let old_path = self.path(id)?;
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
        self.write(&tx, &file)?;
        tx.commit().map_err(db_error)?;
        // Old compressed revisions are replaceable; original legacy JSON is retained.
        if old_path.extension().and_then(|s| s.to_str()) == Some("gz") {
            let _ = fs::remove_file(old_path);
        }
        Ok(file)
    }
    pub fn list(&self) -> Result<FileLibrary> {
        let mut query = self
            .db
            .prepare(
                "SELECT id,name,created_at,updated_at,node_count,preview,blob FROM documents ORDER BY updated_at DESC,id",
            )
            .map_err(db_error)?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    FileSummary {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        created_at: r.get::<_, i64>(2)? as u64,
                        updated_at: r.get::<_, i64>(3)? as u64,
                        node_count: r.get::<_, i64>(4)? as usize,
                        preview: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                    },
                    r.get::<_, String>(6)?,
                ))
            })
            .map_err(db_error)?;
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        for row in rows {
            let (file, blob) = row.map_err(db_error)?;
            if !self.safe_path(&blob)?.exists() {
                warnings.push(format!("{}: document snapshot is missing.", file.name));
            }
            files.push(file);
        }
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
            .add_filter("Flies JSON", &["json", "lra", "gz"])
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
    fn missing_snapshots_are_reported_without_hiding_healthy_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().into()).unwrap();
        store.create("Healthy", vec![]).unwrap();
        let missing = store.create("Missing", vec![]).unwrap();
        fs::remove_file(store.path(&missing.id).unwrap()).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.files.len(), 2);
        assert_eq!(list.warnings.len(), 1);
    }
    #[test]
    fn compressed_snapshots_round_trip_and_do_not_import_legacy_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("abc.json"), "legacy original").unwrap();
        let store = FileStore::new(dir.path().into()).unwrap();
        assert!(store.list().unwrap().files.is_empty());
        let mut large = node();
        large["text"] = json!("hello ".repeat(10_000));
        let file = store.create("Compressed", vec![large]).unwrap();
        let bytes = fs::read(store.path(&file.id).unwrap()).unwrap();
        assert!(bytes.starts_with(&[0x1f, 0x8b]));
        assert!(bytes.len() < serde_json::to_vec(&file).unwrap().len() / 10);
        assert_eq!(store.open(&file.id).unwrap().nodes, file.nodes);
        assert_eq!(
            fs::read_to_string(dir.path().join("abc.json")).unwrap(),
            "legacy original"
        );
    }
    #[test]
    fn leftover_folders_are_dropped_and_files_stay_listed() {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("library.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TABLE folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL);
             CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL, node_count INTEGER NOT NULL, folder_id TEXT, blob TEXT NOT NULL, preview TEXT NOT NULL);
             INSERT INTO folders VALUES('folder','Old',NULL,1);
             INSERT INTO documents VALUES('abc-1','Kept',1,1,0,0,'folder','missing.json','[]');",
        )
        .unwrap();
        drop(db);
        let store = FileStore::new(dir.path().into()).unwrap();
        assert_eq!(store.list().unwrap().files[0].name, "Kept");
        let leftover: i64 = store
            .db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='folders'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0);
    }
    #[test]
    fn uncommitted_snapshot_never_replaces_the_indexed_document() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().into()).unwrap();
        let mut file = store.create("Original", vec![node()]).unwrap();
        {
            let tx = store.transaction().unwrap();
            file.name = "Uncommitted".into();
            store.write(&tx, &file).unwrap();
        }
        assert_eq!(store.open(&file.id).unwrap().name, "Original");
        let other = FileStore::new(dir.path().into()).unwrap();
        store.save(&file.id, 0, "Saved", vec![]).unwrap();
        assert!(other.save(&file.id, 0, "Stale", vec![node()]).is_err());
        assert_eq!(other.open(&file.id).unwrap().name, "Saved");
    }
}
