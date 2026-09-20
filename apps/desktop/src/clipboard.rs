use serde::Serialize;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClipboard {
    html: String,
    text: String,
    image_base64: Option<String>,
}

/// Read rich clipboard content without WKWebView's permission prompt or HTML filtering.
#[tauri::command]
pub async fn read_canvas_clipboard() -> Result<CanvasClipboard, String> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(|| {
        objc2::rc::autoreleasepool(|_| {
            macos::read(&objc2_app_kit::NSPasteboard::generalPasteboard())
        })
    })
    .await
    .map_err(|error| format!("Could not read the clipboard: {error}"))?;

    #[cfg(not(target_os = "macos"))]
    Err("Native rich clipboard reading is only available on macOS.".into())
}

#[cfg(target_os = "macos")]
mod macos {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardTypeHTML,
        NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSDictionary, NSString};

    use super::CanvasClipboard;

    const MAX_TEXT_BYTES: usize = 5_000_000;
    const MAX_IMAGE_BYTES: usize = 20_000_000;

    fn text(board: &NSPasteboard, kind: &NSString) -> Result<String, String> {
        let Some(value) = board.stringForType(kind) else {
            return Ok(String::new());
        };
        if value.len() > MAX_TEXT_BYTES {
            return Err("Clipboard text is too large. Copy a smaller section.".into());
        }
        let value = value.to_string();
        if value.len() > MAX_TEXT_BYTES {
            return Err("Clipboard text is too large. Copy a smaller section.".into());
        }
        Ok(value)
    }

    fn image(board: &NSPasteboard) -> Result<Option<String>, String> {
        // SAFETY: These are immutable AppKit pasteboard type constants.
        let png = unsafe { board.dataForType(NSPasteboardTypePNG) };
        let is_png = png.is_some();
        // SAFETY: This is an immutable AppKit pasteboard type constant.
        let data = png.or_else(|| unsafe { board.dataForType(NSPasteboardTypeTIFF) });
        let Some(data) = data else { return Ok(None) };
        if data.len() > MAX_IMAGE_BYTES {
            return Err("Clipboard image is too large.".into());
        }
        let bitmap = NSBitmapImageRep::imageRepWithData(&data)
            .ok_or("Could not decode the clipboard image.")?;
        let (width, height) = (bitmap.pixelsWide(), bitmap.pixelsHigh());
        if width <= 0 || height <= 0 || width.saturating_mul(height) > 16_000_000 {
            return Err("Clipboard image is too large.".into());
        }
        if is_png {
            return Ok(Some(STANDARD.encode(data.to_vec())));
        }
        // SAFETY: An empty typed properties dictionary is valid for PNG encoding.
        let png = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }
        .ok_or("Could not prepare the clipboard image.")?;
        if png.len() > MAX_IMAGE_BYTES {
            return Err("Clipboard image is too large.".into());
        }
        Ok(Some(STANDARD.encode(png.to_vec())))
    }

    pub(super) fn read(board: &NSPasteboard) -> Result<CanvasClipboard, String> {
        let revision = board.changeCount();
        // SAFETY: These are immutable AppKit pasteboard type constants.
        let html = text(board, unsafe { NSPasteboardTypeHTML })?;
        let plain = text(board, unsafe { NSPasteboardTypeString })?;
        // HTML captures and Flies JSON use their structured representation, not a preview bitmap.
        let is_snapshot = html.as_bytes()[..html.len().min(4096)]
            .windows(b"<x-paper-html".len())
            .any(|part| part.eq_ignore_ascii_case(b"<x-paper-html"));
        let is_canvas = serde_json::from_str::<serde_json::Value>(&plain)
            .ok()
            .is_some_and(|value| {
                matches!(
                    value.get("type").and_then(|v| v.as_str()),
                    Some("flies-canvas" | "lra-canvas")
                )
            });
        let image_base64 = if !is_snapshot && !is_canvas {
            image(board)?
        } else {
            None
        };
        if board.changeCount() != revision {
            return Err("The clipboard changed while reading it. Paste again.".into());
        }
        Ok(CanvasClipboard {
            html,
            text: plain,
            image_base64,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";

        #[test]
        fn native_pasteboard_preserves_the_exact_paper_html_without_plain_text() {
            objc2::rc::autoreleasepool(|_| {
                let board = NSPasteboard::pasteboardWithUniqueName();
                let html = include_str!("../../../scripts/mcp-tests/fixtures/paper-snapshot.txt");
                assert!(board
                    .setString_forType(&NSString::from_str(html), unsafe { NSPasteboardTypeHTML }));
                let read = read(&board).unwrap();
                assert_eq!(read.html, html);
                assert!(read.text.is_empty());
                assert!(read.image_base64.is_none());
                board.clearContents();
            });
        }

        #[test]
        fn native_pasteboard_preserves_plain_text_and_empty_contents() {
            objc2::rc::autoreleasepool(|_| {
                let board = NSPasteboard::pasteboardWithUniqueName();
                assert!(read(&board).unwrap().html.is_empty());
                assert!(
                    board.setString_forType(&NSString::from_str("Flies clipboard"), unsafe {
                        NSPasteboardTypeString
                    })
                );
                let read = read(&board).unwrap();
                assert_eq!(read.text, "Flies clipboard");
                assert!(read.html.is_empty());
                board.clearContents();
            });
        }

        #[test]
        fn native_pasteboard_keeps_an_image_with_unrelated_html() {
            objc2::rc::autoreleasepool(|_| {
                let board = NSPasteboard::pasteboardWithUniqueName();
                let png = STANDARD.decode(PNG).unwrap();
                assert!(board
                    .setData_forType(Some(&objc2_foundation::NSData::with_bytes(&png)), unsafe {
                        NSPasteboardTypePNG
                    }));
                assert!(board.setString_forType(
                    &NSString::from_str("<img alt='Clipboard image'>"),
                    unsafe { NSPasteboardTypeHTML }
                ));
                let result = read(&board).unwrap();
                assert_eq!(result.image_base64.as_deref(), Some(PNG));
                board.clearContents();
            });
        }

        #[test]
        fn native_pasteboard_converts_tiff_images_to_png() {
            objc2::rc::autoreleasepool(|_| {
                let board = NSPasteboard::pasteboardWithUniqueName();
                let png = objc2_foundation::NSData::with_bytes(&STANDARD.decode(PNG).unwrap());
                let bitmap = NSBitmapImageRep::imageRepWithData(&png).unwrap();
                // SAFETY: An empty typed properties dictionary is valid for TIFF encoding.
                let tiff = unsafe {
                    bitmap.representationUsingType_properties(
                        NSBitmapImageFileType::TIFF,
                        &NSDictionary::new(),
                    )
                }
                .unwrap();
                assert!(board.setData_forType(Some(&tiff), unsafe { NSPasteboardTypeTIFF }));
                let result = read(&board).unwrap();
                let png = STANDARD.decode(result.image_base64.unwrap()).unwrap();
                assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
                let decoded =
                    NSBitmapImageRep::imageRepWithData(&objc2_foundation::NSData::with_bytes(&png))
                        .unwrap();
                assert_eq!((decoded.pixelsWide(), decoded.pixelsHigh()), (2, 2));
                board.clearContents();
            });
        }

        #[test]
        fn native_pasteboard_rejects_oversized_html() {
            objc2::rc::autoreleasepool(|_| {
                let board = NSPasteboard::pasteboardWithUniqueName();
                assert!(board.setString_forType(
                    &NSString::from_str(&"x".repeat(MAX_TEXT_BYTES + 1)),
                    unsafe { NSPasteboardTypeHTML }
                ));
                assert!(read(&board).unwrap_err().contains("too large"));
                board.clearContents();
            });
        }
    }
}
