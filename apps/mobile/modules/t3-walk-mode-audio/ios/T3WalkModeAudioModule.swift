import AVFoundation
import AudioToolbox
import ExpoModulesCore
import MediaPlayer

// Walk mode spike. Answers one question: can the app own the headphone buttons and
// keep speaking with the screen locked? Everything else lives in JS.
public class T3WalkModeAudioModule: Module {
  private let synthesizer = AVSpeechSynthesizer()
  private var speechDelegate: SpeechDelegate?
  private var remoteCommandsInstalled = false
  private var pendingUtterances = 0
  private let keepAliveEngine = AVAudioEngine()
  private let keepAlivePlayer = AVAudioPlayerNode()
  private var keepAliveRunning = false
  private var recorder: AVAudioRecorder?

  public func definition() -> ModuleDefinition {
    Name("T3WalkModeAudio")

    Events("gesture", "speech", "session")

    OnCreate {
      let delegate = SpeechDelegate(
        onChunkStarted: { [weak self] in self?.sendEvent("speech", ["type": "chunkStarted"]) },
        onChunkFinished: { [weak self] in
          guard let self else { return }
          self.pendingUtterances = max(0, self.pendingUtterances - 1)
          if self.pendingUtterances == 0 {
            self.sendEvent("speech", ["type": "finished"])
            self.updateNowPlaying(rate: 0)
          }
        })
      self.speechDelegate = delegate
      self.synthesizer.delegate = delegate
      let center = NotificationCenter.default
      // A category or route change stops AVAudioEngine; the keep-alive must come back by itself.
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: self.keepAliveEngine, queue: .main) { [weak self] _ in
        guard let self else { return }
        try? self.restartKeepAliveIfNeeded()
        self.sendEvent("session", ["type": "engineRestarted"])
      }
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
        self?.emitRoute()
      }
    }

    AsyncFunction("configureSession") { () throws in
      let session = AVAudioSession.sharedInstance()
      // .playback keeps audio alive with the screen locked (with UIBackgroundModes audio).
      // .spokenAudio tells the system this is speech, so other audio ducks around it.
      try session.setCategory(.playback, mode: .spokenAudio, options: [])
      try session.setActive(true)
      self.installRemoteCommands()
      self.updateNowPlaying(rate: 0)
      self.sendEvent("session", ["type": "configured"])
    }

    AsyncFunction("speak") { (chunks: [String]) in
      self.synthesizer.stopSpeaking(at: .immediate)
      self.pendingUtterances = chunks.count
      for chunk in chunks {
        let utterance = AVSpeechUtterance(string: chunk)
        utterance.postUtteranceDelay = 0.25
        self.synthesizer.speak(utterance)
      }
      self.updateNowPlaying(rate: 1)
    }

    AsyncFunction("pause") {
      self.synthesizer.pauseSpeaking(at: .word)
      self.updateNowPlaying(rate: 0)
    }

    AsyncFunction("resume") {
      self.synthesizer.continueSpeaking()
      self.updateNowPlaying(rate: 1)
    }

    AsyncFunction("stop") {
      self.pendingUtterances = 0
      self.synthesizer.stopSpeaking(at: .immediate)
      self.updateNowPlaying(rate: 0)
    }

    // Recording uses the phone microphone, never the headset one: a Bluetooth headset in
    // call (HFP) mode stops sending its button presses as media commands. A2DP keeps the
    // headset in music mode, so playback quality and the buttons survive the switch.
    AsyncFunction("startRecording") { (promise: Promise) in
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
        do {
          let session = AVAudioSession.sharedInstance()
          try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetoothA2DP])
          try session.setActive(true)
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
            promise.reject("E_RECORD_START", "Recorder did not start")
            return
          }
          self.recorder = recorder
          try self.restartKeepAliveIfNeeded()
          promise.resolve(url.absoluteString)
        } catch {
          promise.reject("E_RECORD", error.localizedDescription)
        }
      }
    }

    AsyncFunction("stopRecording") { () throws -> [String: Any] in
      guard let recorder = self.recorder else { return ["uri": NSNull(), "seconds": 0] }
      let seconds = recorder.currentTime
      recorder.stop()
      self.recorder = nil
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio, options: [])
      try session.setActive(true)
      try self.restartKeepAliveIfNeeded()
      return ["uri": recorder.url.absoluteString, "seconds": seconds]
    }

    // A looping silent buffer. iOS routes headphone buttons to the app that is "now playing";
    // when speech is paused the app may lose that role. This keeps it. Off by default so the
    // spike can compare both behaviours.
    AsyncFunction("setKeepAlive") { (enabled: Bool) throws in
      if enabled { try self.startKeepAlive() } else { self.stopKeepAlive() }
    }

    AsyncFunction("playSound") { (kind: String) in
      switch kind {
      case "error": AudioServicesPlaySystemSound(1073)
      case "sent": AudioServicesPlaySystemSound(1001)
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

  private func updateNowPlaying(rate: Double) {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: "T3 Code walk mode",
      MPMediaItemPropertyArtist: "Assistant reply",
      MPNowPlayingInfoPropertyPlaybackRate: rate,
      MPMediaItemPropertyPlaybackDuration: 0,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
    ]
  }

  private func restartKeepAliveIfNeeded() throws {
    guard keepAliveRunning else { return }
    keepAlivePlayer.stop()
    keepAliveEngine.stop()
    keepAliveRunning = false
    try startKeepAlive()
  }

  private func emitRoute() {
    let route = AVAudioSession.sharedInstance().currentRoute
    let outputs = route.outputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
    let inputs = route.inputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
    sendEvent("session", ["type": "route", "outputs": outputs, "inputs": inputs])
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
  private let onChunkStarted: () -> Void
  private let onChunkFinished: () -> Void

  init(onChunkStarted: @escaping () -> Void, onChunkFinished: @escaping () -> Void) {
    self.onChunkStarted = onChunkStarted
    self.onChunkFinished = onChunkFinished
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    onChunkStarted()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    onChunkFinished()
  }
}
