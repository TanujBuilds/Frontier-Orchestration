import AppKit
@main struct IconBuilder {
    static func main() throws {
        let folder=URL(fileURLWithPath:CommandLine.arguments[1]);try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        for size in [16,32,128,256,512] {
            for scale in [1,2] {
                let pixels=size*scale
                let image=NSImage(size:NSSize(width:1024,height:1024));image.lockFocus()
                NSColor(calibratedRed:0.068,green:0.081,blue:0.09,alpha:1).setFill()
                NSBezierPath(roundedRect:NSRect(x:32,y:32,width:960,height:960),xRadius:214,yRadius:214).fill()
                for (index,point) in [NSPoint(x:244,y:540),NSPoint(x:540,y:540),NSPoint(x:244,y:244),NSPoint(x:540,y:244)].enumerated() {
                    (index==0 || index==3 ? NSColor(calibratedRed:0.68,green:0.85,blue:0.89,alpha:1):NSColor(calibratedRed:0.57,green:0.62,blue:0.65,alpha:1)).setFill()
                    NSBezierPath(roundedRect:NSRect(x:point.x,y:point.y,width:240,height:240),xRadius:14,yRadius:14).fill()
                }
                image.unlockFocus()
                let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
                NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
                image.draw(in:NSRect(x:0,y:0,width:pixels,height:pixels));NSGraphicsContext.restoreGraphicsState()
                let name="icon_\(size)x\(size)\(scale==2 ? "@2x":"").png"
                try bitmap.representation(using:.png,properties:[:])!.write(to:folder.appendingPathComponent(name))
            }
        }
    }
}
