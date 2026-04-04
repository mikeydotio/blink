'use strict';

hterm.Terminal.prototype.onFocusChange_ = function(focused) {};

hterm.Terminal.prototype.onFocusChange__ = function(focused) {
  var currentState = this.cursorNode_.getAttribute('focus');
  if (currentState === focused + '') {
    return;
  }

  this.cursorNode_.setAttribute('focus', focused);
  this.restyleCursor_();

  if (this.reportFocus) {
    this.io.sendString(focused === true ? '\x1b[I' : '\x1b[O');
  }

  if (focused === true) this.closeBellNotifications_();
};

// Do not show resize notifications. We show ours
hterm.Terminal.prototype.overlaySize = function() {};

hterm.Terminal.prototype.onMouse_ = function() {};

// TODO: Remove our patch. htermjs supports cursorBlinkPause_ option now
// see https://github.com/chromium/hterm/commit/f57d62de8f91f1fc8923fb000aeace041d063f9f
hterm.Terminal.prototype.setCursorVisible = function(state) {
  this.options_.cursorVisible = state;

  if (!state) {
    if (this.timeouts_.cursorBlink) {
      clearTimeout(this.timeouts_.cursorBlink);
      delete this.timeouts_.cursorBlink;
    }
    this.cursorNode_.style.opacity = '0';
    return;
  }

  this.syncCursorPosition_();

  this.cursorNode_.style.opacity = '1';

  if (this.options_.cursorBlink) {
    if (this.timeouts_.cursorBlink) return;

    // Blink: Switch the cursor off, so that the manual (first) blink trigger sets it on again
    this.cursorNode_.style.opacity = '0';
    this.onCursorBlink_();
  } else {
    if (this.timeouts_.cursorBlink) {
      clearTimeout(this.timeouts_.cursorBlink);
      delete this.timeouts_.cursorBlink;
    }
  }
};

// NOTE(@nanzhong) hterm does not support DEC mode 1003 (any mouse event reporting mode).
// DEC mode 1003 and DEC mode 1002 (which hterm does support) are almost identical. The only difference is that mode 1003 includes mouse movement tracking events which are rarely used.
// This patches hterm to treat DEC mode 1003 the same as DEC mode 1002.

hterm.VT.prototype.setDECMode_original = hterm.VT.prototype.setDECMode;
hterm.VT.prototype.setDECMode = function(code, state) {
  if (code === "1003") {
    code = "1002";
  }
  hterm.VT.prototype.setDECMode_original.call(this, code, state);
};

// ── Emoji/Unicode Width Fix ─────────────────────────────────────────
//
// hterm's lib.wc calculates character widths per-codepoint, but emoji
// sequences (ZWJ families, skin tones, flags, VS-16 sequences) are
// multi-codepoint grapheme clusters that render as single 2-cell glyphs.
// Additionally, some emoji codepoints (e.g. U+23F8 pause, U+1F5C4
// cabinet) are missing from the width tables entirely.
//
// This override replaces the width functions with grapheme-cluster-aware
// versions using Intl.Segmenter (available since iOS 16.0).

(function() {
  'use strict';

  if (typeof window.__blinkUnicodeVersion !== 'undefined' && window.__blinkUnicodeVersion < 9) {
    return; // Legacy mode: skip emoji width fix
  }

  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return; // Fall back to original behavior on old platforms
  }

  var segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  // Emoji detection regexes (Unicode property escapes, WebKit 11.1+)
  var emojiPresentationRe = /\p{Emoji_Presentation}/u;
  var emojiVS16Re = /\p{Emoji}\uFE0F/u;

  // Fast pre-check: skip segmentation for strings without emoji indicators.
  // Covers: variation selectors, ZWJ, supplementary emoji planes, misc symbols.
  var mayContainEmojiRe = /[\u00A9\u00AE\u200D\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299\uFE0F\u{1F000}-\u{1FFFF}\u{E0020}-\u{E007F}]/u;

  // Pure ASCII fast-path regex
  var pureAsciiRe = /^[\x20-\x7e]*$/;

  // Calculate terminal column width of a single grapheme cluster.
  function graphemeWidth(grapheme) {
    var cp = grapheme.codePointAt(0);

    // Single ASCII character (common case)
    if (grapheme.length === 1 && cp >= 0x20 && cp <= 0x7E) {
      return 1;
    }

    // NUL
    if (cp === 0) return lib.wc.nulWidth;

    // C0/C1 control characters
    if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return lib.wc.controlWidth;

    // Emoji: check for emoji presentation (default or forced via VS-16)
    if (emojiPresentationRe.test(grapheme) || emojiVS16Re.test(grapheme)) {
      return 2;
    }

    // Non-emoji grapheme: use the base codepoint's width from hterm tables.
    // This preserves CJK (width 2), combining marks (width 0), etc.
    var w = lib.wc.charWidth(cp);
    return w < 0 ? 0 : w;
  }

  // ── lib.wc.strWidth override ──────────────────────────────────────

  var _origStrWidth = lib.wc.strWidth;

  lib.wc.strWidth = function(str) {
    if (!str) return 0;

    // Fast path: pure ASCII
    if (pureAsciiRe.test(str)) return str.length;

    // Fast path: no emoji indicators — use original codepoint-based method
    if (!mayContainEmojiRe.test(str)) return _origStrWidth(str);

    // Full grapheme-aware width
    var width = 0;
    for (var seg of segmenter.segment(str)) {
      var w = graphemeWidth(seg.segment);
      if (w < 0) return -1;
      width += w;
    }
    return width;
  };

  // ── lib.wc.substr override ────────────────────────────────────────
  // Returns a substring starting at terminal column `start`, spanning
  // `opt_width` columns (or to end of string if opt_width is null).

  var _origSubstr = lib.wc.substr;

  lib.wc.substr = function(str, start, opt_width) {
    if (!str) return '';

    // Fast path: pure ASCII
    if (pureAsciiRe.test(str)) {
      if (opt_width != null) {
        return str.substring(start, start + opt_width);
      }
      return str.substring(start);
    }

    // Fast path: no emoji
    if (!mayContainEmojiRe.test(str)) return _origSubstr(str, start, opt_width);

    // Grapheme-aware column navigation
    var segments = Array.from(segmenter.segment(str));
    var col = 0;
    var i = 0;

    // Skip to start column
    while (i < segments.length) {
      var w = graphemeWidth(segments[i].segment);
      if (col + w > start) break;
      col += w;
      i++;
    }

    var startCharIdx = i < segments.length ? segments[i].index : str.length;

    if (opt_width == null) {
      return str.substring(startCharIdx);
    }

    // Accumulate width columns from start
    var widthSoFar = 0;
    var endI = i;
    while (endI < segments.length) {
      var w = graphemeWidth(segments[endI].segment);
      if (widthSoFar + w > opt_width) break;
      widthSoFar += w;
      endI++;
    }

    var endCharIdx = endI < segments.length ? segments[endI].index : str.length;
    return str.substring(startCharIdx, endCharIdx);
  };

  // ── lib.wc.substring override ─────────────────────────────────────

  lib.wc.substring = function(str, start, end) {
    return lib.wc.substr(str, start, end - start);
  };

  // ── hterm.TextAttributes.splitWidecharString override ─────────────
  // Splits text into narrow and wide segments for DOM rendering.
  // Each segment: { str, wcNode, asciiNode, wcStrWidth }

  hterm.TextAttributes.splitWidecharString = function(str) {
    if (!str) return [];

    // Fast path: pure ASCII
    if (pureAsciiRe.test(str)) {
      return [{ str: str, wcNode: false, asciiNode: true, wcStrWidth: str.length }];
    }

    // Fast path: no emoji — check if we can use a simpler codepoint-based split
    var hasEmoji = mayContainEmojiRe.test(str);

    var rv = [];
    var narrowStart = 0;   // char index where current narrow run started
    var narrowEnd = 0;     // char index where current narrow run ends
    var narrowWidth = 0;   // accumulated column width of narrow run
    var isAscii = true;    // whether current narrow run is pure ASCII

    var segments = hasEmoji ? Array.from(segmenter.segment(str)) : null;

    if (!segments) {
      // No emoji: iterate by codepoint (same logic as original hterm but
      // we still use our corrected graphemeWidth for safety)
      for (var i = 0; i < str.length; ) {
        var cp = str.codePointAt(i);
        var cpLen = cp <= 0xFFFF ? 1 : 2;
        var w = lib.wc.charWidth(cp);
        if (w < 0) w = 0;

        if (w === 2) {
          // Flush narrow buffer
          if (narrowEnd > narrowStart) {
            rv.push({
              str: str.substring(narrowStart, narrowEnd),
              wcNode: false,
              asciiNode: isAscii,
              wcStrWidth: narrowWidth
            });
          }
          // Wide character as its own node
          rv.push({
            str: str.substring(i, i + cpLen),
            wcNode: true,
            asciiNode: false,
            wcStrWidth: 2
          });
          narrowStart = i + cpLen;
          narrowEnd = narrowStart;
          narrowWidth = 0;
          isAscii = true;
        } else {
          narrowEnd = i + cpLen;
          narrowWidth += w;
          if (cp > 127) isAscii = false;
        }
        i += cpLen;
      }
    } else {
      // Emoji path: iterate by grapheme cluster
      for (var gi = 0; gi < segments.length; gi++) {
        var seg = segments[gi];
        var grapheme = seg.segment;
        var w = graphemeWidth(grapheme);

        if (w === 2) {
          // Flush narrow buffer
          if (narrowEnd > narrowStart) {
            rv.push({
              str: str.substring(narrowStart, narrowEnd),
              wcNode: false,
              asciiNode: isAscii,
              wcStrWidth: narrowWidth
            });
          }
          // Wide grapheme (emoji or CJK) as its own node
          rv.push({
            str: grapheme,
            wcNode: true,
            asciiNode: false,
            wcStrWidth: 2
          });
          narrowStart = seg.index + grapheme.length;
          narrowEnd = narrowStart;
          narrowWidth = 0;
          isAscii = true;
        } else {
          narrowEnd = seg.index + grapheme.length;
          narrowWidth += w;
          if (grapheme.length > 1 || grapheme.charCodeAt(0) > 127) {
            isAscii = false;
          }
        }
      }
    }

    // Flush remaining narrow buffer
    if (narrowEnd > narrowStart) {
      rv.push({
        str: str.substring(narrowStart, narrowEnd),
        wcNode: false,
        asciiNode: isAscii,
        wcStrWidth: narrowWidth
      });
    }

    // Edge case: empty input produced no segments
    if (rv.length === 0 && str.length > 0) {
      rv.push({ str: str, wcNode: false, asciiNode: false, wcStrWidth: 0 });
    }

    return rv;
  };

})();
