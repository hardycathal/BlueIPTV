package expo.modules.pip

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Picture-in-picture with a play/pause control.
 *
 * Android does not draw player controls inside a PiP window — the app must
 * supply them as RemoteActions backed by a PendingIntent. Taps arrive here as
 * a broadcast, which we forward to JS as an "onPipAction" event; JS toggles
 * playback and calls updatePipActions() so the icon flips.
 */
class PipModule : Module() {
  private var receiver: BroadcastReceiver? = null

  companion object {
    private const val ACTION_TOGGLE = "expo.modules.pip.ACTION_TOGGLE"
    private const val REQUEST_CODE = 1001
  }

  private fun pipSupported(activity: Activity): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  private fun buildParams(activity: Activity, isPlaying: Boolean): PictureInPictureParams {
    val intent = Intent(ACTION_TOGGLE).setPackage(activity.packageName)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      flags = flags or PendingIntent.FLAG_IMMUTABLE
    }
    val pending = PendingIntent.getBroadcast(activity, REQUEST_CODE, intent, flags)

    val iconRes = if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
    val label = if (isPlaying) "Pause" else "Play"
    val action = RemoteAction(Icon.createWithResource(activity, iconRes), label, label, pending)

    return PictureInPictureParams.Builder()
      .setAspectRatio(Rational(16, 9))
      .setActions(listOf(action))
      .build()
  }

  private fun ensureReceiver(activity: Activity) {
    if (receiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == ACTION_TOGGLE) {
          try {
            this@PipModule.sendEvent("onPipAction", mapOf("action" to "toggle"))
          } catch (e: Throwable) {
            // JS listener not attached — ignore rather than crash the app
          }
        }
      }
    }
    val filter = IntentFilter(ACTION_TOGGLE)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        activity.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        activity.registerReceiver(r, filter)
      }
      receiver = r
    } catch (e: Throwable) {
      receiver = null // control button won't work, but PiP itself still will
    }
  }

  private fun clearReceiver() {
    val activity = appContext.activityProvider?.currentActivity
    receiver?.let {
      try { activity?.unregisterReceiver(it) } catch (e: Throwable) { /* already gone */ }
    }
    receiver = null
  }

  override fun definition() = ModuleDefinition {
    Name("Pip")

    Events("onPipAction")

    Function("isSupported") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      pipSupported(activity)
    }

    // Activity APIs must run on the UI thread.
    AsyncFunction("enterPip") { isPlaying: Boolean ->
      val activity = appContext.activityProvider?.currentActivity ?: return@AsyncFunction false
      if (!pipSupported(activity)) return@AsyncFunction false
      if (activity.isFinishing || activity.isDestroyed) return@AsyncFunction false

      activity.runOnUiThread {
        try {
          ensureReceiver(activity)
          activity.enterPictureInPictureMode(buildParams(activity, isPlaying))
        } catch (e: Throwable) {
          // some OEM builds reject PiP even when the feature flag is present
        }
      }
      true
    }

    // Refresh the play/pause icon while the window is already in PiP.
    AsyncFunction("updatePipActions") { isPlaying: Boolean ->
      val activity = appContext.activityProvider?.currentActivity ?: return@AsyncFunction false
      if (!pipSupported(activity)) return@AsyncFunction false

      activity.runOnUiThread {
        try {
          activity.setPictureInPictureParams(buildParams(activity, isPlaying))
        } catch (e: Throwable) {
          // ignore — not in PiP any more
        }
      }
      true
    }

    AsyncFunction("cleanup") {
      clearReceiver()
      true
    }

    OnDestroy {
      clearReceiver()
    }
  }
}
