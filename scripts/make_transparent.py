"""Convert the white-background OmniDesk logo to a transparent-background PNG."""
import sys
from PIL import Image, ImageFilter


def white_to_transparent(src_path, dst_path, fuzz=60):
    img = Image.open(src_path).convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            # White-to-transparent: make near-white pixels fully transparent
            if r > 255 - fuzz - 1 and g > 255 - fuzz - 1 and b > 255 - fuzz - 1:
                px[x, y] = (r, g, b, 0)
            else:
                # Soften jagged edge: scale alpha of light-blue fringe slightly
                brightness = (r + g + b) / 3
                if brightness > 220:
                    px[x, y] = (r, g, b, max(0, int(255 - (brightness - 220))))
    # Faint halo cleanup to avoid white rim
    img = img.filter(ImageFilter.SMOOTH_MORE)
    img.save(dst_path, "PNG")
    print(f"Saved transparent PNG -> {dst_path}")


if __name__ == "__main__":
    white_to_transparent(sys.argv[1], sys.argv[2])