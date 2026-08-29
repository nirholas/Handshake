package ws.three.app.glance;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.util.regex.Pattern;

/**
 * Everything the widget remembers between refreshes: the widget token the
 * owner linked from /glance, and the last card the server handed back (the
 * bitmap per size on disk, its tap target and timestamp in preferences).
 *
 * The bitmap is the source of truth for what is on screen. A refresh that
 * fails leaves it untouched, so an offline phone keeps showing the last real
 * card with its own timestamp rather than a spinner or a broken image.
 */
public final class GlanceStore {
    private static final String PREFS = "glance_widget";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_ORIGIN = "origin";
    private static final String KEY_STATE = "state";
    private static final String KEY_URL = "url";
    private static final String KEY_NAME = "name";
    private static final String KEY_METRIC = "metric";
    private static final String KEY_UPDATED_AT = "updated_at";
    private static final String KEY_LAST_ERROR_AT = "last_error_at";

    public static final String DEFAULT_ORIGIN = "https://three.ws";
    public static final String STATE_AGENT = "agent";
    public static final String STATE_UNLINKED = "unlinked";
    public static final String STATE_NO_AGENT = "no-agent";
    public static final String STATE_SIGNED_OUT = "signed-out";

    /** The server's token shape; anything else is refused before it is stored. */
    private static final Pattern TOKEN_SHAPE = Pattern.compile("^glw_[A-Za-z0-9_-]{32}$");

    private final SharedPreferences prefs;
    private final File dir;

    public GlanceStore(Context context) {
        Context app = context.getApplicationContext();
        prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        dir = new File(app.getFilesDir(), "glance");
    }

    public static boolean isToken(String value) {
        return value != null && TOKEN_SHAPE.matcher(value).matches();
    }

    public String token() {
        return prefs.getString(KEY_TOKEN, null);
    }

    public boolean linked() {
        return isToken(token());
    }

    public boolean link(String token) {
        if (!isToken(token)) return false;
        prefs.edit()
                .putString(KEY_TOKEN, token)
                .remove(KEY_STATE)
                .remove(KEY_URL)
                .remove(KEY_NAME)
                .remove(KEY_METRIC)
                .remove(KEY_UPDATED_AT)
                .remove(KEY_LAST_ERROR_AT)
                .apply();
        clearBitmaps();
        return true;
    }

    public void unlink() {
        prefs.edit().clear().apply();
        clearBitmaps();
    }

    /**
     * The origin the card is fetched from. Fixed to three.ws in the shipped
     * app: the setter exists for the emulator recipe, which points a debug
     * build at a local server, and it only takes effect in a debuggable build
     * (see GlanceLinkActivity).
     */
    public String origin() {
        return prefs.getString(KEY_ORIGIN, DEFAULT_ORIGIN);
    }

    public void setOrigin(String origin) {
        prefs.edit().putString(KEY_ORIGIN, origin).apply();
    }

    public File bitmapFile(String size) {
        return new File(dir, size + ".png");
    }

    public File bitmapTempFile(String size) {
        return new File(dir, size + ".png.part");
    }

    public File dir() {
        return dir;
    }

    public void recordCard(String state, String url, String name, String metric, long updatedAt) {
        prefs.edit()
                .putString(KEY_STATE, state)
                .putString(KEY_URL, url)
                .putString(KEY_NAME, name)
                .putString(KEY_METRIC, metric)
                .putLong(KEY_UPDATED_AT, updatedAt)
                .remove(KEY_LAST_ERROR_AT)
                .apply();
    }

    public void recordFailure(long at) {
        prefs.edit().putLong(KEY_LAST_ERROR_AT, at).apply();
    }

    public String state() {
        return prefs.getString(KEY_STATE, null);
    }

    public String url() {
        return prefs.getString(KEY_URL, null);
    }

    public String name() {
        return prefs.getString(KEY_NAME, null);
    }

    public String metric() {
        return prefs.getString(KEY_METRIC, null);
    }

    public long updatedAt() {
        return prefs.getLong(KEY_UPDATED_AT, 0L);
    }

    public long lastErrorAt() {
        return prefs.getLong(KEY_LAST_ERROR_AT, 0L);
    }

    /** True when the last refresh failed after a card had already been shown. */
    public boolean stale() {
        return lastErrorAt() > updatedAt();
    }

    private void clearBitmaps() {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }
}
