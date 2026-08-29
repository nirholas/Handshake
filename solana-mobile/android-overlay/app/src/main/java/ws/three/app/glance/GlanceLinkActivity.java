package ws.three.app.glance;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

import ws.three.app.R;

/**
 * The hand-off from the web to the widget. /glance mints a widget token and
 * opens
 *
 *   intent://glance/link?token=glw_…#Intent;scheme=threews;package=ws.three.app;end
 *
 * which Chrome routes here. The token is stored, a refresh is queued, and if
 * no widget is on the home screen yet the launcher is asked to offer one.
 * threews://glance/unlink drops the token; the server-side revoke on /glance
 * does the same on the widget's next refresh.
 *
 * Nothing is shown but a toast: the activity is translucent and finishes at
 * once, so the person stays where they were.
 */
public final class GlanceLinkActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handle(getIntent());
        finish();
    }

    private void handle(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"threews".equals(data.getScheme()) || !"glance".equals(data.getHost())) return;

        GlanceStore store = new GlanceStore(this);
        String path = data.getPath() == null ? "" : data.getPath();

        if ("/unlink".equals(path)) {
            store.unlink();
            GlanceWidget.updateAll(this);
            Toast.makeText(this, R.string.glance_toast_unlinked, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!"/link".equals(path)) return;

        String token = data.getQueryParameter("token");
        if (!store.link(token)) {
            Toast.makeText(this, R.string.glance_toast_bad_link, Toast.LENGTH_LONG).show();
            return;
        }

        // The origin override is for the emulator recipe (a debug build pointed
        // at a local server). A release build ignores it, so a crafted link
        // can never redirect a shipped widget's token to another host.
        String origin = data.getQueryParameter("origin");
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        store.setOrigin(debuggable && origin != null && origin.startsWith("http") ? origin : GlanceStore.DEFAULT_ORIGIN);

        GlanceWidget.updateAll(this);
        GlanceWidget.refreshNow(this);
        Toast.makeText(this, R.string.glance_toast_linked, Toast.LENGTH_SHORT).show();
        offerPin();
    }

    /** Ask the launcher to place the widget when none is on the home screen yet. */
    private void offerPin() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        AppWidgetManager manager = AppWidgetManager.getInstance(this);
        ComponentName provider = new ComponentName(this, GlanceWidget.class);
        if (manager.getAppWidgetIds(provider).length > 0) return;
        if (!manager.isRequestPinAppWidgetSupported()) return;
        manager.requestPinAppWidget(provider, null, null);
    }
}
