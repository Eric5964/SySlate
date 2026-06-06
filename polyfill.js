import { NativeModules } from 'react-native';
if (NativeModules.RNScreens) {
    NativeModules.RNScreens.compatibilityFlags =
        NativeModules.RNScreens.compatibilityFlags || {};
}