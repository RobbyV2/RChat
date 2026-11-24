import SwiftRs
import Tauri
import UIKit
import WebKit

struct ShareArgs: Decodable {
  let text: String
  let title: String?
}

struct ShareOutcome: Encodable {
  let shared: Bool
}

// Hands text to the iOS share sheet and reports whether the user shared it.
class SharePlugin: Plugin {
  var webview: WKWebView?

  public override func load(webview: WKWebView) {
    self.webview = webview
    CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(), { _, observer, _, _, _ in
        guard let observer = observer else { return }
        let plugin = Unmanaged<SharePlugin>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async {
          plugin.webview?.evaluateJavaScript("window.dispatchEvent(new Event('rchat-incoming-share'))")
        }
      }, "io.github.robbyv2.rchat.incoming" as CFString, nil, .deliverImmediately)
  }

  deinit {
    CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque())
  }

  private let inboxQueue = DispatchQueue(label: "rchat.share.inbox")

  @objc public func takeIncoming(_ invoke: Invoke) {
    inboxQueue.async {
      do { invoke.resolve(try IncomingShare.take()) }
      catch { invoke.reject("Could not read the shared content.") }
    }
  }

  @objc public func shareText(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareArgs.self)
    DispatchQueue.main.async {
      guard let presenter = self.manager.viewController else {
        invoke.reject("Could not share")
        return
      }
      let sheet = UIActivityViewController(activityItems: [args.text], applicationActivities: nil)
      if let view = self.webview {
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(
          x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
      }
      sheet.completionWithItemsHandler = { _, completed, _, _ in
        invoke.resolve(ShareOutcome(shared: completed))
      }
      presenter.present(sheet, animated: true, completion: nil)
    }
  }
}

@_cdecl("init_plugin_rchat_share")
func initPlugin() -> Plugin {
  return SharePlugin()
}
