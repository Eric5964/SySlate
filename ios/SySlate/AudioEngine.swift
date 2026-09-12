import Foundation
import AVFoundation
import AudioToolbox
import MediaPlayer
import UIKit

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
    // Real bug found here: PlaybackContext.js's stampQid() tags every track
    // it sends over with a `_qid` (a unique per-queue-slot id, separate
    // from the song's own `id` — needed to tell two genuine occurrences of
    // the SAME song apart, e.g. one in Priority and one further down in Up
    // Next). This struct never had a matching field, so init?(dict:) below
    // silently dropped it and toDict() never sent it back — any JS code
    // comparing by `_qid` (see PlaybackContext.js's PlaybackTrackChanged
    // listener) was always comparing `undefined === undefined`, silently
    // no-op'ing back to comparing by `id` alone regardless.
    var qid: String?

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
        self.qid = dict["_qid"] as? String
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
            "_qid": qid as Any,
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
    // Split to match Audio Ramp's granularity (On Play / On Skip / End of
    // Track each have their own duration) — crossfade only ever fires on a
    // genuine forward track change (see advance()'s crossfadeEnabled gate),
    // so there's no "on play" equivalent (nothing precedes a fresh play to
    // crossfade FROM), but a manual skip and a track naturally ending are
    // different enough moments that one duration for both was the actual
    // ask being split up here. crossfadeDurationSkipSeconds keeps the
    // original property name's storage-key/setter pairing on the JS side
    // (setCrossfadeDuration) for backward compatibility with the existing
    // AsyncStorage value — it's the "manual skip" duration now, not "the"
    // duration.
    private var crossfadeDurationSkipSeconds: Double = 0
    private var crossfadeDurationEndOfTrackSeconds: Double = 0
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

    // One-shot timer that starts a NATURAL end-of-track crossfade early
    // enough to actually overlap — see scheduleCrossfadeLeadIn() below for
    // the real architectural bug this exists to fix (crossfade was only
    // ever triggered AFTER the outgoing track had already finished
    // playing, which isn't an overlap at all).
    private var crossfadeLeadTimer: Timer?

    // Instance-level so a pause (or anything else) mid-crossfade can find
    // and finish it — these used to be purely local to runCrossfade, which
    // meant nothing outside that one method's closures could ever
    // intervene in an in-progress crossfade. See settleCrossfadeToIncoming.
    private var crossfadeFadeTimer: Timer?
    private var crossfadeIncomingFile: AVAudioFile?
    private var crossfadeIncomingSampleRate: Double = 0
    private var crossfadeIncomingTrack: Track?
    private var crossfadeIncomingIndex: Int?
    private var crossfadeTargetVolume: Float = 1
    // Raw gain correction alone (crossfadeTargetVolume above is volume ×
    // this, already multiplied together) — settleCrossfadeToIncoming needs
    // the unmultiplied value to correctly set currentGainCorrection for
    // whatever setVolume() calls come after a pause/seek interrupts a
    // crossfade partway through.
    private var crossfadeIncomingGainCorrection: Float = 1.0

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
    // How much silence was cut from the END of the current file by silence
    // trim (0 when trim is off, or when the current track arrived via
    // crossfade — see runCrossfade/settleCrossfadeToIncoming, which don't
    // apply trim at all currently). Needed to report an accurate duration —
    // see loadAndScheduleCurrentTrack's comment on the bug this fixes.
    private var currentTrailingCutSeconds: Double = 0
    // Real bug found here — this is THE reason Match Volume Between Songs
    // doesn't actually work: gainCorrection (the per-track loudness
    // correction from analyzeFile) was only ever a local variable, applied
    // ONCE at the exact moment a track loads (activeNode.volume = volume *
    // gainCorrection in finishLoadingTrack/runCrossfade) and never stored
    // anywhere afterward. setVolume() below — called constantly by every
    // ramp step, every fade, every "just snap to full volume" fallback
    // throughout PlaybackService.js — set activeNode.volume = volume
    // directly, with NO gain correction applied at all. In practice that
    // means the correction only survived until the very next setVolume()
    // call, which for a track played with ANY ramping happens almost
    // immediately — so it was being computed correctly and then
    // overwritten right back out, for nearly every real play. Stored here
    // now so setVolume() (and anything else touching volume) can keep
    // applying it consistently instead of just at the one instant a track
    // loads.
    private var currentGainCorrection: Float = 1.0
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
            // Lock screen / Control Center scrubber. Not part of RNTP's
            // event set (RNTP maps this to a native seek internally) — kept
            // as a JS event instead, same pattern as the other Remote*
            // commands, so PlaybackService.js can route it through the same
            // seek path AllSongsScreen/PlayerScreen already use rather than
            // duplicating seek logic natively.
            "RemoteSeek",
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
        // Requested: ramp out briefly (not an instant cut) specifically when
        // the app is force-quit from the app switcher — background play via
        // the "audio" background mode is untouched, this only fires on
        // actual termination. willTerminateNotification only fires at all
        // for a running-in-background app (which this is, while playing
        // audio) being user-killed from the switcher — a suspended or
        // already-purged app gets no notification whatsoever, nothing to
        // hook for that case.
        NotificationCenter.default.addObserver(self, selector: #selector(handleAppWillTerminate), name: UIApplication.willTerminateNotification, object: nil)
    }

    // MARK: - App termination

    @objc private func handleAppWillTerminate() {
        guard state == .playing else { return }
        // No guaranteed continuation past this notification — the process
        // can be killed shortly after it returns, so this can't be the
        // usual async Timer-driven fade (those might just never get to run
        // at all). beginBackgroundTask asks for a little extra time
        // specifically to finish something short like this; the blocking
        // loop below is the actual fade, deliberately synchronous so it
        // provably completes (or the requested ~1s elapses) before this
        // function returns and the app is allowed to actually die.
        var bgTask = UIBackgroundTaskIdentifier.invalid
        bgTask = UIApplication.shared.beginBackgroundTask {
            UIApplication.shared.endBackgroundTask(bgTask)
        }
        let startVolume = activeNode.volume
        let duration = 1.0
        let steps = 10
        for i in 1...steps {
            Thread.sleep(forTimeInterval: duration / Double(steps))
            activeNode.volume = startVolume * Float(1 - Double(i) / Double(steps))
        }
        activeNode.pause()
        if bgTask != .invalid {
            UIApplication.shared.endBackgroundTask(bgTask)
        }
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
        // reconfiguring. AVAudioEngine can come out of one of these still
        // reporting .playing and still advancing position, but no longer
        // actually wired to the active output, which plays back completely
        // silently despite every outward sign of working — pausing and
        // restarting the engine (NOT stopping it — that would drop the
        // player node's scheduled buffer) re-establishes it against the new
        // route. That fix is what's now suspected of CAUSING a different
        // bug: "connecting Bluetooth permanently skips/glitches the
        // current song." Plausible mechanism — if engine.start() throws
        // here (quite possible mid route-reconfiguration on a real
        // device), the engine is left not-running with nothing to retry it
        // (now guarded against in playInternal, see its comment), or the
        // pause/restart itself disrupts the player node's scheduled-buffer
        // timing enough to misfire its completion handler early, which
        // would look exactly like an unwanted skip.
        //
        // Trying his suggestion: skip the reset specifically for
        // .newDeviceAvailable (a device connecting — the Bluetooth case he
        // described) while still doing it for the other two reasons, which
        // are different situations (nothing connecting, just the route or
        // category changing under an already-connected output). If the
        // Bluetooth silent-audio bug this was originally added for comes
        // back, that tells us which of the two bugs is real/worse and we
        // can revert just this one condition.
        if reason == .routeConfigurationChange || reason == .categoryChange {
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
        // Real bug found here: this handler was never registered at all.
        // MPRemoteCommandCenter's changePlaybackPositionCommand is a
        // SEPARATE opt-in from the play/pause/next/previous ones above —
        // leaving it unregistered doesn't just mean drags are ignored, iOS
        // disables the scrubber interaction entirely on both the lock
        // screen and Control Center widgets (exactly "cannot use the
        // progress bar on either iOS player"). Emitting an event here
        // rather than seeking directly so this reuses PlaybackService.js's
        // existing seek path (same one AllSongsScreen/PlayerScreen already
        // go through), not a second parallel seek implementation.
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.sendEvent(withName: "RemoteSeek", body: ["position": positionEvent.positionTime])
            return .success
        }
    }

    // Real bug found here: this used to strip "file://" with a plain
    // string replace and hand the rest straight to
    // UIImage(contentsOfFile:), which expects a raw filesystem path — not
    // a URL. Any artwork path containing characters a file:// URI
    // percent-encodes (spaces, #, %, non-ASCII artist/album names from
    // embeddedArt.js's cache filenames) silently failed to load, with no
    // error surfaced anywhere, since UIImage(contentsOfFile:) just returns
    // nil for a path that doesn't exist on disk verbatim. That matches
    // "iOS player doesn't always take the cover for some reason" exactly —
    // it would only fail for filenames that happened to need encoding.
    // Going through URL(string:)?.path decodes it properly; falling back
    // to the old naive strip only if that somehow fails to parse at all.
    private func loadArtworkImage(_ artworkPath: String) -> UIImage? {
        if let url = URL(string: artworkPath), url.isFileURL, let image = UIImage(contentsOfFile: url.path) {
            return image
        }
        return UIImage(contentsOfFile: artworkPath.replacingOccurrences(of: "file://", with: ""))
    }

    // Real regression found here, introduced by THIS round's own earlier
    // fix (the periodic updateNowPlayingInfo() push, throttled to ~once a
    // second): this used to only build a fresh MPMediaItemArtwork on a rare
    // state transition. Now that it runs roughly every second while
    // playing, it was re-reading the artwork file from disk and handing
    // iOS a BRAND NEW MPMediaItemArtwork object every single time, even
    // though the actual artwork hadn't changed. Control Center/lock screen
    // artwork rendering doesn't handle that kind of constant churn well —
    // it doesn't reliably keep up when the artwork instance changes every
    // tick, which reads exactly as "song covers do not work outside the
    // app now" (a regression, not something intermittent — it lines up
    // with when the periodic push was added). Cached below, keyed by the
    // artwork path — only reloads from disk and rebuilds the
    // MPMediaItemArtwork when the path actually changes (a real track
    // change), not on every elapsed-time tick.
    private var cachedArtworkPath: String?
    private var cachedArtwork: MPMediaItemArtwork?

    private func updateNowPlayingInfo() {
        guard let idx = currentIndex, idx >= 0, idx < queue.count else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            cachedArtworkPath = nil
            cachedArtwork = nil
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
        if let artworkPath = track.artwork {
            if artworkPath != cachedArtworkPath {
                cachedArtwork = loadArtworkImage(artworkPath).map { image in
                    MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                }
                cachedArtworkPath = artworkPath
            }
            if let artwork = cachedArtwork {
                info[MPMediaItemPropertyArtwork] = artwork
            }
        } else {
            cachedArtworkPath = nil
            cachedArtwork = nil
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
        // Don't let the disk write add to a track's actual load time — the
        // caller (analyzeFile, on the load path) only needs the freshly
        // computed result back, not confirmation this persisted. Encoding
        // and writing the whole growing dictionary happens off to the side.
        let snapshot = AudioEngine.analysisCache
        DispatchQueue.global(qos: .utility).async {
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            UserDefaults.standard.set(data, forKey: "SySlateFileAnalysisCache")
        }
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

        // Belt-and-suspenders, same choke point nearly every load/skip/seek
        // path funnels through: clears any leftover crossfade state (both
        // nodes, the fade timer) AND any pending lead-in timer, so neither
        // can act on a currentIndex that's already been reassigned to the
        // new track by the caller. Both are no-ops if nothing was pending.
        cancelCrossfadeIfNeeded()
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
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
            currentTrailingCutSeconds = trailingCutSeconds
            // Stored so setVolume() keeps applying this correction on every
            // subsequent call, not just the activeNode.volume line below —
            // see currentGainCorrection's declaration for the full bug this
            // fixes. gainCorrection is 1.0 (no-op) whenever normalization
            // is off or analysis wasn't run, so this is always safe to set
            // unconditionally here.
            currentGainCorrection = gainCorrection

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
            } else {
                // Real gap found here: nothing scheduled means
                // scheduleSegment's completion handler above never fires —
                // AVFoundation has no "instant" segment to complete. Without
                // this, seeking (or, rarer, a restored session position)
                // landing past a silence-trimmed track's effective end would
                // leave playback stuck: state says .playing, position frozen,
                // nothing audible, and no natural advance to the next track
                // ever happens since nothing ever "completes." Triggering it
                // directly (dispatched, not synchronous — this function is
                // still unwinding, and handlePlaybackCompleted can call back
                // into this same function via advance() for the NEXT track)
                // treats a zero-frame segment as having already finished.
                DispatchQueue.main.async { [weak self] in
                    self?.handlePlaybackCompleted(token: token)
                }
            }

            var trackWithDuration = track
            if trackWithDuration.duration == nil {
                // Real bug found here: this was Double(file.length) /
                // sampleRate — the FULL, untrimmed file length — while the
                // segment actually scheduled just above is shorter by
                // trailingCutSeconds whenever silence trim cut something
                // off the end. checkRampWindow in PlaybackService.js
                // computes its natural end-of-track ramp-out trigger as
                // `remaining = duration - position`, using exactly this
                // duration — if it's inflated by however many seconds of
                // trailing silence got trimmed, "remaining" reads as
                // larger than the audio that's actually left, so the
                // trigger's `remaining <= ramp` window can end up firing
                // too late (or never, if the trimmed amount exceeds the
                // ramp duration) relative to when the trimmed segment
                // actually completes — the track just stops/advances with
                // no ramp at all. Matches "cuts off early... genuinely
                // zero ramping... maybe an issue with cutting out silence"
                // exactly.
                trackWithDuration.duration = Double(file.length) / file.processingFormat.sampleRate - trailingCutSeconds
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
            if autoPlay { scheduleCrossfadeLeadIn() }
        } catch {
            NSLog("AudioEngine: failed to start engine for \(track.url): \(error)")
            setState(.stopped)
        }
    }

    // MARK: - Crossfade lead-in (natural end-of-track)
    //
    // Real architectural gap found here: a natural end-of-track crossfade
    // only ever ran from handlePlaybackCompleted, which only fires once
    // the outgoing track's FULL scheduled segment has already finished
    // playing every frame. By that point there's nothing left to overlap
    // WITH — calling startCrossfade there just fades the new track in over
    // silence, not a real crossfade. This instead arms a one-shot timer
    // whenever a track starts/resumes/seeks with a known duration,
    // crossfade enabled, and enough of the track left — firing EARLY
    // enough (crossfadeDurationEndOfTrackSeconds before natural end) for
    // the two tracks to genuinely overlap, the same way a manual skip's
    // crossfade already does (that one overlaps correctly because the
    // outgoing track is still actually playing when advance() runs for a
    // skip — this gives natural completion that same real head start).
    private func scheduleCrossfadeLeadIn() {
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
        guard crossfadeEnabled, crossfadeDurationEndOfTrackSeconds > 0.05 else { return }
        // Matches handlePlaybackCompleted's own carve-out — a single-track
        // repeat never goes through advance()/crossfade today (it
        // reschedules the same file silently instead), so this
        // deliberately doesn't try to crossfade a track into itself.
        guard repeatMode != .track else { return }
        guard let idx = currentIndex, idx >= 0, idx < queue.count, let duration = queue[idx].duration, duration > 0 else { return }
        let remaining = duration - currentPositionSeconds()
        let fireIn = remaining - crossfadeDurationEndOfTrackSeconds
        // Already inside (or past) the crossfade window, or not enough of
        // the track left for it to make sense — let natural completion's
        // existing handlePlaybackCompleted path handle this one instead of
        // firing on a negative/near-zero delay.
        guard fireIn > 0.1 else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: fireIn, repeats: false) { [weak self] _ in
            self?.fireCrossfadeLeadIn()
        }
        RunLoop.main.add(timer, forMode: .common)
        crossfadeLeadTimer = timer
    }

    private func fireCrossfadeLeadIn() {
        crossfadeLeadTimer = nil
        // Conditions may have changed since this was armed (paused,
        // settings toggled off, another crossfade already running from
        // some other path) — re-check everything rather than trusting the
        // state from when it was scheduled.
        guard state == .playing, !isCrossfading, crossfadeEnabled, crossfadeDurationEndOfTrackSeconds > 0.05 else { return }
        guard let idx = currentIndex else { return }
        var newIndex = idx + 1
        if newIndex >= queue.count {
            // Nothing to crossfade INTO — off the end of the queue with no
            // wrap. Leave it alone; natural completion's existing
            // handlePlaybackCompleted path already handles ending/stopping
            // correctly, no need to duplicate that here.
            guard repeatMode == .queue else { return }
            newIndex = 0
        }
        guard newIndex >= 0, newIndex < queue.count else { return }
        currentIndex = newIndex
        startCrossfade(toIndex: newIndex, duration: crossfadeDurationEndOfTrackSeconds)
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

        advance(direction: 1, wrap: repeatMode == .queue, autoPlay: true, isManualSkip: false)
    }

    // A skip/advance while a crossfade is still running bumps
    // playbackToken, which makes the fade timer's own guard invalidate
    // itself on its very next tick — but that early-exit path (see
    // runCrossfade below) never reaches the node cleanup lines further
    // down (outgoingNode.stop(), flipping activeNode to the incoming
    // node), since those only run on NORMAL completion. Both nodes
    // involved in the interrupted crossfade were left playing forever,
    // unmanaged — the reported "stacking, never gets rid of the old
    // song." There are only ever two nodes total (nodeA/nodeB), so
    // stopping both unconditionally here is always safe — whichever one
    // becomes active next gets a fresh schedule right after this runs.
    private func cancelCrossfadeIfNeeded() {
        guard isCrossfading else { return }
        // Also invalidate the fade timer itself here now — it used to only
        // stop implicitly (on its own next tick, once whatever call site
        // bumps playbackToken) rather than immediately. Harmless in
        // practice since the nodes below are already stopped by the time
        // it would fire again, but explicit beats implicit.
        crossfadeFadeTimer?.invalidate()
        crossfadeFadeTimer = nil
        crossfadeIncomingFile = nil
        crossfadeIncomingTrack = nil
        crossfadeIncomingIndex = nil
        nodeA.stop()
        nodeB.stop()
        isCrossfading = false
    }

    private func advance(direction: Int, wrap: Bool, autoPlay: Bool, isManualSkip: Bool) {
        cancelCrossfadeIfNeeded()
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

        let crossfadeDuration = isManualSkip ? crossfadeDurationSkipSeconds : crossfadeDurationEndOfTrackSeconds
        if crossfadeEnabled, crossfadeDuration > 0.05, autoPlay, direction == 1, !isCrossfading, state == .playing {
            currentIndex = newIndex
            startCrossfade(toIndex: newIndex, duration: crossfadeDuration)
            return
        }

        currentIndex = newIndex
        loadAndScheduleCurrentTrack(autoPlay: autoPlay)
    }

    // MARK: - Crossfade

    private func startCrossfade(toIndex idx: Int, duration: Double) {
        guard idx >= 0, idx < queue.count else { return }
        // Whichever path got here (manual skip via advance(), or the early
        // lead-in timer for a natural end), a crossfade is now genuinely
        // starting — any OTHER still-pending lead-in timer (there
        // shouldn't be one, but belt-and-suspenders again) is now stale.
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
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
                    self.runCrossfade(file: file, track: track, idx: idx, outgoingNode: outgoingNode, incomingNode: incomingNode, outgoingVolumeStart: outgoingVolumeStart, gainCorrection: analysis?.gainCorrection ?? 1.0, duration: duration, token: token)
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

    private func runCrossfade(file: AVAudioFile, track: Track, idx: Int, outgoingNode: AVAudioPlayerNode, incomingNode: AVAudioPlayerNode, outgoingVolumeStart: Float, gainCorrection: Float, duration: Double, token: UInt64) {
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

        // Mirrored into instance vars so settleCrossfadeToIncoming (called
        // from pauseInternal, a totally different call stack) can complete
        // this handoff early instead of only this closure ever being able
        // to. See that method for the bug this exists to fix — a
        // still-running crossfade timer surviving a pause.
        crossfadeIncomingFile = file
        crossfadeIncomingSampleRate = sampleRate
        crossfadeIncomingTrack = track
        crossfadeIncomingIndex = idx
        crossfadeTargetVolume = targetVolume
        crossfadeIncomingGainCorrection = gainCorrection

        // Coarse timer-driven fade controlling both nodes in lockstep —
        // done natively rather than via the usual JS setVolume() calls
        // because those go over the bridge one at a time; a real
        // crossfade needs both nodes' volumes moving together on every
        // step, which bridge round-trip latency can't guarantee.
        let fadeTimer = Timer.scheduledTimer(withTimeInterval: stepInterval, repeats: true) { [weak self] timer in
            guard let self = self, token == self.playbackToken else { timer.invalidate(); return }
            currentStep += 1
            let t = Float(currentStep) / Float(steps)
            // Requested: smoother, sin-wave crossfade instead of linear.
            // Equal-power curve — outgoing follows cos(t·π/2), incoming
            // follows sin(t·π/2). A linear crossfade (outgoing: 1−t,
            // incoming: t) has a real, audible loudness DIP around the
            // midpoint: perceived loudness tracks roughly with power
            // (amplitude²), and 0.5² + 0.5² = 0.5 — about a 3dB dip right
            // where both tracks are audible together. sin²+cos² = 1
            // always, so the combined perceived loudness stays constant
            // through the whole crossfade instead of sagging in the
            // middle — the standard "equal-power" curve used for this
            // exact reason.
            let angle = t * .pi / 2
            outgoingNode.volume = outgoingVolumeStart * cos(angle)
            incomingNode.volume = targetVolume * sin(angle)

            // Requested: the title/art should switch partway through the
            // crossfade, not only once it's fully done. currentIndex is
            // already flipped to the incoming track the moment the
            // crossfade starts (see advance()) — what was missing is
            // telling JS. PlaybackTrackChanged only fired at the very end
            // (below), so setCurrentTrack() in PlaybackContext.js had
            // nothing to react to until then. Firing it here too, at the
            // halfway point, updates JS's displayed track while leaving
            // getProgress/progressTimer alone — those deliberately keep
            // reading the OUTGOING track's real position via currentFile
            // (see getProgress's comment) until the handoff below actually
            // completes, so the progress bar stays correct the whole time.
            // JS already no-ops a same-track re-fire (currentTrackRef check
            // in PlaybackContext.js), so firing it twice here is harmless.
            if currentStep == steps / 2 {
                self.sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])
            }

            if currentStep >= steps {
                timer.invalidate()
                self.crossfadeFadeTimer = nil
                outgoingNode.stop()
                outgoingNode.volume = targetVolume

                self.activeNode = incomingNode
                self.isCrossfading = false
                self.currentFile = file
                self.currentFileSampleRate = sampleRate
                self.segmentStartOffsetSeconds = 0
                // Same fix as setVolume()/finishLoadingTrack — keeps the
                // INCOMING track's own gain correction in effect for
                // whatever setVolume() calls come after the crossfade
                // finishes, instead of leaving whatever the outgoing
                // track's correction happened to be.
                self.currentGainCorrection = gainCorrection
                // Crossfade never applies silence trim (schedules the full
                // file from frame 0 — see this function's scheduleSegment
                // call above) — reset explicitly rather than leaving
                // whatever the OUTGOING track's trailing cut happened to be,
                // which would otherwise silently apply to this new track's
                // duration reporting too.
                self.currentTrailingCutSeconds = 0
                self.crossfadeIncomingFile = nil
                self.crossfadeIncomingTrack = nil
                self.crossfadeIncomingIndex = nil

                var trackWithDuration = track
                if trackWithDuration.duration == nil {
                    trackWithDuration.duration = Double(file.length) / sampleRate
                    if idx < self.queue.count { self.queue[idx] = trackWithDuration }
                }

                self.sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])
                self.setState(.playing)
                self.startProgressTimer()
                // Handoff just completed — this crossfade's job is done,
                // arm the NEXT one for whatever's now playing (idx here
                // IS the current track already, currentIndex was updated
                // when this crossfade started).
                self.scheduleCrossfadeLeadIn()
            }
        }
        crossfadeFadeTimer = fadeTimer
        RunLoop.main.add(fadeTimer, forMode: .common)
    }

    private func startProgressTimer() {
        progressTimer?.invalidate()
        // Real bug found here: this timer's interval was whatever App.js's
        // progressUpdateEventInterval configured — 1 full second. That's
        // also exactly what feeds checkRampWindow in PlaybackService.js
        // (its NATURAL END-OF-TRACK ramp-out trigger watches for
        // `remaining <= ramp` on every PlaybackProgressUpdated). Ramp
        // durations go as low as 1s on the settings sliders — at 1s
        // polling resolution, a 1-2s ramp window can easily get caught
        // late (say, 0.3s of a 1s window left by the time the next check
        // happens), which then computes a barely-there fade duration and
        // reads as "cuts off early, genuinely zero ramping." This is
        // probabilistic depending on exactly where in the 1s polling cycle
        // the track happens to cross into the window — matches "only
        // sometimes, ~1/3 defective" closely. Firing this timer itself
        // every 0.25s instead (hardcoded here, decoupled from the
        // JS-configurable interval below) gives checkRampWindow 4x the
        // resolution to catch that window accurately, and incidentally
        // sharpens the same precision play-count crediting depends on
        // (also fed by this same event, unrelated to this specific bug).
        // updateNowPlayingInfo() below is throttled separately so this
        // doesn't also mean hammering MPNowPlayingInfoCenter 4x as often —
        // Apple's API isn't meant for sub-second update rates regardless
        // of how often position itself needs checking.
        let tickInterval = min(progressIntervalSeconds, 0.25)
        let nowPlayingInfoEveryNTicks = max(1, Int((progressIntervalSeconds / tickInterval).rounded()))
        var tickCount = 0
        progressTimer = Timer.scheduledTimer(withTimeInterval: tickInterval, repeats: true) { [weak self] _ in
            guard let self = self, self.state == .playing else { return }
            let position = self.currentPositionSeconds()
            // Same fix as getProgress above — derive from currentFile, not
            // queue[currentIndex], so this can't pair mismatched track data
            // during a crossfade's currentIndex-flips-early window either.
            let duration = self.currentFile.map { Double($0.length) / self.currentFileSampleRate - self.currentTrailingCutSeconds }
                ?? (self.currentIndex.flatMap { self.queue[safe: $0]?.duration } ?? 0)
            self.sendEvent(withName: "PlaybackProgressUpdated", body: [
                "position": position,
                "duration": duration,
                "buffered": duration, // local files: fully "buffered" once loaded, no network buffering to report
            ])
            tickCount += 1
            guard tickCount % nowPlayingInfoEveryNTicks == 0 else { return }
            // Real bug found here: updateNowPlayingInfo() only ever ran
            // from setState() — i.e. only on play/pause/track-change, never
            // while just sitting there playing. iOS DOES extrapolate the
            // lock screen's displayed elapsed time on its own between
            // updates (using the elapsed/rate it was last given), but that
            // extrapolation has no way to know about anything that isn't a
            // full state transition — a seek, a ramp landing mid-track, a
            // between-track gain correction, engine drift after a route
            // change. Any of those leaves the OS-side clock and the app's
            // own JS-polled position quietly diverging until the next real
            // state change resyncs them, which reads exactly as "iOS
            // players and our player are desynced." Throttled to roughly
            // once a second (see nowPlayingInfoEveryNTicks above) rather
            // than every 0.25s tick — keeps both sides re-anchored
            // continuously without calling this more than Apple's API is
            // meant for.
            self.updateNowPlayingInfo()
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
        // Real bug: unlike finishLoadingTrack and runCrossfade (both check
        // this before calling play()), this never checked whether `engine`
        // itself was actually running before telling the node to play.
        // Calling AVAudioPlayerNode.play() while the ENGINE isn't running
        // marks the node as wanting to play but produces no audio at all —
        // state still flips to .playing (everything downstream looks
        // correct), it's just silent. handleRouteChange pauses/restarts the
        // engine on a Bluetooth connect or route change and only logs if
        // that restart throws, with nothing to retry it afterward — so a
        // failed restart there leaves the engine permanently not-running
        // until this guard exists. That matches "doesn't unpause once
        // fading finishes" exactly: any pause→play cycle after that silent
        // failure hits this same path, fade timing or not.
        if !engine.isRunning {
            try? engine.start()
        }
        activeNode.play()
        setState(.playing)
        // Resume — reschedule the lead-in timer from the CURRENT position,
        // not whatever was left when it was invalidated on pause below.
        scheduleCrossfadeLeadIn()
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
        //
        // Real bug found here: this never checked for an in-progress
        // crossfade at all. activeNode.pause() below only ever paused the
        // OUTGOING node — the crossfade's own fade timer (a completely
        // separate Timer, not touched by anything in this method) kept
        // running regardless, still actively fading the INCOMING node
        // in — meaning that node kept audibly PLAYING, volume still
        // climbing, for however much of the crossfade duration was left
        // after pause was pressed. That alone is "audio keeps playing
        // after pause with crossfade on." Combine it with JS's OWN
        // pause-ramp (fadeVol, which assumes a fresh 1→0 start and calls
        // setVolume() repeatedly) fighting over the SAME outgoing node's
        // volume property at the same time as the crossfade timer's own
        // per-step write to it, and the result is exactly "ramping up
        // then down" — two independent fades landing conflicting values
        // on the same node in whatever order their timers happened to
        // fire. settleCrossfadeToIncoming ends the crossfade immediately
        // (promoting the incoming node to activeNode at full volume, same
        // as if it had finished naturally) so everything below then
        // operates on ONE settled node instead of two nodes mid-fight.
        if isCrossfading { settleCrossfadeToIncoming() }
        frozenPositionSeconds = currentPositionSeconds()
        activeNode.pause()
        setState(.paused)
        // Don't let a natural-end crossfade fire while paused — playInternal
        // reschedules it from wherever playback actually resumes.
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
    }

    // See pauseInternal's comment above for the bug this fixes — and
    // seekWithinCurrentTrack's, which had the SAME underlying problem for a
    // different reason: seeking used to call the plain
    // cancelCrossfadeIfNeeded(), which stops both crossfade nodes but never
    // promotes the incoming one, leaving activeNode/currentFile pointing at
    // the OUTGOING track while currentIndex already said the incoming one —
    // seeking then rescheduled the WRONG file entirely, while the UI (bound
    // to currentIndex) showed the seek having moved. That's "using the
    // progress bar with crossfade doesn't work at all, it's just visuals."
    // This brings an in-progress crossfade to its completed state
    // immediately instead — the outgoing node stops, the incoming node
    // (already playing) is promoted to activeNode at full target volume,
    // same bookkeeping runCrossfade's own completion does on a normal
    // finish — so whatever called this can then operate on ONE consistent,
    // already-correct node instead of stale crossfade leftovers.
    private func settleCrossfadeToIncoming() {
        guard isCrossfading else { return }
        crossfadeFadeTimer?.invalidate()
        crossfadeFadeTimer = nil
        guard let outgoingNode = activeNode, let file = crossfadeIncomingFile, let idx = crossfadeIncomingIndex else {
            // The crossfade was still on its async file-load (started in
            // startCrossfade, hasn't reached runCrossfade yet) when this
            // ran — nothing to hand off to yet. Bumping the token here is
            // what actually stops it: startCrossfade's completion checks
            // `token == self.playbackToken` before ever calling
            // incomingNode.play(), so without this the load would still
            // complete a moment later and start playing anyway, ignoring
            // whatever just interrupted it (pause or seek).
            playbackToken &+= 1
            isCrossfading = false
            return
        }
        let incomingNode = idleNode
        outgoingNode.stop()
        outgoingNode.volume = crossfadeTargetVolume
        incomingNode.volume = crossfadeTargetVolume

        activeNode = incomingNode
        isCrossfading = false
        // Same fix as runCrossfade's own handoff — keeps the INCOMING
        // track's gain correction in effect for setVolume() calls after
        // this (a pause or seek interrupting the crossfade), instead of
        // leaving whatever the outgoing track's correction was.
        currentGainCorrection = crossfadeIncomingGainCorrection
        currentFile = file
        currentFileSampleRate = crossfadeIncomingSampleRate
        segmentStartOffsetSeconds = 0
        // Same reset as runCrossfade's own handoff — see its comment.
        currentTrailingCutSeconds = 0

        if var trackWithDuration = crossfadeIncomingTrack {
            if trackWithDuration.duration == nil {
                trackWithDuration.duration = Double(file.length) / crossfadeIncomingSampleRate
                if idx < queue.count { queue[idx] = trackWithDuration }
            }
            // Covers landing here before runCrossfade's own halfway-point
            // announcement ever fired — JS still needs to know the track
            // changed. Harmless if it already fired; JS de-dupes by queue
            // slot (see PlaybackContext.js's PlaybackTrackChanged listener).
            sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])
        }

        crossfadeIncomingFile = nil
        crossfadeIncomingTrack = nil
        crossfadeIncomingIndex = nil
    }

    private func stopInternal() {
        cancelCrossfadeIfNeeded()
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
        playbackToken &+= 1
        activeNode.stop()
        progressTimer?.invalidate()
        setState(.stopped)
        deactivateSession()
    }

    private func skipToNextInternal() {
        advance(direction: 1, wrap: repeatMode == .queue, autoPlay: true, isManualSkip: true)
    }

    private func skipToPreviousInternal() {
        advance(direction: -1, wrap: repeatMode == .queue, autoPlay: true, isManualSkip: true)
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
        cancelCrossfadeIfNeeded()
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
        guard let idx = currentIndex, idx >= 0, idx < queue.count, currentFile != nil else {
            loadAndScheduleCurrentTrack(startAtSeconds: startAtSeconds, autoPlay: autoPlay)
            return
        }
        _ = idx
        // Was cancelCrossfadeIfNeeded() here — see settleCrossfadeToIncoming's
        // comment for why that specifically broke seeking during a
        // crossfade (rescheduled the wrong, outgoing file while currentIndex
        // already pointed at the incoming one). Real bug in an earlier
        // version of THIS fix too, caught on review: `file` was captured
        // from currentFile at the top of this function, BEFORE this call —
        // settleCrossfadeToIncoming reassigns self.currentFile to the
        // incoming track's file, but a `let` binding taken before that
        // doesn't retroactively follow the reassignment, so the seek below
        // would have still scheduled the stale outgoing file regardless.
        // currentFile is re-read below, after settling, not captured here.
        settleCrossfadeToIncoming()
        guard let file = currentFile else {
            // Shouldn't happen — settleCrossfadeToIncoming only clears
            // currentFile if there was nothing to hand off to, which
            // implies isCrossfading was already false, which means this
            // guard's currentFile check above would have already caught a
            // genuinely nil currentFile before we ever got here.
            loadAndScheduleCurrentTrack(startAtSeconds: startAtSeconds, autoPlay: autoPlay)
            return
        }
        // A seek changes how much of the track is left, so any lead-in
        // timer armed for the OLD position is now wrong — could fire far
        // too early (seeking backward) or have already fired its window
        // (seeking forward past it). Rescheduled below once the new
        // position is committed.
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
        segmentStartOffsetSeconds = startAtSeconds
        activeNode.stop()
        playbackToken &+= 1
        let token = playbackToken

        let startFrame = AVAudioFramePosition(startAtSeconds * currentFileSampleRate)
        // Real bug found here: didn't subtract currentTrailingCutSeconds at
        // all — a seek used to always reschedule to the RAW end of the
        // file, silently un-trimming a silence-trimmed track's tail the
        // moment you dragged the progress bar even once. Beyond just
        // playing trailing silence that shouldn't be there, this would
        // have newly contradicted the duration fix above (which now
        // reports the TRIMMED length everywhere) — the schedule and the
        // reported duration need to agree on where the track actually
        // ends, or checkRampWindow's natural-end trigger is right back to
        // being wrong, just via a different path than before.
        let trailingCutFrames = AVAudioFramePosition(currentTrailingCutSeconds * currentFileSampleRate)
        let frameCount = AVAudioFrameCount(max(0, file.length - startFrame - trailingCutFrames))

        if frameCount > 0 {
            activeNode.scheduleSegment(file, startingFrame: startFrame, frameCount: frameCount, at: nil) { [weak self] in
                DispatchQueue.main.async {
                    self?.handlePlaybackCompleted(token: token)
                }
            }
        } else {
            // Same gap, same fix as loadAndScheduleCurrentTrack's matching
            // branch — a seek landing past the trimmed end needs to trigger
            // the natural-completion path directly, since nothing gets
            // scheduled for its own completion handler to ever fire.
            DispatchQueue.main.async { [weak self] in
                self?.handlePlaybackCompleted(token: token)
            }
        }

        if autoPlay {
            activeNode.play()
            setState(.playing)
            scheduleCrossfadeLeadIn()
        } else {
            setState(.ready)
        }
    }

    @objc(setVolume:resolver:rejecter:)
    func setVolume(_ vol: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        volume = vol.floatValue
        // Was `activeNode.volume = volume` — see currentGainCorrection's
        // comment for why that silently discarded Match Volume Between
        // Songs' correction on every single call. `volume` itself stays
        // the plain 0–1 value JS's ramp math expects (getVolume() below is
        // unchanged) — the correction is applied on top only when actually
        // writing to the audio engine.
        activeNode.volume = volume * currentGainCorrection
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
        //
        // Also subtracts currentTrailingCutSeconds now — same silence-trim
        // duration bug as loadAndScheduleCurrentTrack's cached-duration fix
        // (see its comment), just also needed here since this computes
        // fresh from currentFile rather than reading that cached value.
        let duration = currentFile.map { Double($0.length) / currentFileSampleRate - currentTrailingCutSeconds }
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

    // Toggling .bypass on an AVAudioUnitEffect while audio is actively
    // flowing through it is a well-known click/pop source — the unit's
    // internal DSP state (the Dynamics Processor's attack/release envelope
    // history) gets abruptly cut in or out of the signal path mid-stream,
    // which is exactly what "pops like plugging in an audio device"
    // describes. Ducking preMixNode (shared downstream of both player
    // nodes) briefly around the toggle means the discontinuity happens
    // while the signal is silent instead of live.
    private func toggleNormalizerBypass(_ bypassed: Bool) {
        // Widened from 15ms/40ms — the pop was specifically reported on the
        // OFF direction (normalizer active → bypassed), which makes sense:
        // turning bypass ON abruptly discards whatever gain reduction the
        // Dynamics Processor was actively applying at that instant, a
        // bigger signal discontinuity than the OFF→ON direction (which
        // starts the DSP fresh at zero reduction). The original duck
        // window was probably just too short to fully mask that specific
        // case. This is a width increase, not a fix for a specific
        // diagnosed cause — couldn't confirm the exact mechanism without
        // device audio to inspect.
        let duckMs = 40.0
        let settleMs = 80.0
        let startVol = preMixNode.outputVolume
        let steps = 8
        for i in 0...steps {
            let delay = duckMs * Double(i) / Double(steps) / 1000.0
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.preMixNode.outputVolume = startVol * Float(1 - Double(i) / Double(steps))
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + duckMs / 1000.0) { [weak self] in
            self?.normalizerNode.bypass = bypassed
        }
        for i in 0...steps {
            let delay = (duckMs + settleMs) / 1000.0 + (duckMs * Double(i) / Double(steps) / 1000.0)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.preMixNode.outputVolume = startVol * Float(Double(i) / Double(steps))
            }
        }
    }

    @objc(setNormalizationEnabled:resolver:rejecter:)
    func setNormalizationEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        toggleNormalizerBypass(!enabled.boolValue)
        resolve(nil)
    }

    @objc(setCrossfadeEnabled:resolver:rejecter:)
    func setCrossfadeEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        crossfadeEnabled = enabled.boolValue
        resolve(nil)
    }

    @objc(setCrossfadeDuration:resolver:rejecter:)
    func setCrossfadeDuration(_ seconds: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        crossfadeDurationSkipSeconds = max(0, seconds.doubleValue)
        resolve(nil)
    }

    @objc(setCrossfadeDurationEndOfTrack:resolver:rejecter:)
    func setCrossfadeDurationEndOfTrack(_ seconds: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        crossfadeDurationEndOfTrackSeconds = max(0, seconds.doubleValue)
        resolve(nil)
    }

    // Renamed on the JS side to make clear this is the per-track dynamics
    // compressor (WITHIN a track), as distinct from setBetweenTrackNormEnabled
    // below (loudness matching ACROSS tracks) — see PreferencesContext.js.
    @objc(setWithinTrackNormEnabled:resolver:rejecter:)
    func setWithinTrackNormEnabled(_ enabled: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        toggleNormalizerBypass(!enabled.boolValue)
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
