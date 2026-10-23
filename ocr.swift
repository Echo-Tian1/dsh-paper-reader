import Foundation
import Vision
import AppKit
let path = CommandLine.arguments[1]
let words = CommandLine.arguments.count > 2 ? CommandLine.arguments[2].split(separator: ",").map(String.init) : []
guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
if !words.isEmpty { request.customWords = words }
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch { exit(3) }
for obs in request.results ?? [] { if let t = obs.topCandidates(1).first { print(t.string) } }
