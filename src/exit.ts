/**
 * Exit only after stdout and stderr have flushed.
 *
 * When stdout is a pipe (`yolo kanban export <tile> | jq`), Node writes to it
 * asynchronously, and `process.exit()` drops whatever the kernel pipe buffer
 * (64 KiB on Linux) has not accepted yet: a large export arrived as exactly
 * 65,536 bytes of truncated JSON, with exit status 0. A file or TTY is written
 * synchronously, which is why `-o <file>` was unaffected.
 *
 * A zero-length write's callback runs after every earlier write on that
 * stream has been handed to the OS, so exiting from both callbacks loses
 * nothing. The explicit exit is kept (rather than just setting exitCode)
 * because some commands can leave handles open that would otherwise keep the
 * process alive.
 */
export function exitAfterFlush(
  code: number,
  streams: ReadonlyArray<NodeJS.WriteStream> = [process.stdout, process.stderr],
  exit: (code: number) => void = (c) => process.exit(c),
): void {
  process.exitCode = code;
  let pending = streams.length;
  if (pending === 0) { exit(code); return; }
  const settle = () => { if (--pending === 0) exit(code); };
  for (const stream of streams) {
    // A destroyed or errored stream (e.g. the reader closed the pipe) never
    // calls back; treat it as flushed rather than hanging the process.
    if (stream.destroyed || !stream.writable) { settle(); continue; }
    stream.write('', settle);
  }
}
