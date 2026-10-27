// MindAR imports all of '@tensorflow/tfjs' (layers, converter, data...).
// It only needs the core ops + WebGL backend, so the viewer build aliases
// '@tensorflow/tfjs' to this file (see vite.config.js): ~25% smaller bundle.
export * from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-core/dist/public/chained_ops/register_all_chained_ops';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
