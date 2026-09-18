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
    // Drives rampVolume(from:to:duration:) below — a single native-side
    // timer instead of JS calling setVolume() ~25x/sec over the bridge.
    // rampGeneration invalidates any in-flight ramp the instant a NEWER one
    // starts (or setVolume()/cancelVolumeRamp() is called directly) without
    // needing the timer to notice on its own next tick — the tick itself
    // checks this before writing anything. pendingRampResolve is kept so a
    // superseded ramp's JS promise can be resolved immediately instead of
    // left hanging forever (the caller `await`s it).
    private var rampTimer: Timer?
    private var rampGeneration: UInt64 = 0
    private var pendingRampResolve: RCTPromiseResolveBlock?
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
    private var crossfadeIncomingNode: AVAudioPlayerNode?
    // Real bug found here: PlaybackTrackChanged fires at the crossfade's
    // halfway point (see runCrossfade below) so title/cover switch without
    // waiting for the whole multi-second crossfade to finish — but
    // position/duration (getProgress, the progress timer) deliberately kept
    // reporting the OUTGOING track's numbers until the actual node handoff
    // completes at the very end. That's correct in isolation (position
    // matches whichever file is actually still playing through activeNode)
    // but WRONG paired with the track identity JS now has from that early
    // announcement — for the whole second half of every crossfade, JS knew
    // "current track = the incoming song" while position/duration still
    // described the outgoing one. Anything matching lyrics or the progress
    // bar to "the current track" during that window was matching the wrong
    // song's timeline. Set true right when that halfway announcement
    // fires; currentPositionSeconds/getProgress/the progress timer check
    // this to switch to reporting the INCOMING node's own elapsed time
    // instead, closing the gap between what JS is told the track is and
    // what position it's given for it.
    private var crossfadeAnnouncedIncoming: Bool = false
    private var crossfadeTargetVolume: Float = 1
    // Raw gain correction alone (crossfadeTargetVolume above is volume ×
    // this, already multiplied together) — settleCrossfadeToIncoming needs
    // the unmultiplied value to correctly set currentGainCorrection for
    // whatever setVolume() calls come after a pause/seek interrupts a
    // crossfade partway through.
    private var crossfadeIncomingGainCorrection: Float = 1.0
    // Mirrors crossfadeIncomingGainCorrection above — same reasoning, now
    // that crossfade actually applies Silence Trim to the incoming track
    // (see startCrossfade/runCrossfade). settleCrossfadeToIncoming (a
    // pause/seek landing mid-crossfade) needs these too, not just the
    // normal full-duration timer completion in runCrossfade.
    private var crossfadeIncomingLeadInSeconds: Double = 0
    private var crossfadeIncomingTrailingCutSeconds: Double = 0

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
        // Apple's DynamicsProcessor stock defaults (~-20dB threshold, a
        // ~0.1ms near-instant attack, and a 2:1 downward expander below
        // -80dB) are tuned more for broadcast/voice leveling than
        // transparent music normalization — that near-instant attack in
        // particular audibly "pumps"/breathes on transients (kicks,
        // plosives), and the expander fights the exact thing Volume
        // Normalization is trying to do (keep quiet passages audible), not
        // helping it. Matches "volume normalization sounds weird." Gentler,
        // more transparent settings: raise the threshold so it only
        // engages on genuinely loud peaks instead of constantly reshaping
        // the whole track, slow the attack down enough to not react to
        // individual transients, and disable the expander entirely.
        // audioUnit is a non-optional AudioUnit on this SDK (not AudioUnit?),
        // so no `if let` here — that's exactly what failed to build.
        // kDynamicsProcessorParam_MasterGain is also gone in Swift (renamed
        // to kDynamicsProcessorParam_OverallGain — the old symbol still
        // exists in the ObjC/C headers but is marked unavailable in Swift).
        let unit = normalizerNode.audioUnit
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_Threshold, kAudioUnitScope_Global, 0, -12.0, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_HeadRoom, kAudioUnitScope_Global, 0, 5.0, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_ExpansionRatio, kAudioUnitScope_Global, 0, 1.0, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_AttackTime, kAudioUnitScope_Global, 0, 0.02, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_ReleaseTime, kAudioUnitScope_Global, 0, 0.15, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_OverallGain, kAudioUnitScope_Global, 0, 0.0, 0)

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
            self?.optimisticallySetPlaybackRate(1.0)
            self?.sendEvent(withName: "RemotePlay", body: nil)
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.optimisticallySetPlaybackRate(0.0)
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
        if let image = UIImage(contentsOfFile: artworkPath.replacingOccurrences(of: "file://", with: "")) {
            return image
        }
        // Real bug found here — specific to sideloaded (SideStore/LiveContainer)
        // installs. See Settings' own "Known issue" note: on some SideStore
        // installs, the Documents folder JS resolves through expo-file-system
        // (this artwork path's origin — see embeddedArt.js) points at a
        // DIFFERENT container UUID than what THIS native code's own sandbox
        // resolves "Documents" to. The path JS hands over is a perfectly real
        // file that genuinely exists — just not at that exact absolute path
        // from this process's actual, current sandbox perspective. RN's own
        // <Image> component still shows it fine in-app because it goes
        // through that same JS-side resolution, consistently — only this
        // native-side load (used for the lock screen/Control Center) sees
        // the mismatch. That matches "covers work in-app but never show up
        // outside the app" exactly — for every song, not just some, since
        // it's an environment-level path mismatch, not anything song-
        // specific. Last resort: re-anchor anything under a "Documents/"
        // segment to this process's own real Documents directory instead of
        // trusting the absolute path JS provided.
        if let range = artworkPath.range(of: "/Documents/"),
           let realDocs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            let relative = String(artworkPath[range.upperBound...])
            let rebased = realDocs.appendingPathComponent(relative)
            if let image = UIImage(contentsOfFile: rebased.path) {
                return image
            }
        }
        return nil
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

    // Play/pause from the lock screen/Control Center are ramp-aware and go
    // through JS (see the RemotePlay/RemotePause comment above) — a real
    // round trip through the bridge, not a same-frame native state change.
    // Without this, the lock screen's own play/pause icon only updates once
    // that whole round trip finishes and setState() runs — checked via
    // screen recording, and it was visibly laggy, holding the old icon for
    // a beat after tapping. This just flips the rate iOS displays
    // immediately on tap; setState()'s own update a moment later confirms
    // (or corrects, if JS ends up not honoring it for some reason) it once
    // the real ramp actually starts.
    private func optimisticallySetPlaybackRate(_ rate: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

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
                // Real bug found here: on failure this still set
                // cachedArtworkPath = artworkPath below, permanently —
                // the very next check above would see the path as
                // "already cached" and never try loading it again, even
                // though cachedArtwork was nil. If JS calls
                // updateMetadataForTrack with the artwork path slightly
                // before the actual file exists on disk (embedded-art
                // extraction is async), that first failed load became
                // the FINAL answer for that track — lock screen/Control
                // Center artwork for it, forever. Only advance
                // cachedArtworkPath on a successful load now, so a
                // failure just leaves it retrying (still throttled to
                // ~once/sec by the caller) instead of giving up for good.
                if let image = loadArtworkImage(artworkPath) {
                    cachedArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    cachedArtworkPath = artworkPath
                } else {
                    cachedArtwork = nil
                }
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
        // V2 — bumped so every device abandons whatever it cached under the
        // old key instead of trusting stale results computed before the
        // over-trimming clamp fix right above analyzeFile's trailing scan.
        // Same file, same size, but a materially different (and wrong, for
        // whichever files hit that bug) trailingCutSeconds — file size
        // alone as a cache key can't tell the two apart, so the only safe
        // option is to stop reading the old entries at all.
        guard let data = UserDefaults.standard.data(forKey: "SySlateFileAnalysisCacheV2"),
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
            UserDefaults.standard.set(data, forKey: "SySlateFileAnalysisCacheV2")
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

        func rms(atFrame frame: AVAudioFramePosition, chunkFrames: AVAudioFrameCount = 4096) -> Float? {
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
            // Real bug found here (direct feedback: progress bar "just
            // didn't work at all... may have worked on some songs" — plus
            // "songs sometimes cut off early... make sure it works
            // perfectly with trim silence"): for any file shorter than the
            // 20s scan cap, trailCap collapses to 0, which means the
            // starting default above — before either loop finds real
            // sound — is trailingCutFrames = totalFrames, i.e. the file's
            // ENTIRE length. A short track that's quiet enough for even a
            // few chunks to read as "silent" near the tail (not silent
            // enough to be wrong to trim SOME of, just enough for the scan
            // to occasionally never hit the exact chunk containing where
            // sound picks back up before running out of frames to check)
            // could keep that full-length default instead of ever
            // overwriting it — reported duration then computes to file
            // length minus its own full length: ~0 or, with leadIn
            // overlapping the same range too, genuinely negative.
            // currentDurationSeconds()/currentPositionSeconds() both feed
            // straight from this, so a duration of ~0 makes `duration > 0`
            // false forever for that track (progress bar never starts
            // moving — matches "may have worked on some songs" exactly,
            // since it only bites short/quiet tracks), and separately,
            // trimming virtually the whole file plays as "cuts off early"
            // in the most literal sense possible. Clamped here so lead-in
            // and trailing cut combined can never eat more than the file
            // has, always leaving at least a floor of real playable audio
            // regardless of what the scan concluded.
            let minPlayableFrames = AVAudioFramePosition(sampleRate * 1) // always leave at least 1s playable
            let maxCombinedCut = max(0, totalFrames - minPlayableFrames)
            if leadInFrames + trailingCutFrames > maxCombinedCut {
                // Scale both down proportionally rather than just capping
                // trailingCutFrames alone — preserves whichever one found a
                // more confident (shorter scan) result relative to the
                // other instead of always sacrificing the same side.
                let totalCut = leadInFrames + trailingCutFrames
                let scale = Double(maxCombinedCut) / Double(totalCut)
                leadInFrames = AVAudioFramePosition(Double(leadInFrames) * scale)
                trailingCutFrames = AVAudioFramePosition(Double(trailingCutFrames) * scale)
            }
        }

        var gain: Float = 1.0
        if betweenTrackNormEnabled, totalFrames > 0 {
            // Was 12 samples of a 4096-frame chunk each — ~93ms per sample,
            // ~1.1s of actual audio measured out of a whole song. That's
            // small enough to easily land unrepresentatively (a quiet
            // bridge, one loud chorus hit) and skew the average either way
            // — "make Match Volume more accurate" tracks directly to this:
            // more, and longer, sample windows make the average far less
            // sensitive to any single point landing somewhere unusual, for
            // a trivial extra cost (still only reading a small fraction of
            // the file — 30 * 16384 frames is ~11s of audio out of a whole
            // song, and read/decoded, not the whole file).
            let sampleCount = 30
            let sampleChunkFrames: AVAudioFrameCount = 16384
            var rmsSum: Float = 0
            var rmsSamples = 0
            for i in 0..<sampleCount {
                let framePos = AVAudioFramePosition(Double(totalFrames) * (Double(i) + 0.5) / Double(sampleCount))
                if let r = rms(atFrame: framePos, chunkFrames: sampleChunkFrames), r > 0.0005 { // skip near-silent chunks so they don't drag the average down
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
        // Once the halfway announcement has told JS the current track is
        // the INCOMING one (crossfadeAnnouncedIncoming), report ITS elapsed
        // time instead of activeNode's (still the outgoing track until the
        // handoff completes at the end of the crossfade) — see
        // crossfadeAnnouncedIncoming's declaration for the sync bug this
        // fixes. Was assuming the incoming node always starts at frame 0 —
        // no longer true now that crossfade applies Silence Trim's lead-in
        // to it (see startCrossfade/runCrossfade); crossfadeIncomingLeadInSeconds
        // is that same offset, playing the same role segmentStartOffsetSeconds
        // plays for activeNode's calculation just below.
        if isCrossfading, crossfadeAnnouncedIncoming, let incoming = crossfadeIncomingNode,
           let nodeTime = incoming.lastRenderTime, let playerTime = incoming.playerTime(forNodeTime: nodeTime) {
            return crossfadeIncomingLeadInSeconds + Double(playerTime.sampleTime) / crossfadeIncomingSampleRate
        }
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
                // Real bug found here: analyzeFile used to run INSIDE
                // finishLoadingTrack, which runs on the main thread — for
                // a file analyzeFile hasn't cached yet (see its cache
                // check), that's a synchronous PCM scan of real audio data
                // (up to 20s sampled from each end for Silence Trim, 12
                // sample points across the whole file for Match Volume)
                // happening directly on the main thread, freezing the UI
                // and dropping touch input for however long the scan
                // takes. startCrossfade already does this analysis off
                // the main thread for exactly this reason (see its own
                // comment) — this was the one remaining place it still
                // ran synchronously, on EVERY plain track load/skip/
                // natural-advance when either Silence Trim or Match
                // Volume is on, which is "the app lags and drops all
                // inputs with audio ramping" (ramping's plain skip/advance
                // path goes through here, not through startCrossfade).
                let analysis: FileAnalysis? = (self?.silenceTrimEnabled == true || self?.betweenTrackNormEnabled == true)
                    ? self?.analyzeFile(file, path: track.url.path) : nil
                DispatchQueue.main.async {
                    guard let self = self, token == self.playbackToken else { return } // superseded by a newer load
                    self.finishLoadingTrack(file: file, track: track, idx: idx, startAtSeconds: startAtSeconds, autoPlay: autoPlay, announceChange: announceChange, token: token, precomputedAnalysis: analysis)
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

    private func finishLoadingTrack(file: AVAudioFile, track: Track, idx: Int, startAtSeconds: Double, autoPlay: Bool, announceChange: Bool, token: UInt64, precomputedAnalysis: FileAnalysis?) {
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
            // Now computed by the caller, off the main thread, before this
            // function ever runs — see loadAndScheduleCurrentTrack's
            // comment. precomputedAnalysis is nil exactly when neither
            // feature is on, same condition this used to check itself.
            if let analysis = precomputedAnalysis {
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
            // Real bug found here: this only filled `duration` in when it
            // was nil, i.e. only for tracks JS hadn't already tagged with
            // one — meaning queue[idx].duration was the JS/tag-reported
            // value for basically every normal track, UNCHECKED against
            // the real file we just loaded. For a file with an inaccurate
            // tag duration (common on certain VBR-encoded files with a
            // missing/wrong Xing header), that mismatched value is exactly
            // what scheduleCrossfadeLeadIn() uses to compute `remaining` —
            // so a track like this either arms its crossfade at the wrong
            // moment or never arms it at all, and playback instead falls
            // through to the raw native completion handler, well after
            // (or before) the UI's own displayed duration (which already
            // came from this same real file, not the tag) said it should.
            // Always overwriting with the just-measured value — instead of
            // only when nil — keeps every duration-dependent computation
            // (this scheduler, the natural-end-of-track ramp trigger, the
            // minimum-length-for-crossfade rule) reading the exact same
            // real number the screen is already showing, tag data aside.
            trackWithDuration.duration = Double(file.length) / file.processingFormat.sampleRate - trailingCutSeconds
            if idx < queue.count { queue[idx] = trackWithDuration }

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
        crossfadeIncomingNode = nil
        crossfadeAnnouncedIncoming = false
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
        // Added: guard against the INCOMING track itself being too short for
        // the configured crossfade duration to make sense on — e.g.
        // crossfading over 4s into a 3s clip means the crossfade is still
        // ramping up after the track has already naturally ended.
        // scheduleCrossfadeLeadIn already guards the OUTGOING side (won't
        // even arm the lead-in timer if too little of the current track is
        // left — see its own fireIn > 0.1 check); this is the missing other
        // half. Minimum: the incoming track needs to be at least double the
        // crossfade duration, same "double the longest duration" rule
        // requested for ramping generally.
        let incomingDuration = queue[newIndex].duration ?? 0
        let incomingLongEnough = incomingDuration <= 0 || incomingDuration >= crossfadeDuration * 2
        if crossfadeEnabled, crossfadeDuration > 0.05, incomingLongEnough, autoPlay, direction == 1, !isCrossfading, state == .playing {
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
                    // Real bug found here (Eric: songs needing Silence Trim
                    // "didn't handle crossfade... properly, mainly when
                    // clicking"): this only ever pulled gainCorrection out
                    // of the analysis — leadInSeconds/trailingCutSeconds
                    // were computed (when Silence Trim is on) and then just
                    // discarded, so crossfading INTO a track with a
                    // silence-trimmed lead-in used to fade all the way up
                    // to volume 1 over several seconds of literal silence
                    // before any real audio started. Now passed through so
                    // runCrossfade can actually apply the trim, same as a
                    // plain load already does.
                    let leadIn = self.silenceTrimEnabled ? (analysis?.leadInSeconds ?? 0) : 0
                    let trailingCut = self.silenceTrimEnabled ? (analysis?.trailingCutSeconds ?? 0) : 0
                    self.runCrossfade(file: file, track: track, idx: idx, outgoingNode: outgoingNode, incomingNode: incomingNode, outgoingVolumeStart: outgoingVolumeStart, gainCorrection: analysis?.gainCorrection ?? 1.0, leadInSeconds: leadIn, trailingCutSeconds: trailingCut, duration: duration, token: token)
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

    private func runCrossfade(file: AVAudioFile, track: Track, idx: Int, outgoingNode: AVAudioPlayerNode, incomingNode: AVAudioPlayerNode, outgoingVolumeStart: Float, gainCorrection: Float, leadInSeconds: Double, trailingCutSeconds: Double, duration: Double, token: UInt64) {
        let sampleRate = file.processingFormat.sampleRate
        incomingNode.stop()
        // Same lead-in/trailing-cut math loadAndScheduleCurrentTrack uses —
        // see startCrossfade's comment for why this used to always be
        // startingFrame: 0 / the full file length regardless of Silence
        // Trim.
        let startFrame = AVAudioFramePosition(leadInSeconds * sampleRate)
        let trailingCutFrames = AVAudioFramePosition(trailingCutSeconds * sampleRate)
        let frameCount = AVAudioFrameCount(max(0, file.length - startFrame - trailingCutFrames))
        incomingNode.scheduleSegment(file, startingFrame: startFrame, frameCount: frameCount, at: nil) { [weak self] in
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
        crossfadeIncomingNode = incomingNode
        crossfadeIncomingLeadInSeconds = leadInSeconds
        crossfadeIncomingTrailingCutSeconds = trailingCutSeconds
        crossfadeAnnouncedIncoming = false
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
            // reading the OUTGOING track's real position via currentFile —
            // NO LONGER how this works, see crossfadeAnnouncedIncoming's
            // declaration for why that was actually a bug (position/lyrics
            // sync mismatch), fixed by flipping this flag right here so
            // getProgress/the progress timer switch to the INCOMING node's
            // own position from this exact moment instead.
            // JS already no-ops a same-track re-fire (currentTrackRef check
            // in PlaybackContext.js), so firing it twice here is harmless.
            if currentStep == steps / 2 {
                self.sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])
                self.crossfadeAnnouncedIncoming = true
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
                self.crossfadeAnnouncedIncoming = false
                // Same fix as setVolume()/finishLoadingTrack — keeps the
                // INCOMING track's own gain correction in effect for
                // whatever setVolume() calls come after the crossfade
                // finishes, instead of leaving whatever the outgoing
                // track's correction happened to be.
                self.currentGainCorrection = gainCorrection
                // Now applies the incoming track's real trim (see
                // startCrossfade/runCrossfade above) instead of always
                // resetting to 0 — this is that same value, just kept
                // through to the moment the incoming node actually becomes
                // `current`, matching what a plain load already does at an
                // equivalent point (loadAndScheduleCurrentTrack).
                self.currentTrailingCutSeconds = trailingCutSeconds
                self.segmentStartOffsetSeconds = leadInSeconds
                self.crossfadeIncomingFile = nil
                self.crossfadeIncomingTrack = nil
                self.crossfadeIncomingIndex = nil
                self.crossfadeIncomingNode = nil

                var trackWithDuration = track
                // Same fix as loadAndScheduleCurrentTrack's equivalent —
                // always trust the just-measured real duration over
                // whatever JS/tag value was there, not just when nil.
                trackWithDuration.duration = Double(file.length) / sampleRate - trailingCutSeconds
                if idx < self.queue.count { self.queue[idx] = trackWithDuration }

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
            // Now shares getProgress's currentDurationSeconds() helper —
            // includes the crossfade-mid-announcement branch too, see its
            // comment.
            let duration = self.currentDurationSeconds()
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
            crossfadeIncomingNode = nil
            crossfadeAnnouncedIncoming = false
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
        // Now uses the incoming track's real lead-in/trailing-cut instead
        // of always 0 — same fix as runCrossfade's own handoff, needed here
        // too since a pause or seek landing mid-crossfade completes the
        // handoff through this function instead.
        segmentStartOffsetSeconds = crossfadeIncomingLeadInSeconds
        currentTrailingCutSeconds = crossfadeIncomingTrailingCutSeconds

        if var trackWithDuration = crossfadeIncomingTrack {
            // Same fix as loadAndScheduleCurrentTrack's equivalent —
            // always trust the just-measured real duration over whatever
            // JS/tag value was there, not just when nil.
            trackWithDuration.duration = Double(file.length) / crossfadeIncomingSampleRate - crossfadeIncomingTrailingCutSeconds
            if idx < queue.count { queue[idx] = trackWithDuration }
            // Covers landing here before runCrossfade's own halfway-point
            // announcement ever fired — JS still needs to know the track
            // changed. Harmless if it already fired; JS de-dupes by queue
            // slot (see PlaybackContext.js's PlaybackTrackChanged listener).
            sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": idx])
        }

        crossfadeIncomingFile = nil
        crossfadeIncomingTrack = nil
        crossfadeIncomingIndex = nil
        crossfadeIncomingNode = nil
        crossfadeAnnouncedIncoming = false
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
        // Real bug found here: this always hard-cancelled any crossfade
        // and force-reloaded, regardless of the Crossfade setting —
        // jumping straight to an arbitrary song in the queue (tapping it
        // in a song list, or in the Up Next sheet) never crossfaded even
        // with Crossfade on and something already playing, unlike a
        // plain next/previous skip. startCrossfade(toIndex:duration:) is
        // already index-agnostic (advance() below only ever calls it for
        // idx+1, but it works for any target still in the current
        // queue), so route through it here too under the same conditions
        // a manual skip uses.
        if crossfadeEnabled, crossfadeDurationSkipSeconds > 0.05, !isCrossfading, state == .playing, idx != currentIndex {
            currentIndex = idx
            startCrossfade(toIndex: idx, duration: crossfadeDurationSkipSeconds)
            resolve(nil)
            return
        }
        cancelCrossfadeIfNeeded()
        currentIndex = idx
        loadAndScheduleCurrentTrack(autoPlay: true)
        resolve(nil)
    }

    // Real bug found here (there wasn't a fix for it before — this method
    // didn't exist): restoreSession (PlaybackContext.js, cold app launch)
    // had no way to get a specific track actually loaded/cued without
    // ALSO forcing playback. skip() is the only other way to make
    // loadAndScheduleCurrentTrack run, and it hardcodes autoPlay: true —
    // using it here would blast audio the instant the app opens, every
    // time. seekTo()'s own "not loaded yet" fallback looks like it should
    // cover this (it calls loadAndScheduleCurrentTrack when currentFile is
    // nil), but that fallback requires currentIndex to ALREADY be set —
    // and at a cold launch, after primeNativeQueue's reset()+add(),
    // nothing had EVER set it. The whole restore chain (primeNativeQueue →
    // wait for a real duration → seekTo → its fallback → loadAndSchedule
    // CurrentTrack) was a dead end: loadAndScheduleCurrentTrack's own guard
    // (`guard let idx = currentIndex ... else { setState(.stopped); return }`)
    // silently no-ops whenever currentIndex is nil, so cold-launch restore
    // never actually loaded a file — the getProgress() duration-polling
    // loop in restoreSession would just spin for its full 4s timeout doing
    // nothing, and the very first tap of the plain Play button afterward
    // (playInternal's own nil-currentIndex fallback) would start the
    // native queue's index 0 from 0:00, NOT last.position, regardless of
    // which track/position was actually being restored. This is
    // deliberately its own method rather than adding an autoPlay param to
    // skip() — skip()'s every other call site (manual skip, jumpToQueueIndex,
    // primeQueueForTransition's crossfade branch) legitimately wants the
    // existing always-autoplay behavior and its crossfade handling; a
    // cold-launch restore should never crossfade (nothing was already
    // playing) and needs autoPlay controllable, so a separate, simpler
    // method is lower-risk than changing skip()'s signature/behavior for
    // every existing caller.
    @objc(load:autoPlay:resolver:rejecter:)
    func load(_ index: NSNumber, autoPlay: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let idx = index.intValue
        guard idx >= 0, idx < queue.count else { resolve(nil); return }
        cancelCrossfadeIfNeeded()
        currentIndex = idx
        loadAndScheduleCurrentTrack(autoPlay: autoPlay.boolValue)
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
        // A direct setVolume call always means "I want this volume NOW" —
        // cancel any ramp still in flight so it can't win a race and
        // overwrite this a moment later on its next tick. Resolves the
        // superseded ramp's own promise (not reject) so whatever JS code is
        // still awaiting it doesn't hang.
        cancelActiveRampLocked()
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

    // Invalidates whatever ramp (if any) currently owns rampTimer and
    // immediately resolves its promise — shared by setVolume, cancelVolumeRamp,
    // and rampVolume itself (a new ramp starting supersedes the old one the
    // same way a direct setVolume does). Must only be called on the main
    // thread/queue, same as everything else touching activeNode.
    private func cancelActiveRampLocked() {
        rampTimer?.invalidate()
        rampTimer = nil
        rampGeneration &+= 1
        if let prevResolve = pendingRampResolve {
            pendingRampResolve = nil
            prevResolve(nil)
        }
    }

    // Replaces JS's old ~25-steps/sec loop of individual setVolume() bridge
    // calls (see PlaybackService.js's fadeVol) with ONE bridge call that
    // drives the whole ramp natively via a single Timer. Two real problems
    // that loop had on-device, especially under any JS-thread/bridge load
    // (a sideloaded/LiveContainer build has no reason to be faster than a
    // normal build here): (1) each step is its own async round-trip, so if
    // the bridge falls behind, steps bunch up or land late — audible as
    // "cuts up and down" / stutter rather than a smooth curve; (2) it's ~25x
    // the bridge traffic of this for the exact same audible result. Running
    // the timer here means the ramp's timing is immune to whatever the JS
    // thread is doing at that moment. Same raised-cosine ("S-curve") easing
    // as before — eases both ends, moves fastest through the middle, reads
    // as smoother than linear because loudness perception is roughly
    // logarithmic, not linear.
    @objc(rampVolume:to:duration:resolver:rejecter:)
    func rampVolume(_ from: NSNumber, to: NSNumber, duration: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        cancelActiveRampLocked()
        let fromVal = max(0, min(1, from.floatValue))
        let toVal = max(0, min(1, to.floatValue))
        let dur = max(0, duration.doubleValue)

        volume = fromVal
        activeNode.volume = fromVal * currentGainCorrection

        if dur <= 0.02 {
            volume = toVal
            activeNode.volume = toVal * currentGainCorrection
            resolve(nil)
            return
        }

        rampGeneration &+= 1
        let myGeneration = rampGeneration
        pendingRampResolve = resolve
        let start = Date()
        // 1/60s tick — smooth without being any more bridge/CPU traffic
        // than a single scheduled Timer regardless of interval; the actual
        // volume math is trivial.
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] t in
            guard let self = self, self.rampGeneration == myGeneration else { t.invalidate(); return }
            let elapsed = Date().timeIntervalSince(start)
            let progress = min(1.0, dur > 0 ? elapsed / dur : 1.0)
            let eased = Float((1 - cos(progress * Double.pi)) / 2)
            let v = fromVal + (toVal - fromVal) * eased
            self.volume = v
            self.activeNode.volume = v * self.currentGainCorrection
            if progress >= 1.0 {
                t.invalidate()
                if self.rampGeneration == myGeneration {
                    self.rampTimer = nil
                    self.pendingRampResolve = nil
                }
                resolve(nil)
            }
        }
        rampTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    // Lets JS cancel a ramp without also forcing a specific final volume
    // (setVolume() does both at once) — not currently called from JS but
    // kept as an explicit escape hatch alongside rampVolume rather than
    // relying only on the implicit cancel-on-next-setVolume behavior.
    @objc(cancelVolumeRamp:rejecter:)
    func cancelVolumeRamp(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        cancelActiveRampLocked()
        resolve(nil)
    }

    // Shared by getProgress and the progress timer — see
    // crossfadeAnnouncedIncoming's declaration and currentPositionSeconds's
    // matching branch for the sync bug this closes: duration needs to
    // switch to describing the incoming track at the exact same moment
    // position does, or the two disagree about which song they're
    // describing for the second half of every crossfade.
    private func currentDurationSeconds() -> Double {
        if isCrossfading, crossfadeAnnouncedIncoming, let file = crossfadeIncomingFile {
            // Now subtracts the incoming track's own trailing cut — see
            // startCrossfade/runCrossfade for why crossfade actually
            // applies Silence Trim now instead of always ignoring it.
            return Double(file.length) / crossfadeIncomingSampleRate - crossfadeIncomingTrailingCutSeconds
        }
        return currentFile.map { Double($0.length) / currentFileSampleRate - currentTrailingCutSeconds }
            ?? (currentIndex.flatMap { queue[safe: $0]?.duration } ?? 0)
    }

    // Build was broken: this @objc attribute previously sat above
    // currentDurationSeconds() instead of here — Swift attaches an
    // attribute to whatever declaration immediately follows it, so it had
    // silently bound to a 0-parameter private helper instead of this
    // method, and getProgress itself had no @objc at all. Moved to the
    // right declaration.
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
        let duration = currentDurationSeconds()
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
