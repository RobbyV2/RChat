import Foundation

// Compiled into both targets. A completed extension request replaces the previous unclaimed one.
struct IncomingShare: Codable {
  struct File: Codable { var name: String; var mime: String; var data: String }
  var text = ""
  var files: [File] = []
  var error: String?
  static let maximum = 8 * 1024 * 1024
  static let maximumText = 64 * 1024

  mutating func appendText(_ part: String) -> Bool {
    guard !part.isEmpty else { return true }
    let separator = text.isEmpty ? "" : "\n"
    guard part.utf8.count <= Self.maximumText - text.utf8.count - separator.utf8.count else { return false }
    text += separator
    text += part
    return true
  }

  static let mailboxLimit = 12 * 1024 * 1024

  func encodedForMailbox() throws -> Data {
    let encoder = JSONEncoder()
    // Base64 can consist almost entirely of slashes. Escaping each would double the file size.
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(self)
    guard data.count <= Self.mailboxLimit else { throw CocoaError(.fileWriteOutOfSpace) }
    return data
  }

  private static func mailbox() -> URL? {
    return FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: "group.io.github.robbyv2.rchat")?
      .appendingPathComponent("Library/Caches/RChat/IncomingShare.json")
  }

  func save() throws {
    guard let url = Self.mailbox() else { throw CocoaError(.fileNoSuchFile) }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try encodedForMailbox().write(to: url, options: [.atomic, .completeFileProtection])
  }

  static func take() throws -> IncomingShare {
    guard let source = mailbox() else { return IncomingShare() }
    let fm = FileManager.default
    let claimed = source.deletingLastPathComponent().appendingPathComponent("ReadingShare.json")
    // A previous host process may have been killed during decoding. Only the host takes shares.
    try? fm.removeItem(at: claimed)
    do { try fm.moveItem(at: source, to: claimed) }
    catch let e as NSError where e.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(e.code) {
      return IncomingShare()
    }
    defer { try? fm.removeItem(at: claimed) }
    let meta = try claimed.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
    guard let modified = meta.contentModificationDate, modified.timeIntervalSinceNow > -600,
      let size = meta.fileSize, size <= mailboxLimit else { return IncomingShare() }
    return try JSONDecoder().decode(IncomingShare.self, from: Data(contentsOf: claimed))
  }
}
