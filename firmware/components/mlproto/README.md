# mlproto — pure payload builders shared across firmware and tests

This component must stay compilable on a host (no ESP-IDF headers in src/).

Seams (agreed with spec §2.7 / §2.9 / §2.1):

- `mlproto_adv_manufacturer(buf)` — 9 B manufacturer data:
  [0..1] vendor ID LE (0xFFFF test), [2] proto major, [3] proto minor,
  [4..5] capability bitmap LE, [6] run state.
  Catches: field order/endianness regressions that would break scanner filtering.
- `mlproto_state_frame(buf, st)` — 12 B full state frame:
  mode(1) arrangementVersion(2 LE) arrangementCrc32(4 LE)
  brightnessLimit(1) tokenHolder(1) errorCode(1) temperature(1) flags(1).
  Catches: wire format drift against §2.9; consumed verbatim by the app.
- `mlproto_device_info(buf, info)` — device info characteristic:
  fwMajor(1) fwMinor(1) protoMajor(1) protoMinor(1) capabilities(2 LE) deviceId(4 LE).

Layout not pinned byte-for-byte by spec (§2.1 lists contents, not offsets);
documented here as the wire contract for the app side.
