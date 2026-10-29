// The system share sheet on Android and iOS. Desktop builds get an empty plugin.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

#[cfg(mobile)]
mod mobile {
    use serde::{Deserialize, Serialize};
    use tauri::plugin::PluginHandle;
    use tauri::{Manager, Runtime};

    #[cfg(target_os = "ios")]
    tauri::ios_plugin_binding!(init_plugin_rchat_share);

    #[derive(Serialize)]
    struct Payload<'a> {
        title: Option<&'a str>,
        text: &'a str,
    }

    #[derive(Deserialize)]
    struct Outcome {
        shared: bool,
    }

    pub struct Share<R: Runtime>(PluginHandle<R>);

    impl<R: Runtime> Share<R> {
        // Opens the share sheet with `text`; false when the user closed it without sharing.
        pub fn text(&self, title: Option<&str>, text: &str) -> Result<bool, String> {
            self.0
                .run_mobile_plugin::<Outcome>("shareText", Payload { title, text })
                .map(|o| o.shared)
                .map_err(|e| e.to_string())
        }
    }

    pub trait ShareExt<R: Runtime> {
        fn share(&self) -> &Share<R>;
    }

    impl<R: Runtime, T: Manager<R>> ShareExt<R> for T {
        fn share(&self) -> &Share<R> {
            self.state::<Share<R>>().inner()
        }
    }

    pub fn register<R: Runtime>(
        app: &tauri::AppHandle<R>,
        api: tauri::plugin::PluginApi<R, ()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(target_os = "android")]
        let handle = api.register_android_plugin("io.github.robbyv2.rchat.share", "SharePlugin")?;
        #[cfg(target_os = "ios")]
        let handle = api.register_ios_plugin(init_plugin_rchat_share)?;
        app.manage(Share(handle));
        Ok(())
    }
}

#[cfg(mobile)]
pub use mobile::{Share, ShareExt};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("rchat-share");
    #[cfg(mobile)]
    let builder = builder.setup(|app, api| mobile::register(app, api));
    builder.build()
}
