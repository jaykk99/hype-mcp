/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Native/binary deps must not be bundled by webpack.
  serverExternalPackages: ["@napi-rs/canvas", "ffmpeg-static", "quickjs-emscripten", "@jitl/quickjs-wasmfile-release-sync", "kokoro-js", "@huggingface/transformers", "onnxruntime-node", "sharp", "phonemizer"],
  // Ship the ffmpeg binary, fonts and WASM with the serverless function.
  outputFileTracingExcludes: { "/api/**": ["./node_modules/@napi-rs/canvas-linux-x64-musl/**", "./node_modules/@jitl/quickjs-wasmfile-debug-*/**", "./node_modules/@jitl/quickjs-wasmfile-release-asyncify/**", "./node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_cuda.so", "./node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_tensorrt.so", "./node_modules/onnxruntime-node/bin/napi-v3/darwin/**", "./node_modules/onnxruntime-node/bin/napi-v3/win32/**", "./node_modules/onnxruntime-node/bin/napi-v3/linux/arm64/**", "./node_modules/onnxruntime-web/**", "./node_modules/@img/sharp-libvips-linuxmusl-x64/**", "./node_modules/@img/sharp-linuxmusl-x64/**"] },
  outputFileTracingIncludes: {
    "/api/mcp": ["./assets/fonts/**", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/@jitl/quickjs-wasmfile-release-sync/**"],
    "/api/v/[token]": ["./assets/fonts/**", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/@jitl/quickjs-wasmfile-release-sync/**"],
    "/api/i/[token]": ["./assets/fonts/**", "./node_modules/@jitl/quickjs-wasmfile-release-sync/**"],
  },
};
