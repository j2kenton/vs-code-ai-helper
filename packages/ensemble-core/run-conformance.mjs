import { run } from "node:test";
import { tap } from "node:test/reporters";
import path from "node:path";

const testStream = run({ files: [path.resolve("out-test/packages/ensemble-core/tests/conformance.test.js")] });
testStream.compose(tap()).pipe(process.stdout);
testStream.on("test:fail", () => {
  process.exitCode = 1;
});
