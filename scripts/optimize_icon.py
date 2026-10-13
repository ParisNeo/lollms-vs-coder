import os
import sys

def optimize_icon():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icon_path = os.path.join(repo_root, "media", "icon.png")

    if not os.path.exists(icon_path):
        print(f"Error: Icon not found at {icon_path}", file=sys.stderr)
        sys.exit(1)

    initial_size_kb = os.path.getsize(icon_path) / 1024.0
    print(f"Current icon size: {initial_size_kb:.2f} KB")

    try:
        from PIL import Image
    except ImportError:
        print("Pillow is not installed in the active environment.", file=sys.stderr)
        print("Install via: pip install pillow, or run scripts/optimize_icon.ps1 instead.", file=sys.stderr)
        sys.exit(1)

    with Image.open(icon_path) as img:
        img_rgba = img.convert("RGBA")
        target_dimensions = (256, 256)
        resample_filter = getattr(Image, "Resampling", Image).LANCZOS
        resized = img_rgba.resize(target_dimensions, resample_filter)
        resized.save(icon_path, format="PNG", optimize=True)

    final_size_kb = os.path.getsize(icon_path) / 1024.0
    print(f"Optimized icon saved: {target_dimensions[0]}x{target_dimensions[1]} px, {final_size_kb:.2f} KB")

    if final_size_kb < 1024.0:
        print("Success: Icon satisfies the Visual Studio Marketplace size requirement (< 1024 KB).")
    else:
        print("Warning: Icon size still exceeds 1024 KB.", file=sys.stderr)

if __name__ == "__main__":
    optimize_icon()