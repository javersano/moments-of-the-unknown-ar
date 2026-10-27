"""Make a fake phone-camera clip (y4m) that walks past several artworks.

    python3 test/make-camera.py out.y4m ref1.jpg ref2.jpg ...

Each artwork gets ~4 s: drift in, hold with hand-shake and slow tilt, drift out,
with a second of bare wall in between. Chrome plays the y4m as its camera via
--use-file-for-fake-video-capture.
"""
import sys, math
import cv2
import numpy as np

W, H, FPS = 480, 640, 15
SEG, GAP = float(__import__("os").environ.get("SEG", 4.0)), 1.0


def place(img, fill, yaw, pitch, roll, cx, cy):
    h, w = img.shape[:2]
    pw = fill * W
    ph = pw * h / w
    pts = []
    for x, y in [(-pw / 2, -ph / 2), (pw / 2, -ph / 2), (pw / 2, ph / 2), (-pw / 2, ph / 2)]:
        s = (1 + 0.5 * math.sin(yaw) * x / (pw / 2)) * (1 + 0.5 * math.sin(pitch) * y / (ph / 2))
        xx, yy = x * s * math.cos(yaw), y * s * math.cos(pitch)
        pts.append([cx + xx * math.cos(roll) - yy * math.sin(roll), cy + xx * math.sin(roll) + yy * math.cos(roll)])
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), np.float32(pts))
    return M


def frame(img, t, rng):
    wall = np.full((H, W, 3), (232, 230, 226), np.float32)
    if img is None:
        return wall
    # t in [0,1] across the segment
    enter = min(1, t / 0.2); leave = min(1, (1 - t) / 0.2)
    k = min(enter, leave)
    cx = W / 2 + (1 - k) * (W * 1.1) * (-1 if t < 0.5 else 1) + 6 * math.sin(t * 37)
    cy = H * 0.45 + 5 * math.cos(t * 29)
    fill = 0.72 + 0.18 * math.sin(t * math.pi)
    yaw = math.radians(-18 + 30 * t)
    pitch = math.radians(8 * math.sin(t * 5))
    roll = math.radians(3 * math.sin(t * 7))
    M = place(img, fill, yaw, pitch, roll, cx, cy)
    warped = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_AREA).astype(np.float32)
    mask = cv2.warpPerspective(np.ones(img.shape[:2], np.float32), M, (W, H))[..., None]
    out = wall * (1 - mask) + warped * mask
    yy, xx = np.mgrid[0:H, 0:W]
    out *= (1 - 0.25 * np.clip(np.hypot(xx - W * 0.6, yy + H * 0.1) / H, 0, 1))[..., None]
    out += rng.normal(0, 3, out.shape)
    return np.clip(out, 0, 255)


def main():
    out, refs = sys.argv[1], sys.argv[2:]
    imgs = [cv2.resize(cv2.imread(r), None, fx=0.6, fy=0.6, interpolation=cv2.INTER_AREA) for r in refs]
    rng = np.random.default_rng(0)
    timeline = []
    for img in imgs:
        timeline += [(None, 0)] * int(GAP * FPS)
        n = int(SEG * FPS)
        timeline += [(img, i / (n - 1)) for i in range(n)]
    timeline += [(None, 0)] * int(GAP * FPS)
    with open(out, 'wb') as f:
        f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
        for img, t in timeline:
            fr = frame(img, t, rng).astype(np.uint8)
            yuv = cv2.cvtColor(fr, cv2.COLOR_BGR2YUV_I420)
            f.write(b'FRAME\n'); f.write(yuv.tobytes())
    print(f'{out}: {len(timeline)} frames, {len(timeline) / FPS:.1f}s')


if __name__ == '__main__':
    main()
