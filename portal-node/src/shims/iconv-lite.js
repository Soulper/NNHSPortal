// ================================================================
// ICONV-LITE SHIM (Cloudflare Workers only — via wrangler "alias")
// ================================================================
// Why: esbuild honours iconv-lite's `browser` field and replaces its
// Node-only modules (lib/streams, lib/extend-node) with empty stubs. Under
// workerd, process.versions.node exists, so iconv-lite still CALLS those
// stubs at require time and the worker crashes at boot.
//
// Callers in this bundle: raw-body (body-parser). It only ever asks for the
// request charset (utf-8, latin1) and uses the decoder API below. The app is
// UTF-8-only (same as the PHP original); anything else answers with iconv's
// own "Encoding not recognized:" error so raw-body turns it into HTTP 415.
// ================================================================
"use strict";

function norm(encoding) {
    const e = String(encoding || "utf-8").toLowerCase();
    if (e === "utf8" || e === "utf-8") return "utf-8";
    if (e === "latin1" || e === "iso-8859-1" || e === "binary") return "latin1";
    throw new Error("Encoding not recognized: '" + encoding + "'");
}

// iconv-lite decoder: write(buf) -> string piece, end() -> remaining string.
// Buffering the whole body and returning it from end() is fine for the
// request sizes this app accepts (a few MB).
function make_decoder(encoding) {
    const enc = norm(encoding);
    let buf = Buffer.alloc(0);
    let started = false;
    return {
        write(chunk) {
            buf = Buffer.concat([buf, Buffer.from(chunk)]);
            return ""; // decoded lazily in end()
        },
        end() {
            let s = buf.toString(enc);
            // UTF-8 BOM stripping, like iconv-lite's StripBOM
            if (enc === "utf-8" && !started) {
                s = s.replace(/^\uFEFF/, "");
                started = true;
            }
            return s;
        },
    };
}

module.exports = {
    // raw-body API
    getDecoder(encoding) {
        return make_decoder(encoding);
    },
    // extend-node API (defensive: other bundled code may call these)
    decode(buffer, encoding) {
        return Buffer.from(buffer).toString(norm(encoding));
    },
    encode(string, encoding) {
        return Buffer.from(String(string), norm(encoding));
    },
    encodingExists(encoding) {
        try { norm(encoding); return true; } catch (_) { return false; }
    },
    decodeStream() { throw new Error("iconv-lite streams are not supported on Workers"); },
    encodeStream() { throw new Error("iconv-lite streams are not supported on Workers"); },
};
