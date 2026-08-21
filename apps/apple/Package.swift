// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Stationary",
    platforms: [
        .macOS(.v14),
        .iOS(.v18)
    ],
    products: [
        .executable(
            name: "Stationary",
            targets: ["Stationary"]
        )
    ],
    targets: [
        .executableTarget(
            name: "Stationary",
            path: "Stationary"
        )
    ]
)
