package ws.three.app.drive;

import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.car.app.Screen;
import androidx.car.app.Session;

/** One connection to the car. Owns nothing but the screen it opens. */
public final class DriveSession extends Session {

    @Override
    @NonNull
    public Screen onCreateScreen(@NonNull Intent intent) {
        return new DriveScreen(getCarContext());
    }
}
