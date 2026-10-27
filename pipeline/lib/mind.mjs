// Run MindAR's image-target internals in Node (pure-JS CPU backend).
import * as tf from '@tensorflow/tfjs';
import '../../node_modules/mind-ar/src/image-target/detector/kernels/cpu/index.js';
export { Detector } from '../../node_modules/mind-ar/src/image-target/detector/detector.js';
export { buildImageList, buildTrackingImageList } from '../../node_modules/mind-ar/src/image-target/image-list.js';
export { build as buildCluster } from '../../node_modules/mind-ar/src/image-target/matching/hierarchical-clustering.js';
export { extractTrackingFeatures } from '../../node_modules/mind-ar/src/image-target/tracker/extract-utils.js';
export { Matcher } from '../../node_modules/mind-ar/src/image-target/matching/matcher.js';
export { Estimator } from '../../node_modules/mind-ar/src/image-target/estimation/estimator.js';
export { tf };
await tf.setBackend('cpu');
