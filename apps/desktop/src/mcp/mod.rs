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
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tauri::Manager;
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};

const TIMEOUT: Duration = Duration::from_secs(45);
type Reply = oneshot::Sender<Value>;

#[derive(Clone, Serialize)]
pub struct EditorRequest {
    id: String,
    name: String,
    arguments: Value,
}

pub struct Bridge {
    sender: mpsc::Sender<EditorRequest>,
    receiver: Mutex<mpsc::Receiver<EditorRequest>>,
    pending: Mutex<HashMap<String, Reply>>,
    sessions: Mutex<HashMap<String, String>>,
    guided_sessions: Mutex<HashSet<String>>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    capacity: Semaphore,
}

impl Bridge {
    fn new() -> Arc<Self> {
        let (sender, receiver) = mpsc::channel(16);
        Arc::new(Self {
            sender,
            receiver: Mutex::new(receiver),
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            guided_sessions: Mutex::new(HashSet::new()),
            locks: Mutex::new(HashMap::new()),
            capacity: Semaphore::new(17),
        })
    }

    #[cfg(test)]
    async fn call(&self, name: String, arguments: Value) -> Value {
        self.call_on(name, arguments, None).await
    }

    async fn call_on(&self, name: String, mut arguments: Value, session: Option<&str>) -> Value {
        // Bound queued HTTP tools. Same-file calls stay FIFO; other files run together.
        let Ok(_capacity) = self.capacity.try_acquire() else {
            return tool_error("Desktop request queue is full (16 waiting tools). Wait for pending calls to finish.");
        };
        self.bind_session_file(&name, &mut arguments, session).await;
        let file_lock = self.file_lock(&name, &arguments).await;
        let _serial = match file_lock.as_ref() {
            Some(lock) => match tokio::time::timeout(TIMEOUT, lock.lock()).await {
                Ok(guard) => Some(guard),
                Err(_) => {
                    return tool_error(
                        "Request waited 45 seconds in the queue and was not dispatched. It is safe to retry.",
                    );
                }
            },
            None => None,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.retain(|_, reply| !reply.is_closed());
            pending.insert(id.clone(), tx);
        }
        let request = EditorRequest {
            id: id.clone(),
            name: name.clone(),
            arguments,
        };
        if self.sender.try_send(request).is_err() {
            self.pending.lock().await.remove(&id);
            return tool_error(
                "Desktop request queue is full. Wait for the editor to finish loading.",
            );
        }
        let result = tokio::time::timeout(TIMEOUT, rx).await;
        self.pending.lock().await.remove(&id);
        match result {
            Ok(Ok(value)) => {
                self.remember_opened_file(session, &name, &value).await;
                value
            }
            _ => tool_error("Desktop editor did not reply within 45 seconds. If an edit was dispatched, inspect the document before retrying."),
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

    async fn file_lock(&self, name: &str, arguments: &Value) -> Option<Arc<Mutex<()>>> {
        let key = lock_key(name, arguments)?;
        let mut locks = self.locks.lock().await;
        Some(
            locks
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone(),
        )
    }

    async fn next(&self) -> Option<EditorRequest> {
        let mut receiver = self.receiver.lock().await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(request) = receiver.recv().await {
                if self
                    .pending
                    .lock()
                    .await
                    .get(&request.id)
                    .is_some_and(|reply| !reply.is_closed())
                {
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
    if let Some(reply) = state.pending.lock().await.remove(&id) {
        let _ = reply.send(result);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
