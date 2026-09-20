use keyring::{Entry, Error};
use std::sync::Mutex;

// Some native credential stores cannot reliably handle concurrent access.
static ACCESS: Mutex<()> = Mutex::new(());

fn entry(server: &str) -> Result<Entry, String> {
    // Keep development and production sessions separate.
    Entry::new("com.flies.app.session", server)
        .map_err(|_| "Could not open the system credential store.".to_owned())
}

#[tauri::command]
pub async fn read_desktop_session(server: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ACCESS.lock().map_err(|_| "Credential store lock failed.")?;
        match entry(&server)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(Error::NoEntry) => Ok(None),
            Err(_) => Err(
                "Could not restore your session. Unlock your system credential store and retry."
                    .to_owned(),
            ),
        }
    })
    .await
    .map_err(|_| "Credential store task failed.".to_owned())?
}

#[tauri::command]
pub async fn write_desktop_session(server: String, token: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ACCESS.lock().map_err(|_| "Credential store lock failed.")?;
        let entry = entry(&server)?;
        match token {
            Some(token) => entry.set_password(&token).map_err(|_| {
                "Could not save your session. Unlock your system credential store and retry.".to_owned()
            }),
            None => match entry.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(_) => Err("Could not remove your saved session. Unlock your system credential store and retry.".to_owned()),
            },
        }
    })
    .await
    .map_err(|_| "Credential store task failed.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Opt-in: exercises the real OS store using an isolated, disposable entry.
    #[tokio::test]
    #[ignore = "requires an unlocked system credential store"]
    async fn native_session_round_trip() {
        let server = format!("https://session-test-{}.invalid", uuid::Uuid::new_v4());
        assert_eq!(read_desktop_session(server.clone()).await.unwrap(), None);
        write_desktop_session(server.clone(), Some("test-session".into()))
            .await
            .unwrap();
        let restored = read_desktop_session(server.clone()).await;
        write_desktop_session(server.clone(), None).await.unwrap();
        assert_eq!(restored.unwrap().as_deref(), Some("test-session"));
        assert_eq!(read_desktop_session(server.clone()).await.unwrap(), None);
        write_desktop_session(server, None).await.unwrap();
    }
}
