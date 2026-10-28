require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3WalkModeAudioNative'
  s.version = package['version']
  s.summary = 'Walk mode spike: spoken replies and headphone button gestures.'
  s.description = 'Speaks text with the system voice, keeps the audio session alive, and reports headphone remote commands as gestures.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks = 'AVFoundation', 'MediaPlayer', 'AudioToolbox'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
