package ws.three.app.drive;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The single channel between the Android Auto templates on the car screen and
 * the /drive page running in {@link DriveWebService}'s web view.
 *
 * Android Auto's template host renders the car screen; an app never draws on it
 * outside the navigation category, and three.ws is not a navigation app. So the
 * conversation, the agent, its voice and its memory all stay in the page, and
 * this object is the wire between them. The page posts its state out through the
 * {@code ThreeWsDriveNative} JavaScript interface, and template presses go back
 * in as {@code window.threeWsDrive.command(...)}. Both halves of that protocol
 * live in src/drive/bridge.js, and the iOS half is DriveLink.swift.
 *
 * Every mutation lands on the main looper, because the page calls in from the
 * WebView's JavaScript thread and the car screen may only be invalidated from
 * the main thread.
 */
public final class DriveLink {

    /** Protocol version. Must match PROTOCOL in src/drive/bridge.js. */
    static final int PROTOCOL = 1;

    public static final String STATE_IDLE = "idle";

    /** One control mirrored onto the car screen. */
    public static final class Action {
        public final String id;
        public final String label;
        public final boolean enabled;

        Action(String id, String label, boolean enabled) {
            this.id = id;
            this.label = label;
            this.enabled = enabled;
        }
    }

    /** Implemented by the car screen so it can repaint when anything changes. */
    public interface Listener {
        void onDriveChanged();
    }

    /** Implemented by the web service: delivers a command into the page. */
    public interface CommandSink {
        void sendCommand(String json);
    }

    private static final DriveLink INSTANCE = new DriveLink();

    public static DriveLink get() {
        return INSTANCE;
    }

    private final Handler main = new Handler(Looper.getMainLooper());

    private String state = STATE_IDLE;
    private String agentName;
    private String lastSpoken;
    private String lastHeard;
    private String lastError;
    private List<Action> actions = Collections.emptyList();

    private Listener listener;
    private CommandSink sink;

    private DriveLink() {
    }

    // -- reads (main thread) --------------------------------------------------

    public String state() {
        return state;
    }

    /** Is a turn in flight? The car screen shows progress for exactly this window. */
    public boolean isActive() {
        return !STATE_IDLE.equals(state);
    }

    public String agentName() {
        return agentName;
    }

    public String lastSpoken() {
        return lastSpoken;
    }

    public String lastHeard() {
        return lastHeard;
    }

    public String lastError() {
        return lastError;
    }

    public List<Action> actions() {
        return actions;
    }

    // -- wiring ---------------------------------------------------------------

    public void setListener(Listener value) {
        listener = value;
    }

    public void setCommandSink(CommandSink value) {
        sink = value;
    }

    /**
     * Send a command the page understands. See onNativeCommand in
     * src/drive/index.js for the accepted types. Dropped, deliberately, when no
     * page is attached yet: a press before the loop is up is not an error.
     */
    public void send(String type) {
        CommandSink target = sink;
        if (target == null) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("type", type);
            target.sendCommand(payload.toString());
        } catch (Exception ignored) {
            // A malformed command must never take the drive down.
        }
    }

    public void reset() {
        main.post(new Runnable() {
            @Override
            public void run() {
                state = STATE_IDLE;
                agentName = null;
                lastSpoken = null;
                lastHeard = null;
                lastError = null;
                actions = Collections.emptyList();
                notifyChanged();
            }
        });
    }

    // -- inbound: page to car screen ------------------------------------------

    /**
     * Called from the JavaScript interface thread with one message from the
     * page. Anything unparseable is dropped rather than thrown: the page is a
     * remote document and this is a trust boundary.
     */
    void accept(String json) {
        final JSONObject body;
        try {
            body = new JSONObject(json);
        } catch (Exception e) {
            return;
        }
        if (body.optInt("v", -1) != PROTOCOL) return;
        final String type = body.optString("type", "");
        if (type.isEmpty()) return;

        main.post(new Runnable() {
            @Override
            public void run() {
                apply(type, body);
                notifyChanged();
            }
        });
    }

    private void apply(String type, JSONObject body) {
        switch (type) {
            case "ready": {
                JSONObject agent = body.optJSONObject("agent");
                agentName = agent == null ? null : emptyToNull(agent.optString("name", ""));
                lastError = null;
                break;
            }
            case "state":
                state = body.optString("state", STATE_IDLE);
                break;
            case "heard":
                lastHeard = emptyToNull(body.optString("text", ""));
                break;
            case "said":
                lastSpoken = emptyToNull(body.optString("text", ""));
                lastError = null;
                break;
            case "error":
                lastError = emptyToNull(body.optString("message", ""));
                break;
            case "actions":
                actions = readActions(body.optJSONArray("actions"));
                break;
            default:
                break;
        }
    }

    private static List<Action> readActions(JSONArray raw) {
        if (raw == null) return Collections.emptyList();
        List<Action> parsed = new ArrayList<>(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            JSONObject entry = raw.optJSONObject(i);
            if (entry == null) continue;
            String id = entry.optString("id", "");
            String label = entry.optString("label", "");
            if (id.isEmpty() || label.isEmpty()) continue;
            parsed.add(new Action(id, label, entry.optBoolean("enabled", true)));
        }
        return Collections.unmodifiableList(parsed);
    }

    private void notifyChanged() {
        Listener target = listener;
        if (target != null) target.onDriveChanged();
    }

    private static String emptyToNull(String value) {
        return value == null || value.isEmpty() ? null : value;
    }
}
