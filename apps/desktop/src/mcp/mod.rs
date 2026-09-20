//! Local MCP Streamable HTTP endpoint and desktop request bridge.
mod tools;

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
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
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
    serial: Mutex<()>,
    capacity: Semaphore,
}

impl Bridge {
    fn new() -> Arc<Self> {
        let (sender, receiver) = mpsc::channel(16);
        Arc::new(Self {
            sender,
            receiver: Mutex::new(receiver),
            pending: Mutex::new(HashMap::new()),
            serial: Mutex::new(()),
            capacity: Semaphore::new(17),
        })
    }

    async fn call(&self, name: String, arguments: Value) -> Value {
        // Wait FIFO for the active tool, while bounding queued HTTP requests.
        let Ok(_capacity) = self.capacity.try_acquire() else {
            return tool_error("Desktop request queue is full (16 waiting tools). Wait for pending calls to finish.");
        };
        let Ok(_serial) = tokio::time::timeout(TIMEOUT, self.serial.lock()).await else {
            return tool_error("Request waited 45 seconds in the queue and was not dispatched. It is safe to retry.");
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
            name,
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
            Ok(Ok(value)) => value,
            _ => tool_error("Desktop editor did not reply within 45 seconds. If an edit was dispatched, inspect the document before retrying."),
        }
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

impl ServerHandler for FliesServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("flies", env!("CARGO_PKG_VERSION")))
            .with_instructions(tools::GUIDE)
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
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if !tools::catalog()
            .iter()
            .any(|tool| tool["name"] == request.name.as_ref())
        {
            return Err(ErrorData::invalid_params("Unknown tool", None));
        }
        if request.name == "get_guide" {
            return Ok(CallToolResult::success(vec![ContentBlock::text(tools::GUIDE)]).into());
        }
        let value = self
            .bridge
            .call(
                request.name.into_owned(),
                Value::Object(request.arguments.unwrap_or_default()),
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
