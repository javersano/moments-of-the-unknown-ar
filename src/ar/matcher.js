// MindAR's keyframe matcher, extended for angle-trained targets.
//
// Identical to mind-ar/src/image-target/matching/matcher.js except for one thing:
// a keyframe rendered from an oblique viewpoint (see pipeline/lib/views.mjs)
// stores its points in its own warped pixel space plus `toWorld`, a homography
// back to the artwork. World coordinates for pose estimation go through it, so
// a lock found on a side view still pins the film to the real canvas plane.
// vite.config.js swaps this file in for MindAR's own (also inside its worker).
import { match } from 'mind-ar/src/image-target/matching/matching.js';

function toWorld(kf, x, y) {
  if (kf.toWorld) {
    const H = kf.toWorld;
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  return [x / kf.scale, y / kf.scale];
}

class Matcher {
  constructor(queryWidth, queryHeight, debugMode = false) {
    this.queryWidth = queryWidth;
    this.queryHeight = queryHeight;
    this.debugMode = debugMode;
  }

  matchDetection(keyframes, featurePoints) {
    const debugExtra = { frames: [] };
    let best = null;
    for (let i = 0; i < keyframes.length; i++) {
      const { H, matches, debugExtra: d } = match({
        keyframe: keyframes[i], querypoints: featurePoints,
        querywidth: this.queryWidth, queryheight: this.queryHeight, debugMode: this.debugMode,
      });
      debugExtra.frames.push(d);
      if (H && (best === null || best.matches.length < matches.length)) best = { keyframeIndex: i, H, matches };
    }
    if (best === null) return { keyframeIndex: -1, debugExtra };

    const kf = keyframes[best.keyframeIndex];
    const screenCoords = [], worldCoords = [];
    for (const { querypoint, keypoint } of best.matches) {
      screenCoords.push({ x: querypoint.x, y: querypoint.y });
      const [x, y] = toWorld(kf, keypoint.x + 0.5, keypoint.y + 0.5);
      worldCoords.push({ x, y, z: 0 });
    }
    return { screenCoords, worldCoords, keyframeIndex: best.keyframeIndex, debugExtra };
  }
}

export { Matcher };
