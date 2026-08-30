# Milestone 1 — Integration & Test Steps

## 1. Add files to the Xcode project
- `AudioEngine.swift` and `AudioEngine.m` go in `ios/SySlate/` (next to
  `AppDelegate.swift`/`.mm`), then **drag them into the SySlate group in
  Xcode's Project Navigator** (File → Add Files won't set up target
  membership correctly on its own — dragging in and checking "SySlate" as
  the target does).
- `AudioEngine.js` goes wherever you want it in `src/` — I'd suggest
  `src/native/AudioEngine.js` — no Xcode step needed, it's pure JS.
- Adding the first Swift file to an Xcode project normally prompts
  "Would you like to configure an Objective-C bridging header?" — say
  **No**, since `SySlate-Bridging-Header.h` already exists. Xcode
  auto-generates `SySlate-Swift.h` behind the scenes to expose this Swift
  class to the existing Objective-C bridge; you don't need to touch the
  bridging header for this.

## 2. Confirm Info.plist background mode
RNTP requires `UIBackgroundModes` → `audio` to keep playing while
backgrounded — check that's already present (it should be, since
background playback already works today) and don't remove it.

## 3. Smoke test (before touching PlaybackContext.js at all)
Don't wire this into the real app yet. From anywhere convenient (a
temporary button on `SettingsScreen.js`, or the debugger console), run:

```js
import AudioEngine from '../native/AudioEngine';

await AudioEngine.setupPlayer({});
await AudioEngine.add([{ id: '1', url: 'file:///path/to/a/real/song.mp3', title: 'Test' }]);
await AudioEngine.play();
```

What to check:
- Sound actually comes out.
- Lock screen shows title "Test" and play/pause/next/previous controls
  respond.
- Backgrounding the app (press home / lock screen) keeps it playing.
- `AudioEngine.addEventListener('PlaybackProgressUpdated', console.log)`
  fires roughly once a second while playing.
- Pausing from the lock screen updates in-app state too (fire
  `getState()` after tapping lock-screen pause and confirm it reports
  `paused`).

If all of that holds, Milestone 1 is real and it's safe to move on to
actually wiring `PlaybackContext.js`/`PlaybackService.js` to import this
instead of `react-native-track-player`. If something's off, tell me what
you saw (which check failed, any Xcode console output) rather than just
"it didn't work" — the failure mode tells me which part of the graph to
look at first.

## Known gaps in this pass (expected, not bugs)
- `capabilities`/`compactCapabilities` from `updateOptions` are accepted
  but not yet selectively enforced — all five remote commands are always
  registered. Only matters if you ever want fewer than all five.
- Ramps are untouched — `PlaybackService.js`'s existing JS step-loop
  keeps working once pointed at this module's `setVolume`/`getVolume`,
  same as it works against RNTP today. Real audio-thread ramps are
  Milestone 3.
- EQ does nothing yet (Milestone 2) — no `AVAudioUnitEQ` node in the
  graph at all in this pass.
- Not tested against every format in your library — I'd try a couple of
  your trickier files (anything that's given you format trouble before)
  once basic playback is confirmed, not just one clean MP3.

## Changes since this was first delivered
Found and fixed while reviewing for bugs, before any smoke test happened:
- **`getCurrentTrack`, `skip`, `remove`, `updateMetadataForTrack` were all
  id-based, not index-based.** RNTP's real versions of all four take a
  queue INDEX, and every existing call site in
  `PlaybackContext.js`/`PlaybackService.js` already passes one (e.g.
  `TrackPlayer.skip(realIndex)`, `TrackPlayer.updateMetadataForTrack(idx,
  ...)`, arithmetic like `currentIndex + 1` on `getCurrentTrack()`'s
  result). Left as id-based, this would have silently broken nearly all of
  `PlaybackContext.js`'s queue/priority math the moment it got wired in —
  not a small thing to catch after the fact. Id-based matching was also
  independently wrong on its own terms: this app deliberately allows the
  same song to appear more than once in the queue (priority-queue design),
  and `firstIndex(where:)` can only ever resolve to one of them. All four
  now take/return indices, matching RNTP exactly.
- **Position after seeking was wrong.** `AVAudioPlayerNode`'s `playerTime`
  resets to 0 relative to whatever segment is currently scheduled — it
  doesn't know about `scheduleSegment`'s `startingFrame` offset. Without
  adding that back in, seeking to (say) 1:30 into a song would make the
  reported position/progress bar snap back to 0:00 and count up from
  there, while the audio correctly played from 1:30. Fixed by tracking the
  segment's start offset and adding it back into
  `currentPositionSeconds()`.
- **Missing thread confinement.** JS-bridge method calls ran on RN's
  default background method queue while `MPRemoteCommandCenter`/
  notification callbacks ran on the main thread — `queue`/`currentIndex`
  had no synchronization between the two. Added a `methodQueue` override
  so everything touching that state runs on the main thread.

## Lower-confidence, not changed
`Track.init?`'s URL fallback (`URL(string:) ?? URL(fileURLWithPath:)`) —
if a `file://...` string ever fails `URL(string:)` (e.g. an unencoded
space) the fallback passes that same "file://..." string straight into
`URL(fileURLWithPath:)`, which would treat "file:" as a literal path
component rather than stripping it, producing a wrong path. Not changed
because it depends on whether `files.js`'s `encodeFileUrl` already
percent-encodes everything it needs to (if so this branch never runs in
practice) — worth a look if a file with unusual characters in its name
ever fails to load.
