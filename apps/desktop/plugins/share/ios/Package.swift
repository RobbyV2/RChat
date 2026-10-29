// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-rchat-share",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "tauri-plugin-rchat-share",
      type: .static,
      targets: ["tauri-plugin-rchat-share"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-rchat-share",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
