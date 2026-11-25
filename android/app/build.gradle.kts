/**
 * MoleculeForge Lite for Android. The app is a WebView around the web trial's production build
 * (`pnpm --dir ui build:lite` → ui/dist-lite), packaged as the APK's assets: no network at all.
 *
 * Release signing reads a keystore from the environment (CI passes the repository's secrets):
 * MF_ANDROID_KEYSTORE (path), MF_ANDROID_KEYSTORE_PASSWORD, MF_ANDROID_KEY_ALIAS, MF_ANDROID_KEY_PASSWORD.
 * Versions come from MF_VERSION_NAME / MF_VERSION_CODE (the release tag), defaulting to 1.0.0 / 1.
 */
plugins {
    id("com.android.application")
}

val webBuild = rootProject.layout.projectDirectory.dir("../ui/dist-lite")
val keystorePath = providers.environmentVariable("MF_ANDROID_KEYSTORE").orNull?.takeIf { it.isNotBlank() }

android {
    namespace = "com.moleculeforge.lite"
    // AndroidX core 1.19 needs the Android 17 SDK to compile; the app still targets Android 16's behaviour.
    compileSdk = 37

    defaultConfig {
        applicationId = "com.moleculeforge.lite"
        minSdk = 26
        targetSdk = 36
        versionName = providers.environmentVariable("MF_VERSION_NAME").getOrElse("1.0.0")
        versionCode = providers.environmentVariable("MF_VERSION_CODE").map(String::toInt).getOrElse(1)
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = providers.environmentVariable("MF_ANDROID_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("MF_ANDROID_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("MF_ANDROID_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // Android 16 (API 36) is the target Google Play requires; Android 17's behaviour changes are
        // adopted once the app has been tested against them.
        disable += "OldTargetApi"
        warningsAsErrors = true
        abortOnError = true
    }
}

// The web app is the APK's assets (served from https://appassets.androidplatform.net/assets/).
androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addStaticSourceDirectory(webBuild.asFile.path)
    }
}

val checkWebBuild = tasks.register("checkWebBuild") {
    val index = webBuild.file("index.html").asFile
    doLast {
        check(index.exists()) { "Build the web app first: pnpm --dir ui build:lite (expected ${index.path})" }
    }
}
tasks.named("preBuild") { dependsOn(checkWebBuild) }

// Every dependency of the app and its tests is pinned in gradle.lockfile, which CI's OSV-Scanner
// audits. Android Lint's own classpath (androidLintTool) is build tooling like the compiler: it runs
// on the build machine against this source and never enters the APK, so it is not locked.
dependencyLocking {
    lockAllConfigurations()
}
configurations.matching { it.name == "androidLintTool" }.configureEach {
    resolutionStrategy.deactivateDependencyLocking()
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.webkit:webkit:1.18.0")

    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
