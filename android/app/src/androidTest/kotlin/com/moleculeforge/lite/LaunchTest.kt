package com.moleculeforge.lite

import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Launches the app with no network access and checks that the bundled web app loads, the
 * WebAssembly engine starts in its worker, and a template can be drawn and validated.
 *
 * The page is read and driven through the WebView's own evaluateJavascript rather than
 * Espresso-Web, which waits for the window to have input focus: on CI emulators a lock screen or a
 * system dialog can hold focus for the whole run although the app works.
 */
@RunWith(AndroidJUnit4::class)
class LaunchTest {
    @get:Rule
    val activity = ActivityScenarioRule(MainActivity::class.java)

    /** Runs JavaScript in the app's page and returns its JSON-encoded result. */
    private fun js(script: String): String {
        val done = CountDownLatch(1)
        val result = AtomicReference("null")
        activity.scenario.onActivity { app ->
            app.evaluateForTest(script) { value ->
                result.set(value)
                done.countDown()
            }
        }
        check(done.await(15, TimeUnit.SECONDS)) { "the page did not answer within 15 s" }
        return result.get()
    }

    private fun text(testId: String): String =
        js("(function () { var e = document.querySelector(\"[data-testid='$testId']\"); return e ? e.textContent : ''; })()")

    private fun pageState(): String = runCatching {
        js(
            "JSON.stringify({href: location.href, ready: document.readyState," +
                " status: (document.querySelector(\"[data-testid='engine-status']\") || {}).textContent," +
                " detail: (document.querySelector(\"[data-testid='engine-status']\") || {}).title," +
                " text: document.body ? document.body.innerText.slice(0, 400) : null})",
        )
    }.getOrElse { "unavailable ($it)" }

    /** Waits for [condition]; a failure says what the page was showing. An engine error fails at once. */
    private fun waitFor(what: String, timeoutMs: Long = 120_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            if (text("engine-status").contains("error", ignoreCase = true)) throw AssertionError("The engine reported an error while waiting for $what. Page: ${pageState()}")
            if (System.currentTimeMillis() > deadline) throw AssertionError("Timed out waiting for $what. Page: ${pageState()}")
            Thread.sleep(500)
        }
    }

    @Test
    fun engineStartsAndValidatesADrawing() {
        waitFor("the app page") { js("location.href.indexOf('/assets/index.html') >= 0") == "true" }
        waitFor("the engine") { text("engine-status").contains("runs on this device") }
        js("document.querySelector(\"[data-testid='template-benzene']\").click()")
        waitFor("the drawn template", 30_000) { text("phone-formula").contains("C6H6") }
    }
}
