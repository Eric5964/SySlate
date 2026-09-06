import Foundation
import AVFoundation
import AudioToolbox
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
    // Two player nodes instead of one — a real overlapping crossfade needs
    // both the outgoing and incoming track's audio playing simultaneously,
    // which a single AVAudioPlayerNode fundamentally can't do (it's one
    // audio stream). activeNode is whichever one is currently the "real"
    // track for every existing purpose (position, pause, seek, progress);
    // the other is idle except during the brief crossfade overlap window.
    // They swap roles at the end of each crossfade rather than either one
    // being permanently "the" player node.
    private let nodeA = AVAudioPlayerNode()
    private let nodeB = AVAudioPlayerNode()
    private var activeNode: AVAudioPlayerNode!
    private var idleNode: AVAudioPlayerNode { activeNode === nodeA ? nodeB : nodeA }
    // Both nodes feed into this before EQ/normalization — AVAudioUnitEQ
    // and AVAudioUnitEffect each only take one input, so two simultaneous
    // player nodes need a mixer ahead of them regardless of crossfade
    // being active at that moment or not.
    private let preMixNode = AVAudioMixerNode()
    // 10-band graphic EQ, frequencies matching src/utils/eq.js's presets
    // exactly (32/64/125/250/500/1k/2k/4k/8k/16k) so a preset's `bands`
    // array maps directly onto eqNode.bands by index with no translation.
    private let eqNode = AVAudioUnitEQ(numberOfBands: 10)
    // Apple's built-in dynamics processor AudioUnit — used here as a
    // volume-normalization approximation (consistent perceived loudness
    // across tracks recorded at different levels) since these are local
    // files with no embedded loudness metadata (ReplayGain etc.) to read
    // instead. Real per-track loudness analysis would need decoding each
    // full file up front, which isn't practical to add on top of
    // everything else this pass — this is a legitimate, standard
    // alternative (this is literally what it's for), not a placeholder.
    private var normalizerNode: AVAudioUnitEffect!
    private var currentFile: AVAudioFile?
    private var currentFileSampleRate: Double = 44100

    // MARK: - Queue state
    private var queue: [Track] = []
    private var currentIndex: Int? = nil
    private var repeatMode: RepeatModeValue = .off
    private var state: PlaybackStateValue = .none
    private var volume: Float = 1.0
    private var crossfadeEnabled: Bool = false
    private var crossfadeDurationSeconds: Double = 0
    // Between-track normalization: a rough per-file gain correction so a
    // notably quiet or loud track doesn't stand out next to its neighbors.
    // Separate from normalizerNode above (Apple's DynamicsProcessor,
    // compression WITHIN a track) — this instead nudges playback volume
    // per-file based on a cheap sampled loudness estimate. Off by default.
    private var betweenTrackNormEnabled: Bool = false
    // Silence trim: skip detected leading/trailing silence on a track's
    // natural start/end. Off by default.
    private var silenceTrimEnabled: Bool = false
    // True only for the duration of an actual overlap — guards against
    // starting a second crossfade (e.g. a rapid double-skip) while one is
    // already using the idle node, which would need a THIRD node to do
    // correctly. A skip/natural-end that lands mid-crossfade just falls
    // back to the plain instant swap instead.
    private var isCrossfading: Bool = false

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
    // Frozen position snapshot for display while paused — separate from
    // segmentStartOffsetSeconds, see pauseInternal below for why conflating
    // the two caused a real "jumps forward" bug on resume.
    private var frozenPositionSeconds: Double?

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
        activeNode = nodeA

        var normalizerDesc = AudioComponentDescription()
        normalizerDesc.componentType = kAudioUnitType_Effect
        normalizerDesc.componentSubType = kAudioUnitSubType_DynamicsProcessor
        normalizerDesc.componentManufacturer = kAudioUnitManufacturer_Apple
        normalizerDesc.componentFlags = 0
        normalizerDesc.componentFlagsMask = 0
        normalizerNode = AVAudioUnitEffect(audioComponentDescription: normalizerDesc)

        engine.attach(nodeA)
        engine.attach(nodeB)
        engine.attach(preMixNode)
        engine.attach(eqNode)
        engine.attach(normalizerNode)

        engine.connect(nodeA, to: preMixNode, format: nil)
        engine.connect(nodeB, to: preMixNode, format: nil)
        engine.connect(preMixNode, to: eqNode, format: nil)
        engine.connect(eqNode, to: normalizerNode, format: nil)
        engine.connect(normalizerNode, to: engine.mainMixerNode, format: nil)

        // Frequencies match src/utils/eq.js's BAND_HZ exactly (index-for-
        // index) so a preset's bands array can be applied directly with
        // no remapping. .parametric gives each band a bell/peaking curve,
        // the standard shape for a graphic EQ band.
        let eqFrequencies: [Float] = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
        for (i, freq) in eqFrequencies.enumerated() where i < eqNode.bands.count {
            eqNode.bands[i].filterType = .parametric
            eqNode.bands[i].frequency = freq
            eqNode.bands[i].bandwidth = 1.0
            eqNode.bands[i].gain = 0
            eqNode.bands[i].bypass = false
        }
        eqNode.bypass = false
        // Normalization off by default until a preference explicitly
        // turns it on — see setNormalizationEnabled.
        normalizerNode.bypass = true

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

    // MARK: - File analysis (silence trim + between-track loudness)
    //
    // One-time-per-file scan, not a full decode: silence trim only samples
    // bounded chunks in from each end (capped at 20s of scanning either
    // way), and the loudness estimate only samples a handful of chunks
    // spread across the file. Both were explicitly asked to stay cheap —
    // this is deliberately a rough estimate, not accurate LUFS/ReplayGain-
    // style analysis, which would mean decoding the whole file. Result is
    // cached per file path (invalidated if the file's size changes) in
    // UserDefaults, so a given file is only ever scanned once, not on every
    // play — same spirit as the existing tag/art caches, just native-side
    // since this needs actual PCM samples.
    private struct FileAnalysis: Codable {
        let fileSize: Int64
        let leadInSeconds: Double
        let trailingCutSeconds: Double
        let gainCorrection: Float
    }
    private static var analysisCache: [String: FileAnalysis] = {
        guard let data = UserDefaults.standard.data(forKey: "SySlateFileAnalysisCache"),
              let decoded = try? JSONDecoder().decode([String: FileAnalysis].self, from: data) else { return [:] }
        return decoded
    }()
    private func saveAnalysisCache() {
        guard let data = try? JSONEncoder().encode(AudioEngine.analysisCache) else { return }
        UserDefaults.standard.set(data, forKey: "SySlateFileAnalysisCache")
    }
    // Rough reference level the gain-correction estimate below aims for —
    // not a real loudness standard (LUFS etc.), just an internally
    // consistent target across files given how it's measured.
    private let targetSampleRms: Float = 0.09

    private func analyzeFile(_ file: AVAudioFile, path: String) -> FileAnalysis {
        let sizeKey = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int64 ?? 0) ?? 0
        if let cached = AudioEngine.analysisCache[path], cached.fileSize == sizeKey {
            return cached
        }
        let format = file.processingFormat
        let sampleRate = format.sampleRate
        let totalFrames = file.length
        let chunkFrames: AVAudioFrameCount = 4096
        let silenceThreshold: Float = 0.006 // roughly -44 dBFS
        let channels = Int(format.channelCount)

        func rms(atFrame frame: AVAudioFramePosition) -> Float? {
            guard frame >= 0, frame < totalFrames, channels > 0,
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return nil }
            file.framePosition = frame
            guard (try? file.read(into: buffer, frameCount: chunkFrames)) != nil,
                  buffer.frameLength > 0, let data = buffer.floatChannelData else { return nil }
            var sumSquares: Float = 0
            var count = 0
            for ch in 0..<channels {
                let ptr = data[ch]
                for i in 0..<Int(buffer.frameLength) {
                    let s = ptr[i]
                    sumSquares += s * s
                    count += 1
                }
            }
            guard count > 0 else { return nil }
            return sqrtf(sumSquares / Float(count))
        }

        var leadInFrames: AVAudioFramePosition = 0
        var trailingCutFrames: AVAudioFramePosition = 0
        if silenceTrimEnabled, totalFrames > 0 {
            let scanCap = AVAudioFramePosition(sampleRate * 20) // don't scan more than 20s in from either end
            var pos: AVAudioFramePosition = 0
            leadInFrames = min(totalFrames, scanCap)
            while pos < min(totalFrames, scanCap) {
                guard let r = rms(atFrame: pos) else { break }
                if r > silenceThreshold { leadInFrames = pos; break }
                pos += AVAudioFramePosition(chunkFrames)
            }
            let trailCap = max(0, totalFrames - scanCap)
            pos = totalFrames
            trailingCutFrames = totalFrames - trailCap
            while pos > trailCap {
                let chunkStart = max(0, pos - AVAudioFramePosition(chunkFrames))
                guard let r = rms(atFrame: chunkStart) else { break }
                if r > silenceThreshold { trailingCutFrames = totalFrames - pos; break }
                pos = chunkStart
            }
        }

        var gain: Float = 1.0
        if betweenTrackNormEnabled, totalFrames > 0 {
            let sampleCount = 12
            var rmsSum: Float = 0
            var rmsSamples = 0
            for i in 0..<sampleCount {
                let framePos = AVAudioFramePosition(Double(totalFrames) * (Double(i) + 0.5) / Double(sampleCount))
                if let r = rms(atFrame: framePos), r > 0.0005 { // skip near-silent chunks so they don't drag the average down
                    rmsSum += r
                    rmsSamples += 1
                }
            }
            let measured = rmsSamples > 0 ? rmsSum / Float(rmsSamples) : targetSampleRms
            gain = min(max(targetSampleRms / max(measured, 0.0005), 0.4), 2.5) // keep corrections modest — rough estimate, not exact
        }

        let result = FileAnalysis(
            fileSize: sizeKey,
            leadInSeconds: Double(leadInFrames) / sampleRate,
            trailingCutSeconds: Double(trailingCutFrames) / sampleRate,
            gainCorrection: gain
        )
        AudioEngine.analysisCache[path] = result
        saveAnalysisCache()
        return result
    }

    private func currentPositionSeconds() -> Double {
        guard let nodeTime = activeNode.lastRenderTime,
              let playerTime = activeNode.playerTime(forNodeTime: nodeTime) else { return frozenPositionSeconds ?? segmentStartOffsetSeconds }
        return segmentStartOffsetSeconds + Double(playerTime.sampleTime) / currentFileSampleRate
    }

    private func loadAndScheduleCurrentTrack(startAtSeconds: Double = 0, autoPlay: Bool, announceChange: Bool = true) {
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
                    self.finishLoadingTrack(file: file, track: track, idx: idx, startAtSeconds: startAtSeconds, autoPlay: autoPlay, announceChange: announceChange, token: token)
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

    private func finishLoadingTrack(file: AVAudioFile, track: Track, idx: Int, startAtSeconds: Double, autoPlay: Bool, announceChange: Bool, token: UInt64) {
        do {
            currentFile = file
            currentFileSampleRate = file.processingFormat.sampleRate

            // Analysis (silence trim points + loudness gain) only runs when
            // at least one of the two features is actually on, and only
            // costs anything the first time a given file is seen — see
            // analyzeFile's cache. startAtSeconds == 0 specifically means a
            // genuine fresh start (tapped a song, natural advance, repeat) —
            // NOT a session-restore or a manual seek (seeks use a separate,
            // lighter reschedule path and never call this), so silence trim
            // only ever applies to a track's real natural start/end, never
            // second-guessing a position the user or a restored session
            // explicitly asked for.
            var effectiveStartAtSeconds = startAtSeconds
            var trailingCutSeconds: Double = 0
            var gainCorrection: Float = 1.0
            if silenceTrimEnabled || betweenTrackNormEnabled {
                let analysis = analyzeFile(file, path: track.url.path)
                if silenceTrimEnabled && startAtSeconds == 0 {
                    effectiveStartAtSeconds = analysis.leadInSeconds
                    trailingCutSeconds = analysis.trailingCutSeconds
                }
                if betweenTrackNormEnabled {
                    gainCorrection = analysis.gainCorrection
                }
            }
            segmentStartOffsetSeconds = effectiveStartAtSeconds

            activeNode.stop()

            let startFrame = AVAudioFramePosition(effectiveStartAtSeconds * currentFileSampleRate)
            let trailingCutFrames = AVAudioFramePosition(trailingCutSeconds * currentFileSampleRate)
            let frameCount = AVAudioFrameCount(max(0, file.length - startFrame - trailingCutFrames))

            if frameCount > 0 {
                activeNode.scheduleSegment(file, startingFrame: startFrame, frameCount: frameCount, at: nil) { [weak self] in
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

            if announceChange {
                sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])
            }

            if !engine.isRunning {
                try engine.start()
            }
            activateSession()
            activeNode.volume = volume * gainCorrection

            if autoPlay {
                activeNode.play()
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
            loadAndScheduleCurrentTrack(startAtSeconds: 0, autoPlay: true, announceChange: false)
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
            activeNode.stop()
            setState(.ended)
            return
        }

        if crossfadeEnabled, crossfadeDurationSeconds > 0.05, autoPlay, direction == 1, !isCrossfading, state == .playing {
            currentIndex = newIndex
            startCrossfade(toIndex: newIndex)
            return
        }

        currentIndex = newIndex
        loadAndScheduleCurrentTrack(autoPlay: autoPlay)
    }

    // MARK: - Crossfade

    private func startCrossfade(toIndex idx: Int) {
        guard idx >= 0, idx < queue.count else { return }
        let track = queue[idx]
        let outgoingNode = activeNode!
        let incomingNode = idleNode
        let outgoingVolumeStart = outgoingNode.volume

        playbackToken &+= 1
        let token = playbackToken
        isCrossfading = true

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let file = try AVAudioFile(forReading: track.url)
                // Analysis (when either feature is on) runs here, off the
                // main thread, same reasoning as the file open itself —
                // doing this synchronously in runCrossfade below would
                // block the main thread on first-time PCM sampling for a
                // file that hasn't been cached yet.
                let analysis: FileAnalysis? = (self?.silenceTrimEnabled == true || self?.betweenTrackNormEnabled == true)
                    ? self?.analyzeFile(file, path: track.url.path) : nil
                DispatchQueue.main.async {
                    guard let self = self, token == self.playbackToken else {
                        self?.isCrossfading = false
                        return
                    }
                    self.runCrossfade(file: file, track: track, idx: idx, outgoingNode: outgoingNode, incomingNode: incomingNode, outgoingVolumeStart: outgoingVolumeStart, gainCorrection: analysis?.gainCorrection ?? 1.0, token: token)
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.isCrossfading = false
                    NSLog("AudioEngine: crossfade load failed for \(track.url): \(error)")
                    // Falls back to a plain load so playback doesn't just
                    // silently stop because specifically the crossfade
                    // path failed (missing file, unreadable format, etc).
                    guard token == self.playbackToken else { return }
                    self.loadAndScheduleCurrentTrack(autoPlay: true)
                }
            }
        }
    }

    private func runCrossfade(file: AVAudioFile, track: Track, idx: Int, outgoingNode: AVAudioPlayerNode, incomingNode: AVAudioPlayerNode, outgoingVolumeStart: Float, gainCorrection: Float, token: UInt64) {
        let sampleRate = file.processingFormat.sampleRate
        incomingNode.stop()
        incomingNode.scheduleSegment(file, startingFrame: 0, frameCount: AVAudioFrameCount(file.length), at: nil) { [weak self] in
            DispatchQueue.main.async {
                self?.handlePlaybackCompleted(token: token)
            }
        }
        incomingNode.volume = 0
        if !engine.isRunning {
            try? engine.start()
        }
        activateSession()
        incomingNode.play()

        let duration = crossfadeDurationSeconds
        let steps = max(10, Int(duration * 25))
        let stepInterval = duration / Double(steps)
        var currentStep = 0
        // Same between-track gain correction as the plain-load path
        // (finishLoadingTrack) — otherwise a track that needed a gain
        // correction would fade in at the wrong final volume specifically
        // when it arrives via crossfade instead of a plain track change.
        // Computed on the background thread by the caller (startCrossfade),
        // not here — see its comment for why.
        let targetVolume = volume * gainCorrection

        // Coarse timer-driven fade controlling both nodes in lockstep —
        // done natively rather than via the usual JS setVolume() calls
        // because those go over the bridge one at a time; a real
        // crossfade needs both nodes' volumes moving together on every
        // step, which bridge round-trip latency can't guarantee.
        let fadeTimer = Timer.scheduledTimer(withTimeInterval: stepInterval, repeats: true) { [weak self] timer in
            guard let self = self, token == self.playbackToken else { timer.invalidate(); return }
            currentStep += 1
            let t = Float(currentStep) / Float(steps)
            outgoingNode.volume = outgoingVolumeStart * (1 - t)
            incomingNode.volume = targetVolume * t
            if currentStep >= steps {
                timer.invalidate()
                outgoingNode.stop()
                outgoingNode.volume = targetVolume

                self.activeNode = incomingNode
                self.isCrossfading = false
                self.currentFile = file
                self.currentFileSampleRate = sampleRate
                self.segmentStartOffsetSeconds = 0

                var trackWithDuration = track
                if trackWithDuration.duration == nil {
                    trackWithDuration.duration = Double(file.length) / sampleRate
                    if idx < self.queue.count { self.queue[idx] = trackWithDuration }
                }

                self.sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])
                self.setState(.playing)
                self.startProgressTimer()
            }
        }
        RunLoop.main.add(fadeTimer, forMode: .common)
    }

    private func startProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = Timer.scheduledTimer(withTimeInterval: progressIntervalSeconds, repeats: true) { [weak self] _ in
            guard let self = self, self.state == .playing else { return }
            let position = self.currentPositionSeconds()
            // Same fix as getProgress above — derive from currentFile, not
            // queue[currentIndex], so this can't pair mismatched track data
            // during a crossfade's currentIndex-flips-early window either.
            let duration = self.currentFile.map { Double($0.length) / self.currentFileSampleRate }
                ?? (self.currentIndex.flatMap { self.queue[safe: $0]?.duration } ?? 0)
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
        frozenPositionSeconds = nil
        activeNode.play()
        setState(.playing)
    }

    private func pauseInternal() {
        // Freeze the real position for display while paused — activeNode's
        // lastRenderTime/playerTime go nil/stale once paused, so
        // currentPositionSeconds() needs a snapshot to fall back to.
        //
        // Real bug found here: this used to overwrite
        // segmentStartOffsetSeconds itself with that snapshot.
        // segmentStartOffsetSeconds is the ORIGIN a scheduled segment's
        // playerTime is measured relative to — that origin does NOT change
        // across a plain pause/resume (nothing gets rescheduled; the same
        // segment just keeps counting from its original start once resumed,
        // playerTime included). Overwriting it added the elapsed-at-pause
        // time a SECOND time on top of playerTime's own already-correct
        // count the moment playback resumed — e.g. pausing at 60s set
        // segmentStartOffsetSeconds to 60, and on resume playerTime
        // continued reporting ~60s+ on its own (it was never reset), so
        // currentPositionSeconds() read 60 + 60+ instead of just 60+. That's
        // exactly "hitting play jumps forward greatly" — and identical
        // in-app or via a remote/lock-screen Play, since both go through
        // this same pause/resume path. Storing the snapshot separately
        // instead leaves segmentStartOffsetSeconds untouched, so resuming
        // counts correctly from the same original origin it always had.
        frozenPositionSeconds = currentPositionSeconds()
        activeNode.pause()
        setState(.paused)
    }

    private func stopInternal() {
        playbackToken &+= 1
        activeNode.stop()
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
        activeNode.stop()
        playbackToken &+= 1
        let token = playbackToken

        let startFrame = AVAudioFramePosition(startAtSeconds * currentFileSampleRate)
        let frameCount = AVAudioFrameCount(max(0, file.length - startFrame))

        if frameCount > 0 {
            activeNode.scheduleSegment(file, startingFrame: startFrame, frameCount: frameCount, at: nil) { [weak self] in
                DispatchQueue.main.async {
                    self?.handlePlaybackCompleted(token: token)
                }
            }
        }

        if autoPlay {
            activeNode.play()
            setState(.playing)
        } else {
            setState(.ready)
        }
    }

    @objc(setVolume:resolver:rejecter:)
    func setVolume(_ vol: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        volume = vol.floatValue
        activeNode.volume = volume
        resolve(nil)
    }

    @objc(getVolume:rejecter:)
    func getVolume(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(volume)
    }

    @objc(getProgress:rejecter:)
    func getProgress(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let position = currentPositionSeconds()
        // Was `queue[currentIndex].duration` — but currentIndex is bumped
        // to the INCOMING track the moment a crossfade starts (see advance/
        // startCrossfade), well before the handoff itself completes. For
        // the whole crossfade window, that paired the OUTGOING track's real
        // position (still correct — activeNode hasn't swapped yet) with the
        // INCOMING track's duration, a genuinely inconsistent reading. Since
        // currentFile only gets reassigned at the same moment activeNode/
        // segmentStartOffsetSeconds do (see loadAndScheduleCurrentTrack and
        // runCrossfade's handoff), deriving duration from it instead keeps
        // position and duration always describing the same track.
        let duration = currentFile.map { Double($0.length) / currentFileSampleRate }
            ?? (currentIndex.flatMap { queue[safe: $0]?.duration } ?? 0)
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

    // MARK: - EQ / normalization / crossfade

    // `bands` is 10 gain values in dB, index-matched to eq.js's BAND_HZ
    // (32Hz..16kHz). A "flat" preset is just all zeros — no special-casing
    // needed, the EQ node stays attached and active either way, it's just
    // a no-op at that point.
    @objc(setEQBands:resolver:rejecter:)
    func setEQBands(_ bands: [NSNumber], resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        for (i, gain) in bands.enumerated() where i < eqNode.bands.count {
            eqNode.bands[i].gain = gain.floatValue
        }
        resolve(nil)
    }

    @objc(setNormalizationEnabled:resolver:rejecter:)
    func setNormalizationEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        normalizerNode.bypass = !enabled.boolValue
        resolve(nil)
    }

    @objc(setCrossfadeEnabled:resolver:rejecter:)
    func setCrossfadeEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        crossfadeEnabled = enabled.boolValue
        resolve(nil)
    }

    @objc(setCrossfadeDuration:resolver:rejecter:)
    func setCrossfadeDuration(_ seconds: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        crossfadeDurationSeconds = max(0, seconds.doubleValue)
        resolve(nil)
    }

    // Renamed on the JS side to make clear this is the per-track dynamics
    // compressor (WITHIN a track), as distinct from setBetweenTrackNormEnabled
    // below (loudness matching ACROSS tracks) — see PreferencesContext.js.
    @objc(setWithinTrackNormEnabled:resolver:rejecter:)
    func setWithinTrackNormEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        normalizerNode.bypass = !enabled.boolValue
        resolve(nil)
    }

    @objc(setBetweenTrackNormEnabled:resolver:rejecter:)
    func setBetweenTrackNormEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        betweenTrackNormEnabled = enabled.boolValue
        resolve(nil)
    }

    @objc(setSilenceTrimEnabled:resolver:rejecter:)
    func setSilenceTrimEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        silenceTrimEnabled = enabled.boolValue
        resolve(nil)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
