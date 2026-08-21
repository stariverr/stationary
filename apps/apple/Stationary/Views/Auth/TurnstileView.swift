import SwiftUI
import WebKit

#if os(macOS)
public struct TurnstileWebView: NSViewRepresentable {
    public let siteKey: String
    public let onTokenReceived: (String) -> Void
    
    public init(siteKey: String = "1x00000000000000000000BB", onTokenReceived: @escaping (String) -> Void) {
        self.siteKey = siteKey
        self.onTokenReceived = onTokenReceived
    }
    
    public func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "turnstile")
        
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        
        let html = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
            <style>
                body {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: transparent;
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                }
            </style>
        </head>
        <body>
            <div class="cf-turnstile" data-sitekey="\(siteKey)" data-callback="onTurnstileSuccess" data-theme="auto"></div>
            <script>
                function onTurnstileSuccess(token) {
                    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.turnstile) {
                        window.webkit.messageHandlers.turnstile.postMessage(token);
                    }
                }
            </script>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: URL(string: "http://localhost:9400"))
        return webView
    }
    
    public func updateNSView(_ nsView: WKWebView, context: Context) {}
    
    public func makeCoordinator() -> Coordinator {
        Coordinator(onTokenReceived: onTokenReceived)
    }
    
    public class Coordinator: NSObject, WKScriptMessageHandler {
        let onTokenReceived: (String) -> Void
        
        init(onTokenReceived: @escaping (String) -> Void) {
            self.onTokenReceived = onTokenReceived
        }
        
        public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "turnstile", let token = message.body as? String {
                onTokenReceived(token)
            }
        }
    }
}
#else
public struct TurnstileWebView: UIViewRepresentable {
    public let siteKey: String
    public let onTokenReceived: (String) -> Void
    
    public init(siteKey: String = "1x00000000000000000000BB", onTokenReceived: @escaping (String) -> Void) {
        self.siteKey = siteKey
        self.onTokenReceived = onTokenReceived
    }
    
    public func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "turnstile")
        
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        
        let html = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
            <style>
                body {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: transparent;
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                }
            </style>
        </head>
        <body>
            <div class="cf-turnstile" data-sitekey="\(siteKey)" data-callback="onTurnstileSuccess" data-theme="auto"></div>
            <script>
                function onTurnstileSuccess(token) {
                    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.turnstile) {
                        window.webkit.messageHandlers.turnstile.postMessage(token);
                    }
                }
            </script>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: URL(string: "http://localhost:9400"))
        return webView
    }
    
    public func updateUIView(_ uiView: WKWebView, context: Context) {}
    
    public func makeCoordinator() -> Coordinator {
        Coordinator(onTokenReceived: onTokenReceived)
    }
    
    public class Coordinator: NSObject, WKScriptMessageHandler {
        let onTokenReceived: (String) -> Void
        
        init(onTokenReceived: @escaping (String) -> Void) {
            self.onTokenReceived = onTokenReceived
        }
        
        public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "turnstile", let token = message.body as? String {
                onTokenReceived(token)
            }
        }
    }
}
#endif
