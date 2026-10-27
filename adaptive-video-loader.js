// Adaptive Video Quality Loader
// Detects network speed and serves the best quality that will load smoothly.
// Tiers:
//   large  = original mp4 (full quality, no re-encode)
//   medium = webm 360p (CRF 35)
//   small  = webm 240p (CRF 36)
// Bias: prefer large — only downgrades on clearly slow connections.
//
// <source src> is NEVER rewritten, so right-click "Save video as" always
// offers the original mp4.  Adaptive quality only applies to data-* attrs
// consumed by JS playback code (gallery hover, GS toggle, etc.).

(function () {
    'use strict';

    function detectTier() {
        if ('connection' in navigator) {
            var c = navigator.connection;
            var dl = c.downlink;
            var ect = c.effectiveType;
            if (ect === '2g' || (dl !== undefined && dl < 0.5)) return 'small';
            if (ect === '3g' || (dl !== undefined && dl < 2)) return 'medium';
        }
        return 'large';
    }

    function canPlayWebM() {
        var v = document.createElement('video');
        return v.canPlayType('video/webm; codecs="vp9"') !== '';
    }

    var tier = detectTier();
    var webm = canPlayWebM();

    function adaptSrc(src) {
        if (!src) return src;
        if (!/\.mp4$/i.test(src)) return src;
        if (tier === 'large') return src;
        if (!webm) return src;
        return src.replace(/\.mp4$/i, '_' + tier + '.webm');
    }

    window.adaptVideoSrc = adaptSrc;
    window.adaptiveVideoTier = tier;
    window.adaptiveUseWebM = webm && tier !== 'large';

    // Only rewrite data-* attributes used by JS playback code.
    // <source src> and <video src> are left untouched so the browser's
    // native "Save video as" always points to the original mp4.
    function rewriteDataAttrs() {
        ['data-src', 'data-lazy-src', 'data-gs-src', 'data-video-src'].forEach(function (attr) {
            document.querySelectorAll('[' + attr + ']').forEach(function (el) {
                var orig = el.getAttribute(attr);
                var adapted = adaptSrc(orig);
                if (adapted !== orig) el.setAttribute(attr, adapted);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', rewriteDataAttrs);
    } else {
        rewriteDataAttrs();
    }
})();
