// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "StudyStudioNative",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "StudyStudioApp", targets: ["StudyStudioApp"])],
    targets: [.executableTarget(name: "StudyStudioApp")],
    swiftLanguageVersions: [.v5]
)
