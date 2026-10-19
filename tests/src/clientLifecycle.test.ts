import * as assert from "assert";
import {
  ClientLifecycle,
  ClientResource,
} from "../../client/out/clientLifecycle";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Resource implements ClientResource {
  starts = 0;
  cancels = 0;
  stops = 0;
  constructor(private readonly startup: Promise<void> = Promise.resolve()) {}
  async start() {
    ++this.starts;
    await this.startup;
  }
  cancel() {
    ++this.cancels;
  }
  async stop() {
    ++this.stops;
  }
}

suite("Client process lifecycle", () => {
  test("785 simultaneous opens launch one server, and stop it once", async () => {
    const errors: unknown[] = [];
    const clients = new ClientLifecycle<Resource>((error) =>
      errors.push(error),
    );
    const gate = deferred();
    let creations = 0;
    const resource = new Resource(gate.promise);
    const starts = Array.from({ length: 785 }, () =>
      clients.start("folder", () => {
        ++creations;
        return resource;
      }),
    );
    await Promise.resolve();
    assert.strictEqual(creations, 1);
    assert.strictEqual(resource.starts, 1);
    assert.strictEqual(clients.size, 1);
    assert.ok(starts.every((start) => start === starts[0]));
    gate.resolve();
    await Promise.all(starts);
    await clients.dispose();
    assert.strictEqual(resource.stops, 1);
    assert.deepStrictEqual(errors, []);
  });

  test("removing a folder before startup skips server creation", async () => {
    const clients = new ClientLifecycle<Resource>((error) =>
      assert.fail(String(error)),
    );
    const resource = new Resource();
    const pending = clients.start("folder", () => resource);
    await clients.clear();
    assert.strictEqual(await pending, undefined);
    assert.strictEqual(resource.starts, 0);
    assert.strictEqual(resource.cancels, 1);
    assert.strictEqual(resource.stops, 1);
  });

  test("removing and re-adding a folder cannot revive old startup", async () => {
    const errors: unknown[] = [];
    const clients = new ClientLifecycle<Resource>((error) =>
      errors.push(error),
    );
    const gate = deferred();
    const old = new Resource(gate.promise);
    const oldReady = clients.start("folder", () => old);
    await Promise.resolve();
    const clearing = clients.clear();
    assert.strictEqual(old.cancels, 1);
    const replacement = new Resource();
    const current = clients.start("folder", () => replacement);
    gate.reject(new Error("obsolete startup failed"));
    await clearing;
    assert.strictEqual(await oldReady, undefined);
    assert.strictEqual(await current, replacement);
    assert.strictEqual(clients.size, 1);
    assert.strictEqual(old.stops, 1);
    await clients.dispose();
    assert.strictEqual(replacement.stops, 1);
    assert.strictEqual(errors.length, 1);
  });

  test("deactivation waits for pending startup and prevents future starts", async () => {
    const clients = new ClientLifecycle<Resource>((error) =>
      assert.fail(String(error)),
    );
    const gate = deferred();
    const resource = new Resource(gate.promise);
    void clients.start("folder", () => resource);
    await Promise.resolve();
    let disposed = false;
    const disposing = clients.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    assert.strictEqual(disposed, false);
    assert.strictEqual(resource.cancels, 1);
    assert.strictEqual(resource.stops, 0);
    gate.resolve();
    await disposing;
    assert.strictEqual(resource.stops, 1);
    let createdAfterShutdown = false;
    assert.strictEqual(
      await clients.start("other", () => {
        createdAfterShutdown = true;
        return new Resource();
      }),
      undefined,
    );
    assert.strictEqual(createdAfterShutdown, false);
  });

  test("failed startup is reported, disposed, and can be retried", async () => {
    const errors: unknown[] = [];
    const clients = new ClientLifecycle<Resource>((error) =>
      errors.push(error),
    );
    const error = new Error("server failed to initialize");
    const broken = new Resource(Promise.reject(error));
    assert.strictEqual(await clients.start("folder", () => broken), undefined);
    assert.strictEqual(broken.stops, 1);
    assert.strictEqual(clients.size, 0);
    assert.deepStrictEqual(errors, [error]);
    const replacement = new Resource();
    assert.strictEqual(
      await clients.start("folder", () => replacement),
      replacement,
    );
    await clients.dispose();
  });

  test("a stop failure is reported without skipping other shutdowns", async () => {
    const errors: unknown[] = [];
    const clients = new ClientLifecycle<Resource>((error) =>
      errors.push(error),
    );
    const broken = new Resource();
    broken.stop = async () => {
      throw new Error("shutdown failed");
    };
    const healthy = new Resource();
    await Promise.all([
      clients.start("a", () => broken),
      clients.start("b", () => healthy),
    ]);
    await clients.dispose();
    assert.strictEqual(healthy.stops, 1);
    assert.strictEqual(errors.length, 1);
  });

  test("a synchronous construction failure is reported and permits retry", async () => {
    const errors: unknown[] = [];
    const clients = new ClientLifecycle<Resource>((error) =>
      errors.push(error),
    );
    const error = new Error("invalid client options");
    assert.strictEqual(
      await clients.start("folder", () => {
        throw error;
      }),
      undefined,
    );
    assert.deepStrictEqual(errors, [error]);
    assert.strictEqual(clients.size, 0);
    const resource = new Resource();
    assert.strictEqual(await clients.start("folder", () => resource), resource);
    await clients.dispose();
  });
});
