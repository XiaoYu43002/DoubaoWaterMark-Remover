"use strict";

(() => {
  const _B = [
    "D/WgGhSacOZZqfcfQZol6Qv08RwVm3bnWqfzHUTKdOQ=",
    "CvKmHEOeJ7IDo/1PFZ0tsQqo8kxEkXGyDqb1GUCdJ+Q=",
    "XaX9TBbOIrYLqaEWE54ttAmnpRlFzSbnWKClF0LJJ7Y=",
    "Cvf0GxadJOgCo6VLEZos5AKm9xwVniexCKmlTxPMIOg="
  ];
  const _M = 0xaa;
  const _K = [0x91, 0x3b, 0x6e, 0x84, 0xdd, 0x02, 0xbf, 0x7a].map((v) => v ^ _M);

  let _wasm = null;
  let _hex = null;

  function _b64ToBytes(value) {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function _bootWasm() {
    if (_wasm) return _wasm;
    const url = chrome.runtime.getURL("opaque/xcodec.wasm");
    const buffer = await fetch(url).then((response) => {
      if (!response.ok) throw new Error("opaque codec missing");
      return response.arrayBuffer();
    });
    _wasm = await WebAssembly.instantiate(buffer);
    return _wasm;
  }

  function _joinParts() {
    const chunks = _B.map(_b64ToBytes);
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async function resolveOpaqueSaltHex() {
    if (_hex) return _hex;
    const { instance } = await _bootWasm();
    const enc = _joinParts();
    const memory = new Uint8Array(instance.exports.m.buffer);
    if (memory.length < enc.length) throw new Error("opaque memory too small");
    memory.set(enc, 0);
    for (let i = 0; i < enc.length; i += 1) {
      instance.exports.x(i, 1, _K[i % _K.length]);
    }
    let text = "";
    for (let i = 0; i < enc.length; i += 1) text += String.fromCharCode(memory[i]);
    memory.fill(0, 0, enc.length);
    if (!/^[0-9a-f]{128}$/i.test(text)) throw new Error("opaque material invalid");
    _hex = text.toLowerCase();
    return _hex;
  }

  self.resolveOpaqueSaltHex = resolveOpaqueSaltHex;
})();
