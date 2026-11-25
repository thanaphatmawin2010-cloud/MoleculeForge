package com.moleculeforge.lite

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * MoleculeForge Lite for Android: the web trial's build, bundled in the APK and served to a WebView
 * from https://appassets.androidplatform.net/assets/ by WebViewAssetLoader. The app holds no
 * INTERNET permission, so the chemistry engine (WebAssembly in a Web Worker) runs entirely on the
 * device. Links to other sites open in the browser; files open through the system picker and are
 * saved through "Save as" (a message channel limited to the app's own origin).
 */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private var webViewDestroyed = false
    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: PendingSave? = null

    private class PendingSave(val requestId: String, val bytes: ByteArray, val reply: JavaScriptReplyProxy)

    private val openDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        chooserCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        chooserCallback = null
    }

    private val createDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val save = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        val uri = result.data?.data
        val saved = result.resultCode == RESULT_OK && uri != null && runCatching {
            contentResolver.openOutputStream(uri, "wt")?.use { it.write(save.bytes) } != null
        }.getOrDefault(false)
        reply(save.reply, save.requestId, saved)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportMultipleWindows(false)
            setBackgroundColor(getColor(R.color.background))
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == APP_HOST) return false
                    openExternally(request.url)
                    return true
                }

                // The page's renderer crashed or was reclaimed for memory: start again with a fresh WebView.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()
                    webViewDestroyed = true
                    recreate()
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    chooserCallback?.onReceiveValue(null)
                    chooserCallback = callback
                    return try {
                        openDocument.launch(params.createIntent())
                        true
                    } catch (_: ActivityNotFoundException) {
                        chooserCallback = null
                        false
                    }
                }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, BRIDGE, setOf(APP_ORIGIN)) { _, message, _, _, reply ->
                onBridgeMessage(message.data, reply)
            }
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.background))
            addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        // Keep the page clear of the status bar, navigation bar, display cutout and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.updatePadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
        webView.loadUrl(START_URL)
    }

    override fun onDestroy() {
        if (!webViewDestroyed) webView.destroy()
        super.onDestroy()
    }

    /** `{type: "save", requestId, name, base64}` from ui/src/lib/files.ts: ask where to save, then write. */
    private fun onBridgeMessage(data: String?, reply: JavaScriptReplyProxy) {
        val message = runCatching { JSONObject(data.orEmpty()) }.getOrNull() ?: return
        if (message.optString("type") != "save") return
        val requestId = message.optString("requestId")
        val name = message.optString("name").ifBlank { "molecule.txt" }.replace(UNSAFE_NAME, "_").take(120)
        val bytes = runCatching { Base64.decode(message.optString("base64"), Base64.DEFAULT) }.getOrNull()
        if (bytes == null || bytes.size > MAX_SAVE_BYTES || pendingSave != null) {
            reply(reply, requestId, false)
            return
        }
        pendingSave = PendingSave(requestId, bytes, reply)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mimeFor(name))
            .putExtra(Intent.EXTRA_TITLE, name)
        try {
            createDocument.launch(intent)
        } catch (_: ActivityNotFoundException) {
            pendingSave = null
            reply(reply, requestId, false)
        }
    }

    // A reply proxy exists only when WEB_MESSAGE_LISTENER is supported (checked before the listener is added).
    @SuppressLint("RequiresFeature")
    private fun reply(proxy: JavaScriptReplyProxy, requestId: String, saved: Boolean) {
        proxy.postMessage(JSONObject().put("type", "saved").put("requestId", requestId).put("saved", saved).toString())
    }

    private fun openExternally(uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // No browser installed: nothing to open the link with.
        }
    }

    companion object {
        const val APP_HOST = "appassets.androidplatform.net"
        const val APP_ORIGIN = "https://$APP_HOST"
        const val START_URL = "$APP_ORIGIN/assets/index.html"
        private const val BRIDGE = "MoleculeForgeAndroid"
        private const val MAX_SAVE_BYTES = 64 * 1024 * 1024
        private val UNSAFE_NAME = Regex("""[\\/:*?"<>|\u0000-\u001f]""")

        /** Chemistry formats are saved as generic files so document providers keep their extensions. */
        fun mimeFor(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "json" -> "application/json"
            "csv" -> "text/csv"
            "pdf" -> "application/pdf"
            "png" -> "image/png"
            else -> "application/octet-stream"
        }
    }
}
