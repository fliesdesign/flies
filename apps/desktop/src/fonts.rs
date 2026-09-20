use serde::Serialize;
use std::sync::OnceLock;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    family: String,
    postscript_name: String,
    weight: u16,
    style: String,
}

fn discover_fonts() -> Vec<SystemFont> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let mut fonts: Vec<_> = database
        .faces()
        .flat_map(|face| {
            face.families
                .iter()
                .filter(|(family, _)| !family.starts_with('.'))
                .map(|(family, _)| SystemFont {
                    family: family.clone(),
                    postscript_name: face.post_script_name.clone(),
                    weight: if face.weight.0 == 0 {
                        400
                    } else {
                        face.weight.0.min(1000)
                    },
                    style: match face.style {
                        fontdb::Style::Normal => "normal",
                        fontdb::Style::Italic | fontdb::Style::Oblique => "italic",
                    }
                    .into(),
                })
        })
        .collect();
    fonts.sort_by(|a, b| (&a.family, a.weight, &a.style).cmp(&(&b.family, b.weight, &b.style)));
    fonts.dedup_by(|a, b| a.family == b.family && a.weight == b.weight && a.style == b.style);
    fonts
}

/// Scan system and user font directories off the UI thread; expose names, never file paths.
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFont>, String> {
    static FONTS: OnceLock<Vec<SystemFont>> = OnceLock::new();
    tauri::async_runtime::spawn_blocking(|| FONTS.get_or_init(discover_fonts).clone())
        .await
        .map_err(|error| format!("Could not list system fonts: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_fonts_have_usable_names_weights_and_styles() {
        let fonts = discover_fonts();
        assert!(!fonts.is_empty(), "System font discovery returned no fonts");
        for font in fonts {
            assert!(!font.family.is_empty());
            assert!(!font.postscript_name.is_empty());
            assert!((1..=1000).contains(&font.weight));
            assert!(["normal", "italic"].contains(&font.style.as_str()));
        }
    }
}
