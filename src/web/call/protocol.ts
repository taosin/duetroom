const header = 16;

// All multibyte fields are little endian. Stream 1 is capture, stream 2 is playback.
export function frame(
  kind: 1 | 2,
  generation: number,
  segment: number,
  sequence: number,
  pcm: Uint8Array,
) {
  if (!pcm.length || pcm.length > 4800 || pcm.length % 2)
    throw Error("invalid_audio");
  const bytes = new Uint8Array(header + pcm.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = kind;
  view.setUint32(4, generation, true);
  view.setUint32(8, segment, true);
  view.setUint32(12, sequence, true);
  bytes.set(pcm, header);
  return bytes;
}
export function unpack(bytes: Uint8Array) {
  if (
    bytes.length <= header ||
    bytes.length > header + 4800 ||
    bytes.length % 2 ||
    bytes[0] !== 1 ||
    (bytes[1] !== 1 && bytes[1] !== 2)
  )
    throw Error("invalid_audio");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    kind: bytes[1],
    generation: view.getUint32(4, true),
    segment: view.getUint32(8, true),
    sequence: view.getUint32(12, true),
    pcm: bytes.subarray(header),
  };
}
