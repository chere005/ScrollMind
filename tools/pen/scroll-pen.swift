// scroll-pen: reads the pen of a Wacom One 12 pen display for ScrollMind: its side buttons, its tip and where it is.
//
// The Wacom driver decides what a side button means before any app sees it: it can turn a button into a click, into
// Pan/Scroll or into a keystroke, and then the app cannot tell which switch moved or where the pen touched meanwhile. The
// display itself reports its pen on its digitizer HID interface (usage page 0x0D, usage 0x02), the one the driver reads.
// This opens that interface WITHOUT seizing it, so the driver keeps the pen and the pointer behaves as usual. (The
// display's other vendor interface, usage page 0xFFD1, has no input reports at all: nothing is ever read from it.)
// macOS may hold reports back until the app that started this helper has INPUT MONITORING (Privacy & Security); the
// helper says which it is ("access") and notices the grant.
//
// One JSON object per line on stdout:
//   {"k":"access","v":"granted"|"denied"|"undetermined"}                  Input Monitoring for the app that started this
//   {"k":"opened","pid":974}                                             the display's pen interface is open
//   {"k":"buttons","tip":false,"lower":true,"upper":false,"range":true,"x":0.5,"y":0.5,"p":0}
//                                                                        every change of tip, switches or proximity, with
//                                                                        the pen's place on the display (0...1 from its
//                                                                        top left) and pressure (0...1) when in range
//   {"k":"at","x":0.5,"y":0.5,"p":0.4}                                    the pen moved while a side switch is held
//   {"k":"closed","why":"…"}                                             the display went away (it is looked for again)
//   {"k":"raw","hex":"…"}                                                the first few reports that are not pen reports
//   {"k":"log","m":"…"}
// Everything ends when stdin closes or on SIGTERM; a display that is gone releases its buttons first.
//
// Without a device, for tests and diagnostics:
//   scroll-pen --decode "<report bytes, hex>"   the buttons line for one report, or {"k":"not-a-button-report"}
//   scroll-pen --replay "<hex>" "<hex>" …       the lines a run of reports produces, in order
//   scroll-pen --list                           each Wacom HID interface found
//   scroll-pen --access                         {"k":"access",…}, nothing else
//   scroll-pen --request-access                 asks macOS once for Input Monitoring, then says {"k":"access",…}
//
// THE REPORTS (Wacom One 12, 056a:03ce, from the display's own report descriptor).
// Standard pen report, the one that arrives with the Wacom driver running: byte 0 the report id 0x06, byte 1 the contact
// count, byte 2 the STATUS: 0x01 tip down, 0x02 barrel switch (the lower side button, nearer the tip), 0x04 secondary
// barrel switch (the upper one), 0x40 in range. X is bytes 3-4 (0...25632), Y bytes 6-7 (0...14418), pressure bytes 9-10
// (0...4095), all little-endian.
// Vendor pen report, sent instead when the display is in its vendor mode: report id 0x1E, byte 1 0x01 (0x00 is an empty
// report), STATUS 0x80 in range, 0x40 valid, and the same three low bits; X bytes 3-5, Y bytes 6-8, pressure bytes 9-10,
// same ranges. 0x80 alone is a stale sample the display sometimes emits as the pen leaves.
// A switch or the tip only counts while the pen is in range.

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
    if bytes.count >= 3, bytes[0] == 0x06 {
        let status = bytes[2]
        let range = status & 0x40 != 0
        return Side(tip: range && status & 0x01 != 0, lower: range && status & 0x02 != 0, upper: range && status & 0x04 != 0, range: range)
    }
    guard bytes.count >= 3, bytes[0] == 0x1E, bytes[1] <= 1 else { return nil }
    if bytes[1] == 0 { return Side() }
    let status = bytes[2]
    let range = status & 0xC0 == 0xC0
    return Side(tip: range && status & 0x01 != 0, lower: range && status & 0x02 != 0, upper: range && status & 0x04 != 0, range: range)
}

/// Where the pen is on the display, 0...1 from its top left, and how hard it presses, 0...1. Nil when the report has no place.
struct Place: Equatable { var x = 0.0, y = 0.0, p = 0.0 }

let maxX = 25632, maxY = 14418, maxPressure = 4095

func little(_ bytes: [UInt8], _ offset: Int, _ count: Int) -> Int {
    (0..<count).reduce(0) { $0 | (Int(bytes[offset + $1]) << (8 * $1)) }
}

func place(_ bytes: [UInt8]) -> Place? {
    guard bytes.count >= 11, bytes[0] == 0x06 || bytes[0] == 0x1E else { return nil }
    let wide = bytes[0] == 0x1E ? 3 : 2
    let x = little(bytes, 3, wide), y = little(bytes, 6, wide), p = little(bytes, 9, 2)
    guard x <= maxX, y <= maxY, p <= maxPressure else { return nil }
    return Place(x: Double(x) / Double(maxX), y: Double(y) / Double(maxY), p: Double(p) / Double(maxPressure))
}

func rounded(_ value: Double) -> String { String(format: "%.5f", value) }
func placeFields(_ at: Place?) -> String { at.map { ",\"x\":\(rounded($0.x)),\"y\":\(rounded($0.y)),\"p\":\(rounded($0.p))" } ?? "" }

func buttonsLine(_ side: Side, _ at: Place? = nil) -> String {
    "{\"k\":\"buttons\",\"tip\":\(side.tip),\"lower\":\(side.lower),\"upper\":\(side.upper),\"range\":\(side.range)\(side.range ? placeFields(at) : "")}"
}

/// The lines one report adds: the switches when they change, and the pen's place while a side switch is held.
struct Reports {
    private(set) var side = Side()
    private var last: Place?

    mutating func read(_ bytes: [UInt8], emit: (String) -> Void) -> Bool {
        guard let now = sideState(bytes) else { return false }
        let at = now.range ? place(bytes) : nil
        if now != side {
            side = now
            emit(buttonsLine(now, at))
        } else if (now.lower || now.upper), let at, at != last {
            emit("{\"k\":\"at\"\(placeFields(at))}")
        }
        last = at
        return true
    }

    mutating func release(emit: (String) -> Void) {
        if side != Side() { side = Side(); emit(buttonsLine(side)) }
        last = nil
    }
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

/// The digitizer interface that carries a supported pen display's pen reports: the one whose usages include a pen.
func buttonInterface() -> IOHIDDevice? {
    wacomInterfaces().first { device in
        guard supportedProducts.contains(number(device, kIOHIDProductIDKey)),
              let pairs = IOHIDDeviceGetProperty(device, kIOHIDDeviceUsagePairsKey as CFString) as? [[String: Any]] else { return false }
        return pairs.contains { ($0[kIOHIDDeviceUsagePageKey] as? Int) == 0x0D && ($0[kIOHIDDeviceUsageKey] as? Int) == 0x02 }
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
    if let side = sideState(bytes) { say(buttonsLine(side, place(bytes))) } else { say("{\"k\":\"not-a-button-report\"}") }
    exit(0)
}

if arguments.first == "--replay" {
    var reports = Reports()
    for report in arguments.dropFirst() {
        let bytes = report.split(separator: " ").compactMap { UInt8($0, radix: 16) }
        if !reports.read(bytes, emit: say) { say("{\"k\":\"not-a-button-report\"}") }
    }
    exit(0)
}

if arguments.first == "--list" {
    for device in wacomInterfaces() {
        say("{\"k\":\"interface\",\"name\":\(quoted(text(device, kIOHIDProductKey))),\"pid\":\(number(device, kIOHIDProductIDKey)),\"page\":\(number(device, kIOHIDPrimaryUsagePageKey)),\"usage\":\(number(device, kIOHIDPrimaryUsageKey)),\"supported\":\(supportedProducts.contains(number(device, kIOHIDProductIDKey)))}")
    }
    exit(0)
}

guard arguments.isEmpty else { FileHandle.standardError.write(Data("usage: scroll-pen [--decode \"<hex bytes>\" | --replay \"<hex bytes>\" … | --list | --access | --request-access]\n".utf8)); exit(64) }

var reports = Reports()
var openDevice: IOHIDDevice?
var refusedStatus: IOReturn = 0
var unknownReports = 0
let reportBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 512)

func closeInterface(_ why: String) {
    guard let device = openDevice else { return }
    openDevice = nil
    IOHIDDeviceUnscheduleFromRunLoop(device, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
    // A display that is gone holds no buttons.
    reports.release(emit: say)
    say("{\"k\":\"closed\",\"why\":\(quoted(why))}")
}

func openInterface() {
    guard openDevice == nil, let device = buttonInterface() else { return }
    // No seize: the driver and the system keep the pen.
    let status = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
    if status != kIOReturnSuccess {
        if status != refusedStatus {
            refusedStatus = status
            say("{\"k\":\"log\",\"m\":\"the pen display's pen interface did not open: \(String(format: "0x%08x", UInt32(bitPattern: status)))\"}")
        }
        return
    }
    refusedStatus = 0
    openDevice = device
    IOHIDDeviceRegisterInputReportCallback(device, reportBuffer, 512, { _, _, _, _, _, report, length in
        let bytes = Array(UnsafeBufferPointer(start: report, count: length))
        if !reports.read(bytes, emit: say) && unknownReports < 8 {
            unknownReports += 1
            say("{\"k\":\"raw\",\"hex\":\"\(hex(Array(bytes.prefix(32))))\"}")
        }
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
