import * as assert from "assert";
import { closeOnWorkerError } from "../../client/out/workerLifecycle";

class TestWorker extends EventTarget {
  terminations = 0;
  terminate(): void {
    ++this.terminations;
  }
}

suite("Browser worker failure lifecycle", () => {
  test("a fatal error terminates the worker and closes the LSP connection once", () => {
    const worker = new TestWorker();
    let closes = 0;
    const dispose = closeOnWorkerError(worker, () => ++closes);
    worker.dispatchEvent(new Event("error"));
    worker.dispatchEvent(new Event("error"));
    worker.dispatchEvent(new Event("messageerror"));
    assert.strictEqual(worker.terminations, 1);
    assert.strictEqual(closes, 1);
    dispose();
  });

  test("an unreadable worker message also closes the LSP connection", () => {
    const worker = new TestWorker();
    let closes = 0;
    const dispose = closeOnWorkerError(worker, () => ++closes);
    worker.dispatchEvent(new Event("messageerror"));
    assert.strictEqual(worker.terminations, 1);
    assert.strictEqual(closes, 1);
    dispose();
  });

  test("disposing listeners prevents old workers from closing a replacement connection", () => {
    const oldWorker = new TestWorker();
    const replacement = new TestWorker();
    let oldCloses = 0;
    let replacementCloses = 0;
    const disposeOld = closeOnWorkerError(oldWorker, () => ++oldCloses);
    const disposeReplacement = closeOnWorkerError(
      replacement,
      () => ++replacementCloses,
    );
    disposeOld();
    oldWorker.dispatchEvent(new Event("error"));
    assert.strictEqual(oldWorker.terminations, 0);
    assert.strictEqual(oldCloses, 0);
    assert.strictEqual(replacementCloses, 0);
    replacement.dispatchEvent(new Event("error"));
    assert.strictEqual(replacementCloses, 1);
    disposeReplacement();
  });
});
