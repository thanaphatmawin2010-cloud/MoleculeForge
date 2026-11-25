#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (from android/): the instrumented test, then a
# screenshot of the release build. The device log is saved whatever happens, so the workflow can
# report why a run failed (scripts/android_ci_report.py turns it into annotations).
set -u
# A fresh emulator can sit behind its lock screen, fall asleep, or show a system dialog.
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
adb shell svc power stayon true || true
adb shell settings put system screen_off_timeout 1800000 || true
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS || true
adb logcat -c || true
status=0
./gradlew --no-daemon :app:connectedDebugAndroidTest || status=$?
adb logcat -d > ../android-logcat.txt 2>/dev/null || true
if [ "$status" -ne 0 ]; then
  adb shell dumpsys window | grep -E "mCurrentFocus|mFocusedApp|mFocusedWindow" | sed 's/^/WindowFocus: /' >> ../android-logcat.txt || true
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
