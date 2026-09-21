//! Local MCP Streamable HTTP endpoint and desktop request bridge.
mod tools;

use axum::http::request::Parts;
use axum::Router;
use rmcp::{
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, RoleServer, ServerHandler,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tauri::Manager;
use tokio::sync::{mpsc, oneshot, Mutex, OwnedMutexGuard, Semaphore};

const TIMEOUT: Duration = Duration::from_secs(45);
type Reply = oneshot::Sender<()>;

struct FileHold {
    key: String,
    id: String,
    busy: Arc<std::sync::Mutex<HashMap<String, String>>>,
    _guard: OwnedMutexGuard<()>,
}

impl FileHold {
    fn new(
        busy: Arc<std::sync::Mutex<HashMap<String, String>>>,
        key: String,
        id: String,
        guard: OwnedMutexGuard<()>,
    ) -> Self {
        busy.lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key.clone(), id.clone());
        Self {
            key,
            id,
            busy,
            _guard: guard,
        }
    }
}

impl Drop for FileHold {
    fn drop(&mut self) {
        let mut busy = self.busy.lock().unwrap_or_else(|error| error.into_inner());
        if busy.get(&self.key).map(String::as_str) == Some(self.id.as_str()) {
            busy.remove(&self.key);
        }
    }
}

struct Outstanding {
    name: String,
    session: Option<String>,
    reply: Option<Reply>,
    result: Option<Value>,
    hold: Option<FileHold>,
}

struct Requests {
    entries: HashMap<String, Outstanding>,
    stored: VecDeque<String>,
}

#[derive(Clone, Serialize)]
pub struct EditorRequest {
    id: String,
    name: String,
    arguments: Value,
}

pub struct Bridge {
    sender: mpsc::Sender<EditorRequest>,
    receiver: Mutex<mpsc::Receiver<EditorRequest>>,
    requests: Mutex<Requests>,
    sessions: Mutex<HashMap<String, String>>,
    guided_sessions: Mutex<HashSet<String>>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    busy: Arc<std::sync::Mutex<HashMap<String, String>>>,
    capacity: Semaphore,
    timeout: Duration,
}

impl Bridge {
    fn new() -> Arc<Self> {
        Self::create(TIMEOUT)
    }

    fn create(timeout: Duration) -> Arc<Self> {
        let (sender, receiver) = mpsc::channel(16);
        Arc::new(Self {
            sender,
            receiver: Mutex::new(receiver),
            requests: Mutex::new(Requests {
                entries: HashMap::new(),
                stored: VecDeque::new(),
            }),
            sessions: Mutex::new(HashMap::new()),
            guided_sessions: Mutex::new(HashSet::new()),
            locks: Mutex::new(HashMap::new()),
            busy: Arc::new(std::sync::Mutex::new(HashMap::new())),
            capacity: Semaphore::new(17),
            timeout,
        })
    }

    #[cfg(test)]
    async fn call(&self, name: String, arguments: Value) -> Value {
        self.call_on(name, arguments, None).await
    }

    async fn call_on(&self, name: String, mut arguments: Value, session: Option<&str>) -> Value {
        if name == "get_request" {
            return self.read_stored_request(&arguments).await;
        }
        // Bound queued HTTP tools. Same-file calls stay FIFO; other files run together.
        let Ok(_capacity) = self.capacity.try_acquire() else {
            return tool_error("Desktop request queue is full (16 waiting tools). Wait for pending calls to finish.");
        };
        self.bind_session_file(&name, &mut arguments, session).await;
        let id = uuid::Uuid::new_v4().to_string();
        let hold = if let Some(key) = lock_key(&name, &arguments) {
            match self.acquire_file(&key).await {
                Ok(guard) => Some(FileHold::new(self.busy.clone(), key, id.clone(), guard)),
                Err(error) => return error,
            }
        } else {
            None
        };
        let (tx, rx) = oneshot::channel();
        {
            let mut requests = self.requests.lock().await;
            requests.entries.insert(
                id.clone(),
                Outstanding {
                    name: name.clone(),
                    session: session.map(str::to_owned),
                    reply: Some(tx),
                    result: None,
                    hold,
                },
            );
        }
        let request = EditorRequest {
            id: id.clone(),
            name: name.clone(),
            arguments,
        };
        if self.sender.try_send(request).is_err() {
            self.requests.lock().await.entries.remove(&id);
            return tool_error(
                "Desktop request queue is full. Wait for the editor to finish loading.",
            );
        }
        let signaled = tokio::time::timeout(self.timeout, rx).await.is_ok();
        if signaled {
            if let Some(value) = self.take_ready(&id).await {
                return value;
            }
        } else {
            let mut requests = self.requests.lock().await;
            if let Some(entry) = requests.entries.get_mut(&id) {
                // Keep the file lock until the editor replies, then store that reply.
                entry.reply.take();
            }
        }
        if let Some(value) = self.take_ready(&id).await {
            return value;
        }
        let tool_name = self
            .requests
            .lock()
            .await
            .entries
            .get(&id)
            .map(|entry| entry.name.clone())
            .unwrap_or(name);
        still_running(&id, &tool_name)
    }

    async fn acquire_file(&self, key: &str) -> Result<OwnedMutexGuard<()>, Value> {
        let mutex = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(key.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        if let Some((id, name)) = self.detached_holder(key).await {
            return Err(file_busy(&id, &name));
        }
        match tokio::time::timeout(self.timeout, mutex.lock_owned()).await {
            Ok(guard) => Ok(guard),
            Err(_) => {
                if let Some((id, name)) = self.detached_holder(key).await {
                    Err(file_busy(&id, &name))
                } else {
                    Err(tool_error(
                        "Request waited 45 seconds in the queue and was not dispatched. It is safe to retry.",
                    ))
                }
            }
        }
    }

    async fn detached_holder(&self, key: &str) -> Option<(String, String)> {
        let id = {
            let busy = self.busy.lock().unwrap_or_else(|error| error.into_inner());
            busy.get(key).cloned()
        }?;
        let requests = self.requests.lock().await;
        let entry = requests.entries.get(&id)?;
        (entry.reply.is_none() && entry.result.is_none()).then(|| (id, entry.name.clone()))
    }

    async fn read_stored_request(&self, arguments: &Value) -> Value {
        let Some(id) = arguments
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            return tool_error("get_request requires the id from a desktop timeout.");
        };
        if let Some(result) = self.take_ready(id).await {
            return result;
        }
        let requests = self.requests.lock().await;
        requests.entries.get(id).map_or_else(
            || tool_error("No editor request with that id is running or stored."),
            |entry| running_status(id, &entry.name),
        )
    }

    async fn take_ready(&self, id: &str) -> Option<Value> {
        let ready = {
            let mut requests = self.requests.lock().await;
            let entry = requests.entries.get_mut(id)?;
            let result = entry.result.take()?;
            let name = entry.name.clone();
            let session = entry.session.clone();
            requests.entries.remove(id);
            requests.stored.retain(|stored| stored != id);
            (session, name, result)
        };
        self.remember_opened_file(ready.0.as_deref(), &ready.1, &ready.2)
            .await;
        Some(ready.2)
    }

    async fn finish(&self, id: &str, result: Value) {
        let reply = {
            let mut requests = self.requests.lock().await;
            let Some(entry) = requests.entries.get_mut(id) else {
                return;
            };
            entry.result = Some(result);
            let reply = entry.reply.take();
            if reply.is_none() {
                // The caller already timed out, so release the file and keep the result.
                entry.hold.take();
                requests.stored.push_back(id.to_owned());
                while requests.stored.len() > 8 {
                    let Some(old) = requests.stored.pop_front() else {
                        break;
                    };
                    if old == id {
                        requests.stored.push_back(old);
                        break;
                    }
                    if requests.entries.get(&old).is_some_and(|entry| {
                        entry.result.is_some() && entry.hold.is_none() && entry.reply.is_none()
                    }) {
                        requests.entries.remove(&old);
                    }
                }
            }
            reply
        };
        if let Some(reply) = reply {
            let _ = reply.send(());
        }
    }

    async fn bind_session_file(&self, name: &str, arguments: &mut Value, session: Option<&str>) {
        if matches!(
            name,
            "create_file" | "list_files" | "open_file" | "archive_file" | "restore_file"
        ) {
            return;
        }
        if argument_file_id(arguments).is_some() {
            return;
        }
        let Some(session) = session else { return };
        let Some(file_id) = self.sessions.lock().await.get(session).cloned() else {
            return;
        };
        if let Some(object) = arguments.as_object_mut() {
            object.insert("fileId".into(), json!(file_id));
        }
    }

    async fn remember_opened_file(&self, session: Option<&str>, name: &str, result: &Value) {
        let Some(session) = session else { return };
        let Some(file_id) = opened_file_id(name, result) else {
            return;
        };
        self.sessions
            .lock()
            .await
            .insert(session.to_owned(), file_id);
    }

    async fn next(&self) -> Option<EditorRequest> {
        let mut receiver = self.receiver.lock().await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(request) = receiver.recv().await {
                if self.requests.lock().await.entries.contains_key(&request.id) {
                    return Some(request);
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
    }
}

#[derive(Clone)]
struct FliesServer {
    bridge: Arc<Bridge>,
}

fn tool_error(message: &str) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":message}]})
}

fn still_running(id: &str, name: &str) -> Value {
    tool_error(&format!(
        "Desktop editor did not reply within 45 seconds. Request {id} ({name}) is still running and its result will be kept. Call get_request with id \"{id}\". It returns immediately with status running, or the original result once the editor finishes. Other tools for this file also return immediately with that id until then."
    ))
}

fn file_busy(id: &str, name: &str) -> Value {
    tool_error(&format!(
        "This file is still running {name} request {id}. Call get_request with id \"{id}\". It returns immediately and does not use the editor. The original result is kept until that read."
    ))
}

fn running_status(id: &str, tool: &str) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": json!({"status":"running","id":id,"tool":tool}).to_string()
        }]
    })
}

fn argument_file_id(arguments: &Value) -> Option<&str> {
    arguments
        .get("fileId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn lock_key(name: &str, arguments: &Value) -> Option<String> {
    match name {
        "list_files" => None,
        "create_file" => Some(format!("create:{}", uuid::Uuid::new_v4())),
        _ => Some(argument_file_id(arguments).unwrap_or_default().to_owned()),
    }
}

fn opened_file_id(name: &str, result: &Value) -> Option<String> {
    if !matches!(name, "create_file" | "open_file") {
        return None;
    }
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let text = result
        .get("content")?
        .as_array()?
        .first()?
        .get("text")?
        .as_str()?;
    serde_json::from_str::<Value>(text)
        .ok()?
        .get("fileId")?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn mcp_session(context: &RequestContext<RoleServer>) -> Option<String> {
    context
        .extensions
        .get::<Parts>()
        .and_then(|parts| parts.headers.get("mcp-session-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

impl ServerHandler for FliesServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("flies", env!("CARGO_PKG_VERSION")))
            .with_instructions(tools::INSTRUCTIONS)
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tools::catalog()
            .into_iter()
            .find(|tool| tool["name"] == name)
            .and_then(|tool| serde_json::from_value(tool).ok())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = tools::catalog()
            .into_iter()
            .map(serde_json::from_value)
            .collect::<Result<Vec<Tool>, _>>()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        // The current protocol requires cache metadata; rmcp defaults omit it for legacy peers.
        Ok(ListToolsResult::with_all_items(tools)
            .with_ttl_ms(0)
            .with_cache_scope(CacheScope::Private))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if !tools::catalog()
            .iter()
            .any(|tool| tool["name"] == request.name.as_ref())
        {
            return Err(ErrorData::invalid_params("Unknown tool", None));
        }
        let transport_session = mcp_session(&context);
        let mut arguments = request.arguments.unwrap_or_default();
        let receipt = arguments.remove("guideSessionId");
        let receipt = match receipt.as_ref() {
            None => None,
            Some(Value::String(value)) if uuid::Uuid::parse_str(value).is_ok() => {
                Some(value.as_str())
            }
            _ => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "guideSessionId must be the string returned by get_guide. Call get_guide with no arguments to start a new guide session.",
                )])
                .into());
            }
        };
        let mut guided_sessions = self.bridge.guided_sessions.lock().await;
        let session = transport_session
            .as_ref()
            .map(|id| format!("transport:{id}"))
            .or_else(|| receipt.map(|id| format!("guide:{id}")));
        if request.name == "get_guide" {
            let (session, guide_session_id) = match transport_session.as_deref() {
                Some(id) => (format!("transport:{id}"), None),
                None => {
                    let id = receipt
                        .filter(|_| {
                            session
                                .as_ref()
                                .is_some_and(|session| guided_sessions.contains(session))
                        })
                        .map(str::to_owned)
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    (format!("guide:{id}"), Some(id))
                }
            };
            guided_sessions.insert(session);
            let session_instructions = match &guide_session_id {
                Some(id) => format!("Guide session ready. Pass guideSessionId: \"{id}\" in every subsequent Flies tool call, including repeated get_guide reads. It preserves this client's opened file. This is workflow state, not authentication."),
                None => "Guide read for this MCP transport session. Keep using the same Mcp-Session-Id; other sessions must call get_guide independently.".to_owned(),
            };
            let mut result = CallToolResult::success(vec![
                ContentBlock::text(session_instructions),
                ContentBlock::text(tools::GUIDE),
            ]);
            result.structured_content = Some(json!({
                "guideSessionId": guide_session_id,
                "guideRead": true
            }));
            return Ok(result.into());
        }
        let Some(session) = session.filter(|session| guided_sessions.contains(session)) else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "Call get_guide first, read its HTML/CSS rendering and design workflow, then retry. No editor operation was dispatched. If get_guide returned a guideSessionId, include it in every tool's arguments; a guide read in another MCP session does not unlock this one.",
            )])
            .into());
        };
        drop(guided_sessions);
        let value = self
            .bridge
            .call_on(
                request.name.into_owned(),
                Value::Object(arguments),
                Some(&session),
            )
            .await;
        let mut result: CallToolResult = serde_json::from_value(value)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        // IPC payloads are version-neutral. Deserialization does not apply the SDK's
        // constructor default; mark every completed reply, including tool errors.
        // rmcp strips this field when serializing for legacy protocol peers.
        result.result_type = Some(ResultType::COMPLETE);
        Ok(result.into())
    }
}

fn router(host: String, bridge: Arc<Bridge>) -> Router {
    let mut config = StreamableHttpServerConfig::default();
    config.legacy_session_mode = false;
    config.json_response = true;
    config.allowed_hosts = vec![host];
    config.max_request_body_bytes = 2 * 1024 * 1024;
    config = config.enforce_origin_validation();
    let service: StreamableHttpService<FliesServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || {
                Ok(FliesServer {
                    bridge: bridge.clone(),
                })
            },
            Default::default(),
            config,
        );
    Router::new().nest_service("/mcp", service)
}

fn private_write(path: &Path, value: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| std::io::Error::other("Missing MCP directory"))?,
    )?;
    temp.write_all(value)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

struct RuntimeTask(tauri::async_runtime::JoinHandle<()>);

impl Drop for RuntimeTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn serve(
    listener: std::net::TcpListener,
    host: String,
    bridge: Arc<Bridge>,
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, router(host, bridge)).await
}

pub fn start(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?.join("mcp");
    std::fs::create_dir_all(&root)?;
    let port: u16 = std::env::var("FLIES_MCP_PORT")
        .unwrap_or_else(|_| "43123".into())
        .parse()?;
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))?;
    listener.set_nonblocking(true)?;
    let host = listener.local_addr()?.to_string();
    let bridge = Bridge::new();
    app.manage(bridge.clone());
    let config = json!({"mcpServers":{"flies":{"url":format!("http://{host}/mcp")}}});
    private_write(
        &root.join("client.json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    eprintln!(
        "Flies MCP listening at http://{host}/mcp (client config: {})",
        root.join("client.json").display()
    );
    let task = tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(listener, host, bridge).await {
            eprintln!("Flies MCP stopped: {error}");
        }
    });
    app.manage(RuntimeTask(task));
    Ok(())
}

#[tauri::command]
pub async fn mcp_next_request(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Bridge>>,
) -> Result<Option<EditorRequest>, String> {
    if window.label() != "main" {
        return Err("MCP bridge is only available to the main editor".into());
    }
    Ok(state.next().await)
}

#[tauri::command]
pub async fn mcp_reply(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Bridge>>,
    id: String,
    result: Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("MCP bridge is only available to the main editor".into());
    }
    state.finish(&id, result).await;
    Ok(())
}

#[cfg(test)]
mod tests;
