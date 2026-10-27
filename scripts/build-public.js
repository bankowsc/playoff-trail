
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(projectRoot, "public");
const outputDir = path.join(projectRoot, "dist", "public");

function buildPublic() {
  const entryFile = path.join(sourceDir, "index.html");

  if (!fs.existsSync(entryFile)) {
    throw new Error(`Missing frontend entry point: ${entryFile}`);
  }

  // Replace the previous generated frontend.
  fs.rmSync(outputDir, { recursive: true, force: true });

  // Copy HTML, CSS, JavaScript, and other public assets.
  fs.cpSync(sourceDir, outputDir, { recursive: true });

  console.log("Frontend built successfully.");
  console.log(`Output: ${outputDir}`);
}

try {
  buildPublic();
} catch (error) {
  console.error("Frontend build failed:", error.message);
  process.exitCode = 1;
}
