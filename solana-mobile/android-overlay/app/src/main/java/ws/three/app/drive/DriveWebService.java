package ws.three.app.drive;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import ws.three.app.R;

/**
 * Hosts the /drive page for the length of an Android Auto session.
 *
 * The page is the product: microphone in, /api/asr, /api/chat, /api/tts, and the
 * agent's own voice back out. On Android Auto there is nowhere to draw it, so it
 * runs here in a web view that is never attached to a window, and the page is
 * told so with {@code ?surface=androidauto}: src/drive/surface.js turns off the
 * 3D stage for that surface, because a windowless web view gets no animation
 * frames. Audio, fetch and timers all keep running, which is the whole loop.
 *
 * A foreground service is not optional here. The phone screen belongs to Android
 * Auto during a drive, so this process is background by definition, and a
 * background process may not hold the microphone. The notification is the honest
 * price of that: the user can see the agent is listening and stop it in one tap.
 */
public final class DriveWebService extends Service implements DriveLink.CommandSink {

    /** The car screen starts and stops the loop with these. */
    public static final String ACTION_START = "ws.three.app.drive.START";
    public static final String ACTION_STOP = "ws.three.app.drive.STOP";

    /** The surface preset the page reads. See src/drive/surface.js. */
    private static final String DRIVE_URL = "https://three.ws/drive?surface=androidauto";

    /** The name the page posts to. Must match src/drive/bridge.js. */
    private static final String BRIDGE = "ThreeWsDriveNative";

    private static final String CHANNEL_ID = "drive_session";
    private static final int NOTIFICATION_ID = 4201;

    private WebView web;

    public static void start(Context context) {
        Intent intent = new Intent(context.getApplicationContext(), DriveWebService.class);
        intent.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getApplicationContext().startForegroundService(intent);
        } else {
            context.getApplicationContext().startService(intent);
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context.getApplicationContext(), DriveWebService.class);
        intent.setAction(ACTION_STOP);
        context.getApplicationContext().startService(intent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        goForeground();
        if (web == null) createWebView();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        DriveLink.get().setCommandSink(null);
        DriveLink.get().reset();
        if (web != null) {
            web.removeJavascriptInterface(BRIDGE);
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // -- the page -------------------------------------------------------------

    private void createWebView() {
        // Application context: a Service context is not a UI context, and some
        // OEM web views refuse to inflate against one.
        web = new WebView(getApplicationContext());
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // No window means no gesture is possible, and the whole point of the
        // surface is that it speaks the moment it has something to say.
        settings.setMediaPlaybackRequiresUserGesture(false);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Grant the microphone and nothing else, and only what the page
                // actually asked for. The app's own RECORD_AUDIO grant is checked
                // on the car screen before this service is ever started.
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                        return;
                    }
                }
                request.deny();
            }
        });

        web.addJavascriptInterface(new Bridge(), BRIDGE);
        DriveLink.get().setCommandSink(this);
        web.loadUrl(DRIVE_URL);
    }

    /**
     * The page's outbound half. Every method here is reachable from a remote
     * document, so it takes one string, parses it defensively, and exposes
     * nothing else.
     */
    private static final class Bridge {
        @JavascriptInterface
        public void post(String json) {
            DriveLink.get().accept(json);
        }
    }

    @Override
    public void sendCommand(final String json) {
        final WebView target = web;
        if (target == null) return;
        target.post(new Runnable() {
            @Override
            public void run() {
                // Optional chaining on the page side: a command that arrives
                // before the page has booted is dropped, not thrown.
                target.evaluateJavascript("window.threeWsDrive?.command(" + json + ");", null);
            }
        });
    }

    // -- foreground ------------------------------------------------------------

    private void goForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        getString(R.string.drive_channel_name),
                        NotificationManager.IMPORTANCE_LOW);
                channel.setDescription(getString(R.string.drive_channel_description));
                channel.setShowBadge(false);
                manager.createNotificationChannel(channel);
            }
        }

        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                            | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        Intent stop = new Intent(this, DriveWebService.class).setAction(ACTION_STOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, flags);

        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("https://three.ws/drive"));
        PendingIntent openIntent = PendingIntent.getActivity(this, 2, open, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle(getString(R.string.drive_notification_title))
                .setContentText(getString(R.string.drive_notification_text))
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(openIntent)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(
                        null, getString(R.string.drive_notification_stop), stopIntent).build())
                .build();
    }
}
