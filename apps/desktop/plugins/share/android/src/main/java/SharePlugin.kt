package io.github.robbyv2.rchat.share

import android.app.Activity
import android.content.Intent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ShareArgs {
  lateinit var text: String
  var title: String? = null
}

// Hands text to the Android share sheet. Android does not say whether the user picked a target,
// so an opened sheet counts as shared.
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun shareText(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = "text/plain"
      putExtra(Intent.EXTRA_TEXT, args.text)
      args.title?.let { putExtra(Intent.EXTRA_TITLE, it) }
    }
    activity.runOnUiThread {
      try {
        activity.startActivity(Intent.createChooser(send, args.title))
        invoke.resolve(JSObject().put("shared", true))
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Could not share")
      }
    }
  }
}
