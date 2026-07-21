import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: slack-image-ocr <image-path>\n".utf8))
  exit(2)
}

let imagePath = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: imagePath) else {
  FileHandle.standardError.write(Data("이미지를 열 수 없습니다\n".utf8))
  exit(3)
}

var proposedRect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
  FileHandle.standardError.write(Data("CGImage 변환에 실패했습니다\n".utf8))
  exit(4)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ko-KR", "en-US"]
request.usesLanguageCorrection = true

do {
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
  let observations = (request.results ?? []).sorted { left, right in
    let verticalDifference = abs(left.boundingBox.maxY - right.boundingBox.maxY)
    if verticalDifference > 0.02 { return left.boundingBox.maxY > right.boundingBox.maxY }
    return left.boundingBox.minX < right.boundingBox.minX
  }
  let lines = observations.compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
  print(lines.joined(separator: "\n"))
} catch {
  FileHandle.standardError.write(Data("OCR 실패: \(error.localizedDescription)\n".utf8))
  exit(5)
}
