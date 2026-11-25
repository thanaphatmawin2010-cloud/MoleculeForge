package com.moleculeforge.lite

import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.model.Atom
import androidx.test.espresso.web.model.Atoms.castOrDie
import androidx.test.espresso.web.model.Atoms.getCurrentUrl
import androidx.test.espresso.web.model.Atoms.script
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.hamcrest.Matchers.containsString
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Launches the app with no network access and checks that the bundled web app loads, the
 * WebAssembly engine starts in its worker, and a template can be drawn and validated.
 */
@RunWith(AndroidJUnit4::class)
class LaunchTest {
    @get:Rule
    val activity = ActivityScenarioRule(MainActivity::class.java)

    private fun eventually(timeoutMs: Long = 120_000, check: () -> Unit) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            try {
                check()
                return
            } catch (e: Throwable) {
                if (System.currentTimeMillis() > deadline) throw e
                Thread.sleep(500)
            }
        }
    }

    // The DOM is read and clicked directly: on a phone the status label is for screen readers only
    // and the template button may be scrolled out of the toolbar, which WebDriver's visible-text
    // and click atoms would treat as missing.
    private fun textOf(testId: String): Atom<String> =
        script("var e = document.querySelector(\"[data-testid='$testId']\"); return e ? e.textContent : '';", castOrDie(String::class.java))

    private fun click(testId: String): Atom<Boolean> =
        script("document.querySelector(\"[data-testid='$testId']\").click(); return true;", castOrDie(Boolean::class.javaObjectType))

    @Test
    fun engineStartsAndValidatesADrawing() {
        eventually { onWebView().check(webMatches(getCurrentUrl(), containsString(MainActivity.START_URL))) }
        eventually { onWebView().check(webMatches(textOf("engine-status"), containsString("runs on this device"))) }
        onWebView().perform(click("template-benzene"))
        eventually(30_000) { onWebView().check(webMatches(textOf("phone-formula"), containsString("C6H6"))) }
    }
}
