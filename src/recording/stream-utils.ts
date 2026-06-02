import { createRequire } from "node:module";
import type { Readable, Transform } from "node:stream";
import { toError } from "./errors.js";

const require = createRequire(import.meta.url);
const prism = require("prism-media") as {
  opus: {
    OggLogicalBitstream: new (options: unknown) => Transform;
    OpusHead: new (options: unknown) => unknown;
  };
};

export function createOggStream(): Transform {
  return new prism.opus.OggLogicalBitstream({
    opusHead: new prism.opus.OpusHead({
      channelCount: 2,
      sampleRate: 48_000,
    }),
    pageSizeControl: {
      maxPackets: 10,
    },
  });
}

export function waitForWritableClose(
  receiveStream: Readable,
  oggStream: Transform,
  outputStream: NodeJS.WritableStream,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      outputStream.off("finish", done);
      outputStream.off("close", done);
      outputStream.off("error", fail);
      oggStream.off("error", fail);
      receiveStream.off("error", fail);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toError(error));
    };

    outputStream.once("finish", done);
    outputStream.once("close", done);
    outputStream.once("error", fail);
    oggStream.once("error", fail);
    receiveStream.once("error", fail);
  });
}
