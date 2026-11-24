import UIKit
import MobileCoreServices

final class ShareViewController: UIViewController {
  private let prompt = UILabel()
  private let save = UIButton(type: .system)
  private var cancelled = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    prompt.text = "Save this share, then open RChat to choose an account and destination."
    prompt.numberOfLines = 0
    let cancel = UIButton(type: .system)
    cancel.setTitle("Cancel", for: .normal)
    cancel.addTarget(self, action: #selector(dismissShare), for: .touchUpInside)
    save.setTitle("Save for RChat", for: .normal)
    save.addTarget(self, action: #selector(collect), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [prompt, save, cancel])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
  }

  @objc private func dismissShare() {
    cancelled = true
    extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
  }

  @objc private func collect() {
    save.isEnabled = false
    let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
    let providers = items.flatMap { $0.attachments ?? [] }
    let initial = items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
    guard providers.count <= 8, initial.utf8.count <= IncomingShare.maximumText else { fail(); return }
    var payload = IncomingShare()
    payload.text = initial
    read(providers[...], payload, IncomingShare.maximum)
  }

  private func fail() { prompt.text = "Could not read this share. Choose up to 8 files totaling 8 MB." }

  private func read(_ providers: ArraySlice<NSItemProvider>, _ payload: IncomingShare, _ remaining: Int) {
    guard !cancelled else { return }
    guard let p = providers.first else {
      guard !payload.text.isEmpty || !payload.files.isEmpty else { fail(); return }
      do {
        try payload.save()
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
          CFNotificationName(rawValue: "io.github.robbyv2.rchat.incoming" as CFString), nil, nil, true)
        extensionContext?.completeRequest(returningItems: nil)
      } catch { fail() }
      return
    }
    let next = providers.dropFirst()
    let plain = kUTTypePlainText as String, link = kUTTypeURL as String
    let type = p.hasItemConformingToTypeIdentifier(plain) ? plain : link
    let fileURL = kUTTypeFileURL as String
    if !p.hasItemConformingToTypeIdentifier(fileURL) && p.suggestedName == nil && p.hasItemConformingToTypeIdentifier(type) {
      p.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
        let text = (item as? String) ?? (item as? URL)?.absoluteString
        DispatchQueue.main.async {
          var result = payload
          guard let text = text, result.appendText(text) else { self.fail(); return }
          self.read(next, result, remaining)
        }
      }
      return
    }
    guard let identifier = p.registeredTypeIdentifiers.first(where: { $0 != fileURL }) ?? p.registeredTypeIdentifiers.first else { fail(); return }
    let copy: (URL?, Bool) -> Void = { url, requiresScope in
      do {
        guard let url = url, url.isFileURL else { throw CocoaError(.fileReadUnknown) }
        let scoped = url.startAccessingSecurityScopedResource()
        guard !requiresScope || scoped else { throw CocoaError(.fileReadNoPermission) }
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let handle = try FileHandle(forReadingFrom: url)
        defer { handle.closeFile() }
        let bytes = handle.readData(ofLength: remaining + 1)
        guard bytes.count <= remaining else { throw CocoaError(.fileReadTooLarge) }
        let mime = UTTypeCopyPreferredTagWithClass(identifier as CFString, kUTTagClassMIMEType)?.takeRetainedValue() as String?
        var result = payload
        result.files.append(.init(name: String((p.suggestedName ?? url.lastPathComponent).prefix(255)),
                                  mime: mime ?? "", data: bytes.base64EncodedString()))
        DispatchQueue.main.async { self.read(next, result, remaining - bytes.count) }
      } catch { DispatchQueue.main.async { self.fail() } }
    }
    if identifier == fileURL {
      p.loadItem(forTypeIdentifier: fileURL, options: nil) { item, _ in copy(item as? URL, true) }
    } else {
      p.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in copy(url, false) }
    }
  }
}
