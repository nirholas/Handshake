# android-overlay: native sources for the three.ws Android app

The Android app (`ws.three.app`) is a Trusted Web Activity that Bubblewrap regenerates from
[`../twa/twa-manifest.json`](../twa/twa-manifest.json) on every build. Bubblewrap owns that
generated project completely, so anything native lives here and is laid over the generated
tree after `bubblewrap update` and before `bubblewrap build`. [`../scripts/build-apk.sh`](../scripts/build-apk.sh)
runs [`../scripts/apply-overlay.mjs`](../scripts/apply-overlay.mjs) in exactly that slot, and
fails the build if this directory is missing.

## What is in it

The home screen widget ("Agent glance"): the owner's agent as a card, one live number, and a
tap that opens the app on that agent. Product docs: [`docs/native-widgets.md`](../../docs/native-widgets.md).

| File | Role |
| --- | --- |
| `app/src/main/java/ws/three/app/glance/GlanceWidget.java` | The `AppWidgetProvider`: picks the card size from the cells, paints the cached bitmap, wires the taps, schedules the refresh. |
| `.../GlanceRefreshWorker.java` | The WorkManager job: fetches `GET /api/glance/mine?format=png` per size in use, writes each bitmap atomically, repaints. Failure keeps the last card. |
| `.../GlanceApi.java` | The one HTTP call, with the widget token as a bearer and the card's facts read from response headers. |
| `.../GlanceStore.java` | Token, cached bitmaps, tap target and timestamp. |
| `.../GlanceLinkActivity.java` | Handles `threews://glance/link?token=…` from the `/glance` page, stores the token, offers to pin the widget. |
| `app/src/main/res/layout/glance_widget_{small,wide}.xml` | RemoteViews layouts for 2x2 and 4x2 / 4x3. |
| `app/src/main/res/xml/glance_widget_info.xml` | Widget metadata: sizes, resize modes, no AppWidget alarm (`updatePeriodMillis=0`, WorkManager refreshes). |
| `app/src/main/res/values/glance.xml`, `res/drawable/glance_*.xml` | Strings, colors, the rounded card background, the action chip. |
| `AndroidManifest.permissions.xml` | Spliced after the `<manifest>` tag: `INTERNET`, `ACCESS_NETWORK_STATE`. |
| `AndroidManifest.application.xml` | Spliced before `</application>`: the widget receiver and the link activity. |
| `build.gradle.fragment` | Appended to `app/build.gradle`: `androidx.work:work-runtime`. |

## Rules

- Every file name and resource id starts with `glance`, so the overlay can never collide with a
  Bubblewrap-generated file. `apply-overlay.mjs` refuses to overwrite anything it does not own.
- Java 8 source level (that is what the generated project compiles at). No Kotlin, no Compose.
- The widget never renders WebGL or HTML. It shows the PNG the server renders and nothing else.
- Applying the overlay by hand, for a debug build:

```bash
cd solana-mobile/build
npx --no-install @bubblewrap/cli update --skipVersionUpgrade
node ../scripts/apply-overlay.mjs --project . --overlay ../android-overlay
JAVA_HOME=~/.bubblewrap/jdk/jdk-17.0.20.1+1 ./gradlew assembleDebug
```
