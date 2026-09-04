import Foundation
import AVFoundation
import MediaPlayer

// MARK: - Track model
//
// Field names assumed to match what PlaybackContext.js already passes
// around for a song (id/url/title/artist/album/artwork/duration). Check
// this against the real shape before wiring PlaybackContext.js up to this
// module — if the app uses different keys, only this struct's `init?`
// needs to change, nothing else in the file cares.
struct Track {
    let id: String
    let url: URL
    var title: String?
    var artist: String?
    var album: String?
    var artwork: String?   // local file uri, expected already-resolved (embeddedArt.js / coverColor.js already produce these upstream)
    var duration: Double?  // seconds, may be nil until we've loaded the file

    init?(dict: NSDictionary) {
        guard let idVal = dict["id"] as? String,
              let urlString = dict["url"] as? String,
              let url = URL(string: urlString) ?? URL(fileURLWithPath: urlString) as URL? else {
            return nil
        }
        self.id = idVal
        self.url = url
        self.title = dict["title"] as? String
        self.artist = dict["artist"] as? String
        self.album = dict["album"] as? String
        self.artwork = dict["artwork"] as? String
        self.duration = dict["duration"] as? Double
    }

    func toDict() -> [String: Any] {
        return [
            "id": id,
            "url": url.absoluteString,
            "title": title as Any,
            "artist": artist as Any,
            "album": album as Any,
            "artwork": artwork as Any,
            "duration": duration as Any,
        ]
    }
}

// MARK: - Repeat mode (matches RNTP's RepeatMode.Off / .Track / .Queue)
enum RepeatModeValue: Int {
    case off = 0
    case track = 1
    case queue = 2
}

// MARK: - Playback state (matches RNTP's State enum values loosely — JS side keys off these strings, not raw ints, on purpose so this is easier to eyeball in logs)
enum PlaybackStateValue: String {
    case none = "none"
    case ready = "ready"
    case playing = "playing"
    case paused = "paused"
    case stopped = "stopped"
    case buffering = "buffering"
    case ended = "ended"
}

@objc(AudioEngine)
class AudioEngine: RCTEventEmitter {

    // MARK: - Engine graph
    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private var currentFile: AVAudioFile?
    private var currentFileSampleRate: Double = 44100

    // MARK: - Queue state
    private var queue: [Track] = []
    private var currentIndex: Int? = nil
    private var repeatMode: RepeatModeValue = .off
    private var state: PlaybackStateValue = .none
    private var volume: Float = 1.0

    // Guards the specific race RNTP's own completion callback used to hit:
    // scheduleFile's completion handler firing after we've already moved
    // on (skip/seek/stop called while a completion callback was in flight).
    // Every scheduleFile call gets a token; a stale token's completion is
    // ignored instead of acting on outdated state.
    private var playbackToken: UInt64 = 0

    private var progressTimer: Timer?
    private var progressIntervalSeconds: Double = 1.0

    // Seconds into the file where the CURRENTLY scheduled segment begins —
    // 0 for a normal track start, non-zero after a seek. AVAudioPlayerNode's
    // own playerTime resets to 0 relative to whatever segment is currently
    // scheduled (see currentPositionSeconds below), it does NOT track
    // position within the underlying file when scheduleSegment was given a
    // non-zero startingFrame. Without adding this back in, position/elapsed
    // time would appear to snap back to 0 and count up from there every
    // time you seek, while the audio itself correctly plays from the seeked
    // position — a real, easy-to-miss AVAudioEngine gotcha.
    private var segmentStartOffsetSeconds: Double = 0

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { true }

    // Without this, JS-bridge method calls (play/pause/skip/etc.) run on
    // RN's default background method queue, while MPRemoteCommandCenter
    // targets and the interruption/route-change notification handlers fire
    // on the main thread — meaning `queue`/`currentIndex`/`playerNode`
    // could be mutated from two different threads concurrently with no
    // synchronization at all (a plain Swift Array isn't safe for that).
    // requiresMainQueueSetup only affects module INIT timing, not this —
    // forcing every exposed method onto the main thread too puts all of
    // it (JS calls, remote commands, notifications, the scheduleSegment
    // completion handler, which already explicitly hops to main) on one
    // thread, which removes the race entirely rather than trying to guard
    // each mutation site individually.
    override var methodQueue: DispatchQueue! { return DispatchQueue.main }

    override func supportedEvents() -> [String]! {
        return [
            "PlaybackState",
            "PlaybackTrackChanged",
            "PlaybackProgressUpdated",
            "RemotePlay",
            "RemotePause",
            "RemoteStop",
            "RemoteNext",
            "RemotePrevious",
            // Not part of RNTP's event set — added specifically so JS can
            // run the existing ramp-based pause path on a real interruption
            // instead of this module doing a raw stop. See spec doc,
            // decision #2.
            "AudioInterruptionBegan",
            "AudioInterruptionEnded",
        ]
    }

    override init() {
        super.init()
        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: nil)
        configureAudioSession()
        configureRemoteCommandCenter()
        NotificationCenter.default.addObserver(self, selector: #selector(handleInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
    }

    // MARK: - Session

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
        } catch {
            NSLog("AudioEngine: failed to set audio session category: \(error)")
        }
    }

    private func activateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            NSLog("AudioEngine: failed to activate session: \(error)")
        }
    }

    private func deactivateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            NSLog("AudioEngine: failed to deactivate session: \(error)")
        }
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        if type == .began {
            // Deliberately NOT calling pause() here. Per decision #2,
            // interruptions should fade out using the existing "Ramp on
            // Pause" JS setting, same as a manual pause — and in Milestone
            // 1 that ramp logic still lives in PlaybackService.js. So this
            // just tells JS an interruption started; JS's existing
            // pause-with-ramp function is expected to call this module's
            // pause()/setVolume() itself, same as it does for a manual
            // pause tap.
            sendEvent(withName: "AudioInterruptionBegan", body: nil)
        } else if type == .ended {
            var shouldResume = false
            if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsValue).contains(.shouldResume)
            }
            // Deliberately not auto-resuming even when iOS suggests it's
            // safe to — most players require an explicit tap back to play.
            // Flip this if that's not what's wanted.
            sendEvent(withName: "AudioInterruptionEnded", body: ["shouldResume": shouldResume])
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let info = notification.userInfo,
              let reasonValue = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }

        if reason == .oldDeviceUnavailable {
            DispatchQueue.main.async { [weak self] in
                self?.pauseInternal()
            }
            return
        }

        // A device connecting (e.g. Bluetooth) or the route otherwise
        // reconfiguring — previously left alone entirely. AVAudioEngine
        // can come out of one of these still reporting .playing and still
        // advancing position, but no longer actually wired to the active
        // output, which plays back completely silently despite every
        // outward sign of working. Pausing and restarting the engine
        // (NOT stopping it — that would drop the player node's scheduled
        // buffer) re-establishes it against the new route.
        if reason == .newDeviceAvailable || reason == .routeConfigurationChange || reason == .categoryChange {
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.state == .playing else { return }
                self.engine.pause()
                do {
                    try self.engine.start()
                } catch {
                    NSLog("AudioEngine: failed to restart engine after route change: \(error)")
                }
            }
        }
    }

    // MARK: - Remote command center / now playing

    private func configureRemoteCommandCenter() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            self?.sendEvent(withName: "RemotePlay", body: nil)
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.sendEvent(withName: "RemotePause", body: nil)
            return .success
        }
        center.stopCommand.addTarget { [weak self] _ in
            self?.sendEvent(withName: "RemoteStop", body: nil)
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.sendEvent(withName: "RemoteNext", body: nil)
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.sendEvent(withName: "RemotePrevious", body: nil)
            return .success
        }
    }

    private func updateNowPlayingInfo() {
        guard let idx = currentIndex, idx >= 0, idx < queue.count else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let track = queue[idx]
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title ?? "",
            MPMediaItemPropertyArtist: track.artist ?? "",
            MPMediaItemPropertyAlbumTitle: track.album ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentPositionSeconds(),
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0,
        ]
        if let duration = track.duration {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let artworkPath = track.artwork, let image = UIImage(contentsOfFile: artworkPath.replacingOccurrences(of: "file://", with: "")) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // MARK: - Playback engine internals

    private func setState(_ newState: PlaybackStateValue) {
        state = newState
        sendEvent(withName: "PlaybackState", body: ["state": newState.rawValue])
        updateNowPlayingInfo()
    }

    private func currentPositionSeconds() -> Double {
        guard let nodeTime = playerNode.lastRenderTime,
              let playerTime = playerNode.playerTime(forNodeTime: nodeTime) else { return segmentStartOffsetSeconds }
        return segmentStartOffsetSeconds + Double(playerTime.sampleTime) / currentFileSampleRate
    }

    private func loadAndScheduleCurrentTrack(startAtSeconds: Double = 0, autoPlay: Bool) {
        guard let idx = currentIndex, idx >= 0, idx < queue.count else {
            setState(.stopped)
            return
        }
        let track = queue[idx]

        playbackToken &+= 1
        let token = playbackToken

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let file = try AVAudioFile(forReading: track.url)
                DispatchQueue.main.async {
                    guard let self = self, token == self.playbackToken else { return } // superseded by a newer load
                    self.finishLoadingTrack(file: file, track: track, idx: idx, startAtSeconds: startAtSeconds, autoPlay: autoPlay, token: token)
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self = self, token == self.playbackToken else { return }
                    NSLog("AudioEngine: failed to load track \(track.url): \(error)")
                    self.setState(.stopped)
                }
            }
        }
    }

    private func finishLoadingTrack(file: AVAudioFile, track: Track, idx: Int, startAtSeconds: Double, autoPlay: Bool, token: UInt64) {
        do {
            currentFile = file
            currentFileSampleRate = file.processingFormat.sampleRate
            segmentStartOffsetSeconds = startAtSeconds

            playerNode.stop()

            let startFrame = AVAudioFramePosition(startAtSeconds * currentFileSampleRate)
            let frameCount = AVAudioFrameCount(file.length - startFrame)

            if frameCount > 0 {
                playerNode.scheduleSegment(file, startingFrame: startFrame, frameCount: frameCount, at: nil) { [weak self] in
                    DispatchQueue.main.async {
                        self?.handlePlaybackCompleted(token: token)
                    }
                }
            }

            var trackWithDuration = track
            if trackWithDuration.duration == nil {
                trackWithDuration.duration = Double(file.length) / file.processingFormat.sampleRate
                if idx < queue.count { queue[idx] = trackWithDuration }
            }

            sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])

            if !engine.isRunning {
                try engine.start()
            }
            activateSession()
            playerNode.volume = volume

            if autoPlay {
                playerNode.play()
                setState(.playing)
            } else {
                setState(.ready)
            }
            startProgressTimer()
        } catch {
            NSLog("AudioEngine: failed to start engine for \(track.url): \(error)")
            setState(.stopped)
        }
    }

    // Fires when a scheduled segment finishes playing to the end on its
    // own (i.e. NOT from a manual stop/skip/seek, which all bump
    // playbackToken first specifically so this stale callback gets
    // ignored here instead of double-advancing).
    private func handlePlaybackCompleted(token: UInt64) {
        guard token == playbackToken else { return }

        if repeatMode == .track {
            // RNTP doesn't fire PlaybackTrackChanged for a same-track
            // repeat — PlaybackService.js's natural-end-of-track ramp
            // watcher depends on that exact absence to tell a real repeat
            // apart from a real track change. Preserve that: reschedule
            // silently, no PlaybackTrackChanged event here.
            loadAndScheduleCurrentTrack(startAtSeconds: 0, autoPlay: true)
            return
        }

        advance(direction: 1, wrap: repeatMode == .queue, autoPlay: true)
    }

    private func advance(direction: Int, wrap: Bool, autoPlay: Bool) {
        guard !queue.isEmpty else {
            currentIndex = nil
            setState(.stopped)
            return
        }
        guard let idx = currentIndex else {
            currentIndex = 0
            loadAndScheduleCurrentTrack(autoPlay: autoPlay)
            return
        }
        var newIndex = idx + direction
        if newIndex >= queue.count {
            newIndex = wrap ? 0 : queue.count
        } else if newIndex < 0 {
            newIndex = wrap ? queue.count - 1 : -1
        }
        if newIndex < 0 || newIndex >= queue.count {
            currentIndex = nil
            playerNode.stop()
            setState(.ended)
            return
        }
        currentIndex = newIndex
        loadAndScheduleCurrentTrack(autoPlay: autoPlay)
    }

    private func startProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = Timer.scheduledTimer(withTimeInterval: progressIntervalSeconds, repeats: true) { [weak self] _ in
            guard let self = self, self.state == .playing else { return }
            let position = self.currentPositionSeconds()
            let duration = self.currentIndex.flatMap { self.queue[safe: $0]?.duration } ?? 0
            self.sendEvent(withName: "PlaybackProgressUpdated", body: [
                "position": position,
                "duration": duration,
                "buffered": duration, // local files: fully "buffered" once loaded, no network buffering to report
            ])
        }
    }

    private func playInternal() {
        guard currentIndex != nil else {
            if !queue.isEmpty {
                currentIndex = 0
                loadAndScheduleCurrentTrack(autoPlay: true)
            }
            return
        }
        activateSession()
        playerNode.play()
        setState(.playing)
    }

    private func pauseInternal() {
        // Freeze the real position while it's still readable — once
        // paused, lastRenderTime/playerTime go stale and
        // currentPositionSeconds() falls back to this value, so it must
        // be the actual current position, not whatever it was at last
        // load/seek (was defaulting to 0, showing 0:00 while paused).
        segmentStartOffsetSeconds = currentPositionSeconds()
        playerNode.pause()
        setState(.paused)
    }

    private func stopInternal() {
        playbackToken &+= 1
        playerNode.stop()
        progressTimer?.invalidate()
        setState(.stopped)
        deactivateSession()
    }

    private func skipToNextInternal() {
        advance(direction: 1, wrap: repeatMode == .queue, autoPlay: true)
    }

    private func skipToPreviousInternal() {
        advance(direction: -1, wrap: repeatMode == .queue, autoPlay: true)
    }

    // MARK: - Exposed methods (mirrors RNTP's method names/shapes)

    @objc(setupPlayer:resolver:rejecter:)
    func setupPlayer(_ options: NSDictionary, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        // minBuffer/maxBuffer from RNTP don't have a direct AVAudioEngine
        // equivalent for local-file playback (those were about network
        // streaming buffer windows) — accepted here for call-site
        // compatibility and otherwise ignored. Flag if this app ever
        // plays anything non-local.
        resolve(nil)
    }

    @objc(updateOptions:resolver:rejecter:)
    func updateOptions(_ options: NSDictionary, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        if let interval = options["progressUpdateEventInterval"] as? Double {
            progressIntervalSeconds = interval
        }
        // capabilities / compactCapabilities: MPRemoteCommandCenter targets
        // are already registered unconditionally in
        // configureRemoteCommandCenter(). Selectively enabling/disabling
        // per the `capabilities` array is a straightforward follow-up
        // (`.isEnabled = false` per command) if this app ever needs fewer
        // than all five — not done yet since App.js currently requests
        // all five anyway.
        resolve(nil)
    }

    @objc(add:insertBeforeIndex:resolver:rejecter:)
    func add(_ tracks: [NSDictionary], insertBeforeIndex: NSNumber?, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let parsed = tracks.compactMap { Track(dict: $0) }
        if let idx = insertBeforeIndex?.intValue, idx >= 0, idx <= queue.count {
            queue.insert(contentsOf: parsed, at: idx)
            if let current = currentIndex, idx <= current {
                currentIndex = current + parsed.count
            }
        } else {
            queue.append(contentsOf: parsed)
        }
        resolve(nil)
    }

    // Index-based, matching RNTP's actual remove(indexes) — same reasoning
    // as skip above: every call site passes an index (`TrackPlayer.remove
    // (realIndex)`), and id-based matching breaks the moment a song is
    // queued more than once. Removing by index also needs currentIndex
    // shifted for whichever removed slots sat before it — process from
    // highest index to lowest so earlier removals don't shift the meaning
    // of indexes still waiting to be removed.
    @objc(remove:resolver:rejecter:)
    func remove(_ indexes: [NSNumber], resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let sorted = indexes.map { $0.intValue }.filter { $0 >= 0 && $0 < queue.count }.sorted(by: >)
        for idx in sorted {
            queue.remove(at: idx)
            if let current = currentIndex {
                if idx < current {
                    currentIndex = current - 1
                } else if idx == current {
                    // Removing the currently-playing slot itself — not a
                    // case PlaybackContext.js's existing call sites
                    // trigger today (removeFromQueue only ever targets
                    // realIndex values after currentIndex), but handled
                    // rather than left to silently corrupt state if
                    // something ever does hit this path.
                    currentIndex = nil
                }
            }
        }
        resolve(nil)
    }

    @objc(removeUpcomingTracks:rejecter:)
    func removeUpcomingTracks(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        if let idx = currentIndex {
            queue.removeSubrange((idx + 1)...)
            if queue.count == idx { /* nothing after current, no-op */ }
        }
        resolve(nil)
    }

    // Index-based, matching RNTP's actual skip(index) — every existing call
    // site in PlaybackService.js/PlaybackContext.js already passes a queue
    // index (e.g. `TrackPlayer.skip(realIndex)`), never an id. Matching by
    // id here would also independently be wrong for a duplicated song (the
    // same song genuinely queued twice, which this app's priority-queue
    // design explicitly relies on being able to do) — firstIndex(where:)
    // would always resolve to whichever copy comes first, not necessarily
    // the one actually being tapped. Both problems disappear by taking the
    // index directly instead of searching for it.
    @objc(skip:resolver:rejecter:)
    func skip(_ index: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let idx = index.intValue
        guard idx >= 0, idx < queue.count else {
            resolve(nil)
            return
        }
        currentIndex = idx
        loadAndScheduleCurrentTrack(autoPlay: true)
        resolve(nil)
    }

    @objc(skipToNext:rejecter:)
    func skipToNext(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        skipToNextInternal()
        resolve(nil)
    }

    @objc(skipToPrevious:rejecter:)
    func skipToPrevious(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        skipToPreviousInternal()
        resolve(nil)
    }

    @objc(getQueue:rejecter:)
    func getQueue(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(queue.map { $0.toDict() })
    }

    // Index-based, matching RNTP's actual getCurrentTrack() — it returns
    // the QUEUE INDEX, not the track's id. PlaybackContext.js does
    // arithmetic directly on this value everywhere (currentIndex + 1,
    // queue[currentIndex], realIndex <= currentIndex, ...) — returning the
    // id here instead would silently break essentially all of that math
    // the moment this module got wired in, not just this one call site.
    @objc(getCurrentTrack:rejecter:)
    func getCurrentTrack(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(currentIndex.map { NSNumber(value: $0) })
    }

    @objc(reset:rejecter:)
    func reset(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        stopInternal()
        queue.removeAll()
        currentIndex = nil
        sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": NSNull()])
        resolve(nil)
    }

    // Index-based, matching RNTP's real updateMetadataForTrack(index,
    // metadata) — PlaybackContext.js already calls this with the queue
    // index it just resolved (`TrackPlayer.updateMetadataForTrack(idx,
    // {artwork: uri})`), not an id. Same class of mismatch as
    // getCurrentTrack/skip/remove above.
    @objc(updateMetadataForTrack:metadata:resolver:rejecter:)
    func updateMetadataForTrack(_ index: NSNumber, metadata: NSDictionary, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let idx = index.intValue
        guard idx >= 0, idx < queue.count else {
            resolve(nil)
            return
        }
        var track = queue[idx]
        if let title = metadata["title"] as? String { track.title = title }
        if let artist = metadata["artist"] as? String { track.artist = artist }
        if let album = metadata["album"] as? String { track.album = album }
        if let artwork = metadata["artwork"] as? String { track.artwork = artwork }
        queue[idx] = track
        if idx == currentIndex { updateNowPlayingInfo() }
        resolve(nil)
    }

    @objc(play:rejecter:)
    func play(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        playInternal()
        resolve(nil)
    }

    @objc(pause:rejecter:)
    func pause(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        pauseInternal()
        resolve(nil)
    }

    @objc(stop:rejecter:)
    func stop(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        stopInternal()
        resolve(nil)
    }

    @objc(seekTo:resolver:rejecter:)
    func seekTo(_ seconds: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let wasPlaying = state == .playing
        seekWithinCurrentTrack(startAtSeconds: seconds.doubleValue, autoPlay: wasPlaying)
        resolve(nil)
    }

    // Same scheduling as loadAndScheduleCurrentTrack but reuses the
    // already-open currentFile instead of reopening it from disk, and
    // does NOT re-fire PlaybackTrackChanged or reset volume — this is a
    // reposition within the SAME track, not a track change, and firing
    // that event here made every single drag tick look like a track
    // change to the JS side. Falls back to the full load path only if
    // there's genuinely no file loaded yet (shouldn't normally happen —
    // seekTo implies something is already current).
    private func seekWithinCurrentTrack(startAtSeconds: Double, autoPlay: Bool) {
        guard let idx = currentIndex, idx >= 0, idx < queue.count, let file = currentFile else {
            loadAndScheduleCurrentTrack(startAtSeconds: startAtSeconds, autoPlay: autoPlay)
            return
        }
        _ = idx
        segmentStartOffsetSeconds = startAtSeconds
        playerNode.stop()
        playbackToken &+= 1
        let token = playbackToken

        let startFrame = AVAudioFramePosition(startAtSeconds * currentFileSampleRate)
        let frameCount = AVAudioFrameCount(max(0, file.length - startFrame))

        if frameCount > 0 {
            playerNode.scheduleSegment(file, startingFrame: startFrame, frameCount: frameCount, at: nil) { [weak self] in
                DispatchQueue.main.async {
                    self?.handlePlaybackCompleted(token: token)
                }
            }
        }

        if autoPlay {
            playerNode.play()
            setState(.playing)
        } else {
            setState(.ready)
        }
    }

    @objc(setVolume:resolver:rejecter:)
    func setVolume(_ vol: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        volume = vol.floatValue
        playerNode.volume = volume
        resolve(nil)
    }

    @objc(getVolume:rejecter:)
    func getVolume(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(volume)
    }

    @objc(getProgress:rejecter:)
    func getProgress(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let position = currentPositionSeconds()
        let duration = currentIndex.flatMap { queue[safe: $0]?.duration } ?? 0
        resolve(["position": position, "duration": duration, "buffered": duration])
    }

    @objc(getState:rejecter:)
    func getState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(state.rawValue)
    }

    @objc(setRepeatMode:resolver:rejecter:)
    func setRepeatMode(_ mode: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        repeatMode = RepeatModeValue(rawValue: mode.intValue) ?? .off
        resolve(nil)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
