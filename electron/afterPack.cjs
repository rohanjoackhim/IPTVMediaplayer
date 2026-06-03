/**
 * electron-builder afterPack hook — strips unused platform binaries,
 * duplicate ONNX bundles, source maps, and redundant WASM variants
 * to shrink the packaged app by ~350–450 MB.
 */
const fs = require("fs");
const path = require("path");

/** Recursively delete a directory tree. */
function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

/** Recursively delete files matching a predicate. */
function removeMatchingFiles(dir, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      removeMatchingFiles(full, predicate);
    } else if (predicate(e.name, full)) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* noop */
      }
    }
  }
}

/** Map electron-builder platform/arch to onnxruntime directory names. */
function onnxPlatformDir(platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  return "linux";
}

exports.default = async function afterPack(context) {
  const { electronPlatformName, arch } = context;
  const appDir = context.appOutDir;

  // Determine target platform and arch names for onnxruntime
  const targetPlatform = onnxPlatformDir(electronPlatformName);
  // electron-builder arch: 1=x64, 3=arm64, 0=ia32
  const targetArch = arch === 3 ? "arm64" : "x64";

  console.log(`[afterPack] Stripping for ${targetPlatform}/${targetArch}…`);

  // Find the app resources directory (asar unpacked or regular)
  let resourcesDir;
  if (electronPlatformName === "darwin") {
    // macOS: .app/Contents/Resources/app.asar.unpacked
    const apps = fs.readdirSync(appDir).filter((n) => n.endsWith(".app"));
    const appBundle = apps[0] || "Player.app";
    resourcesDir = path.join(appDir, appBundle, "Contents", "Resources");
  } else {
    resourcesDir = path.join(appDir, "resources");
  }

  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  const asarModules = path.join(unpackedDir, "node_modules");

  // Also look in the asar-extracted dir if present
  const regularModules = path.join(resourcesDir, "app", "node_modules");
  const moduleDirs = [asarModules, regularModules].filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });

  if (!moduleDirs.length) {
    console.log("[afterPack] No node_modules found in packaged app, skipping.");
    return;
  }

  let savedBytes = 0;

  function sizeOf(p) {
    try {
      const s = fs.statSync(p);
      if (s.isFile()) return s.size;
      let total = 0;
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        total += sizeOf(path.join(p, e.name));
      }
      return total;
    } catch {
      return 0;
    }
  }

  for (const nmDir of moduleDirs) {
    // 1. Strip other-platform ONNX native binaries
    const onnxNodeBin = path.join(nmDir, "onnxruntime-node", "bin", "napi-v3");
    if (fs.existsSync(onnxNodeBin)) {
      for (const platform of ["darwin", "linux", "win32"]) {
        const platformDir = path.join(onnxNodeBin, platform);
        if (!fs.existsSync(platformDir)) continue;
        if (platform !== targetPlatform) {
          const sz = sizeOf(platformDir);
          rmDir(platformDir);
          savedBytes += sz;
          console.log(`[afterPack] Removed onnxruntime-node/${platform} (${(sz / 1e6).toFixed(1)}MB)`);
        } else {
          // Remove other arch within same platform
          for (const arch of ["x64", "arm64"]) {
            if (arch !== targetArch) {
              const archDir = path.join(platformDir, arch);
              if (fs.existsSync(archDir)) {
                const sz = sizeOf(archDir);
                rmDir(archDir);
                savedBytes += sz;
                console.log(`[afterPack] Removed onnxruntime-node/${platform}/${arch} (${(sz / 1e6).toFixed(1)}MB)`);
              }
            }
          }
        }
      }
    }

    // 2. Strip nested duplicate ONNX in @xenova/transformers/node_modules
    const xenovaNestedNm = path.join(nmDir, "@xenova", "transformers", "node_modules");
    for (const pkg of ["onnxruntime-node", "onnxruntime-web", "onnxruntime-common"]) {
      const nested = path.join(xenovaNestedNm, pkg);
      if (fs.existsSync(nested)) {
        const sz = sizeOf(nested);
        rmDir(nested);
        savedBytes += sz;
        console.log(`[afterPack] Removed @xenova nested ${pkg} (${(sz / 1e6).toFixed(1)}MB)`);
      }
    }

    // 3. Remove source maps (.map) from bundled modules
    for (const pkg of [
      "onnxruntime-web",
      "@xenova/transformers",
      "@huggingface/transformers",
      "kokoro-js",
    ]) {
      const pkgDist = path.join(nmDir, pkg, "dist");
      if (fs.existsSync(pkgDist)) {
        removeMatchingFiles(pkgDist, (name) => name.endsWith(".map"));
      }
    }

    // 4. Remove redundant WASM variants from onnxruntime-web
    //    Keep only ort-wasm-simd-threaded.jsep.wasm (the main one used)
    const ortWebDist = path.join(nmDir, "onnxruntime-web", "dist");
    if (fs.existsSync(ortWebDist)) {
      const keepWasm = "ort-wasm-simd-threaded.jsep.wasm";
      removeMatchingFiles(ortWebDist, (name) => {
        return name.endsWith(".wasm") && name !== keepWasm;
      });
    }

    // 5. Remove redundant WASM variants from @xenova/transformers/dist
    const xenovaDist = path.join(nmDir, "@xenova", "transformers", "dist");
    if (fs.existsSync(xenovaDist)) {
      // Keep only ort-wasm-simd-threaded.wasm (used by @xenova)
      const keepWasm = "ort-wasm-simd-threaded.wasm";
      removeMatchingFiles(xenovaDist, (name) => {
        return name.endsWith(".wasm") && name !== keepWasm;
      });
    }

    // 6. Remove redundant WASM from @huggingface/transformers/dist
    const hfDist = path.join(nmDir, "@huggingface", "transformers", "dist");
    if (fs.existsSync(hfDist)) {
      const keepWasm = "ort-wasm-simd-threaded.jsep.wasm";
      removeMatchingFiles(hfDist, (name) => {
        return name.endsWith(".wasm") && name !== keepWasm;
      });
    }
  }

  console.log(`[afterPack] Total estimated savings: ${(savedBytes / 1e6).toFixed(0)}MB`);
};
