package com.moleculeforge.lite

import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.model.Atoms.getCurrentUrl
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
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

    private fun byTestId(id: String) = findElement(Locator.CSS_SELECTOR, "[data-testid='$id']")

    @Test
    fun engineStartsAndValidatesADrawing() {
        eventually { onWebView().check(webMatches(getCurrentUrl(), containsString(MainActivity.START_URL))) }
        eventually { onWebView().withElement(byTestId("engine-status")).check(webMatches(getText(), containsString("runs on this device"))) }
        onWebView().withElement(byTestId("template-benzene")).perform(webClick())
        eventually(30_000) { onWebView().withElement(byTestId("phone-formula")).check(webMatches(getText(), containsString("C6H6"))) }
    }
}
