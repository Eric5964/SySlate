import Foundation
import AVFoundation
import AudioToolbox
import MediaPlayer
import UIKit
import ImageIO

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
    // ReplayGain-style track gain from the song's tags, in dB, already limited
    // by the tag's peak on the JS side. Only sent when "Use Volume Tags" is on.
    var replayGainDb: Double?

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
        self.replayGainDb = dict["replayGainDb"] as? Double
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
    // Playback speed with the pitch kept. Sits between the two players'
    // mixer and the EQ, so everything (crossfades included) is stretched
    // together. Bypassed at 1x so normal listening is untouched.
    private let timePitchNode = AVAudioUnitTimePitch()
    private var playbackRate: Float = 1.0
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
    // The song whose audio the active player node is playing right now. During
    // a crossfade this stays the OUTGOING song until the halfway point, while
    // currentIndex already points at the incoming one. The lock screen /
    // Bluetooth display and the progress readings follow this, so they switch
    // at the same moment as the in-app display (halfway through the fade).
    private var activeNodeTrack: Track? = nil

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
    // True while the running crossfade is a single-track loop (the song
    // fading into a fresh copy of itself). Same queue slot, so JS must not
    // be told the track changed.
    private var crossfadeSelfLoop: Bool = false
    // A skip that arrives while a crossfade is already running. It used to
    // cancel that crossfade on the spot (current song cut off, next one
    // started instantly). Now it waits for the running crossfade to finish
    // and then crossfades into the next song. 1 = next, -1 = previous.
    private var queuedSkipDirection: Int? = nil
    // Where the volume ramp currently in flight is headed. If a crossfade
    // interrupts a fade-in that is still climbing, the crossfade must target
    // that final level, not whatever partial value the ramp had reached.
    private var rampInFlightTarget: Float? = nil
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
    // The origin of the scheduled segment. Whenever it changes (new load, seek,
    // crossfade handoff) the remembered live position below is dropped too.
    private var segmentStartOffsetSeconds: Double = 0 { didSet { lastLivePositionSeconds = nil } }
    // Last position read from the node while it was really rendering, and when.
    // The node briefly reports no render time after an interruption, a pause or
    // a restart of the engine. Reading the segment ORIGIN then (e.g. 67s after a
    // scratch ended there) made the position, the pause snapshot and the
    // natural-end crossfade timer all wrong by however long the song had played
    // since: a crossfade that fired 20s early/late. This is used instead.
    private var lastLivePositionSeconds: Double?
    private var lastLivePositionAt: Date = .distantPast
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

    // DJ disc scratching (see scratchBegin). A small window of the current
    // song is held in memory and played by a render-callback node at a
    // speed (and direction) set from the disc, while the normal player node
    // is silenced. Position reads come from the scratch while it is active.
    private let scratchCore = ScratchCore()
    private var scratchNode: AVAudioSourceNode?
    private var scratchFormat: AVAudioFormat?
    private var scratchActive: Bool = false
    private var scratchWasPlaying: Bool = false
    private var scratchWindowStartSeconds: Double = 0
    private var scratchFileRate: Double = 44100
    private var scratchLoading: Bool = false
    // Length chosen when the natural-end crossfade timer was armed (shorter
    // than the setting when the song's audible end leaves less runway).
    private var crossfadeLeadDurationSeconds: Double? = nil

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
            // In-app debug log viewer (no Xcode/console access on a
            // sideloaded/GH-Actions build) — see debugLog()'s own comment.
            "DebugLog",
        ]
    }

    // Real gap found here: every [RAMP-DEBUG]/[SEEK-DEBUG] line so far only
    // ever went to NSLog — genuinely useless without Xcode's console, which
    // is exactly the situation for a GitHub-Actions-built, sideloaded app.
    // This is the same NSLog call sites now also route through, PLUS an RN
    // event JS can collect into an in-app, on-device log buffer (see
    // utils/debugLog.js) with its own viewer screen. NSLog stays too — free,
    // and still useful on the rare occasion Xcode IS available.
    private func debugLog(_ message: String) {
        // "%@" here, not NSLog(message) directly — message is arbitrary
        // text (could contain a literal '%' from a track title, a file
        // path, etc.), and NSLog treats its first argument as its OWN
        // format string. Passing it as a %@ argument instead avoids that
        // ever being misinterpreted.
        NSLog("%@", message)
        sendEvent(withName: "DebugLog", body: ["message": message, "at": Date().timeIntervalSince1970])
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
        engine.attach(timePitchNode)
        engine.attach(normalizerNode)

        engine.connect(nodeA, to: preMixNode, format: nil)
        engine.connect(nodeB, to: preMixNode, format: nil)
        // Node B has never been used before the first crossfade and would
        // otherwise sit at its default full volume, which is the loud blip at
        // the start of the first crossfade. Idle nodes now always rest at 0.
        nodeB.volume = 0
        engine.connect(preMixNode, to: timePitchNode, format: nil)
        engine.connect(timePitchNode, to: eqNode, format: nil)
        timePitchNode.rate = 1.0
        timePitchNode.pitch = 0
        timePitchNode.bypass = true
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
        eqNode.globalGain = 0 // pre-amp default — restored to its saved value from JS at startup, same as EQ bands
        // Normalization off by default until a preference explicitly
        // turns it on — see setWithinTrackNormEnabled.
        normalizerNode.bypass = true

        configureAudioSession()

        // Real cause of the loud pop on the FIRST play after launch
        // (every play after that is silent/clean): engine.start() was only
        // ever called lazily, right at the moment of the first actual
        // play() — the exact same instant audio starts getting pushed
        // through it. Starting an AVAudioEngine cold and immediately
        // playing through freshly-activated hardware I/O in the same beat
        // is a well-known way to get a transient pop (the DAC/hardware
        // route hasn't settled). Warming the engine up here instead, right
        // after the graph is wired, means it's already running by the time
        // any play() call happens — first tap included — so there's
        // nothing left to cold-start at that critical moment.
        activateSession()
        // The engine used to be started here and left running, silently,
        // from launch. A running engine makes iOS treat the app as
        // playing, so the lock screen and Control Center showed "playing"
        // for a paused song every time the app opened. It is now only
        // prepared (resources allocated, hardware not started); play()
        // starts it with the output held muted (outputIsCold starts true),
        // which is what prevents the first-play pop.
        engine.prepare()

        configureRemoteCommandCenter()
        NotificationCenter.default.addObserver(self, selector: #selector(handleInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleEngineConfigChange(_:)), name: .AVAudioEngineConfigurationChange, object: engine)
        // Requested: ramp out briefly (not an instant cut) specifically when
        // the app is force-quit from the app switcher — background play via
        // the "audio" background mode is untouched, this only fires on
        // actual termination. willTerminateNotification only fires at all
        // for a running-in-background app (which this is, while playing
        // audio) being user-killed from the switcher — a suspended or
        // already-purged app gets no notification whatsoever, nothing to
        // hook for that case.
        NotificationCenter.default.addObserver(self, selector: #selector(handleAppWillTerminate), name: UIApplication.willTerminateNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleAppResigned), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleAppResigned), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: - Playback snapshot (where the user left off)

    // Which song and how far in, written to UserDefaults often and at every
    // moment the app might be about to lose its chance: pause, another app
    // taking over the audio, a route change, going to the background,
    // termination. The JS-side save lives in React Native and can be
    // suspended or killed before it runs; this one is plain native code
    // that runs right where the playback state is.
    private var lastSnapshotAt: Date = .distantPast
    private static let snapshotKey = "SySlatePlaybackSnapshotV1"

    private func savePlaybackSnapshot(force: Bool = false) {
        if !force && Date().timeIntervalSince(lastSnapshotAt) < 1.5 { return }
        guard let idx = currentIndex, idx >= 0, idx < queue.count else { return }
        let position = frozenPositionSeconds ?? currentPositionSeconds()
        guard position.isFinite, position >= 0 else { return }
        lastSnapshotAt = Date()
        let track = queue[idx]
        let snapshot: [String: Any] = [
            "id": track.id,
            "qid": track.qid ?? "",
            "position": position,
            "savedAt": Date().timeIntervalSince1970,
        ]
        UserDefaults.standard.set(snapshot, forKey: AudioEngine.snapshotKey)
    }

    @objc private func handleAppResigned() {
        savePlaybackSnapshot(force: true)
    }

    @objc(getSavedSnapshot:rejecter:)
    func getSavedSnapshot(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(UserDefaults.standard.dictionary(forKey: AudioEngine.snapshotKey))
    }

    // MARK: - App termination

    @objc private func handleAppWillTerminate() {
        guard state == .playing else { savePlaybackSnapshot(force: true); return }
        // The process can be killed very shortly after this returns, so the
        // fade has to start at once and be synchronous. The fade used to
        // begin only after the snapshot was saved, and its first step was a
        // sleep, so the already-short window was spent before any volume
        // change happened and the sound got cut mid-fade. Now: the first
        // step is applied immediately, the steps are finer (smoother),
        // both players are faded (a crossfade has two audible), and the
        // snapshot is saved afterwards (it is also saved every time the app
        // goes to the background, so nothing is lost).
        var bgTask = UIBackgroundTaskIdentifier.invalid
        bgTask = UIApplication.shared.beginBackgroundTask {
            UIApplication.shared.endBackgroundTask(bgTask)
        }
        let startA = nodeA.volume
        let startB = nodeB.volume
        let duration = 0.5
        let steps = 40
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let gain = Float(cos(t * Double.pi / 2))      // smooth, gentle tail
            nodeA.volume = startA * gain
            nodeB.volume = startB * gain
            Thread.sleep(forTimeInterval: duration / Double(steps))
        }
        nodeA.volume = 0
        nodeB.volume = 0
        nodeA.pause()
        nodeB.pause()
        savePlaybackSnapshot(force: true)
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
            // [RAMP-DEBUG] Diagnostic — chasing "the starting glitch also
            // happens after something interrupts playback and you have to
            // start the song again", same bug class as the cold-launch
            // repro (see advance()/reset()'s matching comments): logging
            // currentIndex right at the moment of interruption so a
            // capture spanning an interruption shows whether it's already
            // nil here, or goes nil sometime between this and the next
            // Play tap.
            debugLog("[RAMP-DEBUG] interruption BEGAN — currentIndex=\(currentIndex.map(String.init) ?? "nil"), state=\(state)")
            // Deliberately NOT calling pause() here. Per decision #2,
            // interruptions should fade out using the existing "Ramp on
            // Pause" JS setting, same as a manual pause — and in Milestone
            // 1 that ramp logic still lives in PlaybackService.js. So this
            // just tells JS an interruption started; JS's existing
            // pause-with-ramp function is expected to call this module's
            // pause()/setVolume() itself, same as it does for a manual
            // pause tap.
            savePlaybackSnapshot(force: true)
            sendEvent(withName: "AudioInterruptionBegan", body: nil)
        } else if type == .ended {
            var shouldResume = false
            if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsValue).contains(.shouldResume)
            }
            markOutputCold()
            debugLog("[RAMP-DEBUG] interruption ENDED — currentIndex=\(currentIndex.map(String.init) ?? "nil"), state=\(state), shouldResume=\(shouldResume)")
            // Deliberately not auto-resuming even when iOS suggests it's
            // safe to — most players require an explicit tap back to play.
            // Flip this if that's not what's wanted.
            sendEvent(withName: "AudioInterruptionEnded", body: ["shouldResume": shouldResume])
        }
    }

    // After a route change (Bluetooth connecting, a different output) or an
    // engine configuration change, the song that was scheduled on the player
    // node may no longer be there, so a plain play() can report "playing" and
    // advance the position while nothing is heard until the next song is
    // loaded (a skip or the next track). Remember the load this applies to;
    // the next play() then loads the current song again at its position.
    private var staleScheduleToken: UInt64? = nil
    // When an output device (Bluetooth, car, headphones) last connected. A Play
    // command arriving right after is the device resuming on its own, not the
    // user, and is ignored (see handleRemotePlayPause).
    private var lastDeviceConnectAt: Date? = nil

    // MARK: - Click guards around route and engine changes
    // A device disconnecting used to cut the sound off in one step (a click on
    // whatever it moved to), and an engine restart after a route change started
    // the output again at full level (a pop). Both are now softened: the sound
    // fades out over about 70 ms before the pause, and the main mixer is held
    // at 0 across a restart and eased back up.
    private var deviceLossFadeToken: UInt64 = 0
    private var softMuteToken: UInt64 = 0

    // The level the node had before a device-loss fade started. Kept so a second
    // route event during the 70 ms fade (common when Bluetooth drops) does not
    // take the already-lowered level as the "original" and leave it there.
    private var deviceLossBaseVol: Float? = nil

    private func fadeOutThenPause() {
        guard state == .playing, !isCrossfading, !scratchActive else {
            deviceLossFadeToken &+= 1   // cancel any steps of an earlier fade still waiting
            pauseInternal()
            if let base = deviceLossBaseVol { activeNode.volume = base; deviceLossBaseVol = nil }
            return
        }
        deviceLossFadeToken &+= 1
        let t = deviceLossFadeToken
        let startVol = deviceLossBaseVol ?? activeNode.volume
        deviceLossBaseVol = startVol
        let steps = 6
        debugLog("[POP] output device gone: fading out over \(steps * 12) ms before pausing (nodeVol=\(startVol))")
        for i in 1...steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.012 * Double(i)) { [weak self] in
                guard let self = self, t == self.deviceLossFadeToken else { return }
                self.activeNode.volume = startVol * Float(steps - i) / Float(steps)
                if i == steps {
                    self.pauseInternal()
                    // Paused and silent: put the level back as it was before, so
                    // whatever plays next starts from the same level as ever.
                    self.activeNode.volume = startVol
                    self.deviceLossBaseVol = nil
                }
            }
        }
    }

    // Mutes the main mixer now and eases it back up after `hold` seconds.
    // (A cold-start mute in progress is left alone: it has its own release.)
    private func softMute(holdFor hold: TimeInterval) {
        guard !coldMuteHeld else { return }
        softMuteToken &+= 1
        let t = softMuteToken
        engine.mainMixerNode.outputVolume = 0
        debugLog("[POP] soft mute for \(hold)s (state=\(state), engineRunning=\(engine.isRunning))")
        DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
            guard let self = self, t == self.softMuteToken else { return }
            let steps = 8
            for i in 1...steps {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01 * Double(i)) { [weak self] in
                    guard let self = self, t == self.softMuteToken, !self.coldMuteHeld else { return }
                    self.engine.mainMixerNode.outputVolume = Float(i) / Float(steps)
                }
            }
        }
    }
    private func markScheduledAudioStale() { staleScheduleToken = playbackToken }
    @objc private func handleEngineConfigChange(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.debugLog("[POP] engine configuration change: state=\(self.state) engineRunning=\(self.engine.isRunning)")
            self.markScheduledAudioStale()
        }
    }

    // Safety net after every play: if the sound path is not actually live a
    // moment later, repair it instead of leaving the song silent. Only the
    // latest play (and only while still playing, no crossfade, no scratch)
    // is checked; a pause, stop or newer play cancels it.
    private var silenceWatchdogToken: UInt64 = 0
    private func scheduleSilenceWatchdog() {
        silenceWatchdogToken &+= 1
        let t = silenceWatchdogToken
        for delay in [1.0, 9.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, t == self.silenceWatchdogToken,
                      self.state == .playing, !self.isCrossfading, !self.scratchActive else { return }
                var repaired = false
                if !self.engine.isRunning {
                    self.softMute(holdFor: 0.12)
                    self.activateSession()
                    try? self.engine.start()
                    repaired = true
                }
                if self.engine.isRunning, !self.activeNode.isPlaying {
                    self.activeNode.play()
                    repaired = true
                }
                if delay > 5 {
                    // Output mute that never lifted.
                    if !self.coldMuteHeld, self.engine.mainMixerNode.outputVolume < 0.99 {
                        self.engine.mainMixerNode.outputVolume = 1
                        repaired = true
                    }
                    // A fade-in that never ran (volume left at 0 with no fade
                    // under way and nothing asking for 0 for a long while).
                    let zeroAge = self.lastZeroVolumeAt.map { Date().timeIntervalSince($0) } ?? 100
                    if self.rampTimer == nil, self.volume < 0.02, zeroAge > 8 {
                        self.volume = 1
                        self.activeNode.volume = self.currentGainCorrection
                        repaired = true
                    }
                }
                if repaired { self.debugLog("[WATCHDOG] repaired a silent play (after \(delay)s)") }
            }
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let info = notification.userInfo,
              let reasonValue = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }

        markOutputCold()
        markScheduledAudioStale()
        savePlaybackSnapshot(force: true)
        debugLog("[POP] route change: reason=\(reasonValue) state=\(state) engineRunning=\(engine.isRunning) mixerVol=\(engine.mainMixerNode.outputVolume)")
        if reason == .newDeviceAvailable {
            lastDeviceConnectAt = Date()
            // The output hardware is switching while sound is playing: keep the
            // mixer quiet through the switch and the engine reconfiguring.
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.state == .playing else { return }
                self.softMute(holdFor: 0.3)
            }
        }
        if reason == .oldDeviceUnavailable {
            DispatchQueue.main.async { [weak self] in
                self?.fadeOutThenPause()
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
                self.softMute(holdFor: 0.2)
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

        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            self?.handleRemotePlayPause(wantsPlay: true)
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.handleRemotePlayPause(wantsPlay: false)
            return .success
        }
        // Headphone/car/lock-screen single-button toggles. Left unregistered
        // iOS translates them into play/pause on its own, but only from the
        // state it last saw, which is what made a quick second press act on
        // stale info. Handled here from the state the app is showing now.
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            let showingPlaying = self.displayedAsPaused.map { !$0 } ?? (self.state == .playing)
            self.handleRemotePlayPause(wantsPlay: !showingPlaying)
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
    // One place for every remote Play/Pause. The fade-out on pause and the
    // fade-in on play both take a couple of seconds, during which the real
    // engine state has not flipped yet, so the periodic Now Playing refresh
    // kept rewriting the OLD state and Control Center bounced back to
    // "playing" (lock screen only looked right because it happened to
    // refresh at a different moment). The wanted state is now held as the
    // displayed state right away, and every refresh during the fade agrees
    // with it until the real state change lands.
    private func handleRemotePlayPause(wantsPlay: Bool) {
        debugLog("[NP] remote \(wantsPlay ? "PLAY" : "PAUSE") command received (engine state=\(state))")
        // A Bluetooth device / car that connects often sends "play" by itself
        // if the song was playing when it last disconnected. That used to start
        // playback silently (no volume). Nothing starts on connect now: a Play
        // that arrives within a few seconds of a device connecting while paused
        // is ignored, and the system keeps showing paused. Press Play again.
        if wantsPlay, state != .playing, let at = lastDeviceConnectAt, Date().timeIntervalSince(at) < 6.0 {
            debugLog("[NP] ignored remote PLAY right after a device connected (no auto play on connect)")
            displayedAsPaused = nil
            displayedAsPausedAt = nil
            updateNowPlayingInfo()
            MPNowPlayingInfoCenter.default().playbackState = .paused
            reassertPausedToSystem()
            return
        }
        displayedAsPaused = !wantsPlay
        displayedAsPausedAt = Date()
        optimisticallySetPlaybackRate(wantsPlay ? 1.0 : 0.0)
        sendEvent(withName: wantsPlay ? "RemotePlay" : "RemotePause", body: nil)
    }

    private func optimisticallySetPlaybackRate(_ rate: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = rate > 0 ? .playing : .paused
    }

    // Real bug found here — this is why the lock screen play/pause icon
    // flickers during a pause-ramp instead of just switching once: the
    // progress timer keeps firing (and calling updateNowPlayingInfo below,
    // periodically) for the ENTIRE duration of a ramp-out, because `state`
    // doesn't actually flip to .paused until the real pause() call at the
    // very end of the fade — see setNowPlayingPaused's own comment. Every
    // one of those in-between ticks computed rate from raw `state`
    // (.playing the whole time), silently overwriting whatever
    // setNowPlayingPaused had just set the moment before — so for a 2-4s
    // ramp, the lock screen would flip to "paused" once, then get stomped
    // back to "playing" by the next tick a fraction of a second later,
    // repeatedly, until the ramp actually finished. setNowPlayingPaused now
    // sets this instead of writing directly to MPNowPlayingInfoCenter once
    // and being done — updateNowPlayingInfo (below) checks it on every
    // call, so every tick during the fade keeps agreeing with it instead of
    // only the very first one.
    private var displayedAsPaused: Bool? = nil
    // When displayedAsPaused was last set to true. Real bug found here
    // (matches a screenshot: Control Center showing PAUSED at 0:03 while
    // the app itself was playing at 0:36): displayedAsPaused is only ever
    // cleared by setState(), i.e. by a real state TRANSITION. If a pause
    // fade starts (setNowPlayingPaused(true)) and then never reaches its
    // real pause() — interrupted, superseded by a resume/skip/song tap, a
    // crossfade taking over — state stays .playing the whole time, no
    // transition ever fires, and this override sticks forever: the lock
    // screen/Bluetooth display reports "paused" (rate 0) for a song that's
    // audibly playing. No ramp lasts anywhere near this long, so an
    // override still standing while state is .playing is stale by
    // definition — updateNowPlayingInfo drops it (below).
    private var displayedAsPausedAt: Date? = nil

    // Last real duration per track, so a moment where the current track's
    // duration is briefly unknown can't blank the lock screen progress bar.
    // iOS drops the bar entirely when a Now Playing update has no duration.
    private var lastKnownDurationByKey: [String: Double] = [:]
    private var lastNowPlayingLogKey: String = ""
    private var lastNowPlayingWriteSig: String = ""

    // Lock screen / Control Center / car cover fallback. The cover normally
    // comes from the file JS extracted. If that file can't be read from this
    // side (sideloaded installs can resolve the Documents folder differently),
    // the cover is read straight out of the song file instead, which needs no
    // JS-side path at all. Attempted once per track, off the main thread.
    // Cover path and display artist JS last sent for each song id. Kept apart
    // from the queue entries so they survive the queue being rebuilt (reset
    // and re-add), which used to silently drop the cover and the formatted
    // artist from the lock screen.
    private var artworkOverrideById: [String: String] = [:]
    private var artistOverrideById: [String: String] = [:]
    private var embeddedArtwork: MPMediaItemArtwork? = nil
    private var embeddedArtworkKey: String? = nil
    private var embeddedArtworkAttempted = Set<String>()
    private var artLogged = Set<String>()

    private func readEmbeddedArtwork(from url: URL) -> UIImage? {
        let asset = AVURLAsset(url: url)
        var items = AVMetadataItem.metadataItems(from: asset.commonMetadata, filteredByIdentifier: .commonIdentifierArtwork)
        if items.isEmpty {
            items = asset.metadata.filter { item in
                let id = item.identifier?.rawValue.lowercased() ?? ""
                let key = (item.commonKey?.rawValue ?? "").lowercased()
                return key == "artwork" || id.contains("artwork") || id.contains("covr") || id.contains("apic") || id.contains("picture")
            }
        }
        for item in items {
            if let data = item.dataValue, let image = UIImage(data: data) { return image }
            if let data = item.value as? Data, let image = UIImage(data: data) { return image }
        }
        return nil
    }

    private func loadEmbeddedArtworkIfNeeded(for track: Track, key: String) {
        if embeddedArtworkKey == key { return }
        if embeddedArtworkAttempted.contains(key) { return }
        embeddedArtworkAttempted.insert(key)
        let url = track.url
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let image = self?.readEmbeddedArtwork(from: url)
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let image = image {
                    self.embeddedArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    self.embeddedArtworkKey = key
                    self.debugLog("[ART] lock screen cover read straight from the song file for \(track.title ?? "?")")
                    self.updateNowPlayingInfo()
                } else {
                    self.debugLog("[ART] no cover could be read from the song file for \(track.title ?? "?")")
                }
            }
        }
    }

    // Where the song shown on the lock screen / Control Center is. During a
    // crossfade the shown song is already the incoming one (title, cover and
    // length switch the moment it starts), so its elapsed time has to come
    // from the incoming player too. It used to read the outgoing player until
    // the crossfade finished, so iOS showed the new song with the old song's
    // position until then.
    private func nowPlayingElapsedSeconds() -> Double {
        if isCrossfading, crossfadeAnnouncedIncoming, let node = crossfadeIncomingNode, crossfadeIncomingSampleRate > 0 {
            if let nt = node.lastRenderTime, let pt = node.playerTime(forNodeTime: nt) {
                return max(0, crossfadeIncomingLeadInSeconds + Double(pt.sampleTime) / crossfadeIncomingSampleRate)
            }
            return crossfadeIncomingLeadInSeconds
        }
        return currentPositionSeconds()
    }

    private func updateNowPlayingInfo() {
        guard let idx = currentIndex, idx >= 0, idx < queue.count else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            cachedArtworkPath = nil
            cachedArtwork = nil
            return
        }
        var track = queue[idx]
        // During a crossfade currentIndex already points at the incoming song,
        // but the display (lock screen, Bluetooth, car) keeps showing the
        // outgoing song until the halfway point, like the in-app display.
        if isCrossfading, !crossfadeAnnouncedIncoming, let outgoing = activeNodeTrack {
            track = queue.first(where: { $0.id == outgoing.id && $0.qid == outgoing.qid }) ?? outgoing
        }
        // A held display state that never got confirmed by a real state
        // change (fade interrupted, action dropped) must not stick forever.
        if let held = displayedAsPaused, let at = displayedAsPausedAt {
            let age = Date().timeIntervalSince(at)
            let contradictsReality = held ? (state == .playing) : (state != .playing)
            if contradictsReality && age > (held ? 12 : 8) {
                displayedAsPaused = nil
                displayedAsPausedAt = nil
            }
        }
        let isPlayingForDisplay = displayedAsPaused.map { !$0 } ?? (state == .playing)
        // Logged only when something changes, so the Debug Log shows exactly
        // what the lock screen / Control Center were told and when.
        let npKey = "\(isPlayingForDisplay)|\(state)|\(displayedAsPaused.map { String($0) } ?? "nil")"
        if npKey != lastNowPlayingLogKey {
            lastNowPlayingLogKey = npKey
            debugLog("[NP] telling iOS: \(isPlayingForDisplay ? "playing" : "paused") (engine state=\(state), held paused=\(displayedAsPaused.map { String($0) } ?? "nil"))")
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title ?? "",
            MPMediaItemPropertyArtist: artistOverrideById[track.id] ?? track.artist ?? "",
            MPMediaItemPropertyAlbumTitle: track.album ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: nowPlayingElapsedSeconds(),
            MPNowPlayingInfoPropertyPlaybackRate: isPlayingForDisplay ? Double(playbackRate) : 0.0,
        ]
        let durKey = "\(track.id)|\(track.qid ?? "")"
        if let duration = track.duration, duration > 0 {
            lastKnownDurationByKey[durKey] = duration
        }
        if let duration = lastKnownDurationByKey[durKey] {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        info[MPNowPlayingInfoPropertyIsLiveStream] = false
        if let artworkPath = track.artwork ?? artworkOverrideById[track.id] {
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
                    if !artLogged.contains(artworkPath) {
                        artLogged.insert(artworkPath)
                        debugLog("[ART] could not load cover file for lock screen: \(artworkPath) exists=\(FileManager.default.fileExists(atPath: URL(string: artworkPath)?.path ?? artworkPath))")
                    }
                }
            }
        } else {
            cachedArtworkPath = nil
            cachedArtwork = nil
            if !artLogged.contains("none|" + durKey) {
                artLogged.insert("none|" + durKey)
                debugLog("[ART] native has no cover path yet for \(track.title ?? "?")")
            }
        }
        if let artwork = cachedArtwork {
            info[MPMediaItemPropertyArtwork] = artwork
        } else {
            // No usable file from JS: fall back to the cover inside the song.
            if embeddedArtworkKey == durKey, let embedded = embeddedArtwork {
                info[MPMediaItemPropertyArtwork] = embedded
            } else {
                loadEmbeddedArtworkIfNeeded(for: track, key: durKey)
            }
        }
        // Logged only when the song, its cover or the play state changes, so
        // a log taken during a car/Bluetooth blank shows exactly what was
        // sent to the system and when.
        let npSig = "\(track.id)|\(info[MPMediaItemPropertyArtwork] != nil)|\(isPlayingForDisplay)|\(isCrossfading)"
        if npSig != lastNowPlayingWriteSig {
            lastNowPlayingWriteSig = npSig
            debugLog("[NP-WRITE] title=\(track.title ?? "?") cover=\(info[MPMediaItemPropertyArtwork] != nil) playing=\(isPlayingForDisplay) crossfading=\(isCrossfading)")
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        // Control Center reads this explicit state, not just the rate above.
        // Without it, Control Center could show or snap back to "playing"
        // while the lock screen (which follows the rate) stayed paused.
        MPNowPlayingInfoCenter.default().playbackState = isPlayingForDisplay ? .playing : .paused
    }

    // MARK: - Playback engine internals

    private func setState(_ newState: PlaybackStateValue) {
        state = newState
        // Any real, definitive state transition supersedes whatever
        // setNowPlayingPaused's display-only override was holding — clear
        // it so updateNowPlayingInfo goes back to trusting `state` directly
        // instead of possibly holding on to a stale ramp-in-progress guess.
        displayedAsPaused = nil
        displayedAsPausedAt = nil
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

    // Volume Match from the song's own tag: linear gain, kept in a safe range.
    private func tagGain(for track: Track) -> Float? {
        guard let db = track.replayGainDb, db.isFinite else { return nil }
        return Float(min(2.0, max(0.25, pow(10.0, db / 20.0))))
    }

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
        if scratchActive { return scratchCore.windowStart + scratchCore.pos / scratchFileRate }
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
        // While paused, always report the frozen snapshot.
        if state != .playing, let frozen = frozenPositionSeconds { return frozen }
        guard let nodeTime = activeNode.lastRenderTime,
              let playerTime = activeNode.playerTime(forNodeTime: nodeTime) else {
            // The node has no render time for a moment after every play()
            // (more so now that a start is delayed ~80ms and the engine is
            // restarted after a pause). This used to fall back to the
            // segment ORIGIN (often 0:00) once the pause snapshot had been
            // cleared, so the first poll after Play reported the start of
            // the song and the progress bar jumped back for a beat. The
            // snapshot is now kept until the node is truly rendering.
            if let frozen = frozenPositionSeconds { return frozen }
            if let lp = lastLivePositionSeconds {
                if state == .playing {
                    // Still playing: carry on from the last real reading (capped, so
                    // a long gap cannot run the position away).
                    return lp + min(Date().timeIntervalSince(lastLivePositionAt), 1.5) * Double(playbackRate)
                }
                return lp
            }
            return segmentStartOffsetSeconds
        }
        let live = segmentStartOffsetSeconds + Double(playerTime.sampleTime) / currentFileSampleRate
        lastLivePositionSeconds = live
        lastLivePositionAt = Date()
        if state == .playing { frozenPositionSeconds = nil }
        return live
    }

    private func loadAndScheduleCurrentTrack(startAtSeconds: Double = 0, autoPlay: Bool, announceChange: Bool = true) {
        abortScratch()   // a song change during a scratch ends the scratch (no two songs at once)
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
            let debugT0 = Date()
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
                let analysis: FileAnalysis? = (self?.silenceTrimEnabled == true || (self?.betweenTrackNormEnabled == true && track.replayGainDb == nil))
                    ? self?.analyzeFile(file, path: track.url.path) : nil
                // Temporary diagnostic logging — tagged [RAMP-DEBUG], see
                // the matching tag in PlaybackService.js's playWithRamp.
                // Cross-referencing the two timelines is the actual point
                // — safe to strip once the silence-trim-ramp issue is
                // diagnosed.
                let analysisMs = Int(Date().timeIntervalSince(debugT0) * 1000)
                // self?. here, not bare debugLog(...) — this closure only
                // weakly captured self ([weak self] above), and self isn't
                // unwrapped to a non-optional until the guard let inside the
                // nested DispatchQueue.main.async below. Calling an instance
                // method on a still-optional self needs the explicit `?`.
                self?.debugLog(String(format: "[RAMP-DEBUG] native: analysis took %dms, leadIn=%.3fs trailingCut=%.3fs (nil analysis = trim/normalize both off)", analysisMs, analysis?.leadInSeconds ?? -1, analysis?.trailingCutSeconds ?? -1))
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
            activeNodeTrack = track
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
            if betweenTrackNormEnabled, let tg = tagGain(for: track) { gainCorrection = tg }
            segmentStartOffsetSeconds = effectiveStartAtSeconds
            frozenPositionSeconds = nil // new segment: its origin is the truth
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

            let trackWithDuration = track
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
            let liveIdx = commitMeasuredDuration(Double(file.length) / file.processingFormat.sampleRate - trailingCutSeconds, for: trackWithDuration, hint: idx)

            if announceChange {
                sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": liveIdx])
            }

            // Output muted BEFORE the engine/session wake up, so the wake-up
            // click never reaches the speaker.
            let coldStart = autoPlay ? beginColdStartMuteIfNeeded() : false
            let engineWasRunning = engine.isRunning
            if !engine.isRunning {
                try engine.start()
            }
            activateSession()
            // [RAMP-DEBUG] — this line sets activeNode.volume directly,
            // unconditionally, every load — including a fresh ramp-in JS
            // just set to 0 a moment ago via setVolume(0) before calling
            // this. Logging the actual value so it's visible whether this
            // is stomping a ramp-in back to full right as it starts.
            debugLog(String(format: "[RAMP-DEBUG] native: about to set activeNode.volume=%.3f (volume param=%.3f * gainCorrection=%.3f), autoPlay=%@", volume * gainCorrection, volume, gainCorrection, autoPlay ? "true" : "false"))
            activeNode.volume = volume * gainCorrection

            if autoPlay {
                lastAudibleAt = Date()
                setState(.playing)
                startActiveNodeAfterGainSettles(needsSettle: coldStart || activeNode.volume < 0.02)
                debugLog("[RAMP-DEBUG] native: play requested + setState(.playing) fired")
            } else {
                setState(.ready)
                // A load that does not start playing (a skip while paused)
                // must not leave the audio hardware running, or iOS shows
                // the app as playing again. The engine was only started
                // here so the segment could be scheduled; stop it again if
                // it was stopped before. play() restarts it.
                if !engineWasRunning, engine.isRunning { engine.pause() }
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
        leadDeferCount = 0
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
        guard crossfadeEnabled, crossfadeDurationEndOfTrackSeconds > 0.05 else { return }
        // Matches handlePlaybackCompleted's own carve-out — a single-track
        // repeat never goes through advance()/crossfade today (it
        // reschedules the same file silently instead), so this
        // deliberately doesn't try to crossfade a track into itself.
        guard let idx = currentIndex, idx >= 0, idx < queue.count, let duration = queue[idx].duration, duration > 0 else { return }
        // Single-track loop now crossfades too (the song into itself), as
        // long as the song is long enough for the overlap to make sense.
        if repeatMode == .track && duration < crossfadeDurationEndOfTrackSeconds * 2 { return }
        // The song's REAL end is earlier than the file's when Trim Silence
        // cut its tail (currentTrailingCutSeconds). The timer used to count
        // down to the file's full length, so the crossfade started after the
        // audible end: the old song had already finished and the next one
        // simply started (or faded in out of a gap).
        let audibleEnd = duration - max(0, currentTrailingCutSeconds)
        let remaining = audibleEnd - currentPositionSeconds()
        // At a playback speed other than 1x the song's remaining time passes
        // faster or slower in real time, and a crossfade of N real seconds
        // eats N x speed seconds of the song.
        let speed = Double(max(0.25, playbackRate))
        var fireIn = (remaining - crossfadeDurationEndOfTrackSeconds * speed) / speed
        var useDuration = crossfadeDurationEndOfTrackSeconds
        if fireIn <= 0.1 {
            // Not enough runway for the full length (short song, or a long
            // trimmed tail): still crossfade, as long as what is left allows.
            guard remaining / speed > 0.8 else { return }
            fireIn = 0.05
            useDuration = max(0.3, remaining / speed - 0.4)
        }
        crossfadeLeadDurationSeconds = useDuration
        debugLog(String(format: "[XFADE] lead-in armed: fires in %.2fs, length %.2fs (audibleEnd=%.2fs, trailingCut=%.2fs)", fireIn, useDuration, audibleEnd, currentTrailingCutSeconds))
        let timer = Timer.scheduledTimer(withTimeInterval: fireIn, repeats: false) { [weak self] _ in
            self?.fireCrossfadeLeadIn()
        }
        RunLoop.main.add(timer, forMode: .common)
        crossfadeLeadTimer = timer
    }

    private var leadDeferCount = 0
    private func fireCrossfadeLeadIn() {
        crossfadeLeadTimer = nil
        // Conditions may have changed since this was armed (paused,
        // settings toggled off, another crossfade already running from
        // some other path) — re-check everything rather than trusting the
        // state from when it was scheduled.
        guard state == .playing, !isCrossfading, crossfadeEnabled, crossfadeDurationEndOfTrackSeconds > 0.05 else { leadDeferCount = 0; return }
        guard let idx = currentIndex else { return }
        // A pause is fading out right now (JS marks the display as paused
        // when the pause ramp starts, the real pause comes at its end). Do NOT
        // start the crossfade into the next song then: it used to cut the
        // pause ramp short and move on to the next song while "paused". Check
        // again shortly. If the pause completes, state is no longer .playing
        // and the next Play re-arms this timer; if playback resumed instead,
        // work out the timing again from the real position.
        if displayedAsPaused == true && leadDeferCount < 40 {
            leadDeferCount += 1
            let timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
                self?.fireCrossfadeLeadIn()
            }
            RunLoop.main.add(timer, forMode: .common)
            crossfadeLeadTimer = timer
            return
        }
        if leadDeferCount > 0 {
            leadDeferCount = 0
            debugLog("[XFADE] lead-in was held back during a pause fade; re-timing from the real position")
            scheduleCrossfadeLeadIn()
            return
        }
        if repeatMode == .track {
            crossfadeSelfLoop = true
            startCrossfade(toIndex: idx, duration: crossfadeLeadDurationSeconds ?? crossfadeDurationEndOfTrackSeconds)
            return
        }
        crossfadeSelfLoop = false
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
        startCrossfade(toIndex: newIndex, duration: crossfadeLeadDurationSeconds ?? crossfadeDurationEndOfTrackSeconds)
    }

    // Fires when a scheduled segment finishes playing to the end on its
    // own (i.e. NOT from a manual stop/skip/seek, which all bump
    // playbackToken first specifically so this stale callback gets
    // ignored here instead of double-advancing).
    private func handlePlaybackCompleted(token: UInt64) {
        // [RAMP-DEBUG] Diagnostic only. If this fires with token !=
        // playbackToken during a "stuck, position past duration" repro,
        // that confirms a stale/orphaned completion — see startCrossfade's
        // matching comment for the leading theory on how it gets orphaned.
        if token != playbackToken {
            debugLog("[RAMP-DEBUG] handlePlaybackCompleted: STALE token (\(token) != current \(playbackToken)) — ignored, this segment's completion is being dropped")
        }
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
        queuedSkipDirection = nil
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
        crossfadeSelfLoop = false
        nodeA.stop()
        nodeB.stop()
        isCrossfading = false
    }

    // Single-use override — set by JS right before a plain (non-crossfade)
    // ramp-driven skipToNext/skipToPrevious call, for the exact same reason
    // load() exists for skip(index): advance() below makes its own
    // independent crossfade decision from crossfadeEnabled, which can
    // disagree with whatever JS already decided (and already ran its own
    // JS ramp-out for) — same "ramps out of the previous song, never ramps
    // into the new one" bug as skip(index) had, just for the Next/Previous
    // buttons instead of tapping a song. Unlike skip(index), there's no
    // index-free "just do a plain track change" native method to swap in
    // (the target is relative — +1/-1 with wrap — not a known index), so
    // this is a targeted one-shot suppression instead: JS sets it
    // immediately before the call, advance() consumes (clears) it the
    // moment it's read regardless of which branch runs, so it can never
    // leak into some LATER, unrelated advance() call.
    private var suppressNextCrossfade = false
    // When that flag was set. A flag nobody consumed (e.g. a restart-in-place
    // seek never reaches advance()) used to stay armed and silently turn the
    // NEXT skip into a plain cut; it now only counts for a few seconds.
    private var suppressNextCrossfadeAt: Date? = nil

    private func advance(direction: Int, wrap: Bool, autoPlay: Bool, isManualSkip: Bool) {
        abortScratch()
        cancelCrossfadeIfNeeded()
        let suppressCrossfade = suppressNextCrossfade && (suppressNextCrossfadeAt.map { Date().timeIntervalSince($0) < 5 } ?? false)
        suppressNextCrossfade = false
        suppressNextCrossfadeAt = nil
        guard !queue.isEmpty else {
            debugLog("[RAMP-DEBUG] advance(): queue is empty, clearing currentIndex (was \(currentIndex.map(String.init) ?? "nil"))")
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
            // [RAMP-DEBUG] Diagnostic — chasing "first Play after a fresh
            // launch does a slow reload from 0:00 instead of just resuming
            // the restored position/track", per playInternal()'s own
            // nil-currentIndex fallback (see its comment). If this fires
            // during that repro, it's the direct cause: something called
            // advance() past the end of the queue (a stray natural-
            // completion, e.g.) sometime between restore finishing and
            // Play being tapped, clearing currentIndex in the background
            // with nothing visibly wrong on screen since nothing was
            // playing yet to visibly stop.
            debugLog("[RAMP-DEBUG] advance(): newIndex \(newIndex) out of bounds (queue.count=\(queue.count), from idx=\(idx), direction=\(direction), wrap=\(wrap)) — clearing currentIndex")
            currentIndex = nil
            activeNode.stop()
            setState(.ended)
            return
        }

        // Pressing Next/Previous while a crossfade is still running used to
        // fall through to a hard cut (a crossfade can't start while one is
        // running). Finish the running one at its current level first, then
        // fade onward from there.
        if isManualSkip, isCrossfading, crossfadeEnabled, crossfadeDurationSkipSeconds > 0.05, autoPlay, state == .playing {
            settleCrossfadeToIncoming(snapToFull: false)
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
        // Real bug found here: this used to require direction == 1, so the
        // Previous button could never crossfade at all, even with it on —
        // it always did a plain cut. startCrossfade(toIndex:duration:)
        // itself has no notion of direction at all — it just crossfades
        // from whatever's currently playing to queue[toIndex] — so nothing
        // about going backward is actually unsupported by the mechanism;
        // this condition was just never opened up for it. direction == -1
        // can only ever reach advance() from a manual Previous press
        // (fireCrossfadeLeadIn, the only caller for the natural
        // end-of-track case, always passes direction: 1), so this doesn't
        // need an isManualSkip check alongside it to stay scoped correctly.
        if !suppressCrossfade, crossfadeEnabled, crossfadeDuration > 0.05, incomingLongEnough, autoPlay, (direction == 1 || direction == -1), !isCrossfading, state == .playing {
            currentIndex = newIndex
            crossfadeSelfLoop = false
            startCrossfade(toIndex: newIndex, duration: crossfadeDuration)
            return
        }

        currentIndex = newIndex
        loadAndScheduleCurrentTrack(autoPlay: autoPlay)
    }

    // MARK: - Crossfade

    // Crossfades run for seconds, during which JS can legitimately add or
    // remove queue entries (top-ups, removals, shuffle). The index captured
    // when the crossfade began then points at a DIFFERENT slot, and using it
    // blindly overwrote that slot with this track's stale copy (wrong
    // title/cover, duplicate entries) and announced the wrong index to JS.
    // Resolve the slot by identity (qid, then song id) instead, closest to
    // currentIndex, and only ever patch the measured duration into it.
    private func liveIndex(for track: Track, hint: Int) -> Int {
        if hint >= 0, hint < queue.count, queue[hint].id == track.id, queue[hint].qid == track.qid { return hint }
        var best: Int? = nil
        for (i, t) in queue.enumerated() where t.id == track.id && (track.qid == nil || t.qid == track.qid) {
            if best == nil { best = i; continue }
            let ref = currentIndex ?? hint
            if abs(i - ref) < abs(best! - ref) { best = i }
        }
        return best ?? hint
    }

    private func commitMeasuredDuration(_ duration: Double, for track: Track, hint: Int) -> Int {
        let live = liveIndex(for: track, hint: hint)
        if live >= 0, live < queue.count, queue[live].id == track.id { queue[live].duration = duration }
        return live
    }

    private func startCrossfade(toIndex idx: Int, duration: Double) {
        abortScratch()   // a song change during a scratch ends the scratch (no two songs at once)
        guard idx >= 0, idx < queue.count else { return }
        // Whichever path got here (manual skip via advance(), or the early
        // lead-in timer for a natural end), a crossfade is now genuinely
        // starting — any OTHER still-pending lead-in timer (there
        // shouldn't be one, but belt-and-suspenders again) is now stale.
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
        // Real bug found here — the other half of the gap rampVolume/
        // setVolume's own "if isCrossfading { settleCrossfadeToIncoming() }"
        // fix covers: THAT fix stops a JS ramp from colliding with a
        // crossfade already running. This is the reverse case — a JS ramp
        // (most commonly: resume's ramp-in, from tapping Play shortly after
        // pausing) that's still actively ticking via its own native Timer
        // the moment a crossfade STARTS, e.g. this fires autonomously from
        // the natural end-of-track lead-in timer without any JS
        // involvement at all, so JS's own lock has no way to have deferred
        // it. Nothing here ever stopped that ramp's Timer before this
        // function started driving the SAME node's volume via its own
        // crossfadeFadeTimer in runCrossfade below — two independent
        // Timers on outgoingNode.volume, exactly the same class of bug as
        // rampVolume/setVolume's fix, just starting from the opposite
        // side. Matches "playing ramps up, then overlaps with the ramp out
        // at the end of the song" — a resume tapped close enough to a
        // track's end that its ramp-in hadn't finished yet when the
        // natural crossfade lead-in fired on its own. Cancelling first
        // also means outgoingVolumeStart, captured right after, reflects
        // wherever the ramp had actually gotten to and stays accurate
        // instead of going stale the moment a still-running ramp keeps
        // moving it after this snapshot.
        if let climbing = rampInFlightTarget, climbing > volume { volume = climbing }
        cancelActiveRampLocked()
        debugLog("[RAMP-DEBUG] startCrossfade: cancelled any in-flight JS ramp before starting crossfade")
        // Forget the previous crossfade's incoming file. Until runCrossfade sets
        // it again (after the async load below), a settle call must see "nothing
        // loaded yet" instead of the stale file from an earlier crossfade.
        crossfadeIncomingFile = nil
        crossfadeIncomingIndex = nil
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
                let analysis: FileAnalysis? = (self?.silenceTrimEnabled == true || (self?.betweenTrackNormEnabled == true && track.replayGainDb == nil))
                    ? self?.analyzeFile(file, path: track.url.path) : nil
                DispatchQueue.main.async {
                    guard let self = self, token == self.playbackToken else {
                        // [RAMP-DEBUG] Diagnostic only, no behavior change —
                        // logging this rather than acting on it. Real
                        // question this answers: does a resume tapped close
                        // to a track's end (ramp-in still active) cause
                        // playbackToken to get bumped AGAIN before this
                        // crossfade's own async load finishes, abandoning
                        // it here with nothing left driving playback
                        // forward (the outgoing node's OWN completion
                        // callback was already invalidated by THIS
                        // crossfade's own earlier token bump above, and
                        // nothing here replaces it)? That's the leading
                        // theory for "pause then resume, overlaps the
                        // natural crossfade out, then position runs past
                        // the track's length forever until you skip or tap
                        // another song." Deliberately NOT adding a fallback
                        // load here yet — a token mismatch is supposed to
                        // mean something else already took over and is
                        // responsible for its own scheduling; blindly
                        // rescheduling here risks fighting whatever that is
                        // instead. Confirm from this log first.
                        self?.debugLog("[RAMP-DEBUG] startCrossfade: ABANDONED — token changed during async load/analysis (superseded, or the exact stuck-forever bug)")
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
                    self.runCrossfade(file: file, track: track, idx: idx, outgoingNode: outgoingNode, incomingNode: incomingNode, outgoingVolumeStart: outgoingVolumeStart, gainCorrection: (self.betweenTrackNormEnabled ? self.tagGain(for: track) : nil) ?? analysis?.gainCorrection ?? 1.0, leadInSeconds: leadIn, trailingCutSeconds: trailingCut, duration: duration, token: token)
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
        // Same stale-level race as the first-play pop: the node's volume was
        // written only moments before play(), and the first render slice
        // can still carry an old level (the first crossfade after launch is
        // the one that sounds like a pop). Starting the incoming node a few
        // ms later lets the fade curve's own first values land before any
        // audio does. 50ms of slip on a multi-second crossfade is not
        // audible.
        debugLog(String(format: "[XFADE] arm: outgoingTrailingCut=%.2fs", currentTrailingCutSeconds))
        debugLog(String(format: "[POP] crossfade arm: duration=%.1fs leadIn=%.2fs incomingVol=%.3f outgoingVol=%.3f mixerVol=%.3f", duration, leadInSeconds, incomingNode.volume, outgoingNode.volume, engine.mainMixerNode.outputVolume))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self = self, token == self.playbackToken, self.isCrossfading, self.state == .playing else { return }
            if !self.engine.isRunning { try? self.engine.start() }
            incomingNode.play()
            // Tell iOS about the incoming song's position straight away (it
            // extrapolates from there), instead of waiting for the next
            // periodic push or the end of the crossfade.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                guard let self = self, token == self.playbackToken, self.isCrossfading else { return }
                self.updateNowPlayingInfo()
            }
        }

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
                if !self.crossfadeSelfLoop {
                    self.sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": self.liveIndex(for: track, hint: idx)])
                }
                self.crossfadeAnnouncedIncoming = true
                // The lock screen / Bluetooth display switches to the new
                // song now too (same moment as the in-app display).
                self.updateNowPlayingInfo()
            }

            if currentStep >= steps {
                timer.invalidate()
                self.crossfadeFadeTimer = nil
                outgoingNode.stop()
                outgoingNode.volume = 0

                self.activeNode = incomingNode
                self.isCrossfading = false
                self.currentFile = file
                self.activeNodeTrack = track
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
                self.frozenPositionSeconds = nil
                self.crossfadeIncomingFile = nil
                self.crossfadeIncomingTrack = nil
                self.crossfadeIncomingIndex = nil
                self.crossfadeIncomingNode = nil

                // Same fix as loadAndScheduleCurrentTrack's equivalent —
                // always trust the just-measured real duration over
                // whatever JS/tag value was there, not just when nil.
                let liveIdx = self.commitMeasuredDuration(Double(file.length) / sampleRate - trailingCutSeconds, for: track, hint: idx)

                if !self.crossfadeSelfLoop {
                    self.sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": liveIdx])
                }
                self.crossfadeSelfLoop = false
                self.setState(.playing)
                self.startProgressTimer()
                // Handoff just completed — this crossfade's job is done,
                // arm the NEXT one for whatever's now playing (idx here
                // IS the current track already, currentIndex was updated
                // when this crossfade started).
                self.scheduleCrossfadeLeadIn()
                if let queued = self.queuedSkipDirection {
                    self.queuedSkipDirection = nil
                    DispatchQueue.main.async { [weak self] in
                        guard let self = self, self.state == .playing, !self.isCrossfading else { return }
                        if queued > 0 { self.skipToNextInternal() } else { self.skipToPreviousInternal() }
                    }
                }
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
            let who = self.progressTrackIdentity()
            self.sendEvent(withName: "PlaybackProgressUpdated", body: [
                "position": position,
                "duration": duration,
                "buffered": duration, // local files: fully "buffered" once loaded, no network buffering to report
                "id": who.id,
                "qid": who.qid,
            ])
            self.savePlaybackSnapshot()
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
        // Also run while a list is being dragged (the default run loop mode pauses during touch scrolling,
        // which froze progress readings and the saved position). The fade and ramp timers already do this.
        if let t = progressTimer { RunLoop.main.add(t, forMode: .common) }
    }

    // MARK: - Cold-start pop guard

    // The first play after launch, after a Bluetooth/route change, or after
    // sitting paused for a while can produce a one-off pop as the EQ,
    // normalizer and output hardware come alive at the same instant audio
    // starts. The JS ramp-in can't cover it (it fades the player node, which
    // is upstream of that). So on a cold start the very last stage, the main
    // mixer, is held at 0 for a moment and then eased back up, hiding the
    // wake-up before anything reaches the speaker. Normal warm plays are
    // untouched.
    private var outputIsCold: Bool = true
    private var lastAudibleAt: Date? = nil
    private var coldStartToken: Int = 0

    private func markOutputCold() { outputIsCold = true }

    // The pop on the first play (and after a route change) was measured from a
    // screen recording: a full-scale burst about 25ms long at the instant
    // playback starts, before the fade-in, then a clean ramp. That is the
    // first slice of real song audio going out at a STALE node gain (the old
    // 0.4 level, plus the EQ pre-amp, clipping) because the node was told
    // "volume 0" only a few milliseconds before play(), less than one render
    // slice, so the mixer had not applied it yet. Giving the gain a moment to
    // land before play() starts removes the burst.
    private var pendingPlayToken: Int = 0
    private let gainSettleDelay: TimeInterval = 0.08

    private func startActiveNodeAfterGainSettles(needsSettle: Bool) {
        pendingPlayToken += 1
        if !needsSettle {
            activeNode.play()
            return
        }
        let token = pendingPlayToken
        DispatchQueue.main.asyncAfter(deadline: .now() + gainSettleDelay) { [weak self] in
            guard let self = self, token == self.pendingPlayToken, self.state == .playing else { return }
            // Belt and braces: a fade-in must start from true silence. If JS
            // asked for volume 0, write it again right before the node
            // starts so nothing else can have left a stale level on it.
            if !self.isCrossfading, self.volume < 0.02 {
                self.activeNode.volume = 0
            }
            self.debugLog(String(format: "[POP] node starts: nodeVol=%.3f mixerVol=%.3f muteHeld=%@", self.activeNode.volume, self.engine.mainMixerNode.outputVolume, self.coldMuteHeld ? "true" : "false"))
            self.activeNode.play()
        }
    }

    // True while the main mixer is being held at 0 for a cold start. The
    // pop on the first play lined up with the moment this mute lifted on a
    // fixed timer (about 0.33s after play), which is also the moment the
    // JS fade-in begins, so leftover level on the node leaked through for
    // one render slice. The mute is now released by the fade-in itself,
    // only after the node has been written to 0 and a moment has passed,
    // with a timer only as a fallback for plays that have no fade-in.
    private var coldMuteHeld: Bool = false
    // When JS last set the volume to ~0 (the first step of every fade-in).
    private var lastZeroVolumeAt: Date? = nil

    private func releaseColdStartMute(after delay: TimeInterval) {
        guard coldMuteHeld else { return }
        coldMuteHeld = false
        let token = coldStartToken
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, token == self.coldStartToken else { return }
            let steps = 8
            for i in 1...steps {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.015 * Double(i)) { [weak self] in
                    guard let self = self, token == self.coldStartToken else { return }
                    self.engine.mainMixerNode.outputVolume = Float(i) / Float(steps)
                }
            }
        }
    }

    @discardableResult
    private func beginColdStartMuteIfNeeded() -> Bool {
        // Still playing means the output is warm, however long ago play was pressed.
        if !outputIsCold, state != .playing, let last = lastAudibleAt, Date().timeIntervalSince(last) > 4 { outputIsCold = true }
        guard outputIsCold else { return false }
        outputIsCold = false
        coldStartToken += 1
        let token = coldStartToken
        let mixer = engine.mainMixerNode
        mixer.outputVolume = 0
        coldMuteHeld = true
        // A fade-in is coming if JS just set the volume to 0: wait for it
        // (it releases the mute itself). Otherwise keep the old short hold.
        let rampExpected = lastZeroVolumeAt.map { Date().timeIntervalSince($0) < 3 } ?? false
        let fallback: TimeInterval = rampExpected ? 1.5 : 0.15
        DispatchQueue.main.asyncAfter(deadline: .now() + fallback) { [weak self] in
            guard let self = self, token == self.coldStartToken else { return }
            self.releaseColdStartMute(after: 0)
        }
        return true
    }

    private func playInternal() {
        deviceLossFadeToken &+= 1   // a play cancels a device-loss fade-out that is still under way
        if let base = deviceLossBaseVol { activeNode.volume = base; deviceLossBaseVol = nil }   // and puts the level back
        guard currentIndex != nil else {
            if !queue.isEmpty {
                currentIndex = 0
                loadAndScheduleCurrentTrack(autoPlay: true)
            }
            return
        }
        // The song scheduled before a route change may be gone: load it again
        // at the same position (this also starts playback) instead of
        // playing nothing. Cleared by any load that has happened since.
        if state != .playing, !isCrossfading, let stale = staleScheduleToken, stale == playbackToken {
            staleScheduleToken = nil
            let resumeAt = max(0, frozenPositionSeconds ?? currentPositionSeconds())
            activateSession()
            if !engine.isRunning { try? engine.start() }
            loadAndScheduleCurrentTrack(startAtSeconds: resumeAt, autoPlay: true, announceChange: false)
            scheduleSilenceWatchdog()
            return
        }
        let coldStart = beginColdStartMuteIfNeeded()
        activateSession()
        // frozenPositionSeconds is deliberately NOT cleared here: it keeps
        // the position steady until the node reports a real render time
        // (see currentPositionSeconds).
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
        pauseReassertToken += 1
        lastAudibleAt = Date()
        setState(.playing)
        scheduleSilenceWatchdog()
        startActiveNodeAfterGainSettles(needsSettle: coldStart || activeNode.volume < 0.02)
        // Resume — reschedule the lead-in timer from the CURRENT position,
        // not whatever was left when it was invalidated on pause below.
        scheduleCrossfadeLeadIn()
    }

    // Tells iOS "paused" again a few times after a pause has finished.
    // Control Center was reverting to "playing" after a pause while the lock
    // screen stayed paused, so a single paused update right at the pause is
    // not trusted to stick. Each repeat only fires if we are still paused,
    // and does nothing if playback resumed in the meantime.
    private var pauseReassertToken: Int = 0
    private func reassertPausedToSystem() {
        pauseReassertToken += 1
        let token = pauseReassertToken
        for delay in [0.25, 0.8, 2.0, 4.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, token == self.pauseReassertToken else { return }
                guard self.state == .paused, self.displayedAsPaused != false else { return }
                self.updateNowPlayingInfo()
                MPNowPlayingInfoCenter.default().playbackState = .paused
                self.debugLog("[NP] re-sent paused to iOS after \(delay)s")
            }
        }
    }

    // Drops an in-progress scratch without resuming from it (a pause, stop
    // or track change arrived mid-scratch). The playhead stays where the
    // normal player had it; the disc's later scratchEnd then finds nothing
    // to end.
    private func abortScratch() {
        guard scratchActive else { return }
        stopScratchRefillTimer()
        scratchCore.release()
        scratchActive = false
        timePitchNode.bypass = abs(playbackRate - 1) < 0.001
        if state == .playing { activeNode.volume = volume * currentGainCorrection }
    }

    private func pauseInternal() {
        silenceWatchdogToken &+= 1
        abortScratch()
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
        lastAudibleAt = Date()
        pendingPlayToken += 1
        frozenPositionSeconds = currentPositionSeconds()
        activeNode.pause()
        setState(.paused)
        savePlaybackSnapshot(force: true)
        reassertPausedToSystem()
        // Stop the audio hardware too, not just the player node. With the
        // engine left running, iOS still sees the app producing output
        // (silence) and Control Center flips back to "playing" a moment
        // after a pause. Pausing the engine keeps the node's scheduled
        // audio (same as the route-change restart does); playInternal
        // starts it again. The next start is treated as cold so the
        // restart cannot click.
        if engine.isRunning {
            engine.pause()
        }
        markOutputCold()
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
    // `snapToFull: false` leaves the incoming song at whatever level the
    // crossfade had already faded it to instead of jumping it to full
    // volume. The jump was audible as a loud blip whenever anything (a JS
    // fade, a volume write) landed in the middle of a crossfade.
    private func settleCrossfadeToIncoming(snapToFull: Bool = true) {
        guard isCrossfading else { return }
        queuedSkipDirection = nil
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
        outgoingNode.volume = 0
        if snapToFull { incomingNode.volume = crossfadeTargetVolume }

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

        if let incomingTrack = crossfadeIncomingTrack {
            activeNodeTrack = incomingTrack
            // Same fix as loadAndScheduleCurrentTrack's equivalent —
            // always trust the just-measured real duration over whatever
            // JS/tag value was there, not just when nil.
            let liveIdx = commitMeasuredDuration(Double(file.length) / crossfadeIncomingSampleRate - crossfadeIncomingTrailingCutSeconds, for: incomingTrack, hint: idx)
            // Covers landing here before runCrossfade's own halfway-point
            // announcement ever fired — JS still needs to know the track
            // changed. Harmless if it already fired; JS de-dupes by queue
            // slot (see PlaybackContext.js's PlaybackTrackChanged listener).
            if !crossfadeSelfLoop {
                sendEvent(withName: "PlaybackTrackChanged", body: ["nextTrack": liveIdx])
            }
        }
        crossfadeSelfLoop = false

        crossfadeIncomingFile = nil
        crossfadeIncomingTrack = nil
        crossfadeIncomingIndex = nil
        crossfadeIncomingNode = nil
        crossfadeAnnouncedIncoming = false
    }

    private func stopInternal() {
        silenceWatchdogToken &+= 1
        abortScratch()
        cancelCrossfadeIfNeeded()
        crossfadeLeadTimer?.invalidate()
        crossfadeLeadTimer = nil
        playbackToken &+= 1
        activeNode.stop()
        progressTimer?.invalidate()
        setState(.stopped)
        // Speculative fix, lower confidence than most of this file's other
        // comments — for "sometimes the songs pop when clicking them",
        // separate from the (already-fixed) very-first-play-after-launch
        // pop: this used to deactivateSession() here, on every natural
        // queue-end/stop, while the app stays open. Reactivating a session
        // (activateSession(), called at the start of the next play/skip/
        // load) is its own hardware I/O route event — the same class of
        // thing that causes the first-play pop init now avoids by keeping
        // the engine warm continuously. Deactivating here just to
        // re-activate moments later, the next time the user taps
        // something, pays that same cost repeatedly instead of once.
        // Genuinely deactivating when the app is about to die is still
        // handled — see handleAppWillTerminate above. Not deactivating on
        // every in-app stop is the same "stay warm while the app is
        // alive" philosophy as the engine already gets, just not
        // confirmed against a device the way that fix was.
    }

    private func skipToNextInternal() {
        if isCrossfading {
            queuedSkipDirection = 1
            debugLog("[RAMP-DEBUG] skip NEXT arrived mid-crossfade, queued until it finishes")
            return
        }
        advance(direction: 1, wrap: repeatMode == .queue, autoPlay: true, isManualSkip: true)
    }

    private func skipToPreviousInternal() {
        if isCrossfading {
            queuedSkipDirection = -1
            debugLog("[RAMP-DEBUG] skip PREVIOUS arrived mid-crossfade, queued until it finishes")
            return
        }
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
                    debugLog("[RAMP-DEBUG] remove(): removing the CURRENT index (\(current)) itself — clearing currentIndex. If this fires unexpectedly during a repro, a call site is hitting this \"shouldn't happen today\" path.")
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
        abortScratch()   // a song change during a scratch ends the scratch (no two songs at once)
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
        // Tapping a song while a crossfade is already running used to hard-stop
        // both players (cancelCrossfadeIfNeeded) and cold-start the new song,
        // which cut the fade off dead. Instead the running fade is brought to
        // its current state (the song fading in is kept at the level it had
        // reached, nothing jumps) and a fresh crossfade from there to the
        // tapped song starts straight away.
        if crossfadeEnabled, crossfadeDurationSkipSeconds > 0.05, isCrossfading, state == .playing, idx != currentIndex {
            settleCrossfadeToIncoming(snapToFull: false)
        }
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

    // Real bug found here (still-reported "queues the song but then just
    // goes straight to it, no crossfade" after the JS-side transition lock
    // added for this same symptom in an earlier round): that JS lock only
    // ever blocked JS's OWN natural-end-of-track polling from interleaving
    // with primeQueueForTransition's insert->skip->remove sequence — it has
    // no way to touch THIS side's completely independent natural-end
    // detection (startProgressTimer's tick -> handlePlaybackCompleted ->
    // advance()), which runs regardless of any JS lock. If the outgoing
    // song happens to hit its own real end natively in the narrow window
    // between JS deciding "crossfade should apply here" and its skip()
    // call actually landing, state/currentIndex can have already moved by
    // the time skip() re-derives its own crossfade decision from current
    // state — silently falling through to the hard-cut branch instead,
    // even though every precondition was genuinely true when JS checked.
    // primeQueueForTransition already verifies crossfade should apply
    // before it ever gets here; having skip() re-verify the exact same
    // thing again after an async gap is exactly what leaves the opening
    // for state to shift in between. This bypasses that re-check entirely
    // and goes straight to the same startCrossfade() skip() would have
    // used — correct precisely because the caller already confirmed
    // everything moments ago, not despite it.
    @objc(crossfadeToIndex:duration:resolver:rejecter:)
    func crossfadeToIndex(_ index: NSNumber, duration: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        abortScratch()   // a song change during a scratch ends the scratch (no two songs at once)
        let idx = index.intValue
        guard idx >= 0, idx < queue.count else { resolve(nil); return }
        // Tapping a song while a crossfade is already running: starting a
        // second crossfade on top used the song fading IN as the "idle" player
        // and stopped it dead. Bring the running fade to its current state
        // first (nothing jumps), then fade from there to the tapped song.
        if isCrossfading { settleCrossfadeToIncoming(snapToFull: false) }
        // Same song again (Previous restarting it, or tapping the song that is
        // already playing): the song fades into its own start. It is not a
        // track change, so no change event is sent for it.
        crossfadeSelfLoop = (idx == currentIndex)
        currentIndex = idx
        startCrossfade(toIndex: idx, duration: duration.doubleValue)
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

    // Sets suppressNextCrossfade (see its declaration for the full
    // reasoning) — called from JS immediately before skipToNext/Previous
    // whenever JS has already decided this specific skip should be a plain
    // JS-driven ramp, not native's own crossfade.
    @objc(setSuppressNextCrossfade:resolver:rejecter:)
    func setSuppressNextCrossfade(_ v: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        suppressNextCrossfade = v.boolValue
        suppressNextCrossfadeAt = v.boolValue ? Date() : nil
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
        // [RAMP-DEBUG] Diagnostic — same chase as advance()'s. If this
        // fires between a fresh launch's restore finishing and the first
        // Play tap, something called reset() in that window (a stray
        // fresh-song-tap sequence, e.g.) and that's the direct cause of
        // the slow-reload-from-0:00 bug this session's log already
        // narrowed down to a nil currentIndex.
        debugLog("[RAMP-DEBUG] reset() called — clearing queue and currentIndex (was \(currentIndex.map(String.init) ?? "nil"), queue had \(queue.count) tracks)")
        stopInternal()
        queue.removeAll()
        currentIndex = nil
        activeNodeTrack = nil
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
        if let artist = metadata["artist"] as? String {
            track.artist = artist
            artistOverrideById[track.id] = artist
        }
        if let album = metadata["album"] as? String { track.album = album }
        if let artwork = metadata["artwork"] as? String {
            track.artwork = artwork
            artworkOverrideById[track.id] = artwork
        }
        queue[idx] = track
        if idx == currentIndex { updateNowPlayingInfo() }
        resolve(nil)
    }

    // Writes a downscaled JPEG copy of an image (longest side = maxPixel).
    // iOS empties React Native's decoded-image cache every time the app goes
    // to the background, so every cover had to be decoded again from its
    // full-size file on return, which is the blank-then-fill flash on lists.
    // A ~160px copy decodes near-instantly, so lists use those; the same
    // helper makes a screen-sized copy of the custom background.
    @objc(makeThumbnail:destPath:maxPixel:resolver:rejecter:)
    func makeThumbnail(_ src: String, destPath dest: String, maxPixel: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .utility).async {
            func plainPath(_ p: String) -> String {
                if p.hasPrefix("file://"), let u = URL(string: p) { return u.path }
                return p
            }
            var srcPath = plainPath(src)
            let destPathPlain = plainPath(dest)
            if !FileManager.default.fileExists(atPath: srcPath),
               let range = srcPath.range(of: "/Documents/"),
               let realDocs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                srcPath = realDocs.appendingPathComponent(String(srcPath[range.upperBound...])).path
            }
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: srcPath) as CFURL, nil) else {
                resolve(false)
                return
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixel.intValue,
            ]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
                  let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.85) else {
                resolve(false)
                return
            }
            do {
                try FileManager.default.createDirectory(atPath: (destPathPlain as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: nil)
                try data.write(to: URL(fileURLWithPath: destPathPlain), options: .atomic)
                resolve(true)
            } catch {
                resolve(false)
            }
        }
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

    @objc(setPlaybackRate:resolver:rejecter:)
    func setPlaybackRate(_ rate: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { resolve(nil); return }
            let r = max(0.25, min(3.0, rate.floatValue))
            self.playbackRate = r
            self.timePitchNode.rate = r
            self.timePitchNode.pitch = 0
            // While scratching the stretch stays off so the scratch sounds like
            // a record; it is applied again when the scratch ends.
            self.timePitchNode.bypass = abs(r - 1) < 0.001 || self.scratchActive
            // The song's end now comes sooner or later in real time.
            if self.state == .playing, !self.isCrossfading { self.scheduleCrossfadeLeadIn() }
            self.updateNowPlayingInfo()
            self.debugLog(String(format: "[RATE] playback speed %.2fx", r))
            resolve(nil)
        }
    }

    // MARK: - DJ disc scratching

    private func ensureScratchNode() -> Bool {
        if scratchNode != nil { return true }
        let sr = engine.mainMixerNode.outputFormat(forBus: 0).sampleRate
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: sr > 0 ? sr : 44100, channels: 2) else { return false }
        let core = scratchCore
        let node = AVAudioSourceNode(format: fmt) { _, _, frameCount, audioBufferList -> OSStatus in
            let bufs = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let n = Int(frameCount)
            guard core.active, core.left != nil, core.right != nil, core.frames > 4, bufs.count >= 2,
                  let outL = bufs[0].mData?.assumingMemoryBound(to: Float.self),
                  let outR = bufs[1].mData?.assumingMemoryBound(to: Float.self) else {
                for b in bufs { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
                return noErr
            }
            var pos = core.pos
            if let pl = core.pendL, let pr = core.pendR, core.pendFrames > 4 {
                core.retiredL = core.left; core.retiredR = core.right
                core.left = pl; core.right = pr
                core.frames = core.pendFrames
                pos -= core.pendShift
                core.windowStart = core.pendStart
                core.pendL = nil; core.pendR = nil; core.pendFrames = 0
            }
            guard let l = core.left, let r = core.right else { return noErr }
            var cur = core.cur
            var g = core.gain
            let tgt = core.target
            let loAbs = core.limitLo
            let gTgt = core.gainTarget
            let hiAbs = core.limitHi
            let fr = max(1, core.fileRate)
            let ws = core.windowStart
            let level = core.level
            let step = core.step
            let maxPos = Double(core.frames - 2)
            for i in 0..<n {
                // Smoothing: the speed glides toward what the disc asks for
                // (about 10ms) so a finger's jitter does not crackle.
                cur += (tgt - cur) * 0.0018
                g += (gTgt - g) * 0.0035
                var spd = cur
                let absNow = ws + pos / fr
                if spd > 0 {
                    let room = hiAbs - absNow
                    if room <= 0 { spd = 0 } else if room < 0.15 { spd *= Float(room / 0.15) }
                } else if spd < 0 {
                    let room = absNow - loAbs
                    if room <= 0 { spd = 0 } else if room < 0.15 { spd *= Float(room / 0.15) }
                }
                pos += Double(spd) * step
                if pos < 0 { pos = 0 }
                if pos > maxPos { pos = maxPos }
                let i0 = Int(pos)
                let f = Float(pos - Double(i0))
                let a = g * level
                outL[i] = (l[i0] * (1 - f) + l[i0 + 1] * f) * a
                outR[i] = (r[i0] * (1 - f) + r[i0 + 1] * f) * a
            }
            core.pos = pos
            core.cur = cur
            core.gain = g
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: preMixNode, format: fmt)
        scratchNode = node
        scratchFormat = fmt
        return true
    }

    // Starts scratching at the current position. Resolves true once audio is
    // ready (false when it cannot start: crossfading, nothing loaded, or too
    // close to the start or end of the song).
    @objc(scratchBegin:rejecter:)
    func scratchBegin(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { resolve(false); return }
            guard !self.scratchActive, !self.scratchLoading, !self.isCrossfading,
                  let idx = self.currentIndex, idx >= 0, idx < self.queue.count,
                  self.state == .playing || self.state == .paused || self.state == .ready,
                  let file = self.currentFile, self.ensureScratchNode() else { resolve(false); return }
            let track = self.queue[idx]
            let fileRate = file.processingFormat.sampleRate
            let totalSec = Double(file.length) / fileRate
            let now = self.currentPositionSeconds()
            // Native-side backstop for the same rule JS applies.
            if now < 1.0 || now > totalSec - 4.0 { resolve(false); return }
            let windowStart = max(0, now - 15)
            let windowEnd = min(totalSec, now + 15)
            self.scratchLoading = true
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                var left: UnsafeMutablePointer<Float>? = nil
                var right: UnsafeMutablePointer<Float>? = nil
                var frames = 0
                do {
                    let f = try AVAudioFile(forReading: track.url)
                    let startFrame = AVAudioFramePosition(windowStart * fileRate)
                    let count = AVAudioFrameCount(max(0, (windowEnd - windowStart) * fileRate))
                    f.framePosition = startFrame
                    if let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: count), count > 0 {
                        try f.read(into: buf, frameCount: count)
                        frames = Int(buf.frameLength)
                        if frames > 4, let ch = buf.floatChannelData {
                            let chans = Int(buf.format.channelCount)
                            let l = UnsafeMutablePointer<Float>.allocate(capacity: frames)
                            let r = UnsafeMutablePointer<Float>.allocate(capacity: frames)
                            l.update(from: ch[0], count: frames)
                            r.update(from: ch[chans > 1 ? 1 : 0], count: frames)
                            left = l; right = r
                        }
                    }
                } catch { frames = 0 }
                let leftOut = left, rightOut = right, framesOut = frames
                DispatchQueue.main.async {
                    guard let self = self else { leftOut?.deallocate(); rightOut?.deallocate(); resolve(false); return }
                    self.scratchLoading = false
                    guard let l = leftOut, let r = rightOut, framesOut > 4, !self.isCrossfading,
                          self.currentIndex == idx, let fmt = self.scratchFormat else {
                        leftOut?.deallocate(); rightOut?.deallocate(); resolve(false); return
                    }
                    // Use the position as it is NOW (loading took a moment).
                    let nowAfter = self.currentPositionSeconds()
                    let startPos = (nowAfter - windowStart) * fileRate
                    if startPos < 2 || startPos > Double(framesOut - 2) {
                        l.deallocate(); r.deallocate(); resolve(false); return
                    }
                    let core = self.scratchCore
                    core.release()
                    core.left = l; core.right = r; core.frames = framesOut
                    core.step = fileRate / fmt.sampleRate
                    core.windowStart = windowStart
                    core.fileRate = fileRate
                    core.limitHi = totalSec - 4.0   // same backstop as above; the app's own limits are stricter
                    core.limitLo = 1.0
                    core.pos = startPos
                    core.target = 0
                    // Like a hand on a turntable: the sound stops the moment the
                    // disc is touched and only moves when the disc moves.
                    core.cur = 0
                    core.target = 0
                    core.gain = 0
                    core.gainTarget = 1
                    core.level = self.volume * self.currentGainCorrection
                    self.scratchWindowStartSeconds = windowStart
                    self.scratchFileRate = fileRate
                    self.scratchWasPlaying = self.state == .playing
                    self.crossfadeLeadTimer?.invalidate()
                    self.crossfadeLeadTimer = nil
                    if !self.engine.isRunning {
                        self.activateSession()
                        try? self.engine.start()
                    }
                    self.scratchActive = true
                    self.scratchTotalSeconds = totalSec
                    self.startScratchRefillTimer()
                    self.timePitchNode.bypass = true
                    core.active = true
                    // Silence the normal player over ~15ms (the scratch node
                    // fades in over the same time), so there is no click.
                    let startVol = self.activeNode.volume
                    for i in 1...8 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.004 * Double(i)) { [weak self] in
                            guard let self = self, self.scratchActive else { return }
                            self.activeNode.volume = startVol * Float(8 - i) / 8
                            // Once silent, actually pause the normal player so
                            // nothing of the song can play underneath the scratch.
                            if i == 8, self.scratchWasPlaying { self.activeNode.pause() }
                        }
                    }
                    self.debugLog(String(format: "[SCRATCH] begin at %.2fs window=%.1f-%.1f wasPlaying=%@", nowAfter, windowStart, windowEnd, self.scratchWasPlaying ? "true" : "false"))
                    resolve(true)
                }
            }
        }
    }

    // Keeps the scratch audio ahead of the disc. Only about 30 seconds around
    // the starting point are loaded, so spinning the disc forward (or back)
    // for long used to run off the end of that and go silent until the
    // finger turned around. A timer now checks every 100ms and, when the disc
    // nears an edge of what is loaded, loads a fresh 30-second window centred
    // on where the disc is and swaps it in without a gap.
    private var scratchRefillTimer: Timer?
    private var scratchRefilling = false
    private var scratchTotalSeconds: Double = 0
    private func startScratchRefillTimer() {
        scratchRefillTimer?.invalidate()
        scratchRefillTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.checkScratchWindow() }
        if let t = scratchRefillTimer { RunLoop.main.add(t, forMode: .common) }
    }
    private func stopScratchRefillTimer() {
        scratchRefillTimer?.invalidate()
        scratchRefillTimer = nil
        scratchRefilling = false
    }
    private func checkScratchWindow() {
        guard scratchActive, !scratchRefilling, scratchCore.pendL == nil,
              let idx = currentIndex, idx >= 0, idx < queue.count else { return }
        let core = scratchCore
        let rate = scratchFileRate
        guard rate > 0, core.frames > 4 else { return }
        let posSec = core.pos / rate
        let lenSec = Double(core.frames) / rate
        let abs = core.windowStart + posSec
        let movingForward = core.target > 0.05
        let movingBack = core.target < -0.05
        let needForward = movingForward && (lenSec - posSec) < 6 && (core.windowStart + lenSec) < scratchTotalSeconds - 0.05
        let needBack = movingBack && posSec < 6 && core.windowStart > 0.05
        guard needForward || needBack else { return }
        scratchRefilling = true
        let newStart = max(0, abs - 15)
        let newEnd = min(scratchTotalSeconds, abs + 15)
        let url = queue[idx].url
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var left: UnsafeMutablePointer<Float>? = nil
            var right: UnsafeMutablePointer<Float>? = nil
            var frames = 0
            do {
                let f = try AVAudioFile(forReading: url)
                let count = AVAudioFrameCount(max(0, (newEnd - newStart) * rate))
                f.framePosition = AVAudioFramePosition(newStart * rate)
                if let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: count), count > 0 {
                    try f.read(into: buf, frameCount: count)
                    frames = Int(buf.frameLength)
                    if frames > 4, let ch = buf.floatChannelData {
                        let chans = Int(buf.format.channelCount)
                        let l = UnsafeMutablePointer<Float>.allocate(capacity: frames)
                        let r = UnsafeMutablePointer<Float>.allocate(capacity: frames)
                        l.update(from: ch[0], count: frames)
                        r.update(from: ch[chans > 1 ? 1 : 0], count: frames)
                        left = l; right = r
                    }
                }
            } catch { frames = 0 }
            let lo = left, ro = right, fo = frames
            DispatchQueue.main.async {
                guard let self = self else { lo?.deallocate(); ro?.deallocate(); return }
                self.scratchRefilling = false
                guard let l = lo, let r = ro, fo > 4, self.scratchActive, self.currentIndex == idx,
                      self.scratchCore.pendL == nil else { lo?.deallocate(); ro?.deallocate(); return }
                // Where the disc is right now, which is further on than when loading began.
                let c = self.scratchCore
                let absNow = c.windowStart + c.pos / rate
                let newPos = (absNow - newStart) * rate
                if newPos < 2 || newPos > Double(fo - 2) { l.deallocate(); r.deallocate(); return }
                c.pendShift = (newStart - c.windowStart) * rate
                c.pendStart = newStart
                c.pendFrames = fo
                c.pendR = r
                c.pendL = l
                // Old window is freed a moment after the audio thread has let go of it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self = self else { return }
                    let rl = self.scratchCore.retiredL, rr = self.scratchCore.retiredR
                    self.scratchCore.retiredL = nil; self.scratchCore.retiredR = nil
                    rl?.deallocate(); rr?.deallocate()
                }
                self.debugLog(String(format: "[SCRATCH] window moved to %.1f-%.1f", newStart, newEnd))
            }
        }
    }

    // Speed of the disc: 1 = normal forward, 0 = held, negative = backward.
    @objc(scratchSetRate:)
    func scratchSetRate(_ rate: NSNumber) {
        scratchCore.target = max(-4, min(4, rate.floatValue))
    }

    // Stops scratching, resumes the song from where the disc left it (playing
    // if it was playing before) and resolves with that position in seconds.
    @objc(scratchEnd:rejecter:)
    func scratchEnd(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.scratchActive else { resolve(nil); return }
            let core = self.scratchCore
            let wasPlaying = self.scratchWasPlaying
            let restoreVol = self.volume * self.currentGainCorrection
            // Playing before: the disc first glides back up to normal speed
            // (about 120ms, so letting go sounds like the record catching
            // up, not a cut), then the normal player takes over from that
            // exact spot with a short overlap. Paused before: just fade out.
            core.target = wasPlaying ? 1 : 0
            let glide: TimeInterval = wasPlaying ? 0.12 : 0.0
            DispatchQueue.main.asyncAfter(deadline: .now() + glide) { [weak self] in
                guard let self = self, self.scratchActive else { resolve(nil); return }
                let finalSec = max(0, core.windowStart + core.pos / self.scratchFileRate)
                core.gainTarget = 0
                DispatchQueue.main.asyncAfter(deadline: .now() + (wasPlaying ? 0.0 : 0.06)) { [weak self] in
                    guard let self = self, self.scratchActive else { resolve(nil); return }
                    self.scratchActive = false
                    self.stopScratchRefillTimer()
                    self.timePitchNode.bypass = abs(self.playbackRate - 1) < 0.001
                    self.seekWithinCurrentTrack(startAtSeconds: finalSec, autoPlay: wasPlaying)
                    // The normal player comes up over ~32ms while the scratch
                    // audio fades out underneath it.
                    self.activeNode.volume = 0
                    for i in 1...8 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.004 * Double(i)) { [weak self] in
                            guard let self = self, !self.scratchActive else { return }
                            self.activeNode.volume = restoreVol * Float(i) / 8
                        }
                    }
                    if !wasPlaying, self.engine.isRunning { self.engine.pause() }
                    // Let the scratch fade finish before its audio is dropped.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                        // A new scratch may have started meanwhile; only drop the audio if not.
                        if self?.scratchActive == false { core.release() }
                    }
                    self.debugLog(String(format: "[SCRATCH] end at %.2fs resume=%@", finalSec, wasPlaying ? "play" : "paused"))
                    resolve(finalSec)
                }
            }
        }
    }

    @objc(seekTo:resolver:rejecter:)
    func seekTo(_ seconds: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        let wasPlaying = state == .playing
        // [SEEK-DEBUG] Temporary — see PlayerScreen.js's matching tag.
        debugLog(String(format: "[SEEK-DEBUG] native seekTo called: seconds=%.3f wasPlaying=%@ currentIndex=%@ isCrossfading=%@", seconds.doubleValue, wasPlaying ? "true" : "false", currentIndex.map(String.init) ?? "nil", isCrossfading ? "true" : "false"))
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
        frozenPositionSeconds = nil // a seek moves the origin; never keep the pre-seek snapshot
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
            if !engine.isRunning {
                try? engine.start()
            }
            activeNode.play()
            setState(.playing)
            scheduleCrossfadeLeadIn()
        } else {
            setState(.ready)
        }
    }

    // Real cause of "in-app pause not reflected on lock screen" found here
    // (two prior rounds looked for a logic bug in pauseInternal/setState/
    // updateNowPlayingInfo itself and correctly found none — the actual
    // gap was never in this file at all). PlaybackService.js's
    // pauseWithRamp() runs the ENTIRE fade-out to silence — up to several
    // seconds, depending on the Skip Ramp / Audio Ramp setting — before it
    // ever calls the real AudioEngine.pause() below. Nothing updates
    // MPNowPlayingInfoPropertyPlaybackRate until that real pause() finally
    // fires, so the lock screen/Control Center keeps showing "playing"
    // for the whole fade — exactly "keeps showing playing" if you check it
    // right after tapping pause, which is the natural thing to do. This
    // lets JS flip just the DISPLAYED rate immediately when a ramp-out
    // starts, without touching the actual engine state (state/activeNode
    // untouched) — the audio keeps fading out normally, the lock screen
    // just stops lying about it while that happens. The real pause() call
    // that follows the fade re-affirms the same info a moment later
    // (harmless), and if playback resumes mid-fade instead, the normal
    // play() → setState(.playing) path overwrites this on its own — no
    // separate "undo" needed.
    @objc(setNowPlayingPaused:resolver:rejecter:)
    func setNowPlayingPaused(_ paused: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        displayedAsPaused = paused.boolValue
        displayedAsPausedAt = Date()
        updateNowPlayingInfo()
        resolve(nil)
    }

    @objc(setVolume:resolver:rejecter:)
    func setVolume(_ vol: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        // Real bug found here (ramp-in glitching against a crossfade/fade
        // already in flight): a native crossfade (whether started by the
        // autonomous lead-in timer near a natural track end, or by a manual
        // skip) drives BOTH nodes' volume itself, on its own Timer
        // (crossfadeFadeTimer in runCrossfade), and does not hand activeNode
        // over to the incoming node until it finishes. Critically, JS has NO
        // way to know an autonomous lead-in crossfade has started — it only
        // ever gets a PlaybackTrackChanged event at the crossfade's halfway
        // point and again on completion — so isTransitionLocked() on the JS
        // side stays false the entire time, and any ordinary JS-triggered
        // action (pause, a song tap, Next/Previous) proceeds thinking
        // nothing is happening. Every one of those goes through setVolume/
        // rampVolume below, which used to write straight to activeNode —
        // still the OUTGOING node for the whole crossfade — with nothing
        // stopping crossfadeFadeTimer first. Two independent timers then
        // wrote to the same node's volume on every tick, each unaware of
        // the other: audible as volume jumping around rather than a clean
        // fade, plus the incoming node kept right on playing/ramping in
        // regardless of whatever JS thought it had just started (e.g. a
        // pause). pauseInternal/seekWithinCurrentTrack already settle an
        // in-progress crossfade before touching activeNode (see
        // settleCrossfadeToIncoming's own comment) — this was the same
        // fix, just missing from the two lowest-level volume entry points
        // every JS ramp/fade actually calls. Settling first here means any
        // JS-driven volume change always lands on one already-consistent
        // node, never a node a crossfade timer is still actively fading.
        // While a native crossfade is running it owns both nodes' volume.
        // JS writes that land mid-crossfade (the "restore to full" or the
        // start-at-zero of a ramp-in it thinks it needs) used to snap the
        // crossfade shut: incoming jumped to full volume for an instant,
        // then JS pulled it to 0 and ramped it back up, which is the
        // full-volume blip at the start of a crossfade. They are now
        // ignored; the crossfade finishes at the level it was started for.
        if isCrossfading {
            resolve(nil)
            return
        }
        // A direct setVolume call always means "I want this volume NOW" —
        // cancel any ramp still in flight so it can't win a race and
        // overwrite this a moment later on its next tick. Resolves the
        // superseded ramp's own promise (not reject) so whatever JS code is
        // still awaiting it doesn't hang.
        cancelActiveRampLocked()
        volume = vol.floatValue
        if volume < 0.02 {
            lastZeroVolumeAt = Date()
        } else {
            // A real "play at this volume" request: no fade-in is coming,
            // so a cold-start mute (if one is being held) can lift now.
            releaseColdStartMute(after: 0.05)
        }
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
        rampInFlightTarget = nil
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
        // Same fix, same reasoning as setVolume() above — this is the one
        // that actually matters most in practice, since every JS ramp/fade
        // (pause-out, skip-out, a fresh song's ramp-in) calls THIS, not
        // setVolume, for the actual fade. Settle any in-progress crossfade
        // onto a single node before this ramp starts driving activeNode.
        var fromVal = max(0, min(1, from.floatValue))
        let toVal = max(0, min(1, to.floatValue))
        let dur = max(0, duration.doubleValue)
        if isCrossfading {
            if toVal >= fromVal {
                // A fade-IN (or restore) during a crossfade: the crossfade is
                // already fading the incoming song in, so this is skipped
                // instead of snapping the crossfade shut. See setVolume.
                resolve(nil)
                return
            }
            // A fade-OUT (pause, a tap on another song) during a crossfade:
            // finish the crossfade on the incoming song WITHOUT jumping it
            // to full volume, and start the fade-out from the level it was
            // actually at, so there is no blip up before the fade down.
            // (Only when the incoming song has actually started; if it is
            // still loading, the outgoing song is the one audible and the
            // fade-out just starts from where JS said.)
            let incomingStarted = crossfadeIncomingNode != nil && crossfadeIncomingFile != nil
            let liveLevel = (crossfadeIncomingNode?.volume ?? 0) / max(crossfadeIncomingGainCorrection, 0.0001)
            settleCrossfadeToIncoming(snapToFull: false)
            if incomingStarted { fromVal = min(fromVal, max(0.0, liveLevel)) }
        }
        cancelActiveRampLocked()

        volume = fromVal
        activeNode.volume = fromVal * currentGainCorrection
        // The fade-in is now genuinely under way and the node has just been
        // written to its start level: only now is it safe to lift a
        // cold-start mute (see coldMuteHeld).
        releaseColdStartMute(after: 0.15)

        if dur <= 0.02 {
            volume = toVal
            activeNode.volume = toVal * currentGainCorrection
            resolve(nil)
            return
        }

        rampGeneration &+= 1
        let myGeneration = rampGeneration
        pendingRampResolve = resolve
        rampInFlightTarget = toVal
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
                    self.rampInFlightTarget = nil
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
        let who = progressTrackIdentity()
        resolve(["position": position, "duration": duration, "buffered": duration, "id": who.id, "qid": who.qid])
    }

    // Which song a position/duration reading describes: the outgoing song
    // until the crossfade's halfway point, then the incoming one. JS drops a
    // reading that does not belong to the song it is showing (a late reading
    // from before a skip used to make the progress bar jump).
    private func progressTrackIdentity() -> (id: String, qid: String) {
        let t: Track? = (isCrossfading && crossfadeAnnouncedIncoming) ? crossfadeIncomingTrack : activeNodeTrack
        return (t?.id ?? "", t?.qid ?? "")
    }

    @objc(getState:rejecter:)
    func getState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(state.rawValue)
    }

    @objc(setRepeatMode:resolver:rejecter:)
    func setRepeatMode(_ mode: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        repeatMode = RepeatModeValue(rawValue: mode.intValue) ?? .off
        // Re-arm (or disarm) the end-of-track crossfade for the new mode,
        // otherwise toggling loop mid-song wouldn't take effect until the
        // next track started.
        if state == .playing && !isCrossfading { scheduleCrossfadeLeadIn() }
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

    // Pre-amp: a single broadband gain stage, in dB, applied on top of the
    // 10 EQ bands rather than as one more band — AVAudioUnitEQ has exactly
    // this built in (`globalGain`), separate from its per-band filters, so
    // this doesn't need its own mixer node. Clamped to ±12dB: wide enough
    // to compensate for a quiet library or pull back a hot one, but a
    // preset already pushing several bands toward +6dB plus a +12dB
    // pre-amp on top risks clipping before it ever reaches
    // normalizerNode — ±12 keeps that combination survivable rather than
    // trying to guard against every possible band+preamp combination.
    @objc(setPreAmp:resolver:rejecter:)
    func setPreAmp(_ db: NSNumber, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        eqNode.globalGain = min(12, max(-12, db.floatValue))
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
    private var normToggleToken: UInt64 = 0
    private var normToggleBaseVol: Float? = nil

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
        // A second toggle while the first is still ducking must not take the lowered level as
        // the original one; the newest toggle owns the steps and the first one's are dropped.
        normToggleToken &+= 1
        let token = normToggleToken
        let startVol = normToggleBaseVol ?? preMixNode.outputVolume
        normToggleBaseVol = startVol
        let steps = 8
        for i in 0...steps {
            let delay = duckMs * Double(i) / Double(steps) / 1000.0
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, token == self.normToggleToken else { return }
                self.preMixNode.outputVolume = startVol * Float(1 - Double(i) / Double(steps))
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + duckMs / 1000.0) { [weak self] in
            guard let self = self, token == self.normToggleToken else { return }
            self.normalizerNode.bypass = bypassed
        }
        for i in 0...steps {
            let delay = (duckMs + settleMs) / 1000.0 + (duckMs * Double(i) / Double(steps) / 1000.0)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, token == self.normToggleToken else { return }
                self.preMixNode.outputVolume = startVol * Float(Double(i) / Double(steps))
                if i == steps { self.normToggleBaseVol = nil }
            }
        }
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


// Shared state between the main thread and the scratch render callback.
// Plain stored values: the audio thread only reads them (and writes pos /
// cur / gain), the main thread sets them before flipping `active`.
final class ScratchCore {
    var active = false
    var left: UnsafeMutablePointer<Float>?
    var right: UnsafeMutablePointer<Float>?
    var frames = 0
    var pos: Double = 0
    var step: Double = 1
    var cur: Float = 0
    var target: Float = 0
    var gain: Float = 0
    var gainTarget: Float = 0
    var level: Float = 1
    // Absolute song time (seconds) of the first frame in `left`/`right`.
    var windowStart: Double = 0
    // The disc cannot go below limitLo or past limitHi (song time, seconds):
    // the audio slows to a stop just before, instead of running into the end
    // of what is loaded. (The app's own limits are stricter: these are a backstop.)
    var limitHi: Double = .greatestFiniteMagnitude
    var limitLo: Double = 0
    var fileRate: Double = 44100
    // A replacement window prepared off the audio thread. The audio thread
    // swaps it in at the start of its next render, shifting `pos` by
    // `pendShift` frames so the sound carries on without a gap.
    var pendL: UnsafeMutablePointer<Float>?
    var pendR: UnsafeMutablePointer<Float>?
    var pendFrames = 0
    var pendShift: Double = 0
    var pendStart: Double = 0
    var retiredL: UnsafeMutablePointer<Float>?
    var retiredR: UnsafeMutablePointer<Float>?

    func release() {
        active = false
        let l = left, r = right
        let pl = pendL, pr = pendR, rl = retiredL, rr = retiredR
        left = nil
        right = nil
        pendL = nil; pendR = nil; pendFrames = 0
        retiredL = nil; retiredR = nil
        frames = 0
        // Freed a moment later so a render pass already in flight finishes.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            l?.deallocate()
            r?.deallocate()
            pl?.deallocate(); pr?.deallocate()
            rl?.deallocate(); rr?.deallocate()
        }
    }
}
