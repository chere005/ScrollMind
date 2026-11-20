// scroll-pen: reads the side buttons of a Wacom One 12 pen display for ScrollMind.
//
// The Wacom driver decides what a side button means before any app sees it: it can turn a button into a click, into
// Pan/Scroll or into a keystroke, and then the app cannot tell which switch moved. The display itself reports its
// switches on a vendor HID interface (usage page 0xFFD1, usage 0x300). This opens that interface WITHOUT seizing it, so
// the driver keeps the pen and the pointer behaves as usual. It reports the physical switches whatever Wacom Center
// assigns to them. macOS opens the interface without complaint but delivers no reports until the app that started this
// helper has INPUT MONITORING (Privacy & Security); the helper says which it is ("access") and notices the grant.
//
// One JSON object per line on stdout:
//   {"k":"access","v":"granted"|"denied"|"undetermined"}                  Input Monitoring for the app that started this
//   {"k":"opened","pid":974}                                             the display's vendor interface is open
//   {"k":"buttons","tip":false,"lower":true,"upper":false,"range":true}  every change of tip, switches or proximity
//   {"k":"closed","why":"…"}                                             the display went away (it is looked for again)
//   {"k":"raw","hex":"…"}                                                the first few reports that are not button reports
//   {"k":"log","m":"…"}
// Everything ends when stdin closes or on SIGTERM; a display that is gone releases its buttons first.
//
// Without a device, for tests and diagnostics:
//   scroll-pen --decode "<report bytes, hex>"   the buttons line for one report, or {"k":"not-a-button-report"}
//   scroll-pen --list                           each Wacom HID interface found
//   scroll-pen --access                         {"k":"access",…}, nothing else
//   scroll-pen --request-access                 asks macOS once for Input Monitoring, then says {"k":"access",…}
//
// THE REPORT (decoded on the Wacom One 12, 056a:03ce): byte 0 the report id 0x1E, byte 1 0x01 (0x00 is an empty report),
// byte 2 the STATUS: 0x80 in range, 0x40 valid, 0x01 tip down, 0x02 lower side button, 0x04 upper side button. Seen:
// c0 hover, c1 tip, c2 hover + lower, c4 hover + upper, c3 tip + lower, c5 tip + upper. 0x80 alone is a stale sample that
// the display sometimes emits as the pen leaves. A switch or the tip only counts while the pen is in range.

import Foundation
import IOKit
import IOKit.hid

setvbuf(stdout, nil, _IOLBF, 0)

let wacomVendor = 0x056A
let supportedProducts: Set<Int> = [0x03CE]

struct Side: Equatable {
    var tip = false, lower = false, upper = false, range = false
}

func sideState(_ bytes: [UInt8]) -> Side? {
    guard bytes.count >= 3, bytes[0] == 0x1E, bytes[1] <= 1 else { return nil }
    if bytes[1] == 0 { return Side() }
    let status = bytes[2]
    let range = status & 0xC0 == 0xC0
    return Side(tip: range && status & 0x01 != 0, lower: range && status & 0x02 != 0, upper: range && status & 0x04 != 0, range: range)
}

func buttonsLine(_ side: Side) -> String {
    "{\"k\":\"buttons\",\"tip\":\(side.tip),\"lower\":\(side.lower),\"upper\":\(side.upper),\"range\":\(side.range)}"
}

func say(_ line: String) { print(line) }

func quoted(_ text: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [text], options: [])) ?? Data("[\"\"]".utf8)
    let array = String(decoding: data, as: UTF8.self)
    return String(array.dropFirst().dropLast())
}

func number(_ device: IOHIDDevice, _ key: String) -> Int {
    (IOHIDDeviceGetProperty(device, key as CFString) as? NSNumber)?.intValue ?? 0
}

func text(_ device: IOHIDDevice, _ key: String) -> String {
    (IOHIDDeviceGetProperty(device, key as CFString) as? String) ?? ""
}

func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined(separator: " ") }

func wacomInterfaces() -> [IOHIDDevice] {
    let matching = IOServiceMatching(kIOHIDDeviceKey) as NSMutableDictionary
    matching[kIOHIDVendorIDKey] = wacomVendor
    var iterator: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS else { return [] }
    defer { IOObjectRelease(iterator) }
    var found: [IOHIDDevice] = []
    while case let service = IOIteratorNext(iterator), service != 0 {
        defer { IOObjectRelease(service) }
        if let device = IOHIDDeviceCreate(kCFAllocatorDefault, service) { found.append(device) }
    }
    return found
}

/// The vendor interface that carries a supported pen display's pen reports.
func buttonInterface() -> IOHIDDevice? {
    wacomInterfaces().first {
        supportedProducts.contains(number($0, kIOHIDProductIDKey))
            && number($0, kIOHIDPrimaryUsagePageKey) == 0xFFD1 && number($0, kIOHIDPrimaryUsageKey) == 0x300
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())

func access() -> String {
    switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
    case kIOHIDAccessTypeGranted: return "granted"
    case kIOHIDAccessTypeDenied: return "denied"
    default: return "undetermined"
    }
}
func accessLine() -> String { "{\"k\":\"access\",\"v\":\"\(access())\"}" }

if arguments.first == "--access" { say(accessLine()); exit(0) }
if arguments.first == "--request-access" {
    if access() != "granted" { _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) }
    say(accessLine())
    exit(0)
}

if arguments.first == "--decode" {
    guard arguments.count == 2 else { FileHandle.standardError.write(Data("usage: scroll-pen --decode \"<hex bytes>\"\n".utf8)); exit(64) }
    let bytes = arguments[1].split(separator: " ").compactMap { UInt8($0, radix: 16) }
    if let side = sideState(bytes) { say(buttonsLine(side)) } else { say("{\"k\":\"not-a-button-report\"}") }
    exit(0)
}

if arguments.first == "--list" {
    for device in wacomInterfaces() {
        say("{\"k\":\"interface\",\"name\":\(quoted(text(device, kIOHIDProductKey))),\"pid\":\(number(device, kIOHIDProductIDKey)),\"page\":\(number(device, kIOHIDPrimaryUsagePageKey)),\"usage\":\(number(device, kIOHIDPrimaryUsageKey)),\"supported\":\(supportedProducts.contains(number(device, kIOHIDProductIDKey)))}")
    }
    exit(0)
}

guard arguments.isEmpty else { FileHandle.standardError.write(Data("usage: scroll-pen [--decode \"<hex bytes>\" | --list | --access | --request-access]\n".utf8)); exit(64) }

var side = Side()
var openDevice: IOHIDDevice?
var refusedStatus: IOReturn = 0
var unknownReports = 0
let reportBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 256)

func closeInterface(_ why: String) {
    guard let device = openDevice else { return }
    openDevice = nil
    IOHIDDeviceUnscheduleFromRunLoop(device, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
    // A display that is gone holds no buttons.
    if side != Side() { side = Side(); say(buttonsLine(side)) }
    say("{\"k\":\"closed\",\"why\":\(quoted(why))}")
}

func openInterface() {
    guard openDevice == nil, let device = buttonInterface() else { return }
    // No seize: the driver and the system keep the pen.
    let status = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
    if status != kIOReturnSuccess {
        if status != refusedStatus {
            refusedStatus = status
            say("{\"k\":\"log\",\"m\":\"the pen display's vendor interface did not open: \(String(format: "0x%08x", UInt32(bitPattern: status)))\"}")
        }
        return
    }
    refusedStatus = 0
    openDevice = device
    IOHIDDeviceRegisterInputReportCallback(device, reportBuffer, 256, { _, _, _, _, _, report, length in
        let bytes = Array(UnsafeBufferPointer(start: report, count: length))
        guard let now = sideState(bytes) else {
            if unknownReports < 8 { unknownReports += 1; say("{\"k\":\"raw\",\"hex\":\"\(hex(Array(bytes.prefix(32))))\"}") }
            return
        }
        if now != side { side = now; say(buttonsLine(now)) }
    }, nil)
    IOHIDDeviceRegisterRemovalCallback(device, { _, _, _ in closeInterface("the display was unplugged") }, nil)
    IOHIDDeviceScheduleWithRunLoop(device, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    say("{\"k\":\"opened\",\"pid\":\(number(device, kIOHIDProductIDKey))}")
}

func leave() -> Never { closeInterface("quit"); exit(0) }
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { leave() }; terminate.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { leave() }; interrupt.resume()
let stdinClosed = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
stdinClosed.setEventHandler {
    var buffer = [UInt8](repeating: 0, count: 256)
    if read(STDIN_FILENO, &buffer, buffer.count) <= 0 { leave() }
}
stdinClosed.resume()

var lastAccess = access()
say(accessLine())
openInterface()
// A display plugged in later, or one whose interface was not ready yet, is found within a couple of seconds. A permission
// granted while this runs only takes hold on a fresh open of the interface, so the interface is reopened when it arrives.
let watch = Timer(timeInterval: 2, repeats: true) { _ in
    let now = access()
    if now != lastAccess {
        lastAccess = now
        say(accessLine())
        if now == "granted" { closeInterface("Input Monitoring was granted") }
    }
    openInterface()
}
RunLoop.main.add(watch, forMode: .common)
CFRunLoopRun()
exit(0)
