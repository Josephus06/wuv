# WVI Time Clock

A small Android app for employees: sign in with their WVI account, then **Time In** and
**Time Out**. Nothing else from the ERP is in it.

It uses the same server as the ERP (`https://wuventure.graphicstar.ph`) and the same
attendance records: a stamp made here shows on the ERP's My Attendance and HR → Attendance
pages, and the other way round. The server takes the time, not the phone, so changing the
phone's clock changes nothing.

An employee can use it once HR has set the **Employee** on their user account (Users &
Permissions). Shifts come from HR → Shift Assignments.

## Build the APK

Needs Android Studio installed (for the Android SDK and its bundled Java).

```bash
cd timeclock
npm install
npm run build
npx cap sync android
cd android
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. Bump `versionCode` and
`versionName` in `android/app/build.gradle` for each new release so phones accept it as an update.

**Gradle stays on 9.5.x.** Android Gradle Plugin 8.13 uses an internal Gradle API that was
removed in 9.6, so 9.6+ fails with "relies on org.gradle.api.problems.internal.InternalProblems";
Gradle 8.x cannot run on Android Studio's Java 25. 9.5 is the version that works with both.

To point a build at a different server (e.g. a local test API), set it before `npm run build`:

```bash
VITE_API_BASE=http://192.168.1.10:4000 npm run build
```

## Installing on phones

This is a debug-signed APK, for installing directly (Android asks to allow installs from
the source you open it with -- Files, Messenger, Drive...). Updates must be built on the same
PC, since a phone only accepts an update signed with the same key. For the Play Store a
release keystore is needed instead.
