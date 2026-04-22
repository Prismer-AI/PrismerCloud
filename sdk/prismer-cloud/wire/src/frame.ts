/**
 * @prismer/wire — Binary frame encode/decode for WSS multiplexing
 *
 * Ported from scripts/PARA/exp-06-binary-frame.ts (PASS, 5M enc/s, 2-byte overhead).
 *
 * Frame format (EXP-06 §5.6.4):
 *   Byte 0: opcode (uint8)
 *   Byte 1: slot   (uint8, 0–255)
 *   Bytes 2+: payload
 *
 * Opcodes:
 *   0x00 JSON_CONTROL  — control messages (ParaEvent JSON)
 *   0x01 AGENT_OUTPUT  — agent stdout/stderr stream
 *   0x02 TERMINAL_IO   — terminal I/O passthrough
 *   0x03 FILE_CHUNK    — file transfer chunk (4-byte seq prefix in payload)
 *   0x04 AUDIT_TAP     — audit tap (read-only observation, never blocked)
 */

/** Wire frame opcodes. */
export const Opcode = {
  JSON_CONTROL: 0x00,
  AGENT_OUTPUT: 0x01,
  TERMINAL_IO: 0x02,
  FILE_CHUNK: 0x03,
  AUDIT_TAP: 0x04,
} as const;

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

/** Human-readable names for opcodes (for logging). */
export const OPCODE_NAMES: Record<number, string> = {
  0x00: 'json-control',
  0x01: 'agent-output',
  0x02: 'terminal-io',
  0x03: 'file-chunk',
  0x04: 'audit-tap',
};

/** A decoded frame. */
export interface Frame {
  opcode: OpcodeValue;
  /** Slot index (0–255), used to demultiplex concurrent streams. */
  slot: number;
  payload: Uint8Array;
}

/**
 * Encode a frame to a Buffer suitable for sending as a single WS message.
 * Overhead: exactly 2 bytes.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  const result = new Uint8Array(2 + frame.payload.length);
  result[0] = frame.opcode;
  result[1] = frame.slot;
  result.set(frame.payload, 2);
  return result;
}

/**
 * Decode a Buffer received as a single WS message into a Frame.
 * Throws if the buffer is shorter than 2 bytes.
 */
export function decodeFrame(data: Uint8Array): Frame {
  if (data.length < 2) {
    throw new Error(`Frame too short: ${data.length} byte(s), minimum 2`);
  }
  return {
    opcode: data[0] as OpcodeValue,
    slot: data[1],
    payload: data.subarray(2),
  };
}

/**
 * FrameMultiplexer — collect frames from multiple virtual streams and
 * produce a sequence of encoded WS messages (one message per frame).
 */
export class FrameMultiplexer {
  private buffer: Uint8Array[] = [];

  push(frame: Frame): void {
    this.buffer.push(encodeFrame(frame));
  }

  /** Flush all buffered frames and reset the buffer. */
  flush(): Uint8Array[] {
    const result = this.buffer;
    this.buffer = [];
    return result;
  }
}

/**
 * FrameDemultiplexer — route incoming WS messages to per-slot/opcode buckets.
 */
export class FrameDemultiplexer {
  private buckets = new Map<string, Frame[]>();

  onMessage(data: Uint8Array): void {
    const frame = decodeFrame(data);
    const key = `${frame.opcode}:${frame.slot}`;
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key)!.push(frame);
  }

  getFrames(opcode: number, slot: number): Frame[] {
    return this.buckets.get(`${opcode}:${slot}`) ?? [];
  }

  getAllKeys(): string[] {
    return [...this.buckets.keys()];
  }
}

/**
 * Split a large buffer into FILE_CHUNK frames with 4-byte sequence numbers.
 * Each frame payload: [uint32-BE seq (4 bytes)] + [chunk data].
 */
export function chunkFile(data: Uint8Array, chunkSize: number, slot: number): Frame[] {
  const frames: Frame[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    const payload = new Uint8Array(4 + chunk.length);
    // Write sequence number as big-endian uint32
    const seq = frames.length;
    payload[0] = (seq >>> 24) & 0xff;
    payload[1] = (seq >>> 16) & 0xff;
    payload[2] = (seq >>> 8) & 0xff;
    payload[3] = seq & 0xff;
    payload.set(chunk, 4);
    frames.push({ opcode: Opcode.FILE_CHUNK, slot, payload });
  }
  return frames;
}

/**
 * Reassemble FILE_CHUNK frames into the original buffer.
 * Sorts by sequence number (first 4 bytes of each frame's payload).
 */
export function reassembleFile(frames: Frame[]): Uint8Array {
  const sorted = [...frames].sort((a, b) => {
    const seqA = ((a.payload[0] << 24) | (a.payload[1] << 16) | (a.payload[2] << 8) | a.payload[3]) >>> 0;
    const seqB = ((b.payload[0] << 24) | (b.payload[1] << 16) | (b.payload[2] << 8) | b.payload[3]) >>> 0;
    return seqA - seqB;
  });

  const totalLength = sorted.reduce((sum, f) => sum + f.payload.length - 4, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const frame of sorted) {
    const data = frame.payload.subarray(4);
    result.set(data, offset);
    offset += data.length;
  }
  return result;
}
