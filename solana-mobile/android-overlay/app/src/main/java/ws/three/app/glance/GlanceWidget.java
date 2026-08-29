package ws.three.app.glance;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.RemoteViews;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.io.File;
import java.util.Date;
import java.util.concurrent.TimeUnit;

import ws.three.app.R;

/**
 * The three.ws home screen widget: the owner's agent as a glance card, one
 * live number, and a tap that lands back in the app on that agent.
 *
 * The card itself is a bitmap the server renders (GET /api/glance/mine
 * ?format=png), because no Android widget can run WebGL and RemoteViews can
 * draw a bitmap on any launcher. This class only decides which size to ask
 * for, paints what is cached, and wires the taps.
 */
public final class GlanceWidget extends AppWidgetProvider {
    public static final String ACTION_REFRESH = "ws.three.app.glance.REFRESH";

    static final String SIZE_SMALL = "small";
    static final String SIZE_MEDIUM = "medium";
    static final String SIZE_LARGE = "large";

    private static final String PERIODIC_WORK = "glance-refresh-periodic";
    private static final String ONCE_WORK = "glance-refresh-now";
    // WorkManager's floor is 15 minutes; 30 keeps the number honest for a card
    // whose metric is "moves today" while staying inside the battery budget
    // the OS grants a background app.
    private static final long PERIOD_MINUTES = 30;

    private static final String UTM = "utm_source=android_widget";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        updateAll(context, manager, ids);
        schedulePeriodic(context);
        refreshNow(context);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        manager.updateAppWidget(id, buildViews(context, manager, id));
        // A resize may need a size that has never been fetched.
        refreshNow(context);
    }

    @Override
    public void onEnabled(Context context) {
        schedulePeriodic(context);
    }

    @Override
    public void onDisabled(Context context) {
        cancelPeriodic(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) refreshNow(context);
    }

    // ── scheduling ─────────────────────────────────────────────────────────

    static void schedulePeriodic(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                GlanceRefreshWorker.class, PERIOD_MINUTES, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    static void cancelPeriodic(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK);
    }

    public static void refreshNow(Context context) {
        // No network constraint on purpose: a tap on "refresh" while offline
        // should answer at once with the "(offline)" footer, not sit silently
        // until a connection appears. The periodic job keeps the constraint.
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(GlanceRefreshWorker.class).build();
        // REPLACE, not KEEP: a tap on "refresh" while an earlier attempt is
        // sitting in retry backoff must run now, not wait out the backoff.
        WorkManager.getInstance(context).enqueueUniqueWork(ONCE_WORK, ExistingWorkPolicy.REPLACE, request);
    }

    // ── painting ───────────────────────────────────────────────────────────

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, GlanceWidget.class));
        updateAll(context, manager, ids);
    }

    static void updateAll(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, buildViews(context, manager, id));
    }

    /** Which server size fits the cells this instance was given. */
    static String sizeFor(Bundle options) {
        if (options == null) return SIZE_MEDIUM;
        int minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        if (minHeight >= 190) return SIZE_LARGE;
        if (minWidth < 200) return SIZE_SMALL;
        return SIZE_MEDIUM;
    }

    /** The bitmap density to request: 3x on xxhdpi and denser, 2x elsewhere. */
    static int scaleFor(Context context) {
        float density = context.getResources().getDisplayMetrics().density;
        return density >= 2.5f ? 3 : 2;
    }

    static RemoteViews buildViews(Context context, AppWidgetManager manager, int id) {
        GlanceStore store = new GlanceStore(context);
        Bundle options = manager.getAppWidgetOptions(id);
        String size = sizeFor(options);
        boolean wide = !SIZE_SMALL.equals(size);
        RemoteViews views = new RemoteViews(context.getPackageName(),
                wide ? R.layout.glance_widget_wide : R.layout.glance_widget_small);

        Bitmap bitmap = store.linked() || store.state() != null ? loadBitmap(context, store, size, options) : null;

        if (bitmap != null) {
            views.setImageViewBitmap(R.id.glance_card, bitmap);
            views.setViewVisibility(R.id.glance_card, View.VISIBLE);
            views.setViewVisibility(R.id.glance_notice, View.GONE);
            views.setContentDescription(R.id.glance_card, describe(store));
        } else {
            views.setViewVisibility(R.id.glance_card, View.GONE);
            views.setViewVisibility(R.id.glance_notice, View.VISIBLE);
            if (store.linked()) {
                views.setTextViewText(R.id.glance_notice_title, context.getString(R.string.glance_loading_title));
                views.setTextViewText(R.id.glance_notice_body, context.getString(R.string.glance_loading_body));
            } else {
                views.setTextViewText(R.id.glance_notice_title, context.getString(R.string.glance_link_title));
                views.setTextViewText(R.id.glance_notice_body, context.getString(R.string.glance_link_body));
            }
        }

        if (wide) {
            views.setTextViewText(R.id.glance_updated, footer(context, store));
            views.setOnClickPendingIntent(R.id.glance_action_create,
                    open(context, id, 1, "https://three.ws/create?" + UTM));
            views.setOnClickPendingIntent(R.id.glance_action_agents,
                    open(context, id, 2, "https://three.ws/my-agents?" + UTM));
            views.setOnClickPendingIntent(R.id.glance_updated, refreshIntent(context, id));
            views.setViewVisibility(R.id.glance_actions, SIZE_LARGE.equals(size) ? View.VISIBLE : View.GONE);
        }

        views.setOnClickPendingIntent(R.id.glance_root, open(context, id, 0, tapTarget(store)));
        return views;
    }

    private static String tapTarget(GlanceStore store) {
        if (!store.linked() && !GlanceStore.STATE_UNLINKED.equals(store.state())) {
            return "https://three.ws/glance?link=android&" + UTM;
        }
        String url = store.url();
        if (url == null || !url.startsWith("https://")) url = "https://three.ws/glance";
        return url + (url.contains("?") ? "&" : "?") + UTM;
    }

    private static String describe(GlanceStore store) {
        String name = store.name();
        String metric = store.metric();
        if (name == null || name.isEmpty()) return "three.ws agent card";
        return metric == null || metric.isEmpty() ? name : name + ", " + metric;
    }

    private static CharSequence footer(Context context, GlanceStore store) {
        long at = store.updatedAt();
        if (at <= 0) return context.getString(R.string.glance_footer_never);
        String time = DateFormat.getTimeFormat(context).format(new Date(at));
        return context.getString(store.stale() ? R.string.glance_footer_stale : R.string.glance_footer_updated, time);
    }

    /**
     * Decode the cached PNG at no more than the pixels this instance can show.
     * RemoteViews ships the bitmap across Binder, so a 3x large card is
     * downsampled for a 2x2 slot instead of being sent at full size.
     */
    private static Bitmap loadBitmap(Context context, GlanceStore store, String size, Bundle options) {
        File file = store.bitmapFile(size);
        if (!file.isFile()) {
            // A size that has not been fetched yet borrows the nearest cached one
            // rather than flashing the notice layout during a resize.
            for (String other : new String[] {SIZE_MEDIUM, SIZE_LARGE, SIZE_SMALL}) {
                File candidate = store.bitmapFile(other);
                if (candidate.isFile()) {
                    file = candidate;
                    break;
                }
            }
            if (!file.isFile()) return null;
        }

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        if (bounds.outWidth <= 0) return null;

        float density = context.getResources().getDisplayMetrics().density;
        int maxWidthDp = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
        int targetPx = maxWidthDp > 0 ? Math.round(maxWidthDp * density) : bounds.outWidth;
        int sample = 1;
        while (bounds.outWidth / (sample * 2) >= targetPx) sample *= 2;

        BitmapFactory.Options decode = new BitmapFactory.Options();
        decode.inSampleSize = sample;
        decode.inPreferredConfig = Bitmap.Config.ARGB_8888;
        return BitmapFactory.decodeFile(file.getPath(), decode);
    }

    // ── taps ───────────────────────────────────────────────────────────────

    private static PendingIntent open(Context context, int widgetId, int slot, String url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        // Explicit to our own package: the https filter on LauncherActivity
        // takes it, so the tap lands inside the app, never in a browser tab.
        intent.setPackage(context.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, widgetId * 8 + slot, intent, flags());
    }

    private static PendingIntent refreshIntent(Context context, int widgetId) {
        Intent intent = new Intent(context, GlanceWidget.class).setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(context, widgetId * 8 + 3, intent, flags());
    }

    private static int flags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }
}
