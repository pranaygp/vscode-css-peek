type WorkerEvents = Pick<
  Worker,
  "addEventListener" | "removeEventListener" | "terminate"
>;

/** A failed worker cannot recover; close its LSP connection so it can restart. */
export function closeOnWorkerError(
  worker: WorkerEvents,
  close: () => void,
): () => void {
  let closed = false;
  const removeListeners = () => {
    worker.removeEventListener("error", failed);
    worker.removeEventListener("messageerror", failed);
  };
  const failed = () => {
    if (closed) return;
    closed = true;
    removeListeners();
    worker.terminate();
    close();
  };
  worker.addEventListener("error", failed);
  worker.addEventListener("messageerror", failed);
  return () => {
    closed = true;
    removeListeners();
  };
}
