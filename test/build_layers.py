"""
Slice the beach image into depth layers using the depth map.

Strategy: each pixel is assigned to a depth slab by its depth value.
- Layer 0 = farthest = the full original image (acts as the complete backdrop).
- Layers 1..N-1 = each successive near depth slab with the rest transparent.
- Alpha edges are feathered with a small Gaussian blur so seams don't show
  as hard cuts in the A-Frame composite.
"""
import os
from PIL import Image, ImageFilter
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'layers')
os.makedirs(OUT_DIR, exist_ok=True)

img = Image.open(os.path.join(HERE, 'image.jpg')).convert('RGB')
depth = Image.open(os.path.join(HERE, 'depth.jpg')).convert('L')
if depth.size != img.size:
    depth = depth.resize(img.size, Image.LANCZOS)

# Also produce a high-detail 8-bit depth from the 16-bit disparity map.
# Disparity convention matches depth.jpg: bright = near, dark = far.
# Normalize across the actual value range so the full 0..255 byte is used.
disp_path = os.path.join(HERE, 'pf_disparity.png')
if os.path.exists(disp_path):
    disp = np.array(Image.open(disp_path)).astype(np.float32)
    lo, hi = float(disp.min()), float(disp.max())
    disp_norm = ((disp - lo) / (hi - lo) * 255.0).clip(0, 255).astype(np.uint8)
    Image.fromarray(disp_norm).save(os.path.join(HERE, 'depth_hd.png'))
    print(f'depth_hd.png written  raw range {int(lo)}-{int(hi)}  unique={len(np.unique(disp_norm))}')

img_arr = np.array(img)              # H, W, 3
depth_arr = np.array(depth)           # H, W   bright = near, dark = far

N = 5
bounds = np.percentile(depth_arr, np.linspace(0, 100, N + 1))
print(f'Depth percentile bounds (far -> near): {[int(b) for b in bounds]}')

for i in range(N):
    if i == 0:
        # Farthest layer = full opaque backdrop.
        alpha = np.full(depth_arr.shape, 255, dtype=np.uint8)
    else:
        lo, hi = bounds[i], bounds[i + 1]
        if i == N - 1:
            m = (depth_arr >= lo) & (depth_arr <= hi)
        else:
            m = (depth_arr >= lo) & (depth_arr < hi)
        alpha = (m * 255).astype(np.uint8)
        alpha = np.array(
            Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(2.0))
        )

    layer = np.dstack([img_arr, alpha])
    out = os.path.join(OUT_DIR, f'layer_{i}.png')
    Image.fromarray(layer).save(out)
    print(f'  layer_{i}.png  visible_px={(alpha > 8).sum()}')

print('Done.')
