import Foundation

#if os(Linux)
// Supply the app-group directory on a host without the iOS entitlement API.
extension FileManager {
  func containerURL(forSecurityApplicationGroupIdentifier _: String) -> URL? {
    return MailboxRoundTrip.directory
  }
}
#endif

@main
struct MailboxRoundTrip {
  static let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

  static func main() throws {
    let exact = String(repeating: "é", count: IncomingShare.maximumText / 2)
    var first = IncomingShare()
    precondition(first.appendText(exact))
    precondition(first.appendText("") && first.text == exact)
    precondition(!first.appendText("x") && first.text == exact)
    var parts = IncomingShare(text: "x")
    precondition(parts.appendText(String(exact.dropLast())))
    precondition(parts.text.utf8.count == IncomingShare.maximumText && parts.text.hasPrefix("x\n"))
    let bytes = Data(repeating: 0xff, count: IncomingShare.maximum)
    let text = String(repeating: "\u{0001}", count: 65536)
    let file = IncomingShare.File(name: "test.bin", mime: "application/octet-stream", data: bytes.base64EncodedString())
    let share = IncomingShare(text: text, files: [file])
    let data = try share.encodedForMailbox()
    precondition(data.count <= IncomingShare.mailboxLimit)
    let decoded = try JSONDecoder().decode(IncomingShare.self, from: data)
    precondition(Data(base64Encoded: decoded.files[0].data) == bytes && decoded.text == text)
    #if os(Linux)
    defer { try? FileManager.default.removeItem(at: directory) }
    try share.save()
    let taken = try IncomingShare.take()
    precondition(Data(base64Encoded: taken.files[0].data) == bytes && taken.text == text)
    let empty = try IncomingShare.take()
    precondition(empty.files.isEmpty && empty.text.isEmpty)
    #endif
    print("PASS Foundation mailbox round trip: \(bytes.count) file bytes, \(data.count) JSON bytes")
  }
}
