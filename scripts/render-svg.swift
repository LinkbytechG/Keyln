// Rasterise SVG files to square PNGs with the system's SVG renderer (CoreSVG through NSImage).
// Usage: render-svg <input.svg> <output.png> <size> [<input.svg> <output.png> <size> ...]
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
guard !args.isEmpty, args.count % 3 == 0 else {
    FileHandle.standardError.write("Usage: render-svg <input.svg> <output.png> <size> ...\n".data(using: .utf8)!)
    exit(2)
}
for job in stride(from: 0, to: args.count, by: 3) {
    let input = args[job], output = args[job + 1]
    guard let size = Int(args[job + 2]), size > 0, size <= 4096,
          let image = NSImage(contentsOf: URL(fileURLWithPath: input)),
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                        bytesPerRow: 0, bitsPerPixel: 0) else {
        FileHandle.standardError.write("Cannot render \(input)\n".data(using: .utf8)!)
        exit(1)
    }
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
    try png.write(to: URL(fileURLWithPath: output))
}
