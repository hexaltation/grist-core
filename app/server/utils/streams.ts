import {promises, Readable, Writable} from 'stream';

// Creates a writable stream that can be retrieved as a buffer.
// Sub-optimal implementation, as we end up with *at least* two copies in memory one in `buffers`,
// and one produced by `Buffer.concat` at the end.
export class MemoryWritableStream extends Writable {
  private _buffers: Buffer[] = [];

  public getBuffer(): Buffer {
    return Buffer.concat(this._buffers);
  }

  public _write(chunk: any, encoding: BufferEncoding, callback: (error?: (Error | null)) => void) {
    if (typeof (chunk) == "string") {
      this._buffers.push(Buffer.from(chunk, encoding));
    } else {
      this._buffers.push(chunk);
    }
    callback();
  }
}

/**
 * Drains a readable stream if it has any more data after the promise settles.
 * @param {Readable} stream - A readable stream that needs to be drained.
 * @param {Promise<T>} promise - A promise that should only resolve once it's finished with the
 *   stream.
 * @returns {Promise<T>} - A new promise with the same state as the original, unless the stream
 *   draining errors.
 */
export async function drainWhenSettled<T>(stream: Readable, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } finally {
    if (stream.readable) {
      stream.resume();
    }
    await promises.finished(stream);
  }
}
