#!/usr/bin/env python3
"""
GIF to WebM Converter for Stickers and Emojis
Converts GIF files to WebM format meeting strict requirements for messaging platforms.
"""

import subprocess
import tempfile
import sys
import os
import argparse
import json
from pathlib import Path

def check_ffmpeg():
    """Check if FFmpeg is installed and accessible."""
    try:
        subprocess.run(['ffmpeg', '-version'], 
                      stdout=subprocess.DEVNULL, 
                      stderr=subprocess.DEVNULL, 
                      check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False

def get_video_info(file_path):
    """Get video information using ffprobe."""
    try:
        cmd = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json',
            '-show_format', '-show_streams', file_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return None

def crop_filter(crop):
    """FFmpeg filter for crop = (x, y, w, h) as fractions of the frame; even sizes, as yuv420p needs.
    The +0.01 absorbs float error (576 px sent as 0.53333 of 1080 is 575.996) without ever exceeding the frame."""
    x, y, w, h = crop
    return (f"crop=trunc(iw*{w:.6f}/2+0.01)*2:trunc(ih*{h:.6f}/2+0.01)*2"
            f":trunc(iw*{x:.6f}+0.01):trunc(ih*{y:.6f}+0.01)")

def calculate_scale_filter(width, height, mode='sticker'):
    """
    Calculate the scale filter based on mode and aspect ratio.
    
    Args:
        width (int): Original width
        height (int): Original height
        mode (str): 'sticker' or 'emoji'
    
    Returns:
        str: FFmpeg scale filter
    """
    if mode == 'emoji':
        return "scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:black@0"
    
    # Sticker mode: one side must be 512px, other 512px or less
    aspect_ratio = width / height
    
    if width >= height:
        # Wider than tall - make width 512
        return "scale=512:-2"
    else:
        # Taller than wide - make height 512
        return "scale=-2:512"

def _even(v):
    return max(2, int(round(v / 2)) * 2)

def sticker_layout(width, height, mode='sticker', square=False, size=1.0, x=0.5, y=0.5):
    """
    Where the content goes in the sticker: (canvas_w, canvas_h, content_w, content_h, left, top).

    The canvas is 100 x 100 for emoji; for stickers 512 x 512 (square) or the content's shape with its longer
    side 512 (tight) — either way one side is exactly 512, as Telegram requires. The content is fitted into
    size (0.2…1) of the canvas and placed at x, y (0 = left/top, 1 = right/bottom); the rest stays transparent.
    Telegram shows every sticker inside the same square, so transparent space makes the content look smaller
    and moves it within the bubble.
    """
    if mode == 'emoji':
        cw = ch = 100
    elif square:
        cw = ch = 512
    elif width >= height:
        cw, ch = 512, _even(512 * height / width)
    else:
        cw, ch = _even(512 * width / height), 512
    scale = min(cw * size / width, ch * size / height)
    w, h = min(cw, _even(width * scale)), min(ch, _even(height * scale))
    return cw, ch, w, h, int(round((cw - w) * x / 2)) * 2, int(round((ch - h) * y / 2)) * 2

def layout_filter(width, height, mode='sticker', **layout):
    """FFmpeg filters for sticker_layout: scale the content, then pad it with transparency to the canvas."""
    cw, ch, w, h, left, top = sticker_layout(width, height, mode, **layout)
    scaled = f"scale={w}:{h}:flags=lanczos"
    if (w, h) == (cw, ch):
        return scaled
    return f"{scaled},format=yuva420p,pad={cw}:{ch}:{left}:{top}:color=black@0"

def convert_gif_to_webm(input_path, output_path=None, mode='sticker', max_size_kb=256, progress=None,
                        start=0.0, end=None, pingpong=False, crop=None, layout=None):
    """
    Convert GIF (or a video such as an OBS .mkv) to WebM meeting strict requirements.
    
    Args:
        input_path (str): Path to input GIF or video file
        output_path (str, optional): Path for output WebM file
        mode (str): 'sticker' or 'emoji'
        max_size_kb (int): Maximum file size in KB
        progress (callable, optional): progress(attempt, attempts, fraction), called while encoding
        start, end (float, optional): only use this part of the input, in seconds
        pingpong (bool): play the part forward, then backwards
        crop (tuple, optional): (x, y, w, h) as fractions of the frame, cut out before scaling
        layout (dict, optional): sticker_layout options (square, size, x, y); default: tight, full size
    
    Returns:
        bool: True if conversion successful, False otherwise
    """
    
    # Validate input file
    if not os.path.isfile(input_path):
        print(f"Error: Input file '{input_path}' does not exist.")
        return False
    
    # Get video information
    video_info = get_video_info(input_path)
    if not video_info:
        print(f"Error: Could not get video information from '{input_path}'")
        return False
    
    # Find video stream
    video_stream = None
    for stream in video_info.get('streams', []):
        if stream.get('codec_type') == 'video':
            video_stream = stream
            break
    
    if not video_stream:
        print(f"Error: No video stream found in '{input_path}'")
        return False
    
    width = int(video_stream.get('width', 0))
    height = int(video_stream.get('height', 0))
    duration = float(video_info.get('format', {}).get('duration', 0))
    
    print(f"Original: {width}x{height}, {duration:.2f}s")
    
    # Generate output path if not provided
    if output_path is None:
        input_file = Path(input_path)
        suffix = '_emoji' if mode == 'emoji' else '_sticker'
        output_path = input_file.with_name(f"{input_file.stem}{suffix}.webm")
    
    # Calculate scale filter from the cropped size (the size ffmpeg's crop gives, see crop_filter)
    if crop:
        width, height = 2 * int(width * crop[2] / 2 + 0.01), 2 * int(height * crop[3] / 2 + 0.01)
    if mode == 'preview':
        scale_filter = calculate_scale_filter(width, height, mode)
    else:
        scale_filter = layout_filter(width, height, mode, **(layout or {}))
    
    # Build video filters
    filters = [crop_filter(crop), scale_filter] if crop else [scale_filter]
    
    # Limit FPS to 30
    source_fps = eval(video_stream.get('r_frame_rate', '30/1'))
    if source_fps > 30:
        filters.append("fps=30")

    # Selected part of the input: seek before -i (fast on long videos), forward + reversed copy for ping-pong.
    # Reversing after scaling keeps the buffered frames small.
    start = max(0.0, float(start or 0))
    part = (min(end, duration) if end else duration) - start
    if part <= 0:
        print(f"Error: selection {start:.2f}-{end}s is outside the {duration:.2f}s input")
        return False
    input_trim = ['-ss', f"{start:.3f}", '-t', f"{part:.3f}"] if start > 0 or part < duration else []
    if pingpong:
        filters.append("split[fw][bw];[bw]reverse[rv];[fw][rv]concat=n=2:v=1:a=0")
        part *= 2
    # Limit duration to 3 seconds (except for preview mode)
    if mode == 'preview':
        duration_limit = part
        print(f"🎥 PREVIEW MODE: Preserving full {duration_limit:.2f}s duration")
    else:
        duration_limit = min(part, 3.0)
        print(f"🎬 STICKER MODE: Limiting to {duration_limit:.2f}s")
    
    # Combine filters
    video_filter = ",".join(filters)
    
    # Try different CRF values to meet size requirement
    max_size_bytes = max_size_kb * 1024
    crf_values = [35, 40, 45, 50, 55, 60, 63]  # Start with reasonable quality
    
    for attempt, crf in enumerate(crf_values, 1):
        print(f"Trying CRF {crf}...")
        if progress:
            progress(attempt, len(crf_values), 0.0)
        
        # Build FFmpeg command
        cmd = [
            'ffmpeg',
            *input_trim,
            '-i', input_path,
            '-t', str(duration_limit),      # Limit duration to 3 seconds
            '-c:v', 'libvpx-vp9',           # VP9 codec
            '-crf', str(crf),               # Quality setting
            '-b:v', '0',                    # Use CRF mode
            '-an',                          # Remove audio stream
            '-pix_fmt', 'yuva420p',         # Support transparency
            '-vf', video_filter,            # Video filters
            '-movflags', '+faststart',      # Optimize for streaming
            *(['-g', '10'] if mode == 'preview' else []),  # Frequent keyframes: smooth seeking (ping-pong preview)
            *(['-deadline', 'realtime', '-cpu-used', '8'] if mode == 'preview' else []),  # Fast: previews of long videos
            '-progress', 'pipe:1', '-nostats',  # Machine-readable progress on stdout
            '-f', 'webm',                   # Force WebM format
            '-y',                           # Overwrite output
            str(output_path)
        ]
        
        try:
            # Run conversion, reporting how far ffmpeg is (out_time_us of duration_limit)
            with tempfile.TemporaryFile(mode='w+') as err:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
                for line in proc.stdout:
                    if progress and line.startswith('out_time_us=') and duration_limit > 0:
                        try:
                            done = int(line.split('=', 1)[1]) / 1_000_000 / duration_limit
                        except ValueError:
                            continue
                        progress(attempt, len(crf_values), max(0.0, min(1.0, done)))
                returncode = proc.wait()
                if returncode != 0:
                    err.seek(0)
                    print(f"FFmpeg error: {err.read()}")
                    continue
            
            # Check file size
            if os.path.exists(output_path):
                file_size = os.path.getsize(output_path)
                print(f"Generated file size: {file_size:,} bytes ({file_size/1024:.1f} KB)")
                
                if file_size <= max_size_bytes:
                    # Success! File meets size requirement
                    print(f"✅ Conversion successful!")
                    print(f"📁 Output: {output_path}")
                    print(f"📊 Final size: {file_size:,} bytes ({file_size/1024:.1f} KB)")
                    
                    # Verify output dimensions
                    output_info = get_video_info(output_path)
                    if output_info:
                        for stream in output_info.get('streams', []):
                            if stream.get('codec_type') == 'video':
                                out_width = stream.get('width')
                                out_height = stream.get('height')
                                out_duration = float(output_info.get('format', {}).get('duration', 0))
                                print(f"📏 Final dimensions: {out_width}x{out_height}, {out_duration:.2f}s")
                                break
                    
                    return True
                else:
                    print(f"File too large ({file_size/1024:.1f} KB > {max_size_kb} KB), trying higher CRF...")
                    
        except Exception as e:
            print(f"Error during conversion: {e}")
            continue
    
    print(f"❌ Could not create file under {max_size_kb} KB limit")
    return False

def batch_convert(input_dir, output_dir=None, mode='sticker', max_size_kb=256):
    """
    Convert all GIF files in a directory to WebM.
    
    Args:
        input_dir (str): Directory containing GIF files
        output_dir (str, optional): Output directory for WebM files
        mode (str): 'sticker' or 'emoji'
        max_size_kb (int): Maximum file size in KB
    """
    input_path = Path(input_dir)
    
    if not input_path.is_dir():
        print(f"Error: '{input_dir}' is not a valid directory.")
        return
    
    # Find all GIF files
    gif_files = list(input_path.glob('*.gif')) + list(input_path.glob('*.GIF'))
    
    if not gif_files:
        print(f"No GIF files found in '{input_dir}'")
        return
    
    print(f"Found {len(gif_files)} GIF file(s) to convert in {mode} mode.")
    
    # Set output directory
    if output_dir:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = input_path
    
    # Convert each file
    successful = 0
    for gif_file in gif_files:
        suffix = '_emoji' if mode == 'emoji' else '_sticker'
        output_file = output_path / f"{gif_file.stem}{suffix}.webm"
        
        print(f"\n{'='*60}")
        print(f"Converting: {gif_file.name}")
        
        if convert_gif_to_webm(str(gif_file), str(output_file), mode, max_size_kb):
            successful += 1
    
    print(f"\n🎉 Batch conversion complete: {successful}/{len(gif_files)} files converted successfully.")

def main():
    parser = argparse.ArgumentParser(description='Convert GIF files to WebM for stickers/emojis')
    
    # Input options
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('-i', '--input', help='Input GIF file path')
    group.add_argument('-d', '--directory', help='Directory containing GIF files for batch conversion')
    
    # Output options
    parser.add_argument('-o', '--output', help='Output file/directory path')
    
    # Mode selection
    parser.add_argument('-m', '--mode', choices=['sticker', 'emoji'], default='sticker',
                       help='Conversion mode: sticker (512px max) or emoji (100x100px)')
    
    # Size limit
    parser.add_argument('--max-size', type=int, default=256,
                       help='Maximum file size in KB (default: 256)')
    
    args = parser.parse_args()
    
    # Check if FFmpeg is available
    if not check_ffmpeg():
        print("❌ Error: FFmpeg not found. Please install FFmpeg and ensure it's in your PATH.")
        print("   Download from: https://ffmpeg.org/download.html")
        sys.exit(1)
    
    print("🔧 WebM Converter Settings:")
    print(f"   Mode: {args.mode}")
    print(f"   Max size: {args.max_size} KB")
    print(f"   Format: WebM (VP9, no audio, ≤30fps, ≤3s)")
    if args.mode == 'sticker':
        print(f"   Dimensions: One side 512px, other ≤512px (aspect ratio preserved)")
    else:
        print(f"   Dimensions: Exactly 100x100px")
    print()
    
    # Perform conversion
    if args.input:
        # Single file conversion
        success = convert_gif_to_webm(args.input, args.output, args.mode, args.max_size)
        sys.exit(0 if success else 1)
    else:
        # Batch conversion
        batch_convert(args.directory, args.output, args.mode, args.max_size)

if __name__ == '__main__':
    main()