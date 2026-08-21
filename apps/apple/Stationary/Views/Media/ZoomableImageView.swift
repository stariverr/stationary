import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// High-performance zoomable and pannable image viewer with double-tap, pinch-zoom, single-tap HUD toggle, and smooth drag-to-dismiss physics
public struct ZoomableImageView: View {
    public let url: URL
    public var rotationAngle: Double = 0
    public var onDismissRequest: (() -> Void)? = nil
    public var onTapToggleHUD: (() -> Void)? = nil

    @State private var currentScale: CGFloat = 1.0
    @State private var previousScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var previousOffset: CGSize = .zero
    @State private var isDraggingToDismiss: Bool = false
    @State private var dismissDragTranslation: CGFloat = 0

    private let minScale: CGFloat = 1.0
    private let maxScale: CGFloat = 5.0

    public init(
        url: URL,
        rotationAngle: Double = 0,
        onDismissRequest: (() -> Void)? = nil,
        onTapToggleHUD: (() -> Void)? = nil
    ) {
        self.url = url
        self.rotationAngle = rotationAngle
        self.onDismissRequest = onDismissRequest
        self.onTapToggleHUD = onTapToggleHUD
    }

    private var dismissProgress: CGFloat {
        min(abs(dismissDragTranslation) / 300.0, 1.0)
    }

    private var dynamicDragScale: CGFloat {
        if isDraggingToDismiss {
            return max(0.82, 1.0 - (dismissProgress * 0.18))
        }
        return 1.0
    }

    public var body: some View {
        GeometryReader { geometry in
            let containerSize = geometry.size

            ZStack {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .rotationEffect(.degrees(rotationAngle))
                            .scaleEffect(currentScale * dynamicDragScale)
                            .offset(
                                x: offset.width,
                                y: offset.height + dismissDragTranslation
                            )
                            .gesture(
                                currentScale > 1.05
                                    ? panGesture(containerSize: containerSize)
                                    : nil
                            )
                            .simultaneousGesture(pinchGesture)
                            .onTapGesture(count: 2) {
                                handleDoubleTap()
                            }
                            .onTapGesture(count: 1) {
                                onTapToggleHUD?()
                            }
                            .gesture(
                                currentScale <= 1.05 && onDismissRequest != nil
                                    ? dragToDismissGesture
                                    : nil
                            )
                    case .failure:
                        VStack(spacing: 12) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 32))
                                .foregroundColor(.yellow.opacity(0.8))
                            Text("Failed to load image")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.white.opacity(0.7))
                        }
                    case .empty:
                        ProgressView()
                            .controlSize(.regular)
                            .tint(.white)
                    @unknown default:
                        EmptyView()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .onTapGesture {
                onTapToggleHUD?()
            }
            .clipped()
        }
    }

    // MARK: - Gestures

    private var pinchGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                let delta = value / previousScale
                previousScale = value
                let newScale = currentScale * delta
                currentScale = min(max(newScale, minScale * 0.8), maxScale * 1.2)
            }
            .onEnded { _ in
                previousScale = 1.0
                withAnimation(.spring(response: 0.28, dampingFraction: 0.75)) {
                    if currentScale < minScale {
                        currentScale = minScale
                        offset = .zero
                        previousOffset = .zero
                    } else if currentScale > maxScale {
                        currentScale = maxScale
                    }
                }
            }
    }

    private func panGesture(containerSize: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                let maxOffsetX = max(0, (containerSize.width * (currentScale - 1)) / 2)
                let maxOffsetY = max(0, (containerSize.height * (currentScale - 1)) / 2)

                let proposedX = previousOffset.width + value.translation.width
                let proposedY = previousOffset.height + value.translation.height

                offset = CGSize(
                    width: min(max(proposedX, -maxOffsetX * 1.1), maxOffsetX * 1.1),
                    height: min(max(proposedY, -maxOffsetY * 1.1), maxOffsetY * 1.1)
                )
            }
            .onEnded { _ in
                let maxOffsetX = max(0, (containerSize.width * (currentScale - 1)) / 2)
                let maxOffsetY = max(0, (containerSize.height * (currentScale - 1)) / 2)

                withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                    offset.width = min(max(offset.width, -maxOffsetX), maxOffsetX)
                    offset.height = min(max(offset.height, -maxOffsetY), maxOffsetY)
                    previousOffset = offset
                }
            }
    }

    private var dragToDismissGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                if abs(value.translation.height) > abs(value.translation.width) {
                    dismissDragTranslation = value.translation.height
                    isDraggingToDismiss = true
                }
            }
            .onEnded { value in
                if abs(value.translation.height) > 100 {
                    HapticManager.impact(style: .medium)
                    onDismissRequest?()
                } else {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                        dismissDragTranslation = 0
                        isDraggingToDismiss = false
                    }
                }
            }
    }

    private func handleDoubleTap() {
        HapticManager.impact(style: .light)
        withAnimation(.spring(response: 0.28, dampingFraction: 0.75)) {
            if currentScale > 1.05 {
                currentScale = 1.0
                offset = .zero
                previousOffset = .zero
            } else {
                currentScale = 2.5
            }
        }
    }
}
