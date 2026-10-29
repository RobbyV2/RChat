cask "rchat" do
  version "{{VERSION}}"
  sha256 "{{DMG_SHA256}}"

  url "{{DMG_URL}}"
  name "RChat"
  desc "Anonymous Material chat"
  homepage "https://github.com/{{REPO}}"

  depends_on macos: ">= :big_sur"

  app "RChat.app"

  zap trash: [
    "~/Library/Application Support/io.github.robbyv2.rchat",
    "~/Library/Caches/io.github.robbyv2.rchat",
    "~/Library/Saved Application State/io.github.robbyv2.rchat.savedState",
    "~/Library/WebKit/io.github.robbyv2.rchat",
  ]
end
