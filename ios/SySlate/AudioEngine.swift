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

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { true }

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
        // Deprioritized per decision #3 — only the iOS-standard "pause on
        // old device unavailable" (e.g. headphones physically unplugged)
        // is handled, since leaving audio playing into silence is jarring
        // and this is a one-line default. Nothing beyond that; the
        // Bluetooth-reconnect ramp question is explicitly out of scope.
        guard let info = notification.userInfo,
              let reasonValue = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }
        if reason == .oldDeviceUnavailable {
            DispatchQueue.main.async { [weak self] in
                self?.pauseInternal()
            }
        }
    }

    // MARK: - Remote command center / now playing

    private func configureRemoteCommandCenter() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            self?.playInternal()
            self?.sendEvent(withName: "RemotePlay", body: nil)
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.pauseInternal()
            self?.sendEvent(withName: "RemotePause", body: nil)
            return .success
        }
        center.stopCommand.addTarget { [weak self] _ in
            self?.stopInternal()
            self?.sendEvent(withName: "RemoteStop", body: nil)
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.skipToNextInternal()
            self?.sendEvent(withName: "RemoteNext", body: nil)
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.skipToPreviousInternal()
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
              let playerTime = playerNode.playerTime(forNodeTime: nodeTime) else { return 0 }
        return Double(playerTime.sampleTime) / currentFileSampleRate
    }

    private func loadAndScheduleCurrentTrack(startAtSeconds: Double = 0, autoPlay: Bool) {
        guard let idx = currentIndex, idx >= 0, idx < queue.count else {
            setState(.stopped)
            return
        }
        let track = queue[idx]

        do {
            let file = try AVAudioFile(forReading: track.url)
            currentFile = file
            currentFileSampleRate = file.processingFormat.sampleRate

            playerNode.stop()
            playbackToken &+= 1
            let token = playbackToken

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
                queue[idx] = trackWithDuration
            }

            sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": trackWithDuration.toDict()])

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
            NSLog("AudioEngine: failed to load track \(track.url): \(error)")
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

    @objc(remove:resolver:rejecter:)
    func remove(_ ids: [String], resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let currentId = currentIndex.flatMap { queue[safe: $0]?.id }
        queue.removeAll { ids.contains($0.id) }
        if let currentId = currentId {
            currentIndex = queue.firstIndex { $0.id == currentId }
        }
        resolve(nil)
    }

    @objc(removeUpcomingTracks:resolver:rejecter:)
    func removeUpcomingTracks(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        if let idx = currentIndex {
            queue.removeSubrange((idx + 1)...)
            if queue.count == idx { /* nothing after current, no-op */ }
        }
        resolve(nil)
    }

    @objc(skip:resolver:rejecter:)
    func skip(_ id: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        guard let idx = queue.firstIndex(where: { $0.id == id }) else {
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

    @objc(getCurrentTrack:rejecter:)
    func getCurrentTrack(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(currentIndex.flatMap { queue[safe: $0]?.id })
    }

    @objc(reset:rejecter:)
    func reset(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        stopInternal()
        queue.removeAll()
        currentIndex = nil
        resolve(nil)
    }

    @objc(updateMetadataForTrack:metadata:resolver:rejecter:)
    func updateMetadataForTrack(_ id: String, metadata: NSDictionary, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        guard let idx = queue.firstIndex(where: { $0.id == id }) else {
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
        loadAndScheduleCurrentTrack(startAtSeconds: seconds.doubleValue, autoPlay: wasPlaying)
        resolve(nil)
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
