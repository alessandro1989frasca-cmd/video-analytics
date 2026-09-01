package com.analytics.sdk

import android.util.Log

internal object AnalyticsLogger {
    private const val TAG = "VideoAnalytics"
    var isDebug: Boolean = false

    fun debug(msg: String) { if (isDebug) Log.d(TAG, msg) }
    fun warn(msg: String)  { if (isDebug) Log.w(TAG, msg) }
    fun error(msg: String, t: Throwable? = null) {
        if (isDebug) Log.e(TAG, msg, t)
    }
}
