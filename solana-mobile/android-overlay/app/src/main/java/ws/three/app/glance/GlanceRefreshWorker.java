package ws.three.app.glance;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * The refresh. WorkManager runs it every 30 minutes while a widget is placed
 * (battery-aware, coalesced with the system's other periodic work) and once
 * on demand after a link or a tap on "refresh". It fetches one bitmap per
 * size currently on screen, writes each one atomically, and then repaints
 * every widget instance.
 *
 * Failure is the designed path: no network, a timeout, a 5xx all return
 * retry, the cached bitmap stays on screen, and the footer says the card is
 * from earlier. Nothing here ever clears a card it cannot replace.
 */
public final class GlanceRefreshWorker extends Worker {
    private static final String TAG = "GlanceWidget";

    public GlanceRefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        GlanceStore store = new GlanceStore(context);
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, GlanceWidget.class));

        if (ids.length == 0) {
            GlanceWidget.cancelPeriodic(context);
            return Result.success();
        }
        if (!store.linked()) {
            GlanceWidget.updateAll(context, manager, ids);
            return Result.success();
        }

        Set<String> sizes = new LinkedHashSet<>();
        for (int id : ids) {
            Bundle options = manager.getAppWidgetOptions(id);
            sizes.add(GlanceWidget.sizeFor(options));
        }

        int scale = GlanceWidget.scaleFor(context);
        boolean anyFailed = false;
        for (String size : sizes) {
            try {
                GlanceApi.Card card = GlanceApi.fetch(context, store, size, scale);
                writeAtomically(store, size, card.png);
                if (GlanceStore.STATE_UNLINKED.equals(card.state)) {
                    // The owner revoked this widget from /glance. Drop the token so
                    // the tap goes to the link flow instead of retrying a dead one.
                    store.unlink();
                    store.recordCard(card.state, card.url, card.name, card.metric, System.currentTimeMillis());
                    GlanceWidget.updateAll(context, manager, ids);
                    return Result.success();
                }
                store.recordCard(card.state, card.url, card.name, card.metric, System.currentTimeMillis());
            } catch (IOException e) {
                // Logged, never surfaced: the slot keeps its last card, and the
                // footer says it is from earlier. logcat is where a tester looks.
                Log.w(TAG, "glance refresh failed for size " + size + ": " + e.getMessage());
                anyFailed = true;
                store.recordFailure(System.currentTimeMillis());
            }
        }

        GlanceWidget.updateAll(context, manager, ids);
        return anyFailed ? Result.retry() : Result.success();
    }

    private static void writeAtomically(GlanceStore store, String size, byte[] png) throws IOException {
        File dir = store.dir();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File tmp = store.bitmapTempFile(size);
        File target = store.bitmapFile(size);
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(png);
            out.getFD().sync();
        }
        if (!tmp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("cannot replace " + target);
        }
    }
}
