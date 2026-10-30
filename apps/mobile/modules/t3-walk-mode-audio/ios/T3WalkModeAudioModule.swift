import AVFoundation
import AudioToolbox
import CallKit
import ExpoModulesCore
import MediaPlayer

// Walk mode's audio port: speech, headphone buttons, recording, and the keep-alive with the
// screen locked. The behavior lives in the Walk mode session in the client runtime.
public class T3WalkModeAudioModule: Module {
  private let synthesizer = AVSpeechSynthesizer()
  // Spoken errors; separate so the reply queue keeps its place and pause state.
  private let noticeSynthesizer = AVSpeechSynthesizer()
  private var configured = false
  private var speechDelegate: SpeechDelegate?
  private var remoteCommandsInstalled = false
  private var pendingUtterances = 0
  private var nowPlayingTitle = "T3 Code"
  private var nowPlayingRate: Double = 0
  private let keepAliveEngine = AVAudioEngine()
  private let keepAlivePlayer = AVAudioPlayerNode()
  private var keepAliveRunning = false
  private var recorder: AVAudioRecorder?
  private var callProvider: CXProvider?
  private var callDelegate: CallDelegate?
  private let callController = CXCallController()
  private var activeCallId: UUID?
  private var pendingCallRecordingPromise: Promise?
  private var pendingCallRecordingURL: URL?

  public func definition() -> ModuleDefinition {
    Name("T3WalkModeAudio")

    Events("gesture", "speech", "session")

    OnCreate {
      let delegate = SpeechDelegate(onChunkFinished: { [weak self] in
        guard let self else { return }
        self.sendEvent("speech", ["type": "chunkFinished"])
        self.pendingUtterances = max(0, self.pendingUtterances - 1)
        if self.pendingUtterances == 0 { self.updateNowPlaying(rate: 0) }
      })
      self.speechDelegate = delegate
      self.synthesizer.delegate = delegate
      let center = NotificationCenter.default
      // A category or route change stops AVAudioEngine; the keep-alive must come back by itself.
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: self.keepAliveEngine, queue: .main) { [weak self] _ in
        try? self?.restartKeepAliveIfNeeded()
      }
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
        self?.handleRouteChange(notification)
      }
    }

    AsyncFunction("configureSession") { () throws in
      let session = AVAudioSession.sharedInstance()
      // .playback keeps audio alive with the screen locked (with UIBackgroundModes audio).
      // .spokenAudio tells the system this is speech, so other audio ducks around it.
      try session.setCategory(.playback, mode: .spokenAudio, options: [])
      try session.setActive(true)
      self.configured = true
      self.installRemoteCommands()
      self.updateNowPlaying(rate: 0)
      self.emitRoute()
    }.runOnQueue(.main)

    AsyncFunction("speak") { (chunks: [String]) in
      self.synthesizer.stopSpeaking(at: .immediate)
      self.pendingUtterances = 0
      self.queueUtterances(chunks)
      self.updateNowPlaying(rate: 1)
    }

    // Appends after what is loaded; a paused synthesizer stays paused.
    AsyncFunction("enqueue") { (chunks: [String]) in
      self.queueUtterances(chunks)
    }

    AsyncFunction("setNowPlayingTitle") { (title: String) in
      self.nowPlayingTitle = title
      self.updateNowPlaying(rate: self.nowPlayingRate)
    }

    AsyncFunction("pause") {
      self.synthesizer.pauseSpeaking(at: .word)
      self.updateNowPlaying(rate: 0)
    }

    AsyncFunction("resume") {
      self.synthesizer.continueSpeaking()
      self.updateNowPlaying(rate: 1)
    }

    AsyncFunction("announce") { (text: String) in
      self.noticeSynthesizer.speak(AVSpeechUtterance(string: text))
    }

    // Walk mode off: everything ends at once and other apps get the audio and buttons back.
    AsyncFunction("shutdown") {
      self.configured = false
      self.pendingUtterances = 0
      self.synthesizer.stopSpeaking(at: .immediate)
      self.noticeSynthesizer.stopSpeaking(at: .immediate)
      self.recorder?.stop()
      self.recorder = nil
      if let pending = self.pendingCallRecordingPromise {
        self.pendingCallRecordingPromise = nil
        pending.reject("E_STOPPED", "Walk mode stopped")
      }
      self.endCallIfActive()
      self.stopKeepAlive()
      self.removeRemoteCommands()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      self.releaseSession()
    }.runOnQueue(.main)

    // A microphone on the Lightning dongle; iOS prefers it over the built-in one.
    // The .playback category reports no inputs, so ports are read in a recording category.
    AsyncFunction("hasWiredInput") { () -> Bool in
      let session = AVAudioSession.sharedInstance()
      let wired: Set<AVAudioSession.Port> = [.headsetMic, .usbAudio, .lineIn]
      try? session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetoothA2DP])
      let ports = (session.availableInputs ?? []) + session.currentRoute.inputs
      self.restoreMusicMode()
      return ports.contains { wired.contains($0.portType) }
    }

    // Without call mode, recording never uses the Bluetooth (HFP) option: HFP stops the
    // headset sending its button presses as media commands. A2DP keeps the headset in
    // music mode while a wired microphone records.
    AsyncFunction("startRecording") { (useCallMode: Bool, promise: Promise) in
      let requestPermission: (@escaping (Bool) -> Void) -> Void = { completion in
        if #available(iOS 17.0, *) {
          AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
          AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
      }
      requestPermission { granted in
        guard granted else {
          promise.reject("E_MIC_DENIED", "Microphone permission denied")
          return
        }
        if useCallMode {
          self.startCallModeRecording(promise: promise)
          return
        }
        do {
          let session = AVAudioSession.sharedInstance()
          try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetoothA2DP])
          try session.setActive(true)
          let url = try self.beginRecorder()
          try self.restartKeepAliveIfNeeded()
          promise.resolve(url.absoluteString)
        } catch {
          self.restoreMusicMode()
          promise.reject("E_RECORD", error.localizedDescription)
        }
      }
    }

    AsyncFunction("stopRecording") { () throws -> [String: Any] in
      guard let recorder = self.recorder else { return ["uri": NSNull(), "seconds": 0] }
      let seconds = recorder.currentTime
      recorder.stop()
      self.recorder = nil
      let endingCall = self.activeCallId != nil
      self.endCallIfActive()
      // A recorder that started after a shutdown: release the session again.
      guard self.configured else {
        self.releaseSession()
        return ["uri": recorder.url.absoluteString, "seconds": seconds]
      }
      // CallKit deactivates the call's audio after this returns; reclaiming it now would be undone
      // and hand the headphone buttons to another app. callAudioDeactivated restores music mode.
      if !endingCall { self.restoreMusicMode() }
      return ["uri": recorder.url.absoluteString, "seconds": seconds]
    }.runOnQueue(.main)

    // A looping silent buffer. iOS routes headphone buttons to the app that is "now playing";
    // when speech is paused the app may lose that role. This keeps it.
    AsyncFunction("setKeepAlive") { (enabled: Bool) throws in
      if enabled { try self.startKeepAlive() } else { self.stopKeepAlive() }
    }.runOnQueue(.main)

    AsyncFunction("playSound") { (kind: String) in
      switch kind {
      case "error": AudioServicesPlaySystemSound(1073)
      case "sent": AudioServicesPlaySystemSound(1001)
      case "saved": AudioServicesPlaySystemSound(1114)
      default: AudioServicesPlaySystemSound(1057)
      }
    }
  }

  private func installRemoteCommands() {
    guard !remoteCommandsInstalled else { return }
    remoteCommandsInstalled = true
    UIApplication.shared.beginReceivingRemoteControlEvents()
    let center = MPRemoteCommandCenter.shared()
    let single: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
      self?.sendEvent("gesture", ["presses": 1])
      return .success
    }
    center.togglePlayPauseCommand.isEnabled = true
    center.togglePlayPauseCommand.addTarget(handler: single)
    center.playCommand.isEnabled = true
    center.playCommand.addTarget(handler: single)
    center.pauseCommand.isEnabled = true
    center.pauseCommand.addTarget(handler: single)
    center.nextTrackCommand.isEnabled = true
    center.nextTrackCommand.addTarget { [weak self] _ in
      self?.sendEvent("gesture", ["presses": 2])
      return .success
    }
    center.previousTrackCommand.isEnabled = true
    center.previousTrackCommand.addTarget { [weak self] _ in
      self?.sendEvent("gesture", ["presses": 3])
      return .success
    }
    for command in [center.seekForwardCommand, center.seekBackwardCommand, center.skipForwardCommand, center.skipBackwardCommand] {
      command.isEnabled = false
    }
  }

  private func removeRemoteCommands() {
    guard remoteCommandsInstalled else { return }
    remoteCommandsInstalled = false
    let center = MPRemoteCommandCenter.shared()
    for command in [center.togglePlayPauseCommand, center.playCommand, center.pauseCommand, center.nextTrackCommand, center.previousTrackCommand] {
      command.removeTarget(nil)
      command.isEnabled = false
    }
    UIApplication.shared.endReceivingRemoteControlEvents()
  }

  private func queueUtterances(_ chunks: [String]) {
    pendingUtterances += chunks.count
    for chunk in chunks {
      let utterance = AVSpeechUtterance(string: chunk)
      utterance.postUtteranceDelay = 0.25
      synthesizer.speak(utterance)
    }
  }

  private func updateNowPlaying(rate: Double) {
    nowPlayingRate = rate
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: nowPlayingTitle,
      MPMediaItemPropertyArtist: "T3 Code walk mode",
      MPNowPlayingInfoPropertyPlaybackRate: rate,
      MPMediaItemPropertyPlaybackDuration: 0,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
    ]
  }

  private func beginRecorder() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("walk-mode-\(Int(Date().timeIntervalSince1970)).m4a")
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 16_000,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
    ]
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    recorder.prepareToRecord()
    guard recorder.record() else {
      throw NSError(domain: "T3WalkModeAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Recorder did not start"])
    }
    self.recorder = recorder
    return url
  }

  // Call mode: a fake outgoing call owned by this app. iOS then routes the headset
  // microphone to us and delivers stem presses as call actions (mute, end).
  private func ensureCallProvider() -> CXProvider {
    if let provider = callProvider { return provider }
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.includesCallsInRecents = false
    configuration.supportedHandleTypes = [.generic]
    let provider = CXProvider(configuration: configuration)
    let delegate = CallDelegate(
      onAudioActivated: { [weak self] in self?.callAudioActivated() },
      onAudioDeactivated: { [weak self] in self?.callAudioDeactivated() },
      onCallAction: { [weak self] action in
        // The system ending the call (a stem press) means no call is left for us to end.
        if action == "end" { self?.activeCallId = nil }
        self?.sendEvent("gesture", ["presses": 1, "source": "call", "action": action])
      })
    provider.setDelegate(delegate, queue: nil)
    callProvider = provider
    callDelegate = delegate
    return provider
  }

  private func startCallModeRecording(promise: Promise) {
    let provider = ensureCallProvider()
    _ = provider
    let callId = UUID()
    let handle = CXHandle(type: .generic, value: "T3 Code walk mode")
    let startAction = CXStartCallAction(call: callId, handle: handle)
    startAction.isVideo = false
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
    } catch {
      promise.reject("E_CALL_SESSION", error.localizedDescription)
      return
    }
    pendingCallRecordingPromise = promise
    activeCallId = callId
    // A call whose audio never activates would leave the recording waiting forever.
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
      guard let self, self.activeCallId == callId, let pending = self.pendingCallRecordingPromise else { return }
      self.pendingCallRecordingPromise = nil
      self.endCallIfActive()
      self.restoreMusicMode()
      pending.reject("E_CALL_TIMEOUT", "Call audio did not activate")
    }
    callController.request(CXTransaction(action: startAction)) { [weak self] error in
      guard let self else { return }
      if let error {
        // A shutdown or the activation timeout has already settled the promise.
        guard self.activeCallId == callId, self.pendingCallRecordingPromise != nil else { return }
        self.activeCallId = nil
        self.pendingCallRecordingPromise = nil
        self.restoreMusicMode()
        promise.reject("E_CALL_START", error.localizedDescription)
        return
      }
      self.callProvider?.reportOutgoingCall(with: callId, connectedAt: Date())
    }
  }

  private func callAudioActivated() {
    guard let promise = pendingCallRecordingPromise else { return }
    pendingCallRecordingPromise = nil
    do {
      let url = try beginRecorder()
      promise.resolve(url.absoluteString)
    } catch {
      endCallIfActive()
      restoreMusicMode()
      promise.reject("E_RECORD", error.localizedDescription)
    }
  }

  private func callAudioDeactivated() {
    guard configured, activeCallId == nil, recorder == nil else { return }
    restoreMusicMode()
    updateNowPlaying(rate: nowPlayingRate)
  }

  private func releaseSession() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .spokenAudio, options: [])
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func restoreMusicMode() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .spokenAudio, options: [])
    try? session.setActive(true)
    try? restartKeepAliveIfNeeded()
  }

  private func endCallIfActive() {
    guard let callId = activeCallId else { return }
    activeCallId = nil
    callController.request(CXTransaction(action: CXEndCallAction(call: callId))) { _ in }
  }

  private func restartKeepAliveIfNeeded() throws {
    guard keepAliveRunning else { return }
    keepAlivePlayer.stop()
    keepAliveEngine.stop()
    keepAliveRunning = false
    try startKeepAlive()
  }

  private static let headphonePorts: Set<AVAudioSession.Port> = [
    .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio,
  ]

  private func hasHeadphones() -> Bool {
    AVAudioSession.sharedInstance().currentRoute.outputs.contains { Self.headphonePorts.contains($0.portType) }
  }

  private func emitRoute() {
    sendEvent("session", ["type": "route", "headphones": hasHeadphones()])
  }

  // Only device changes count: category changes for recording also change the route.
  private func handleRouteChange(_ notification: Notification) {
    guard configured,
      let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
      reason == .oldDeviceUnavailable || reason == .newDeviceAvailable
    else { return }
    if !hasHeadphones() {
      // Pause here, before the session hears of it, so no word reaches the speaker.
      synthesizer.pauseSpeaking(at: .immediate)
      noticeSynthesizer.stopSpeaking(at: .immediate)
      updateNowPlaying(rate: 0)
    }
    emitRoute()
  }

  private func startKeepAlive() throws {
    guard !keepAliveRunning else { return }
    let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100)!
    buffer.frameLength = 44_100
    if !keepAliveEngine.attachedNodes.contains(keepAlivePlayer) {
      keepAliveEngine.attach(keepAlivePlayer)
      keepAliveEngine.connect(keepAlivePlayer, to: keepAliveEngine.mainMixerNode, format: format)
    }
    keepAliveEngine.mainMixerNode.outputVolume = 0
    try keepAliveEngine.start()
    keepAlivePlayer.scheduleBuffer(buffer, at: nil, options: [.loops])
    keepAlivePlayer.play()
    keepAliveRunning = true
  }

  private func stopKeepAlive() {
    guard keepAliveRunning else { return }
    keepAlivePlayer.stop()
    keepAliveEngine.stop()
    keepAliveRunning = false
  }
}

private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  private let onChunkFinished: () -> Void

  init(onChunkFinished: @escaping () -> Void) {
    self.onChunkFinished = onChunkFinished
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    onChunkFinished()
  }
}

private final class CallDelegate: NSObject, CXProviderDelegate {
  private let onAudioActivated: () -> Void
  private let onAudioDeactivated: () -> Void
  private let onCallAction: (String) -> Void

  init(
    onAudioActivated: @escaping () -> Void,
    onAudioDeactivated: @escaping () -> Void,
    onCallAction: @escaping (String) -> Void
  ) {
    self.onAudioActivated = onAudioActivated
    self.onAudioDeactivated = onAudioDeactivated
    self.onCallAction = onCallAction
  }

  func providerDidReset(_ provider: CXProvider) {}

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    onCallAction("end")
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    onCallAction(action.isMuted ? "mute" : "unmute")
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    onCallAction(action.isOnHold ? "hold" : "unhold")
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    onAudioActivated()
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    onAudioDeactivated()
  }
}
