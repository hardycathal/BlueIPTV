const { withAppBuildGradle, withGradleProperties, withAndroidManifest } = require('@expo/config-plugins');
const generateCode = require('@expo/config-plugins/build/utils/generateCode');

function vlcGradleTaskPatch() {
  return `tasks.whenTaskAdded((task -> {
    if (task.name.contains("merge") && task.name.contains("NativeLibs")) {
        tasks.named(task.name) { mergeTask ->
            doFirst {
                def reactNativeLibs = mergeTask.externalLibNativeLibs
                        .getFiles()
                        .stream()
                        .filter(file -> file.toString().contains("jetified-react-android"))
                        .findAny()
                        .orElse(null)

                if (reactNativeLibs != null) {
                    java.nio.file.Files.walk(reactNativeLibs.toPath()).forEach(file -> {
                        if (file.toString().contains("libc++_shared.so")) {
                            java.nio.file.Files.delete(file)
                        }
                    })
                }
            }
        }
    }
}))`;
}

module.exports = function withVlcMediaPlayer(config) {
  // IPTV providers are almost always plain http:// — allow cleartext traffic,
  // which Android blocks by default since API 28.
  // Also register the Google Cast options provider (react-native-google-cast);
  // this replaces @config-plugins/react-native-google-cast, which is pinned
  // to Expo 51 and conflicts with SDK 54.
  config = withAndroidManifest(config, (modConfig) => {
    const app = modConfig.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:usesCleartextTraffic'] = 'true';

      // Allow the main activity to enter picture-in-picture (used by the
      // in-player PiP button via the local `modules/pip` native module).
      const mainActivity = (app.activity || []).find(
        (a) => a.$?.['android:name'] === '.MainActivity'
      );
      if (mainActivity) {
        mainActivity.$['android:supportsPictureInPicture'] = 'true';
        // PiP windows are freely resized by the system; without this some
        // OEM ROMs tear the task down instead of shrinking it.
        mainActivity.$['android:resizeableActivity'] = 'true';
        // Android requires these config changes to be handled by the activity,
        // otherwise it is recreated when entering PiP.
        const needed = ['screenSize', 'smallestScreenSize', 'screenLayout', 'orientation'];
        const current = (mainActivity.$['android:configChanges'] || '').split('|').filter(Boolean);
        for (const n of needed) if (!current.includes(n)) current.push(n);
        mainActivity.$['android:configChanges'] = current.join('|');
      }

      app['meta-data'] = app['meta-data'] || [];
      const CAST_KEY = 'com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME';
      if (!app['meta-data'].some((m) => m.$?.['android:name'] === CAST_KEY)) {
        app['meta-data'].push({
          $: {
            'android:name': CAST_KEY,
            'android:value': 'com.reactnative.googlecast.GoogleCastOptionsProvider',
          },
        });
      }
    }
    return modConfig;
  });

  config = withGradleProperties(config, (modConfig) => {
    const properties = modConfig.modResults.filter((item) => item.key !== 'android.minSdkVersion');
    properties.push({ type: 'property', key: 'android.minSdkVersion', value: '26' });
    modConfig.modResults = properties;
    return modConfig;
  });

  return withAppBuildGradle(config, (modConfig) => {
    const result = generateCode.mergeContents({
      tag: 'withVlcMediaPlayer',
      src: modConfig.modResults.contents,
      newSrc: vlcGradleTaskPatch(),
      anchor: /dependencies\s*\{/,
      offset: 0,
      comment: '//',
    });

    modConfig.modResults.contents = result.contents;
    return modConfig;
  });
};
