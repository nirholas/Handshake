"""
Build the inpainted backdrop image that sits behind the foreground depth-mesh.

The mesh's UV-space discard punches holes at character silhouettes; the backdrop
mesh provides clean pixels visible through those holes.

Approach:
  1. Detect horizon row from the depth map (steepest sky->ground gradient).
  2. Build a character mask = mid-depth band, dilated.
  3. SKY portion of mask (above horizon): cv2.inpaint with NS algorithm — works
     well here because clean sky surrounds the masked pixels.
  4. GROUND portion (below horizon): per-row HORIZONTAL linear extrapolation —
     lerp between the nearest unmasked pixels left and right on the same row.
     This avoids the vertical "shower curtain" streaks that single-pass
     OpenCV inpainting produces when the mask covers most of the lower half.
"""
import os
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
img = cv2.imread(os.path.join(HERE, 'image.jpg'))            # BGR HxWx3
depth = np.array(Image.open(os.path.join(HERE, 'depth_hd.png')).convert('L'))
H, W = img.shape[:2]

# --- Horizon row ---
row_means = depth.astype(np.float32).mean(axis=1)
row_smooth = np.convolve(row_means, np.ones(20) / 20.0, mode='same')
horizon_y = int(np.argmax(np.gradient(row_smooth)))
print(f'horizon row: {horizon_y} / {H}')

# --- Character mask ---
char_mask = ((depth > 40) & (depth < 215)).astype(np.uint8) * 255
char_mask = cv2.dilate(char_mask, np.ones((5, 5), np.uint8), iterations=2)

band = 25
sky_mask = char_mask.copy()
sky_mask[horizon_y + band:] = 0
gnd_mask = char_mask.copy()
gnd_mask[:horizon_y - band] = 0
print(f'sky-mask px: {int((sky_mask > 0).sum())}   '
      f'ground-mask px: {int((gnd_mask > 0).sum())}')

# --- Sky pass: standard NS inpaint ---
out = cv2.inpaint(img, sky_mask, 12, cv2.INPAINT_NS)

# --- Ground pass: per-row horizontal linear extrapolation ---
# For each row, find runs of masked pixels and lerp between the unmasked
# pixels immediately left and right of the run. Falls back to the one side
# that exists when the run is anchored to an edge.
def horizontal_lerp_fill(img_in, mask):
    out_img = img_in.copy()
    H_, W_ = mask.shape[:2]
    for y in range(H_):
        row = mask[y] > 0
        if not row.any():
            continue
        # Boundary deltas: +1 entering a run, -1 leaving
        d = np.diff(row.astype(np.int8), prepend=0, append=0)
        starts = np.where(d == 1)[0]
        ends = np.where(d == -1)[0] - 1
        for s, e in zip(starts, ends):
            lx, rx = s - 1, e + 1
            width = e - s + 1
            if lx < 0 and rx >= W_:
                continue  # entire row masked -> leave as inpaint-pass result
            if lx < 0:
                out_img[y, s:e + 1] = img_in[y, rx]
                continue
            if rx >= W_:
                out_img[y, s:e + 1] = img_in[y, lx]
                continue
            left = img_in[y, lx].astype(np.float32)
            right = img_in[y, rx].astype(np.float32)
            # t in (0,1) over the run width, exclusive of the endpoints
            t = (np.arange(1, width + 1) / (width + 1))[:, None]
            out_img[y, s:e + 1] = (left * (1.0 - t) + right * t).astype(np.uint8)
    return out_img

out = horizontal_lerp_fill(out, gnd_mask)

# Light vertical blur on the ground band only so the per-row lerps don't read
# as scanlines when viewed from extreme angles.
y0, y1 = max(0, horizon_y - band), H
strip = out[y0:y1].copy()
strip = cv2.GaussianBlur(strip, (1, 9), 0)
out[y0:y1] = strip

dst = os.path.join(HERE, 'image_inpainted.jpg')
cv2.imwrite(dst, out, [cv2.IMWRITE_JPEG_QUALITY, 92])
print(f'wrote {dst}')
