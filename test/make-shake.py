"""Handheld-phone test clip with ground truth, for measuring how steady the film sits.

    python3 test/make-shake.py out.y4m painting.jpg [--fps 30] [--play-fps 30]

Writes out.y4m (Chrome plays it as the camera) and out.json (the painting's true
corners in every frame). Each frame carries its own number as a 12-bit barcode
in the top-left corner, so the bench knows exactly which frame the engine saw
and can run the engine on the clip's own clock even when headless Chrome is slow.

Timeline (seconds, at --fps):
  0.0-1.5  bare wall
  1.5-7.5  held still: slow sway (~1.5 Hz) + fine tremor (~9 Hz), a few px
  7.5-10.5 slow look-around: pan, tilt and step closer
  10.5-12  quick flick sideways and back
  12-14    held still again
"""
import argparse, json, math
import cv2
import numpy as np

W, H = 480, 640
BITS, BX, BY, BW, BH = 12, 4, 2, 10, 7


def quad(w, h, fill, yaw, pitch, roll, cx, cy):
    pw = fill * W
    ph = pw * h / w
    pts = []
    for x, y in [(-pw / 2, -ph / 2), (pw / 2, -ph / 2), (pw / 2, ph / 2), (-pw / 2, ph / 2)]:
        s = (1 + 0.5 * math.sin(yaw) * x / (pw / 2)) * (1 + 0.5 * math.sin(pitch) * y / (ph / 2))
        xx, yy = x * s * math.cos(yaw), y * s * math.cos(pitch)
        pts.append([cx + xx * math.cos(roll) - yy * math.sin(roll), cy + xx * math.sin(roll) + yy * math.cos(roll)])
    return np.float32(pts)


def smoothstep(a, b, t):
    x = min(1, max(0, (t - a) / (b - a)))
    return x * x * (3 - 2 * x)


SHAKE = 1.0


def pose(t):
    """Painting placement at time t (s), or None for bare wall."""
    if t < 1.5:
        return None
    sway_x = 2.5 * math.sin(2 * math.pi * 1.4 * t) + 1.2 * math.sin(2 * math.pi * 0.6 * t + 1)
    sway_y = 2.0 * math.sin(2 * math.pi * 1.1 * t + 2) + 1.0 * math.sin(2 * math.pi * 0.5 * t)
    trem_x = 0.6 * math.sin(2 * math.pi * 9.0 * t) + 0.4 * math.sin(2 * math.pi * 11.3 * t + 1)
    trem_y = 0.6 * math.sin(2 * math.pi * 8.2 * t + 0.5)
    cx, cy = W / 2 + SHAKE * (sway_x + trem_x), H * 0.47 + SHAKE * (sway_y + trem_y)
    fill, yaw, pitch = 0.74, math.radians(12), math.radians(4)
    roll = math.radians(0.4 * math.sin(2 * math.pi * 1.2 * t))
    # slow look-around 7.5-10.5
    k = smoothstep(7.5, 9.0, t) - smoothstep(9.0, 10.5, t)
    cx += -70 * k
    cy += 25 * k
    yaw += math.radians(18) * k
    fill *= 1 + 0.12 * k
    # quick flick 10.5-12: 150 px away and back in about a second
    f = smoothstep(10.5, 11.0, t) - smoothstep(11.2, 11.8, t)
    cx += 150 * f
    return fill, yaw, pitch, roll, cx, cy


def barcode(img, n):
    for b in range(BITS):
        v = 255 if (n >> b) & 1 else 0
        img[BY:BY + BH, BX + b * BW:BX + (b + 1) * BW] = v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out'); ap.add_argument('painting')
    ap.add_argument('--fps', type=float, default=30, help='content frame rate (the clip\'s own clock)')
    ap.add_argument('--play-fps', type=int, default=30, help='rate Chrome plays it at (lower it for slow headless runs)')
    ap.add_argument('--seconds', type=float, default=14)
    ap.add_argument('--noise', type=float, default=2.5)
    ap.add_argument('--gap', default='', help='a,b: the painting leaves the frame between these seconds')
    ap.add_argument('--hard', action='store_true', help='gallery light: dimmer, noisier, JPEG-compressed, shakier')
    a = ap.parse_args()
    global SHAKE
    if a.hard:
        a.noise = max(a.noise, 6)
        SHAKE = 1.8

    src = cv2.imread(a.painting)
    scale = 900 / max(src.shape[:2])
    src = cv2.resize(src, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    h, w = src.shape[:2]
    rng = np.random.default_rng(1)
    yy, xx = np.mgrid[0:H, 0:W]
    vignette = (1 - 0.22 * np.clip(np.hypot(xx - W * 0.6, yy + H * 0.1) / H, 0, 1))[..., None]
    n = int(a.seconds * a.fps)
    truth = []
    with open(a.out, 'wb') as fh:
        fh.write(f'YUV4MPEG2 W{W} H{H} F{a.play_fps}:1 Ip A1:1 C420jpeg\n'.encode())
        prev = None
        for i in range(n):
            t = i / a.fps
            p = pose(t)
            if a.gap and float(a.gap.split(',')[0]) <= t < float(a.gap.split(',')[1]):
                p = None
            img = np.full((H, W, 3), (228, 226, 222), np.float32)
            if p:
                q = quad(w, h, *p)
                M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), q)
                warped = cv2.warpPerspective(src, M, (W, H), flags=cv2.INTER_LINEAR).astype(np.float32)
                mask = cv2.warpPerspective(np.ones((h, w), np.float32), M, (W, H))[..., None]
                img = img * (1 - mask) + warped * mask
                truth.append(q.reshape(-1).round(3).tolist())
                # motion blur along the movement, like a phone camera
                if prev is not None:
                    d = float(np.mean(q - prev, axis=0)[0])
                    if abs(d) > 1.5:
                        k = int(min(15, abs(d)))
                        ker = np.zeros((1, k), np.float32); ker[0, :] = 1 / k
                        img = cv2.filter2D(img, -1, ker)
                prev = q
            else:
                truth.append(None); prev = None
            img = cv2.GaussianBlur(img, (0, 0), 0.9 if a.hard else 0.6)
            if a.hard:
                img = img * 0.72 + 18 + 4 * math.sin(2 * math.pi * 0.7 * t)  # dim room, exposure breathing
            img = img * vignette + rng.normal(0, a.noise, img.shape)
            img = np.clip(img, 0, 255).astype(np.uint8)
            if a.hard:
                img = cv2.imdecode(cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 35])[1], cv2.IMREAD_COLOR)
            barcode(img, i)
            yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV_I420)
            fh.write(b'FRAME\n'); fh.write(yuv.tobytes())
    with open(a.out.rsplit('.', 1)[0] + '.json', 'w') as fh:
        json.dump({'fps': a.fps, 'width': W, 'height': H, 'barcode': [BITS, BX, BY, BW, BH], 'corners': truth}, fh)
    print(f'{a.out}: {n} frames, playing at {a.play_fps} fps')


if __name__ == '__main__':
    main()
