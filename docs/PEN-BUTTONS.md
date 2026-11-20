# Pen buttons

**This is a fixed contract. It must never break.** Sean set this behavior and confirmed it working in ScrollMind 1.8.0 (2026-11-20). Change it only on Sean's explicit word, and then change this page and the tests below in the same commit.

The pen has two side buttons:

- **Lower:** the button nearer the tip.
- **Upper:** the button farther from the tip.

## What the buttons do

The same in Scroll and Grid mode.

| Do this | It does this |
| --- | --- |
| **Lower held, tip taps or drags** | **Delete:** erases what the tip touches. |
| **Lower double-tap** | **Undo** |
| **Upper held, tip drags** | **Scroll:** the page follows the tip. |
| **Upper double-tap** | **Redo** |
| **Lower tapped, then upper held, tip drags** | **Zoom** around where the tip touched: drag up to zoom in, down to zoom out. |

## The rules behind each row

**Holding a button alone does nothing.** Nothing is deleted, scrolled or zoomed until the tip touches. Hovering over ink with the lower button held deletes nothing.

**A held button is a mode until it is let go.**
- Lower held: every tap or drag of the tip deletes. Each drag is one undo.
- Upper held: every drag scrolls. You can lift the tip and drag again.
- Zoom: it starts when the upper button goes down after the lower tap. Every drag zooms until the upper button is let go, and then the pen is normal again.

**Taps:**
- A **tap** is a press and release in the air of at most half a second. A longer press is a hold.
- A **double tap** is two taps of the same button. The second press starts at most 0.4 seconds after the first release.
- A single tap does nothing.
- A tap the Wacom One 12 reports counts however far the pen drifts under the thumb.

**The zoom chord:**
- The order is lower tap, then upper pressed within 0.7 seconds and held.
- Upper then lower, or a longer pause, does nothing.
- The chord's upper press is not a tap, so it never adds to a redo.
- Escape ends zoom mode.

**During a stroke:** a button pressed while the tip is drawing does not erase until the tip lifts and touches again.

**Also erases:** the pen's rear eraser and the toolbar eraser, while they touch.

## Where the buttons come from

- **Wacom One 12 on a Mac.** ScrollMind reads the pen from the display itself: the tip, both buttons and where the pen is. It uses the same pen report the Wacom driver reads (`tools/pen/scroll-pen.swift`). While a button is held, the pen is the display's, and whatever Wacom Center assigns that button is set aside. This covers Right Click, which arrives with pressure even while the pen only hovers, and Pan/Scroll, which freezes the pointer where the button went down. macOS delivers these reports only to an app with **Input Monitoring**. Turn on ScrollMind under System Settings ▸ Privacy & Security ▸ Input Monitoring. **ScrollMind ▸ Pen Display Buttons…** shows whether it is on.
- **Other tablets and Windows.** Assign the lower button to **Right Click** and the upper to **Middle Click** in the Wacom driver. [CONTROLS.md](CONTROLS.md#windows) has the Windows details.

## The tests that hold it

Every `npm run preflight`, and so every release, runs these. `npm run test:pen` runs them alone.

| Test | What it checks |
| --- | --- |
| `tests/ui.spec.mjs`, every test named **Pen button contract** | Each row above in Scroll and Grid mode, through the app. This includes the display's own reports, and the driver's Right Click and Pan/Scroll noise beside them. |
| `tests/pen-shortcuts.test.mjs` | Double taps, the zoom chord and its timings. |
| `tests/pen-input.test.mjs`, `tests/pen-native.test.mjs` | How the display's reports and the driver's events merge, and which of them decides contact. |
| `tests/pen-helper.test.mjs` | The helper decodes the display's reports. |
| `tests/pen-contract-doc.test.mjs` | This page still states the contract, and the contract tests still exist. |

## When a button seems wrong

Read `Logs/pen.log` in `~/Documents/ScrollMind`. It records each button the display reports (`buttons lower=… upper=…`), what reached the page (`native …`, `placed tip=…`, `dom …`), and what the app did (`down tool=…`, `end …`, `action undo|redo|zoom-hold|zoom-end`).
