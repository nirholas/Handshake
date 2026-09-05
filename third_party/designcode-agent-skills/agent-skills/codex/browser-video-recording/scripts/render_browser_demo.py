#!/usr/bin/env python3
"""Render a browser screenshot sequence with a macOS-style cursor and zoom."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image


SWIFT_CURSOR_CAPTURE = r'''
import AppKit
import CoreGraphics
import Foundation

final class CaptureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    let outputDirectory: String
    let captureX: CGFloat = 360
    let captureY: CGFloat = 300
    let captureSize: CGFloat = 280
    var step = 0

    init(outputDirectory: String) {
        self.outputDirectory = outputDirectory
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.main else { NSApp.terminate(nil); return }
        let window = NSWindow(
            contentRect: screen.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.ignoresMouseEvents = true
        window.isOpaque = true
        window.backgroundColor = NSColor(calibratedRed: 0, green: 1, blue: 0, alpha: 1)
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        CGWarpMouseCursorPosition(CGPoint(x: captureX, y: captureY))
        CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            self.captureCurrentBackground()
        }
    }

    func captureCurrentBackground() {
        let filename = step == 0 ? "cursor-green.png" : "cursor-magenta.png"
        let output = URL(fileURLWithPath: outputDirectory).appendingPathComponent(filename).path
        let originX = Int(captureX - captureSize / 2)
        let originY = Int(captureY - captureSize / 2)
        let rect = "\(originX),\(originY),\(Int(captureSize)),\(Int(captureSize))"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-C", "-x", "-R", rect, output]
        try? process.run()
        process.waitUntilExit()
        if step == 0 {
            step = 1
            window?.backgroundColor = NSColor(calibratedRed: 1, green: 0, blue: 1, alpha: 1)
            CGWarpMouseCursorPosition(CGPoint(x: captureX, y: captureY))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.captureCurrentBackground()
            }
        } else {
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
let delegate = CaptureDelegate(outputDirectory: CommandLine.arguments[1])
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
'''


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - (2.0 * value))


def ease_out(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return 1.0 - ((1.0 - value) ** 3)


def ease_out_back(value: float) -> float:
    value = max(0.0, min(1.0, value))
    c1 = 1.28
    c3 = c1 + 1.0
    return 1.0 + c3 * ((value - 1.0) ** 3) + c1 * ((value - 1.0) ** 2)


def interpolate(keys: list[list[float]], time_s: float) -> tuple[float, ...]:
    if not keys:
        raise ValueError("Expected at least one keyframe")
    for index in range(len(keys) - 1):
        start = keys[index]
        end = keys[index + 1]
        if time_s <= end[0]:
            span = max(1e-6, end[0] - start[0])
            amount = smoothstep((time_s - start[0]) / span)
            return tuple(start[i] + (end[i] - start[i]) * amount for i in range(1, len(start)))
    return tuple(keys[-1][1:])


def normalize_scene(entry: Any) -> tuple[float, str, str]:
    if isinstance(entry, dict):
        return (float(entry["time"]), str(entry["shot"]), str(entry.get("transition", "fade")))
    return (float(entry[0]), str(entry[1]), str(entry[2] if len(entry) > 2 else "fade"))


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_template() -> None:
    template = {
        "duration": 20,
        "fps": 60,
        "output_size": [3840, 2880],
        "source_size": [1920, 1440],
        "cursor_scale": 3.0,
        "click_strength": 15,
        "rotation_strength_degrees": 8,
        "shots": {
            "top": "/tmp/capture/01-results-top.png",
            "detail": "/tmp/capture/02-after-card-click.png",
        },
        "scene_starts": [
            [0.0, "top", "fade"],
            [2.3, "detail", "fade"],
        ],
        "cursor_keys": [
            [0.0, 620, 48],
            [1.4, 1450, 530],
            [2.1, 1450, 530],
        ],
        "camera_keys": [
            [0.0, 960, 540, 1.0],
            [2.3, 960, 560, 1.1],
        ],
        "click_times": [2.1],
        "output": "/tmp/browser-demo-4x3-4k-60fps.mp4",
    }
    print(json.dumps(template, indent=2))


def matte_cursor(green_path: Path, magenta_path: Path, output_dir: Path) -> tuple[Path, tuple[float, float]]:
    green = Image.open(green_path).convert("RGB")
    magenta = Image.open(magenta_path).convert("RGB")
    width, height = green.size
    background_a = tuple(float(value) for value in green.getpixel((0, 0)))
    background_b = tuple(float(value) for value in magenta.getpixel((0, 0)))
    output = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    green_pixels = green.load()
    magenta_pixels = magenta.load()
    output_pixels = output.load()

    for y in range(height):
        for x in range(width):
            ga = green_pixels[x, y]
            mb = magenta_pixels[x, y]
            ratios = []
            for channel in range(3):
                denominator = background_a[channel] - background_b[channel]
                if abs(denominator) > 4:
                    ratios.append((ga[channel] - mb[channel]) / denominator)
            if not ratios:
                continue
            ratios.sort()
            one_minus_alpha = max(0.0, min(1.0, ratios[len(ratios) // 2]))
            alpha = 1.0 - one_minus_alpha
            if alpha < 0.025:
                continue
            rgb = []
            for channel in range(3):
                value = (ga[channel] - (1.0 - alpha) * background_a[channel]) / alpha
                rgb.append(max(0, min(255, int(round(value)))))
            output_pixels[x, y] = (*rgb, max(0, min(255, int(round(alpha * 255)))))

    bounds = output.getchannel("A").getbbox()
    if not bounds:
        raise RuntimeError("Could not extract cursor alpha")
    padding = 8
    left = max(0, bounds[0] - padding)
    top = max(0, bounds[1] - padding)
    right = min(width, bounds[2] + padding)
    bottom = min(height, bounds[3] + padding)
    cropped = output.crop((left, top, right, bottom))
    hotspot = ((width / 2.0) - left, (height / 2.0) - top)
    cursor_path = output_dir / "macos-compositor-cursor.png"
    cropped.save(cursor_path)
    return cursor_path, hotspot


def extract_macos_cursor(output_dir: Path) -> tuple[Path, tuple[float, float]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["swift", "-", str(output_dir)],
        input=SWIFT_CURSOR_CAPTURE,
        text=True,
        check=True,
    )
    green_path = output_dir / "cursor-green.png"
    magenta_path = output_dir / "cursor-magenta.png"
    if not green_path.exists() or not magenta_path.exists():
        raise RuntimeError("screencapture did not create cursor matte sources")
    return matte_cursor(green_path, magenta_path, output_dir)


def load_cursor(config: dict[str, Any], temp_dir: Path) -> tuple[Image.Image, tuple[float, float]]:
    if config.get("cursor_asset"):
        cursor_path = Path(config["cursor_asset"]).expanduser()
        cursor = Image.open(cursor_path).convert("RGBA")
        hotspot = tuple(float(value) for value in config.get("cursor_hotspot", [0, 0]))
        return cursor, (hotspot[0], hotspot[1])
    cursor_path, hotspot = extract_macos_cursor(temp_dir)
    return Image.open(cursor_path).convert("RGBA"), hotspot


def click_scale(time_s: float, click_times: list[float], strength: float) -> float:
    elapsed = None
    for click_time in click_times:
        candidate = time_s - click_time
        if 0 <= candidate <= 0.28:
            elapsed = candidate
            break
    if elapsed is None:
        return 1.0
    dip = max(0.0, min(100.0, strength)) / 100.0
    overshoot = dip * 0.22
    if elapsed <= 0.08:
        return 1.0 - (dip * ease_out(elapsed / 0.08))
    if elapsed <= 0.19:
        progress = (elapsed - 0.08) / 0.11
        return (1.0 - dip) + ((dip + overshoot) * ease_out_back(progress))
    progress = (elapsed - 0.19) / 0.09
    return 1.0 + (overshoot * (1.0 - smoothstep(progress)))


def scene_at(
    time_s: float,
    scenes: list[tuple[float, str, str]],
    shots: dict[str, Image.Image],
    source_size: tuple[int, int],
) -> Image.Image:
    index = 0
    for candidate_index, scene in enumerate(scenes):
        if time_s >= scene[0]:
            index = candidate_index
        else:
            break
    start, name, transition = scenes[index]
    current = shots[name]
    if index == 0:
        return current

    previous = shots[scenes[index - 1][1]]
    fade_duration = 0.48 if transition == "scroll" else 0.18
    elapsed = time_s - start
    if elapsed >= fade_duration:
        return current
    amount = smoothstep(elapsed / fade_duration)
    if transition == "scroll":
        width, height = source_size
        offset = int((1.0 - amount) * height * 0.08)
        previous_canvas = Image.new("RGB", (width, height), (255, 255, 255))
        current_canvas = Image.new("RGB", (width, height), (255, 255, 255))
        previous_canvas.paste(previous, (0, -offset))
        current_canvas.paste(current, (0, offset))
        return Image.blend(previous_canvas, current_canvas, amount)
    return Image.blend(previous, current, amount)


def crop_camera(
    image: Image.Image,
    camera: tuple[float, float, float],
    source_size: tuple[int, int],
    output_size: tuple[int, int],
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    source_w, source_h = source_size
    output_w, output_h = output_size
    camera_x, camera_y, zoom = camera
    crop_w = int(source_w / max(1e-6, zoom))
    crop_h = int(source_h / max(1e-6, zoom))
    left = int(max(0, min(source_w - crop_w, camera_x - (crop_w / 2))))
    top = int(max(0, min(source_h - crop_h, camera_y - (crop_h / 2))))
    crop = image.crop((left, top, left + crop_w, top + crop_h))
    frame = crop.resize((output_w, output_h), Image.Resampling.LANCZOS).convert("RGBA")
    return frame, (left, top, crop_w, crop_h)


def draw_cursor(
    frame: Image.Image,
    cursor: Image.Image,
    hotspot: tuple[float, float],
    cursor_xy: tuple[float, float],
    crop_info: tuple[int, int, int, int],
    output_size: tuple[int, int],
    time_s: float,
    previous_cursor_x: float,
    delta_time: float,
    config: dict[str, Any],
) -> Image.Image:
    output_w, output_h = output_size
    left, top, crop_w, crop_h = crop_info
    source_x, source_y = cursor_xy
    screen_x = (source_x - left) / crop_w * output_w
    screen_y = (source_y - top) / crop_h * output_h
    if screen_x < -500 or screen_x > output_w + 500 or screen_y < -500 or screen_y > output_h + 500:
        return frame

    click_times = [float(value) for value in config.get("click_times", [])]
    base_scale = float(config.get("cursor_scale", 3.0))
    strength = float(config.get("click_strength", 15.0))
    scale = base_scale * click_scale(time_s, click_times, strength)
    cursor_w = max(1, int(round(cursor.width * scale)))
    cursor_h = max(1, int(round(cursor.height * scale)))
    rendered_cursor = cursor.resize((cursor_w, cursor_h), Image.Resampling.LANCZOS)

    rotation_strength = math.radians(float(config.get("rotation_strength_degrees", 8.0)))
    velocity_x = (source_x - previous_cursor_x) / max(1e-6, delta_time)
    velocity_progress = min(1.0, abs(velocity_x) / 1400.0) ** 0.72
    angle = (1 if velocity_x >= 0 else -1) * rotation_strength * velocity_progress

    hotspot_x = hotspot[0] * scale
    hotspot_y = hotspot[1] * scale
    if abs(angle) > 0.002:
        padding = int(max(cursor_w, cursor_h) * 0.45)
        padded = Image.new("RGBA", (cursor_w + padding * 2, cursor_h + padding * 2), (0, 0, 0, 0))
        padded.alpha_composite(rendered_cursor, (padding, padding))
        rendered_cursor = padded.rotate(math.degrees(angle), resample=Image.Resampling.BICUBIC, expand=True)
        local_hotspot_x = hotspot_x + padding
        local_hotspot_y = hotspot_y + padding
        center_x = padded.width / 2.0
        center_y = padded.height / 2.0
        dx = local_hotspot_x - center_x
        dy = local_hotspot_y - center_y
        cos_a = math.cos(-angle)
        sin_a = math.sin(-angle)
        hotspot_x = (rendered_cursor.width / 2.0) + (dx * cos_a) - (dy * sin_a)
        hotspot_y = (rendered_cursor.height / 2.0) + (dx * sin_a) + (dy * cos_a)

    paste_x = int(round(screen_x - hotspot_x))
    paste_y = int(round(screen_y - hotspot_y))
    frame.alpha_composite(rendered_cursor, (paste_x, paste_y))
    return frame


def render(config: dict[str, Any], output_path: Path) -> None:
    source_size = tuple(int(value) for value in config.get("source_size", [1920, 1440]))
    output_size = tuple(int(value) for value in config.get("output_size", [3840, 2880]))
    fps = int(config.get("fps", 60))
    duration = float(config.get("duration", 20.0))
    total_frames = int(round(duration * fps))
    shots = {name: Image.open(path).convert("RGB") for name, path in config["shots"].items()}
    scenes = [normalize_scene(entry) for entry in config["scene_starts"]]
    scenes.sort(key=lambda item: item[0])
    cursor_keys = [[float(value) for value in key] for key in config["cursor_keys"]]
    camera_keys = [[float(value) for value in key] for key in config["camera_keys"]]

    with tempfile.TemporaryDirectory(prefix="browser-video-recording-") as temp:
        cursor, hotspot = load_cursor(config, Path(temp))
        command = [
            "ffmpeg", "-y",
            "-f", "rawvideo",
            "-pix_fmt", "rgb24",
            "-s:v", f"{output_size[0]}x{output_size[1]}",
            "-r", str(fps),
            "-i", "-",
            "-an",
            "-c:v", "libx264",
            "-preset", str(config.get("preset", "veryfast")),
            "-crf", str(config.get("crf", 18)),
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(output_path),
        ]
        process = subprocess.Popen(command, stdin=subprocess.PIPE)
        previous_cursor_x = cursor_keys[0][1]
        previous_time = 0.0
        assert process.stdin is not None
        try:
            for frame_index in range(total_frames):
                time_s = frame_index / fps
                base = scene_at(time_s, scenes, shots, source_size)
                camera = interpolate(camera_keys, time_s)
                frame, crop_info = crop_camera(base, camera, source_size, output_size)
                cursor_xy = interpolate(cursor_keys, time_s)
                delta_time = max(1.0 / fps, time_s - previous_time)
                frame = draw_cursor(
                    frame,
                    cursor,
                    hotspot,
                    cursor_xy,
                    crop_info,
                    output_size,
                    time_s,
                    previous_cursor_x,
                    delta_time,
                    config,
                )
                process.stdin.write(frame.convert("RGB").tobytes())
                previous_cursor_x = cursor_xy[0]
                previous_time = time_s
        finally:
            process.stdin.close()
        exit_code = process.wait()
        if exit_code != 0:
            raise RuntimeError(f"ffmpeg failed with exit code {exit_code}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="JSON render config")
    parser.add_argument("--output", type=Path, help="MP4 output path")
    parser.add_argument("--write-template", action="store_true", help="Print a starter JSON config")
    args = parser.parse_args()

    if args.write_template:
        write_template()
        return 0
    if not args.config:
        parser.error("--config is required unless --write-template is used")

    config = load_config(args.config)
    output_path = args.output or Path(config.get("output", "browser-demo-4x3-4k-60fps.mp4"))
    render(config, output_path.expanduser())
    print(output_path.expanduser())
    return 0


if __name__ == "__main__":
    sys.exit(main())
