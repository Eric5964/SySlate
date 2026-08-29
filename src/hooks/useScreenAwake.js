import { useEffect } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

// Requires the expo-keep-awake package — not currently in package.json, run
// `npx expo install expo-keep-awake` (picks the version matched to this
// Expo SDK) then a native rebuild (pod install), same as any other native
// dependency addition.
const TAG = 'syslate-playback';

// Tied to isPlaying specifically, not just "the app is open" — the setting
// is about not having the screen lock mid-song, not about burning battery
// the whole time the app happens to be in front, including while paused or
// sitting on a menu.
export function useScreenAwake(shouldStayAwake) {
    useEffect(() => {
        if (!shouldStayAwake) return;
        activateKeepAwakeAsync(TAG).catch(() => { });
        return () => { try { deactivateKeepAwake(TAG); } catch { } };
    }, [shouldStayAwake]);
}
