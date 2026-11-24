package io.github.robbyv2.rchat.share

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
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
  private val lock = Any()
  private val handler = Handler(Looper.getMainLooper())
  private var pending: Intent? = null
  private var web: WebView? = null
  private val expire = Runnable { synchronized(lock) { pending = null } }

  override fun load(webView: WebView) {
    web = webView
    accept(activity.intent)
  }

  override fun onNewIntent(intent: Intent) { accept(intent) }

  private fun accept(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND && intent?.action != Intent.ACTION_SEND_MULTIPLE) return
    synchronized(lock) {
      pending = Intent(requireNotNull(intent))
      // A recreated activity must not deliver an already consumed share a second time.
      intent.action = null
      intent.replaceExtras(null as android.os.Bundle?)
      intent.clipData = null
      intent.data = null
      handler.removeCallbacks(expire)
      handler.postDelayed(expire, 120_000)
    }
    web?.post { web?.evaluateJavascript("window.dispatchEvent(new Event('rchat-incoming-share'))", null) }
  }

  @Command
  fun takeIncoming(invoke: Invoke) {
    val incoming = synchronized(lock) {
      val saved = pending
      pending = null
      saved
    }
    if (incoming == null) {
      invoke.resolve(JSObject().put("text", "").put("files", JSONArray()))
      return
    }
    Thread { readShare(incoming, invoke) }.start()
  }

  @Suppress("DEPRECATION")
  private fun readShare(incoming: Intent, invoke: Invoke) {
    val files = JSONArray()
    try {
      val parts = listOfNotNull(incoming.getStringExtra(Intent.EXTRA_SUBJECT),
        incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()).distinct()
      require(parts.sumOf { it.length } <= 65_536)
      val text = parts.joinToString("\n")
      val uris = linkedSetOf<Uri>()
      incoming.clipData?.let { clips ->
        require(clips.itemCount <= 8)
        for (i in 0 until clips.itemCount) clips.getItemAt(i).uri?.let { uris.add(it) }
      }
      if (incoming.action == Intent.ACTION_SEND_MULTIPLE) {
        val extras = incoming.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
        require((extras?.size ?: 0) <= 8)
        extras?.let { uris.addAll(it) }
      } else incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.add(it) }
      require(uris.size <= 8)
      var remaining = 8 * 1024 * 1024
      val resolver = activity.contentResolver
      for (uri in uris) {
        require(uri.scheme == "content" && !uri.authority.isNullOrEmpty())
        val authority = uri.authority!!.substringAfterLast('@')
        val provider = activity.packageManager.resolveContentProvider(authority, 0)
        require(provider?.applicationInfo?.uid != activity.applicationInfo.uid)
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
          if (it.moveToFirst()) it.getString(0) else null
        } ?: "Attachment"
        val output = ByteArrayOutputStream()
        requireNotNull(resolver.openInputStream(uri)).use { input ->
          val buffer = ByteArray(16384)
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            remaining -= n
            require(remaining >= 0)
            output.write(buffer, 0, n)
          }
        }
        files.put(JSONObject().put("name", name.take(255)).put("mime", resolver.getType(uri) ?: "")
          .put("data", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)))
      }
      invoke.resolve(JSObject().put("text", text).put("files", files))
    } catch (_: Exception) {
      invoke.resolve(JSObject().put("text", "").put("files", JSONArray())
        .put("error", "Could not open this share. Choose up to 8 files totaling 8 MB."))
    }
  }

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
