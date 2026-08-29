package ws.three.app.glance;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * One request: GET /api/glance/mine?format=png for a size, with the widget
 * token as a bearer. The response is the bitmap plus the card's facts in
 * headers (state, tap target, name, metric), so a refresh is a single
 * round-trip per size and never needs a JSON parser.
 */
final class GlanceApi {
    static final class Card {
        final byte[] png;
        final String state;
        final String url;
        final String name;
        final String metric;

        Card(byte[] png, String state, String url, String name, String metric) {
            this.png = png;
            this.state = state;
            this.url = url;
            this.name = name;
            this.metric = metric;
        }
    }

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    // A 3x large card is under 400 KB; anything past this is not a card.
    private static final int MAX_BYTES = 4 * 1024 * 1024;

    private GlanceApi() {}

    static Card fetch(Context context, GlanceStore store, String size, int scale) throws IOException {
        Uri uri = Uri.parse(store.origin()).buildUpon()
                .path("/api/glance/mine")
                .appendQueryParameter("format", "png")
                .appendQueryParameter("size", size)
                .appendQueryParameter("theme", "dark")
                .appendQueryParameter("scale", String.valueOf(scale))
                .build();

        HttpURLConnection conn = (HttpURLConnection) new URL(uri.toString()).openConnection();
        try {
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Accept", "image/png");
            conn.setRequestProperty("User-Agent", userAgent(context));
            String token = store.token();
            if (token != null) conn.setRequestProperty("Authorization", "Bearer " + token);

            int status = conn.getResponseCode();
            String type = conn.getContentType();
            if (status != 200 || type == null || !type.startsWith("image/png")) {
                throw new IOException("glance card answered " + status + " " + type);
            }

            byte[] png = readAll(conn.getInputStream());
            return new Card(
                    png,
                    header(conn, "x-glance-state", GlanceStore.STATE_AGENT),
                    header(conn, "x-glance-url", store.origin() + "/glance"),
                    header(conn, "x-glance-name", ""),
                    header(conn, "x-glance-metric", ""));
        } finally {
            conn.disconnect();
        }
    }

    private static String header(HttpURLConnection conn, String name, String fallback) {
        String value = conn.getHeaderField(name);
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        byte[] buf = new byte[16 * 1024];
        int total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > MAX_BYTES) throw new IOException("glance card too large");
            out.write(buf, 0, n);
        }
        if (total == 0) throw new IOException("glance card was empty");
        return out.toByteArray();
    }

    private static String userAgent(Context context) {
        String version = "unknown";
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (info.versionName != null) version = info.versionName;
        } catch (PackageManager.NameNotFoundException ignored) {
            // Our own package is always installed; the fallback only guards the API contract.
        }
        return "three.ws-android-widget/" + version;
    }
}
