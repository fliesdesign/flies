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
fn with_session(mut request: Request<Body>, session: &str) -> Request<Body> {
    request
        .headers_mut()
        .insert("mcp-session-id", session.parse().unwrap());
    request
}
async fn read_guide(service: &Router) -> String {
    let body = json(
        service
            .clone()
            .oneshot(request("tools/call", json!({"name":"get_guide"})))
            .await
            .unwrap(),
    )
    .await;
    body["result"]["structuredContent"]["guideSessionId"]
        .as_str()
        .expect("stateless clients receive a guide session")
        .to_owned()
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
    assert!(initialize["result"]["instructions"]
        .as_str()
        .unwrap()
        .starts_with("Your FIRST Flies tool call must be get_guide."));
    let list = json(
        service
            .oneshot(request("tools/list", json!({})))
            .await
            .unwrap(),
    )
    .await;
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 28);
    assert!(tools.iter().any(|tool| tool["name"] == "get_request"));
    assert!(tools.iter().any(|tool| tool["name"] == "write_html"));
    assert!(tools.iter().any(|tool| tool["name"] == "get_screenshot"));
    assert_eq!(tools[0]["name"], "get_guide");
    for tool in tools {
        assert!(tool["description"].as_str().unwrap().contains("get_guide"));
        assert_eq!(
            tool["inputSchema"]["properties"]["guideSessionId"]["type"],
            "string"
        );
    }
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
async fn discovery_exposes_source_import_with_the_same_edit_scopes() {
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
        .find(|tool| tool["name"] == "write_source")
        .unwrap();
    let properties = &tool["inputSchema"]["properties"];
    assert_eq!(tool["inputSchema"]["required"], json!(["source"]));
    assert_eq!(properties["format"]["enum"], json!(["auto", "html", "jsx"]));
    for property in ["parentId", "targetId", "fileId"] {
        assert_eq!(properties[property]["type"], "string");
    }
    for property in ["replace", "validateOnly"] {
        assert_eq!(properties[property]["type"], "boolean");
    }
    assert_eq!(properties["width"]["maximum"], 8192);
}

#[tokio::test]
async fn initialize_and_discovery_do_not_unlock_editor_tools() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    for (method, params) in [
        (
            "initialize",
            json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}),
        ),
        ("tools/list", json!({})),
    ] {
        json(
            service
                .clone()
                .oneshot(request(method, params))
                .await
                .unwrap(),
        )
        .await;
    }
    for (name, arguments) in [
        ("list_files", json!({})),
        ("get_basic_info", json!({})),
        ("create_file", json!({"name":"Home"})),
        ("write_html", json!({"html":"<p>Hello</p>"})),
        ("write_source", json!({"source":"<p>Hello</p>"})),
    ] {
        let body = json(
            service
                .clone()
                .oneshot(request(
                    "tools/call",
                    json!({"name":name,"arguments":arguments}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body["result"]["isError"], true, "{name}: {body}");
        assert!(body["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Call get_guide first"));
    }
    assert!(bridge.receiver.lock().await.try_recv().is_err());
    assert!(bridge.requests.lock().await.entries.is_empty());
}

#[tokio::test]
async fn guide_receipts_do_not_unlock_unrelated_or_malformed_sessions() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    let guide = read_guide(&service).await;
    let other_guide = read_guide(&service).await;
    assert_ne!(guide, other_guide);
    for arguments in [
        json!({}),
        json!({"guideSessionId":null}),
        json!({"guideSessionId":42}),
        json!({"guideSessionId":""}),
        json!({"guideSessionId":"invented"}),
        json!({"guideSessionId":uuid::Uuid::new_v4().to_string()}),
    ] {
        let body = json(
            service
                .clone()
                .oneshot(request(
                    "tools/call",
                    json!({"name":"list_files","arguments":arguments}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body["result"]["isError"], true, "{body}");
        assert!(body["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("get_guide"));
    }
    let other_transport = json(
        service
            .oneshot(with_session(
                request(
                    "tools/call",
                    json!({"name":"list_files","arguments":{"guideSessionId":guide}}),
                ),
                "unread-transport",
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(other_transport["result"]["isError"], true);
    assert!(bridge.receiver.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn repeated_guide_reads_preserve_the_stateless_clients_open_file() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    let guide = read_guide(&service).await;
    let opener = service.clone();
    let receipt = guide.clone();
    let open = tokio::spawn(async move {
        opener
            .oneshot(request("tools/call", json!({"name":"open_file","arguments":{"fileId":"poster","guideSessionId":receipt}})))
            .await
            .unwrap()
    });
    let forwarded = bridge.next().await.unwrap();
    bridge
        .finish(
            &forwarded.id,
            json!({"content":[{"type":"text","text":"{\"fileId\":\"poster\"}"}]}),
        )
        .await;
    json(open.await.unwrap()).await;
    let reread = json(
        service
            .clone()
            .oneshot(request(
                "tools/call",
                json!({"name":"get_guide","arguments":{"guideSessionId":guide}}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        reread["result"]["structuredContent"]["guideSessionId"],
        guide
    );
    let next = tokio::spawn(async move {
        service
            .oneshot(request(
                "tools/call",
                json!({"name":"get_basic_info","arguments":{"guideSessionId":guide}}),
            ))
            .await
            .unwrap()
    });
    let forwarded = bridge.next().await.unwrap();
    assert_eq!(forwarded.arguments, json!({"fileId":"poster"}));
    bridge.finish(&forwarded.id, json!({"content":[]})).await;
    json(next.await.unwrap()).await;
}

#[tokio::test]
async fn stateless_guide_sessions_keep_separate_open_files() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    let alpha = read_guide(&service).await;
    let beta = read_guide(&service).await;
    for (guide, file) in [(&alpha, "alpha"), (&beta, "beta")] {
        let request = request(
            "tools/call",
            json!({"name":"open_file","arguments":{"fileId":file,"guideSessionId":guide}}),
        );
        let client = service.clone();
        let open = tokio::spawn(async move { client.oneshot(request).await.unwrap() });
        let forwarded = bridge.next().await.unwrap();
        bridge
            .finish(
                &forwarded.id,
                json!({"content":[{"type":"text","text":json!({"fileId":file}).to_string()}]}),
            )
            .await;
        json(open.await.unwrap()).await;
    }
    for (guide, file) in [(alpha, "alpha"), (beta, "beta")] {
        let request = request(
            "tools/call",
            json!({"name":"get_basic_info","arguments":{"guideSessionId":guide}}),
        );
        let client = service.clone();
        let inspect = tokio::spawn(async move { client.oneshot(request).await.unwrap() });
        let forwarded = bridge.next().await.unwrap();
        assert_eq!(forwarded.arguments, json!({"fileId":file}));
        bridge.finish(&forwarded.id, json!({"content":[]})).await;
        json(inspect.await.unwrap()).await;
    }
}

#[tokio::test]
async fn transport_guide_status_is_isolated_from_other_clients() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    for _ in 0..2 {
        let guide = json(
            service
                .clone()
                .oneshot(with_session(
                    request("tools/call", json!({"name":"get_guide"})),
                    "agent-a",
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(guide["result"]["structuredContent"]["guideRead"], true);
        assert!(guide["result"]["structuredContent"]["guideSessionId"].is_null());
    }
    for session in ["agent-b", "guide:agent-a"] {
        let blocked = json(
            service
                .clone()
                .oneshot(with_session(
                    request("tools/call", json!({"name":"list_files"})),
                    session,
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(blocked["result"]["isError"], true);
    }
    let next = tokio::spawn(async move {
        service
            .oneshot(with_session(
                request("tools/call", json!({"name":"list_files"})),
                "agent-a",
            ))
            .await
            .unwrap()
    });
    let forwarded = bridge.next().await.unwrap();
    assert_eq!(forwarded.name, "list_files");
    bridge.finish(&forwarded.id, json!({"content":[]})).await;
    json(next.await.unwrap()).await;
}

#[tokio::test]
async fn modern_stateless_guide_and_gate_responses_are_complete() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    for name in ["list_files", "get_guide"] {
        let mut req = request(
            "tools/call",
            json!({"name":name,"_meta":{
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
        let body = json(service.clone().oneshot(req).await.unwrap()).await;
        assert_eq!(body["result"]["resultType"], "complete");
        if name == "get_guide" {
            assert!(body["result"]["structuredContent"]["guideSessionId"].is_string());
            assert!(body["result"]["content"][1]["text"]
                .as_str()
                .unwrap()
                .starts_with("FIRST CALL"));
        } else {
            assert_eq!(body["result"]["isError"], true);
        }
    }
    assert!(bridge.receiver.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn sdk_roundtrips_live_editor_request_and_image() {
    let bridge = Bridge::new();
    let service = app(bridge.clone());
    let guide = read_guide(&service).await;
    let response = tokio::spawn(async move {
        service
            .oneshot(request(
                "tools/call",
                json!({"name":"get_screenshot","arguments":{"nodeId":"frame","guideSessionId":guide}}),
            ))
            .await
            .unwrap()
    });
    let request = bridge.next().await.unwrap();
    assert_eq!(request.name, "get_screenshot");
    assert_eq!(request.arguments["nodeId"], "frame");
    assert!(request.arguments.get("guideSessionId").is_none());
    let result = json!({"content":[{"type":"image","mimeType":"image/png","data":"aGVsbG8="}]});
    bridge.finish(&request.id, result).await;
    let body = json(response.await.unwrap()).await;
    assert_eq!(body["result"]["content"][0]["type"], "image");
    assert!(
        body["result"].get("resultType").is_none(),
        "legacy responses omit resultType"
    );
    assert!(bridge.requests.lock().await.entries.is_empty());
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
    let guide = read_guide(&service).await;
    let response = tokio::spawn(async move {
        service
            .oneshot(request(
                "tools/call",
                json!({"name":"get_selection","arguments":{"guideSessionId":guide}}),
            ))
            .await
            .unwrap()
    });
    let request = bridge.next().await.unwrap();
    bridge
        .finish(&request.id, tool_error("No active file"))
        .await;
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
    assert_eq!(result["tools"].as_array().unwrap().len(), 28);
}

#[tokio::test]
async fn modern_tool_calls_mark_text_images_and_errors_complete() {
    for (name, mut arguments, payload) in [
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
        let guide = read_guide(&service).await;
        arguments["guideSessionId"] = json!(guide);
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
        bridge.finish(&forwarded.id, payload.clone()).await;
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
    bridge.finish(&first.id, json!({"content":[]})).await;
    assert_eq!(write.await.unwrap(), json!({"content":[]}));
    let second = bridge.next().await.unwrap();
    assert_eq!(second.name, "get_screenshot");
    bridge.finish(&second.id, json!({"content":[]})).await;
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
        .finish(&beta.id, json!({"content":[{"type":"text","text":"b"}]}))
        .await;
    assert_eq!(
        second.await.unwrap(),
        json!({"content":[{"type":"text","text":"b"}]})
    );
    bridge
        .finish(&alpha.id, json!({"content":[{"type":"text","text":"a"}]}))
        .await;
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
    bridge.finish(&request.id, json!({"content":[{"type":"text","text":"{\"fileId\":\"poster\",\"name\":\"Poster\"}"}]})).await;
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
    bridge.finish(&forwarded.id, json!({"content":[]})).await;
    assert_eq!(write.await.unwrap(), json!({"content":[]}));
}

#[tokio::test]
async fn full_queue_rejects_without_dispatching() {
    let bridge = Bridge::new();
    let _capacity = bridge.capacity.acquire_many(17).await.unwrap();
    let response = bridge.call("write_html".into(), json!({})).await;
    assert_eq!(response["isError"], true);
    assert!(bridge.requests.lock().await.entries.is_empty());
    assert!(bridge.receiver.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn a_timed_out_dispatch_keeps_its_result_for_get_request() {
    let bridge = Bridge::create(Duration::from_millis(80));
    let writer = bridge.clone();
    let write = tokio::spawn(async move {
        writer
            .call("write_html".into(), json!({"fileId":"hero"}))
            .await
    });
    let request = bridge.next().await.unwrap();
    let timed_out = write.await.unwrap();
    let text = timed_out["content"][0]["text"].as_str().unwrap();
    assert_eq!(timed_out["isError"], true);
    assert!(text.contains(&request.id));
    assert!(text.contains("get_request"));

    let started = std::time::Instant::now();
    let inspection = bridge
        .call("get_tree".into(), json!({"fileId":"hero"}))
        .await;
    assert!(started.elapsed() < Duration::from_millis(500));
    let inspection_text = inspection["content"][0]["text"].as_str().unwrap();
    assert_eq!(inspection["isError"], true);
    assert!(inspection_text.contains(&request.id));
    assert!(bridge.receiver.lock().await.try_recv().is_err());

    let status = bridge
        .call("get_request".into(), json!({"id": request.id}))
        .await;
    let body: Value = serde_json::from_str(status["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(body["status"], "running");
    assert_eq!(body["tool"], "write_html");

    let payload = json!({"content":[{"type":"text","text":"{\"applied\":true}"}]});
    bridge.finish(&request.id, payload.clone()).await;
    let stored = bridge
        .call("get_request".into(), json!({"id": request.id}))
        .await;
    assert_eq!(stored, payload);
    assert_eq!(
        bridge
            .call("get_request".into(), json!({"id": request.id}))
            .await["isError"],
        true
    );

    let follow = bridge.clone();
    let tree = tokio::spawn(async move {
        follow
            .call("get_tree".into(), json!({"fileId":"hero"}))
            .await
    });
    let next = bridge.next().await.unwrap();
    assert_eq!(next.name, "get_tree");
    bridge
        .finish(&next.id, json!({"content":[{"type":"text","text":"tree"}]}))
        .await;
    assert_eq!(tree.await.unwrap()["content"][0]["text"], "tree");
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
    let create = catalog
        .iter()
        .find(|tool| tool["name"] == "create_artboard")
        .unwrap();
    for axis in ["widthSizing", "heightSizing"] {
        assert_eq!(
            properties["properties"][axis]["enum"],
            json!(["fixed", "fill", "hug", null])
        );
        assert_eq!(
            create["inputSchema"]["properties"][axis],
            properties["properties"][axis]
        );
    }
    assert_eq!(
        create["inputSchema"]["properties"]["layout"],
        properties["properties"]["layout"]
    );
    assert!(tools::GUIDE.contains("public HTTP or HTTPS URL"));
    assert!(tools::GUIDE.contains("get_request"));
    assert!(tools::GUIDE.contains("layout.gap"));
    assert!(tools::GUIDE.contains("widthSizing/heightSizing"));
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

#[test]
fn native_paint_schema_and_guide_match_html_import_capabilities() {
    let catalog = tools::catalog();
    let update = catalog
        .iter()
        .find(|tool| tool["name"] == "update_node")
        .unwrap();
    let properties = &update["inputSchema"]["properties"]["properties"]["properties"];
    for name in ["rotation", "gradient", "filters", "blendMode"] {
        assert!(!properties[name].is_null(), "missing {name}");
    }
    assert_eq!(
        properties["gradient"]["properties"]["interpolation"]["enum"],
        json!(["srgb", "oklab"])
    );
    assert_eq!(
        properties["filters"]["properties"]["order"]["uniqueItems"],
        true
    );
    assert!(tools::GUIDE.contains("2D rotation and translation"));
    assert!(!tools::GUIDE.contains("the HTML importer still rejects their CSS equivalents"));
}
