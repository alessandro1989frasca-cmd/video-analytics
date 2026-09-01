// AnalyticsLogger.swift
// Internal logger — prints only when debug mode is active.
// Using os.log in production builds for zero-cost when disabled.

import Foundation
import os.log

internal enum AnalyticsLogger {
    private static let log = OSLog(subsystem: "com.analytics.sdk", category: "VideoAnalytics")
    internal static var isDebug: Bool = false

    static func debug(_ message: String) {
        guard isDebug else { return }
        os_log("[VideoAnalytics] %{public}@", log: log, type: .debug, message)
    }

    static func warn(_ message: String) {
        guard isDebug else { return }
        os_log("[VideoAnalytics] ⚠️ %{public}@", log: log, type: .error, message)
    }
}
