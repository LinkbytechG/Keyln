import CoreImage
import CoreGraphics
import Foundation

// T121: pure QR rendering, no AppKit. Black modules on white, with a white quiet zone of 4 modules on every side.
enum QRCode {
    static let quietModules = 4

    static func cgImage(for text: String, modulePixels: Int) -> CGImage? {
        guard modulePixels >= 1, let data = text.data(using: .utf8), !data.isEmpty,
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let extent = output.extent.integral
        let modules = Int(extent.width)
        guard modules > 0, Int(extent.height) == modules else { return nil }

        // One pixel per module first, then scale by an integer factor with no smoothing.
        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let small = context.createCGImage(output, from: extent) else { return nil }

        let side = (modules + 2 * quietModules) * modulePixels
        let space = CGColorSpaceCreateDeviceRGB()
        guard let canvas = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        canvas.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        canvas.fill(CGRect(x: 0, y: 0, width: side, height: side))
        canvas.interpolationQuality = .none
        canvas.draw(small, in: CGRect(x: quietModules * modulePixels, y: quietModules * modulePixels,
                                      width: modules * modulePixels, height: modules * modulePixels))
        return canvas.makeImage()
    }
}
