import { spawn } from "child_process";
import { join } from "path";

const tests = [
  join(process.cwd(), "tests/usage-bars-core.test.ts"),
];

function runOne(testPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["test", testPath], {
      stdio: "inherit",
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Test failed: ${testPath}`));
    });
  });
}

async function run() {
  for (const test of tests) {
    await runOne(test);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
