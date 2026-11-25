# The app uses no reflection: the WebView bridge is a WebMessageListener lambda, not a
# @JavascriptInterface object, so R8's defaults need no extra keep rules.
