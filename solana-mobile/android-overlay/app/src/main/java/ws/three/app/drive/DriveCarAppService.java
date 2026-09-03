package ws.three.app.drive;

import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Session;
import androidx.car.app.validation.HostValidator;

/**
 * three.ws Drive on the Android Auto screen.
 *
 * The declared category is {@code androidx.car.app.category.IOT}: "take relevant
 * actions on connected devices from within the car". That is literally what this
 * is. A three.ws agent already reaches a real house through the home tools wired
 * into /api/chat, with a safety gate that freezes anything physical until a
 * person approves it, so "turn the porch light on" from the car is the product
 * and not a stretch of the category.
 *
 * There is no conversational category on Android the way iOS 26.4 added one for
 * CarPlay, and there is no drawing surface outside navigation. So this screen is
 * four controls, the conversation lives in DriveWebService's web view, and the
 * two are joined by DriveLink.
 *
 * @see ws.three.app.drive.DriveScreen
 */
public final class DriveCarAppService extends CarAppService {

    @Override
    @NonNull
    public HostValidator createHostValidator() {
        // The library's own allowlist of signed Android Auto / Automotive hosts.
        // ALLOW_ALL_HOSTS_VALIDATOR exists and is a debug convenience; shipping it
        // would let any app on the device drive the car screen as us.
        return new HostValidator.Builder(getApplicationContext())
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build();
    }

    @Override
    @NonNull
    public Session onCreateSession() {
        return new DriveSession();
    }
}
