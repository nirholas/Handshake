package ws.three.app.drive;

import android.Manifest;
import android.content.pm.PackageManager;

import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.CarToast;
import androidx.car.app.Screen;
import androidx.car.app.model.Action;
import androidx.car.app.model.ItemList;
import androidx.car.app.model.ListTemplate;
import androidx.car.app.model.MessageTemplate;
import androidx.car.app.model.Row;
import androidx.car.app.model.Template;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;

import java.util.Collections;
import java.util.List;

import ws.three.app.R;

/**
 * The car screen: four controls and what the agent is doing right now.
 *
 * They are the same four the /drive page shows and the same four CarPlay shows,
 * in the same order, because a driver who learns one has learned all three. Four
 * is not an arbitrary number either: it is the ceiling CarPlay's voice template
 * puts on action buttons, and designing every surface to the tightest one keeps
 * them honest.
 *
 * A row with no click listener is how "not available yet" is expressed. Repeat
 * before the agent has said anything is not a button that does nothing; it is a
 * line of text explaining itself.
 */
public final class DriveScreen extends Screen implements DriveLink.Listener, DefaultLifecycleObserver {

    private boolean askedForMicrophone;

    DriveScreen(@NonNull CarContext carContext) {
        super(carContext);
        getLifecycle().addObserver(this);
    }

    // -- lifecycle -------------------------------------------------------------

    @Override
    public void onCreate(@NonNull LifecycleOwner owner) {
        DriveLink.get().setListener(this);
    }

    @Override
    public void onStart(@NonNull LifecycleOwner owner) {
        if (hasMicrophone()) startLoop();
    }

    @Override
    public void onDestroy(@NonNull LifecycleOwner owner) {
        DriveLink.get().setListener(null);
        DriveWebService.stop(getCarContext());
    }

    @Override
    public void onDriveChanged() {
        invalidate();
    }

    // -- template --------------------------------------------------------------

    @Override
    @NonNull
    public Template onGetTemplate() {
        if (!hasMicrophone()) return microphoneTemplate();

        DriveLink link = DriveLink.get();
        ItemList.Builder items = new ItemList.Builder();
        for (DriveLink.Action action : controls()) {
            Row.Builder row = new Row.Builder().setTitle(action.label);
            String detail = detailFor(action.id);
            if (detail != null) row.addText(detail);
            if (action.enabled) {
                final String id = action.id;
                row.setOnClickListener(() -> perform(id));
            }
            items.addItem(row.build());
        }

        String title = link.agentName() == null
                ? getCarContext().getString(R.string.drive_car_title)
                : link.agentName();

        return new ListTemplate.Builder()
                .setSingleList(items.build())
                .setTitle(title)
                .setHeaderAction(Action.APP_ICON)
                .build();
    }

    /**
     * What the page published, or the resting set until it has published
     * anything. An empty car screen while the loop boots would read as broken.
     */
    private List<DriveLink.Action> controls() {
        List<DriveLink.Action> published = DriveLink.get().actions();
        if (!published.isEmpty()) return published;
        CarContext context = getCarContext();
        return Collections.unmodifiableList(java.util.Arrays.asList(
                new DriveLink.Action("talk", context.getString(R.string.drive_action_talk), true),
                new DriveLink.Action("hands", context.getString(R.string.drive_action_hands), true),
                new DriveLink.Action("repeat", context.getString(R.string.drive_action_repeat), false),
                new DriveLink.Action("hush", context.getString(R.string.drive_action_hush), false)));
    }

    /** One short line per row. A driver reads at most this much. */
    private String detailFor(String id) {
        DriveLink link = DriveLink.get();
        CarContext context = getCarContext();
        if (link.lastError() != null && "talk".equals(id)) return link.lastError();
        switch (id) {
            case "talk":
                return "listening".equals(link.state())
                        ? context.getString(R.string.drive_detail_listening)
                        : context.getString(R.string.drive_detail_ask);
            case "hands":
                return context.getString(R.string.drive_detail_hands);
            case "repeat":
                return link.lastSpoken() != null
                        ? link.lastSpoken()
                        : context.getString(R.string.drive_detail_nothing_said);
            case "hush":
                return "speaking".equals(link.state())
                        ? context.getString(R.string.drive_detail_stop_talking)
                        : null;
            default:
                return null;
        }
    }

    private void perform(String id) {
        DriveLink link = DriveLink.get();
        if ("talk".equals(id)) {
            link.send("listening".equals(link.state()) ? "talk-stop" : "talk-start");
            return;
        }
        link.send(id);
    }

    // -- microphone ------------------------------------------------------------

    private boolean hasMicrophone() {
        return getCarContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Voice is the entire product here, so a missing microphone is a screen of
     * its own rather than a silent failure. CarContext.requestPermissions puts
     * the system prompt on the phone and tells the driver to look at it, which is
     * the only place Android will ever show it.
     */
    private Template microphoneTemplate() {
        CarContext context = getCarContext();
        return new MessageTemplate.Builder(context.getString(R.string.drive_mic_needed))
                .setTitle(context.getString(R.string.drive_car_title))
                .setHeaderAction(Action.APP_ICON)
                .addAction(new Action.Builder()
                        .setTitle(context.getString(R.string.drive_mic_grant))
                        .setOnClickListener(this::requestMicrophone)
                        .build())
                .build();
    }

    private void requestMicrophone() {
        askedForMicrophone = true;
        getCarContext().requestPermissions(
                Collections.singletonList(Manifest.permission.RECORD_AUDIO),
                (granted, rejected) -> {
                    if (granted.contains(Manifest.permission.RECORD_AUDIO)) {
                        startLoop();
                    } else if (askedForMicrophone) {
                        CarToast.makeText(
                                getCarContext(),
                                R.string.drive_mic_denied,
                                CarToast.LENGTH_LONG).show();
                    }
                    invalidate();
                });
    }

    private void startLoop() {
        DriveWebService.start(getCarContext());
        // Voice first: the driver opened an assistant, so it starts listening
        // rather than waiting to be told twice.
        DriveLink.get().send("talk-start");
    }
}
