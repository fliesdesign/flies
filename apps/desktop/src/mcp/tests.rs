use super::*;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    response::Response,
};
use tower::ServiceExt;

fn request(method: &str, params: Value) -> Request<Body> {
    Request::post("/mcp")
        .header("host", "127.0.0.1:43123")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25")
        .body(Body::from(
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
        ))
        .unwrap()
}
fn app(bridge: Arc<Bridge>) -> Router {
    router("127.0.0.1:43123".into(), bridge)
}
async fn json(response: Response) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn sdk_negotiates_and_lists_tools_without_auth() {
    let service = app(Bridge::new());
    let initialize = json(service.clone().oneshot(request("initialize", json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}))).await.unwrap()).await;
    assert_eq!(initialize["result"]["protocolVersion"], "2025-11-25");
    let list = json(
        service
            .oneshot(request("tools/list", json!({})))
            .await
            .unwrap(),
    )
    .await;
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 26);
    assert!(tools.iter().any(|tool| tool["name"] == "write_html"));
    assert!(tools.iter().any(|tool| tool["name"] == "get_screenshot"));
}

#[tokio::test]
async fn discovery_exposes_incremental_html_scopes() {
    let response = json(
        app(Bridge::new())
            .oneshot(request("tools/list", json!({})))
            .await
            .unwrap(),
    )
    .await;
    let tool = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "write_html")
        .unwrap();
    let properties = &tool["inputSchema"]["properties"];
    assert_eq!(properties["parentId"]["type"], "string");
    assert_eq!(properties["targetId"]["type"], "string");
    assert_eq!(properties["replace"]["type"], "boolean");
    assert_eq!(properties["validateOnly"]["type"], "boolean");
    assert_eq!(properties["fileId"]["type"], "string");
    assert_eq!(tool["inputSchema"]["required"], json!(["html"]));
}

#[tokio::test]
async fn sdk_roundtrips_live_editor_request_and_image() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    let response = tokio::spawn(async move {
        service
            .oneshot(request(
                "tools/call",
                json!({"name":"get_screenshot","arguments":{"nodeId":"frame"}}),
            ))
            .await
            .unwrap()
    });
    let request = bridge.next().await.unwrap();
    assert_eq!(request.name, "get_screenshot");
    assert_eq!(request.arguments["nodeId"], "frame");
    let result = json!({"content":[{"type":"image","mimeType":"image/png","data":"aGVsbG8="}]});
    bridge
        .pending
        .lock()
        .await
        .remove(&request.id)
        .unwrap()
        .send(result)
        .unwrap();
    let body = json(response.await.unwrap()).await;
    assert_eq!(body["result"]["content"][0]["type"], "image");
    assert!(
        body["result"].get("resultType").is_none(),
        "legacy responses omit resultType"
    );
    assert!(bridge.pending.lock().await.is_empty());
}

#[tokio::test]
async fn accepts_local_requests_without_auth_but_blocks_browser_origins_and_rebinding() {
    let service = app(Bridge::new());
    assert_eq!(
        service
            .clone()
            .oneshot(request("ping", json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let mut browser = request("ping", json!({}));
    browser
        .headers_mut()
        .insert("origin", "https://example.com".parse().unwrap());
    assert_eq!(
        service.clone().oneshot(browser).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let mut rebind = request("ping", json!({}));
    rebind
        .headers_mut()
        .insert("host", "evil.example:43123".parse().unwrap());
    assert_eq!(
        service.oneshot(rebind).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn tool_failures_are_returned_as_tool_errors() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    let response = tokio::spawn(async move {
        service
            .oneshot(request("tools/call", json!({"name":"get_selection"})))
            .await
            .unwrap()
    });
    let request = bridge.next().await.unwrap();
    bridge
        .pending
        .lock()
        .await
        .remove(&request.id)
        .unwrap()
        .send(tool_error("No active file"))
        .unwrap();
    let body = json(response.await.unwrap()).await;
    assert_eq!(body["result"]["isError"], true);
    assert!(body.get("error").is_none());
}

#[tokio::test]
async fn background_server_serves_real_http_and_releases_listener_on_shutdown() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(serve(listener, address.to_string(), Bridge::new()));
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let payload = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}).to_string();
    let request = format!("POST /mcp HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-11-25\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{payload}",payload.len());
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    let response = String::from_utf8(response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("write_html"));
    task.abort();
    let _ = task.await;
    assert!(std::net::TcpListener::bind(address).is_ok());
}

#[tokio::test]
async fn modern_tool_listing_includes_required_cache_metadata() {
    let mut req = request(
        "tools/list",
        json!({"_meta":{
            "io.modelcontextprotocol/protocolVersion":"2026-07-28",
            "io.modelcontextprotocol/clientInfo":{"name":"test","version":"1"},
            "io.modelcontextprotocol/clientCapabilities":{}
        }}),
    );
    req.headers_mut()
        .insert("mcp-protocol-version", "2026-07-28".parse().unwrap());
    req.headers_mut()
        .insert("mcp-method", "tools/list".parse().unwrap());
    let response = json(app(Bridge::new()).oneshot(req).await.unwrap()).await;
    let result = &response["result"];
    assert_eq!(result["ttlMs"], 0);
    assert_eq!(result["cacheScope"], "private");
    assert_eq!(result["resultType"], "complete");
    assert_eq!(result["tools"].as_array().unwrap().len(), 26);
}

#[tokio::test]
async fn modern_tool_calls_mark_text_images_and_errors_complete() {
    for (name, arguments, payload) in [
        (
            "list_files",
            json!({}),
            json!({"content":[{"type":"text","text":"{\"files\":[]}"}]}),
        ),
        (
            "get_basic_info",
            json!({}),
            tool_error("No active file. Call create_file or open_file first."),
        ),
        (
            "get_screenshot",
            json!({"nodeId":"frame"}),
            json!({"content":[{"type":"image","mimeType":"image/png","data":"aGVsbG8="}]}),
        ),
    ] {
        let bridge = Bridge::new();
        let service = app(bridge.clone());
        let mut req = request(
            "tools/call",
            json!({"name":name,"arguments":arguments,"_meta":{
                "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientInfo":{"name":"test","version":"1"},
                "io.modelcontextprotocol/clientCapabilities":{}
            }}),
        );
        req.headers_mut()
            .insert("mcp-protocol-version", "2026-07-28".parse().unwrap());
        req.headers_mut()
            .insert("mcp-method", "tools/call".parse().unwrap());
        req.headers_mut().insert("mcp-name", name.parse().unwrap());
        let response = tokio::spawn(async move { service.oneshot(req).await.unwrap() });
        let forwarded = bridge.next().await.expect("tool dispatched");
        assert_eq!(forwarded.name, name);
        bridge
            .pending
            .lock()
            .await
            .remove(&forwarded.id)
            .unwrap()
            .send(payload.clone())
            .unwrap();
        let response = json(response.await.unwrap()).await;
        assert_eq!(
            response["result"]["resultType"], "complete",
            "{name}: {response}"
        );
        assert_eq!(response["result"]["content"], payload["content"]);
        assert_eq!(response["result"]["isError"], payload["isError"]);
    }
}

#[tokio::test]
async fn overlapping_write_and_screenshot_wait_in_order() {
    let bridge = Bridge::new();
    let writer = bridge.clone();
    let write = tokio::spawn(async move { writer.call("write_html".into(), json!({})).await });
    let first = bridge.next().await.unwrap();
    let reader = bridge.clone();
    let screenshot =
        tokio::spawn(async move { reader.call("get_screenshot".into(), json!({})).await });
    tokio::task::yield_now().await;
    assert!(!screenshot.is_finished());
    assert!(bridge.receiver.lock().await.try_recv().is_err());
    bridge
        .pending
        .lock()
        .await
        .remove(&first.id)
        .unwrap()
        .send(json!({"content":[]}))
        .unwrap();
    assert_eq!(write.await.unwrap(), json!({"content":[]}));
    let second = bridge.next().await.unwrap();
    assert_eq!(second.name, "get_screenshot");
    bridge
        .pending
        .lock()
        .await
        .remove(&second.id)
        .unwrap()
        .send(json!({"content":[]}))
        .unwrap();
    assert_eq!(screenshot.await.unwrap(), json!({"content":[]}));
}

#[tokio::test]
async fn different_files_dispatch_without_waiting() {
    let bridge = Bridge::new();
    let writer = bridge.clone();
    let first = tokio::spawn(async move {
        writer
            .call("write_html".into(), json!({"fileId":"alpha"}))
            .await
    });
    let alpha = bridge.next().await.unwrap();
    assert_eq!(alpha.arguments["fileId"], "alpha");
    let reader = bridge.clone();
    let second = tokio::spawn(async move {
        reader
            .call("write_html".into(), json!({"fileId":"beta"}))
            .await
    });
    let beta = tokio::time::timeout(Duration::from_secs(2), bridge.next())
        .await
        .expect("the second file should dispatch while the first is still running")
        .unwrap();
    assert_eq!(beta.arguments["fileId"], "beta");
    bridge
        .pending
        .lock()
        .await
        .remove(&beta.id)
        .unwrap()
        .send(json!({"content":[{"type":"text","text":"b"}]}))
        .unwrap();
    assert_eq!(
        second.await.unwrap(),
        json!({"content":[{"type":"text","text":"b"}]})
    );
    bridge
        .pending
        .lock()
        .await
        .remove(&alpha.id)
        .unwrap()
        .send(json!({"content":[{"type":"text","text":"a"}]}))
        .unwrap();
    assert_eq!(
        first.await.unwrap(),
        json!({"content":[{"type":"text","text":"a"}]})
    );
}

#[tokio::test]
async fn a_session_remembers_its_opened_file() {
    let bridge = Bridge::new();
    let opener = bridge.clone();
    let open = tokio::spawn(async move {
        opener
            .call_on(
                "open_file".into(),
                json!({"fileId":"poster"}),
                Some("agent-a"),
            )
            .await
    });
    let request = bridge.next().await.unwrap();
    assert_eq!(request.name, "open_file");
    bridge
        .pending
        .lock()
        .await
        .remove(&request.id)
        .unwrap()
        .send(json!({"content":[{"type":"text","text":"{\"fileId\":\"poster\",\"name\":\"Poster\"}"}]}))
        .unwrap();
    assert_eq!(open.await.unwrap().get("isError"), None);
    let writer = bridge.clone();
    let write = tokio::spawn(async move {
        writer
            .call_on(
                "write_html".into(),
                json!({"html":"<div></div>"}),
                Some("agent-a"),
            )
            .await
    });
    let forwarded = bridge.next().await.unwrap();
    assert_eq!(forwarded.arguments["fileId"], "poster");
    bridge
        .pending
        .lock()
        .await
        .remove(&forwarded.id)
        .unwrap()
        .send(json!({"content":[]}))
        .unwrap();
    assert_eq!(write.await.unwrap(), json!({"content":[]}));
}

#[tokio::test]
async fn full_queue_rejects_without_dispatching() {
    let bridge = Bridge::new();
    let _capacity = bridge.capacity.acquire_many(17).await.unwrap();
    let response = bridge.call("write_html".into(), json!({})).await;
    assert_eq!(response["isError"], true);
    assert!(bridge.pending.lock().await.is_empty());
    assert!(bridge.receiver.lock().await.try_recv().is_err());
}

#[test]
fn update_schema_describes_geometry_clipping_and_layout() {
    let catalog = tools::catalog();
    let update = catalog
        .iter()
        .find(|tool| tool["name"] == "update_node")
        .unwrap();
    let properties = &update["inputSchema"]["properties"]["properties"];
    assert_eq!(properties["additionalProperties"], false);
    assert_eq!(properties["properties"]["height"]["type"], "number");
    assert_eq!(
        properties["properties"]["clipContent"]["type"],
        json!(["boolean", "null"])
    );
    assert_eq!(
        properties["properties"]["layout"]["properties"]["direction"]["enum"],
        json!(["row", "column"])
    );
    for name in ["fit_node", "set_styles", "preview_html", "close_preview"] {
        assert!(catalog.iter().any(|tool| tool["name"] == name));
    }
}

#[test]
fn theme_tools_expose_typed_tokens_and_nullable_bindings() {
    let catalog = tools::catalog();
    let theme = catalog
        .iter()
        .find(|tool| tool["name"] == "set_theme")
        .unwrap();
    let token = &theme["inputSchema"]["properties"]["tokens"]["items"];
    assert_eq!(token["additionalProperties"], false);
    assert_eq!(token["required"], json!(["id", "name", "type", "value"]));
    assert_eq!(
        token["properties"]["type"]["enum"],
        json!([
            "color",
            "radius",
            "spacing",
            "container",
            "breakpoint",
            "fontFamily",
            "fontWeight",
            "fontSize",
            "lineHeight",
            "letterSpacing"
        ])
    );
    let apply = catalog
        .iter()
        .find(|tool| tool["name"] == "apply_tokens")
        .unwrap();
    let bindings = &apply["inputSchema"]["properties"]["bindings"];
    assert_eq!(bindings["additionalProperties"], false);
    for property in [
        "fill",
        "fontFamily",
        "fontWeight",
        "fontSize",
        "lineHeight",
        "letterSpacing",
        "layoutGap",
        "layoutPadding",
        "cornerRadius",
    ] {
        assert_eq!(
            bindings["properties"][property]["type"],
            json!(["string", "null"])
        );
    }
    assert!(catalog.iter().any(|tool| tool["name"] == "get_theme"));
}
