#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (from android/): the instrumented test, then a
# screenshot of the release build. The device log is saved whatever happens, so the workflow can
# report why a run failed (scripts/android_ci_report.py turns it into annotations).
set -u
adb logcat -c || true
status=0
./gradlew --no-daemon :app:connectedDebugAndroidTest || status=$?
adb logcat -d > ../android-logcat.txt 2>/dev/null || true
if [ "$status" -ne 0 ]; then
  adb exec-out screencap -p > ../android-failure.png 2>/dev/null || true
  exit "$status"
fi
adb uninstall com.moleculeforge.lite || true
adb install app/build/outputs/apk/release/app-release.apk
adb logcat -c || true
adb shell am start -W -n com.moleculeforge.lite/.MainActivity
sleep 25
adb exec-out screencap -p > ../android-screenshot.png
adb logcat -d > ../android-release-logcat.txt 2>/dev/null || true
