/**
 * Extract MP4 sidx box (segment base) information from a Web ReadableStream
 * while preserving stream contents.
 */
export async function extractSegmentBase(stream: ReadableStream<Uint8Array>): Promise<{
    segment_base?: {
        initialization: string;
        index_range: string;
        timescale?: number;
        earliest_presentation_time?: string;
    };
    stream: ReadableStream<Uint8Array>;
}> {
    const maxHeaderSize = 32768;
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    const reader = stream.getReader();
    let done = false;
    let sidxRange:
        | {
              initialization: string;
              index_range: string;
              timescale?: number;
              earliest_presentation_time?: string;
          }
        | undefined = undefined;

    while (bytesRead < maxHeaderSize) {
        const { value, done: readDone } = await reader.read();
        if (readDone) {
            done = true;
            break;
        }
        if (value) {
            chunks.push(value);
            bytesRead += value.length;
        }
    }

    const headerBuffer = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
        headerBuffer.set(chunk, offset);
        offset += chunk.length;
    }

    offset = 0;
    const view = new DataView(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength);
    while (offset + 8 <= bytesRead) {
        const size = view.getUint32(offset);
        const type = String.fromCharCode(
            headerBuffer[offset + 4],
            headerBuffer[offset + 5],
            headerBuffer[offset + 6],
            headerBuffer[offset + 7],
        );

        if (type === "sidx") {
            const version = view.getUint8(offset + 8);
            const timescale = view.getUint32(offset + 16);
            let earliestPresentationTime = 0n;
            if (version === 0) {
                earliestPresentationTime = BigInt(view.getUint32(offset + 20));
            } else {
                earliestPresentationTime = view.getBigUint64(offset + 20);
            }
            sidxRange = {
                initialization: `0-${offset - 1}`,
                index_range: `${offset}-${offset + size - 1}`,
                timescale,
                earliest_presentation_time: earliestPresentationTime.toString(),
            };
            break;
        }

        if (size === 0) {
            break;
        }
        if (size === 1) {
            if (offset + 16 > bytesRead) break;
            const sizeLarge = view.getBigUint64(offset + 8);
            offset += Number(sizeLarge);
        } else {
            offset += size;
        }
    }

    const reconstructedStream = new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            if (done) {
                controller.close();
                return;
            }
            try {
                while (true) {
                    const { value, done: readDone } = await reader.read();
                    if (readDone) {
                        controller.close();
                        break;
                    }
                    if (value) {
                        controller.enqueue(value);
                    }
                }
            } catch (err) {
                controller.error(err);
            } finally {
                reader.releaseLock();
            }
        },
    });

    return {
        segment_base: sidxRange,
        stream: reconstructedStream,
    };
}
