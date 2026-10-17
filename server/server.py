#!/usr/bin/env python3
"""
Flask Server for GIF to WebM Conversion + GIF Editor + Image to Icon Converter
- Keeps existing /api/* endpoints (JSON responses)
- Adds blob-returning endpoints used by the integrated editor:
    * POST /convert/gif-to-webm  -> returns video/webm (preview)
    * POST /edit/trim-gif        -> returns image/gif  (trimmed blob)
    * POST /convert/image-to-icon -> returns image/png (100x100 icon)
- Fixed CORS configuration for converter.piogino.ch
"""

from flask import (
    Flask,
    request,
    jsonify,
    send_file,
)
import tempfile
import os
import subprocess
from pathlib import Path
import uuid
import json
from werkzeug.utils import secure_filename
import threading

# ---- Import conversion helpers (your existing file) ----
try:
    from gif_to_webm import convert_gif_to_webm, check_ffmpeg, get_video_info
    HAS_CONVERTER = True
except ImportError:
    print("Warning: gif_to_webm.py not found. Please ensure it's in the same directory.")
    HAS_CONVERTER = False

app = Flask(__name__)

app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100MB hard limit

# ---- Disable caching for development ----
@app.after_request
def add_no_cache_headers(response):
    """Add headers to prevent browser caching during development."""
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# ---- Storage / validation ----
UPLOAD_FOLDER = 'temp_uploads'
MAX_FILE_SIZE = 100 * 1024 * 1024
ALLOWED_EXTENSIONS = {'gif'}
ALLOWED_IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'ico'}
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def allowed_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def allowed_image_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE_EXTENSIONS

def cleanup_old_files():
    """Remove temp files older than 1 hour."""
    try:
        import time
        now = time.time()
        for fn in os.listdir(UPLOAD_FOLDER):
            p = os.path.join(UPLOAD_FOLDER, fn)
            if os.path.isfile(p) and now - os.path.getctime(p) > 3600:
                os.remove(p)
    except Exception as e:
        print(f"Cleanup warning: {e}")

def run_ffmpeg_command(cmd) -> bool:
    """Run FFmpeg command and return success."""
    try:
        print("Running FFmpeg:", " ".join(cmd))
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300)
        if proc.returncode != 0:
            print("FFmpeg error:", proc.stderr)
            return False
        return True
    except subprocess.TimeoutExpired:
        print("FFmpeg command timed out")
        return False
    except Exception as e:
        print(f"FFmpeg command failed: {e}")
        return False

def convert_to_icon_ffmpeg(input_path, output_path, background='transparent', scaling='contain'):
    """
    Convert image to 100x100 PNG icon using FFmpeg.
    """
    try:
        print(f"🖼️ Converting {os.path.basename(input_path)} to 100x100 PNG icon (background: {background}, scaling: {scaling})")
        
        # Check if input file exists
        if not os.path.exists(input_path):
            print(f"❌ ERROR: Input file does not exist: {input_path}")
            return False
            
        file_size = os.path.getsize(input_path)
        print(f"📁 Input file size: {file_size} bytes")

        if scaling == 'contain':
            # Fit image within 100x100, maintaining aspect ratio, center with padding
            if background == 'transparent':
                # Use the exact same syntax that worked in manual testing
                scale_filter = "scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:color=0x00000000"
                pix_fmt = "rgba"
            elif background == 'white':
                scale_filter = "scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:color=white"
                pix_fmt = "rgb24"
            else:  # black
                scale_filter = "scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2:color=black"
                pix_fmt = "rgb24"
        else:  # cover
            scale_filter = "scale=100:100:force_original_aspect_ratio=increase,crop=100:100"
            pix_fmt = "rgba" if background == 'transparent' else "rgb24"

        # Build FFmpeg command - REMOVED -f png parameter
        cmd = [
            'ffmpeg', '-y',
            '-i', input_path,
            '-vf', scale_filter,
            '-pix_fmt', pix_fmt,
            output_path  # Let FFmpeg auto-detect PNG format from extension
        ]

        print(f"🔧 FFmpeg command: {' '.join(cmd)}")
        return run_ffmpeg_command(cmd)

    except Exception as e:
        print(f"❌ Icon conversion error: {e}")
        return False

@app.route('/debug-test')
def debug_test():
    print("🔥 DEBUG TEST - Server is responding!")
    print(f"🔥 Current working directory: {os.getcwd()}")
    print(f"🔥 Server PID: {os.getpid()}")
    return "Check logs for debug output"

# ---- Simple index with status ----
@app.route('/')
def index():
    ffmpeg_status = "✅ Available" if (HAS_CONVERTER and check_ffmpeg()) else ("❌ Not found" if HAS_CONVERTER else "⚠️ Unknown (converter module missing)")
    converter_status = "✅ Available" if HAS_CONVERTER else "❌ Not found"
    return f"""
    <!DOCTYPE html>
    <html><head><title>GIF to WebM Converter + Editor + Icon Converter API</title></head>
    <body>
        <h1>GIF to WebM Converter + Editor + Icon Converter API</h1>
        <p>Server is running successfully!</p>
        <h2>API Endpoints:</h2>
        <ul>
            <li><strong>POST /api/convert</strong> - Convert GIF to WebM (JSON)</li>
            <li><strong>POST /api/convert-bulk</strong> - Bulk convert GIFs (JSON)</li>
            <li><strong>POST /api/trim-gif</strong> - Trim GIF (JSON)</li>
            <li><strong>POST /convert/gif-to-webm</strong> - Preview WebM blob</li>
            <li><strong>POST /edit/trim-gif</strong> - Trimmed GIF blob</li>
            <li><strong>POST /convert/image-to-icon</strong> - 100x100 PNG icon converter</li>
            <li><strong>GET /api/download/&lt;file_id&gt;</strong> - Download converted files</li>
            <li><strong>GET /api/health</strong> - Health check</li>
        </ul>
        <h2>Requirements Check:</h2>
        <ul>
            <li>FFmpeg: {ffmpeg_status}</li>
            <li>Converter: {converter_status}</li>
            <li>Icon Converter: {ffmpeg_status}</li>
        </ul>
        <h2>CORS Configuration:</h2>
        <ul>
            <li>Allowed Origin: https://converter.piogino.ch (via nginx)</li>
        </ul>
    </body></html>
    """

# ---- Conversion progress ----
# The browser sends a random job id with a conversion and polls /api/progress/<job>.
# Kept in a small file, not in memory: gunicorn runs several workers and the poll may hit another one.
# cleanup_old_files() removes stale progress files with the uploads.

def _progress_path(job):
    try:
        return os.path.join(UPLOAD_FOLDER, f"progress_{uuid.UUID(job)}.json")
    except (ValueError, TypeError, AttributeError):
        return None

def progress_reporter(job):
    """Return a progress(attempt, attempts, fraction) callback for convert_gif_to_webm, or None."""
    path = _progress_path(job)
    if not path:
        return None
    def report(attempt, attempts, fraction):
        tmp = f"{path}.tmp"
        with open(tmp, 'w') as f:
            json.dump({'stage': 'encoding', 'attempt': attempt, 'attempts': attempts,
                       'percent': round(fraction * 100)}, f)
        os.replace(tmp, path)
    return report

@app.route('/api/progress/<job>', methods=['GET', 'OPTIONS'])
def conversion_progress(job):
    path = _progress_path(job)
    if not path:
        return jsonify({'error': 'Invalid job id'}), 400
    try:
        with open(path) as f:
            return jsonify(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return jsonify({'stage': 'waiting'})

# ---- Health ----
@app.route('/api/health', methods=['GET', 'OPTIONS'])
def health_check():
    ffmpeg_ok = check_ffmpeg() if HAS_CONVERTER else False
    return jsonify({
        'status': 'healthy',
        'ffmpeg_available': ffmpeg_ok,
        'converter_available': HAS_CONVERTER,
        'gif_editor_available': ffmpeg_ok,
        'icon_converter_available': ffmpeg_ok
    })

# ====================================================================================
# New endpoints used by the integrated editor (blob responses, match the frontend)
# ====================================================================================

@app.route('/convert/gif-to-webm', methods=['POST', 'OPTIONS'])
def convert_gif_to_webm_preview():
    """
    Returns a WebM BLOB for preview (video/webm).
    Frontend: POST file to this endpoint; expect 200 + WebM body.
    """

    cleanup_old_files()

    try:
        if not HAS_CONVERTER or not check_ffmpeg():
            return jsonify({'error': 'FFmpeg or converter unavailable'}), 500

        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['file']
        if not file.filename or not allowed_file(file.filename):
            return jsonify({'error': 'Only GIF files are allowed'}), 400

        if request.content_length is None or request.content_length > MAX_FILE_SIZE:
            return jsonify({'error': f'File too large. Max {MAX_FILE_SIZE // (1024*1024)}MB'}), 400

        file_id = str(uuid.uuid4())
        secure_name = secure_filename(file.filename)
        in_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_{secure_name}")
        out_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_preview.webm")

        file.save(in_path)

        # Use 'preview' mode; allow generous size for quality
        ok = convert_gif_to_webm(
            input_path=in_path,
            output_path=out_path,
            mode='preview',
            max_size_kb=2048,  # higher cap for preview
            progress=progress_reporter(request.form.get('job'))
        )

        # Clean input
        try:
            os.remove(in_path)
        except:
            pass

        if not ok or not os.path.exists(out_path):
            # Ensure any partial is removed
            try:
                if os.path.exists(out_path): os.remove(out_path)
            except:
                pass
            return jsonify({'error': 'Conversion failed'}), 400

        # Return the WebM blob; schedule deletion
        def _cleanup():
            try:
                os.remove(out_path)
            except:
                pass

        resp = send_file(out_path, mimetype="video/webm", as_attachment=False)
        threading.Timer(30, _cleanup).start()
        return resp

    except Exception as e:
        print("Preview conversion error:", e)
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/edit/trim-gif', methods=['POST', 'OPTIONS'])
def edit_trim_gif_blob():
    """
    Returns a trimmed GIF as a BLOB (image/gif).
    Frontend sends: file, start, end  (seconds). Optionally pingpong=true.
    """

    cleanup_old_files()

    try:
        if not check_ffmpeg():
            return jsonify({'error': 'FFmpeg not found on server'}), 500

        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        f = request.files['file']
        if not f.filename or not allowed_file(f.filename):
            return jsonify({'error': 'Only GIF files are allowed'}), 400

        # Params (front-end used keys: 'start' and 'end' in your integrated JS)
        try:
            start_time = float(request.form.get('start', request.form.get('start_time', 0)))
            end_time = float(request.form.get('end', request.form.get('end_time', 3)))
            ping_pong = str(request.form.get('pingpong', 'false')).lower() == 'true'
        except ValueError:
            return jsonify({'error': 'Invalid time parameters'}), 400

        if start_time < 0 or end_time <= start_time or (end_time - start_time) > 60:
            return jsonify({'error': 'Invalid time range. Must be 0 ≤ start < end ≤ start+60'}), 400

        file_id = str(uuid.uuid4())
        secure_name = secure_filename(f.filename)
        in_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_{secure_name}")
        out_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_trimmed.gif")
        f.save(in_path)

        duration = end_time - start_time

        if ping_pong:
            # SIMPLIFIED PING-PONG: More reliable approach
            temp = os.path.join(UPLOAD_FOLDER, f"{file_id}_temp.gif")
            temp_reversed = os.path.join(UPLOAD_FOLDER, f"{file_id}_reversed.gif")
            
            # Step 1: Trim the original clip
            cmd_trim = [
                'ffmpeg', '-y',
                '-i', in_path,
                '-ss', str(start_time),
                '-t', str(duration),
                temp
            ]
            
            print(f"🔧 Step 1 - Trimming: {' '.join(cmd_trim)}")
            ok = run_ffmpeg_command(cmd_trim)
            
            if ok:
                # Step 2: Create reversed version
                cmd_reverse = [
                    'ffmpeg', '-y',
                    '-i', temp,
                    '-vf', 'reverse',
                    temp_reversed
                ]
                
                print(f"🔧 Step 2 - Reversing: {' '.join(cmd_reverse)}")
                ok = run_ffmpeg_command(cmd_reverse)
                
                if ok:
                    # Step 3: Concatenate forward + reverse with proper palette
                    cmd_concat = [
                        'ffmpeg', '-y',
                        '-i', temp,
                        '-i', temp_reversed,
                        '-filter_complex', 
                        '[0:v][1:v]concat=n=2:v=1:a=0[v];[v]split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
                        out_path
                    ]
                    
                    print(f"🔧 Step 3 - Concatenating: {' '.join(cmd_concat)}")
                    ok = run_ffmpeg_command(cmd_concat)
            
            # Cleanup temp files
            try:
                if os.path.exists(temp): os.remove(temp)
                if os.path.exists(temp_reversed): os.remove(temp_reversed)
            except:
                pass
                
        else:
            # Regular trim (your existing code) - FIX: Actually run the command!
            cmd = [
                'ffmpeg', '-y',
                '-i', in_path,
                '-ss', str(start_time),
                '-t', str(duration),
                '-vf', 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
                out_path
            ]
            print(f"🔧 Regular trim: {' '.join(cmd)}")
            ok = run_ffmpeg_command(cmd)

        try:
            os.remove(in_path)
        except:
            pass

        if not ok or not os.path.exists(out_path):
            try:
                if os.path.exists(out_path): os.remove(out_path)
            except:
                pass
            return jsonify({'error': 'GIF trimming failed'}), 400

        # Return GIF blob; schedule deletion
        def _cleanup():
            try:
                os.remove(out_path)
            except:
                pass

        resp = send_file(out_path, mimetype='image/gif', as_attachment=True,
                         download_name=f"{Path(secure_name).stem}_trimmed_{start_time:.1f}-{end_time:.1f}.gif")
        threading.Timer(60, _cleanup).start()
        return resp

    except Exception as e:
        print("Trim (blob) error:", e)
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/convert/image-to-icon', methods=['POST', 'OPTIONS'])
def convert_image_to_icon():
    """
    Convert any image to a 100x100 PNG icon with transparent background.
    Maintains aspect ratio and centers the image.
    
    Frontend sends: file, background (transparent/white/black), scaling (contain/cover)
    Returns: PNG blob (100x100 pixels)
    """
    cleanup_old_files()

    try:
        if not check_ffmpeg():
            return jsonify({'error': 'FFmpeg not found on server'}), 500

        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        f = request.files['file']
        if not f.filename:
            return jsonify({'error': 'No file selected'}), 400

        # More permissive file type check - let FFmpeg handle format detection
        allowed_types = {
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 
            'image/webp', 'image/bmp', 'image/tiff', 'image/svg+xml',
            'image/x-icon', 'image/vnd.microsoft.icon'
        }
        
        # Check both MIME type and file extension
        file_ext = f.filename.lower().split('.')[-1] if '.' in f.filename else ''
        
        if not (f.content_type in allowed_types or file_ext in ALLOWED_IMAGE_EXTENSIONS):
            return jsonify({'error': f'Unsupported image format. Supported: JPG, PNG, GIF, WebP, BMP, TIFF, SVG, ICO'}), 400

        # Validate file size (10MB limit for images)
        if request.content_length and request.content_length > 10 * 1024 * 1024:
            return jsonify({'error': 'File too large. Maximum size for images: 10MB'}), 400

        # Get conversion options
        background = request.form.get('background', 'transparent')  # transparent, white, black
        scaling = request.form.get('scaling', 'contain')  # contain, cover

        if background not in ['transparent', 'white', 'black']:
            return jsonify({'error': 'Invalid background option'}), 400
        if scaling not in ['contain', 'cover']:
            return jsonify({'error': 'Invalid scaling option'}), 400

        file_id = str(uuid.uuid4())
        secure_name = secure_filename(f.filename)
        in_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_{secure_name}")
        out_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_icon.png")
        
        # Save uploaded file
        f.save(in_path)
        
        # Verify file was saved and is readable
        if not os.path.exists(in_path) or os.path.getsize(in_path) == 0:
            return jsonify({'error': 'Failed to save uploaded file'}), 400

        print(f"🖼️ Converting {secure_name} ({os.path.getsize(in_path)} bytes) to 100x100 PNG icon (background: {background}, scaling: {scaling})")

        # Convert using FFmpeg
        success = convert_to_icon_ffmpeg(in_path, out_path, background, scaling)

        # Cleanup input file
        try:
            os.remove(in_path)
        except:
            pass

        if not success:
            try:
                if os.path.exists(out_path): os.remove(out_path)
            except:
                pass
            return jsonify({'error': 'FFmpeg conversion failed - check server logs for details'}), 400
            
        if not os.path.exists(out_path):
            return jsonify({'error': 'Output file was not created'}), 400
            
        if os.path.getsize(out_path) == 0:
            try:
                os.remove(out_path)
            except:
                pass
            return jsonify({'error': 'Output file is empty'}), 400

        print(f"✅ Icon conversion successful: {os.path.getsize(out_path)} bytes")

        # Return PNG blob
        def _cleanup():
            try:
                os.remove(out_path)
            except:
                pass

        # Generate descriptive filename
        base_name = Path(secure_name).stem
        download_name = f"{base_name}_100x100_icon.png"

        resp = send_file(out_path, 
                        mimetype='image/png', 
                        as_attachment=True,
                        download_name=download_name)
        threading.Timer(60, _cleanup).start()
        return resp

    except Exception as e:
        print(f"Icon conversion endpoint error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': 'Internal server error'}), 500

# ====================================================================================
# Existing JSON endpoints used by your main converter UI (/api/*)
# ====================================================================================

@app.route('/api/convert', methods=['POST', 'OPTIONS'])
def convert_gif():
    """Convert GIF to WebM endpoint (JSON summary)."""

    cleanup_old_files()
    try:
        if not HAS_CONVERTER:
            return jsonify({'error': 'Conversion module not available'}), 500
        if not check_ffmpeg():
            return jsonify({'error': 'FFmpeg not found on server'}), 500

        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400
        if not allowed_file(file.filename):
            return jsonify({'error': 'Only GIF files are allowed'}), 400
        if request.content_length is None or request.content_length > MAX_FILE_SIZE:
            return jsonify({'error': f'File too large. Maximum size: {MAX_FILE_SIZE // (1024*1024)}MB'}), 400

        max_size_kb = int(request.form.get('max_size', 256))
        mode = request.form.get('mode', 'sticker')  # sticker, emoji, or preview
        starting_crf = int(request.form.get('crf', 35))

        if max_size_kb < 64 or max_size_kb > 2048:
            return jsonify({'error': 'Invalid max_size. Must be between 64 and 2048 KB'}), 400
        if mode not in ['sticker', 'emoji', 'preview']:
            return jsonify({'error': 'Invalid mode. Must be "sticker", "emoji", or "preview"'}), 400

        file_id = str(uuid.uuid4())
        secure_name = secure_filename(file.filename)
        input_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_{secure_name}")
        output_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_output.webm")
        file.save(input_path)

        print(f"Converting {input_path} -> {output_path} (mode={mode}, max_size={max_size_kb}KB, crf={starting_crf})")

        original_info = get_video_info(input_path) if HAS_CONVERTER else None
        original_size = os.path.getsize(input_path)

        ok = convert_gif_to_webm(
            input_path=input_path,
            output_path=output_path,
            mode=mode,
            max_size_kb=max_size_kb if mode != 'preview' else 2048,
            progress=progress_reporter(request.form.get('job'))
        )

        if ok and os.path.exists(output_path):
            output_size = os.path.getsize(output_path)
            output_info = get_video_info(output_path) if HAS_CONVERTER else None

            data = {
                'success': True,
                'original_filename': secure_name,
                'output_filename': f"{Path(secure_name).stem}_{mode}.webm",
                'original_size_bytes': original_size,
                'output_size_bytes': output_size,
                'original_size_kb': round(original_size / 1024, 1),
                'output_size_kb': round(output_size / 1024, 1),
                'compression_ratio': round((1 - output_size / original_size) * 100, 1),
                'mode': mode,
                'max_size_kb': max_size_kb,
                'download_id': file_id
            }

            if original_info and 'streams' in original_info:
                for s in original_info['streams']:
                    if s.get('codec_type') == 'video':
                        data['original_width'] = s.get('width')
                        data['original_height'] = s.get('height')
                        data['original_duration'] = float(original_info.get('format', {}).get('duration', 0))
                        break
            if output_info and 'streams' in output_info:
                for s in output_info['streams']:
                    if s.get('codec_type') == 'video':
                        data['output_width'] = s.get('width')
                        data['output_height'] = s.get('height')
                        data['output_duration'] = float(output_info.get('format', {}).get('duration', 0))
                        break

            try: os.remove(input_path)
            except: pass

            return jsonify(data)

        # fail path
        try:
            os.remove(input_path)
            if os.path.exists(output_path): os.remove(output_path)
        except:
            pass
        return jsonify({'success': False, 'error': f'Conversion failed. Could not meet {max_size_kb}KB limit.'}), 400

    except Exception as e:
        print("Conversion error:", e)
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/trim-gif', methods=['POST', 'OPTIONS'])
def trim_gif_json():
    """Trim GIF and return JSON metadata (kept for your original UI)."""

    cleanup_old_files()
    try:
        if not check_ffmpeg():
            return jsonify({'error': 'FFmpeg not found on server'}), 500
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['file']
        if file.filename == '' or not allowed_file(file.filename):
            return jsonify({'error': 'Only GIF files are allowed'}), 400

        try:
            start_time = float(request.form.get('start_time', 0))
            end_time = float(request.form.get('end_time', 3))
            ping_pong = str(request.form.get('pingpong', 'false')).lower() == 'true'
        except ValueError:
            return jsonify({'error': 'Invalid time parameters'}), 400

        if start_time < 0 or end_time <= start_time or (end_time - start_time) > 60:
            return jsonify({'error': 'Invalid time range. Must be 0 ≤ start < end ≤ start+60'}), 400

        file_id = str(uuid.uuid4())
        secure_name = secure_filename(file.filename)
        in_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_{secure_name}")
        out_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_trimmed.gif")
        file.save(in_path)

        duration = end_time - start_time
        cmd = [
            'ffmpeg', '-y',
            '-i', in_path,
            '-ss', str(start_time),
            '-t', str(duration),
            '-vf', 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
            out_path
        ]
        ok = run_ffmpeg_command(cmd)

        if ok and os.path.exists(out_path):
            original_size = os.path.getsize(in_path)
            output_size = os.path.getsize(out_path)
            try: os.remove(in_path)
            except: pass
            return jsonify({
                'success': True,
                'original_filename': secure_name,
                'output_filename': f"{Path(secure_name).stem}_trimmed_{start_time:.1f}s-{end_time:.1f}s.gif",
                'original_size_kb': round(original_size/1024, 1),
                'output_size_kb': round(output_size/1024, 1),
                'start_time': start_time,
                'end_time': end_time,
                'duration': duration,
                'ping_pong': ping_pong,
                'download_id': file_id
            })

        try:
            if os.path.exists(in_path): os.remove(in_path)
            if os.path.exists(out_path): os.remove(out_path)
        except:
            pass
        return jsonify({'success': False, 'error': 'GIF trimming failed'}), 400

    except Exception as e:
        print("Trim (JSON) error:", e)
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/download/<file_id>')
def download_file(file_id):
    """Download converted file (handles both WebM and GIF)."""
    try:
        webm_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_output.webm")
        gif_path  = os.path.join(UPLOAD_FOLDER, f"{file_id}_trimmed.gif")

        if os.path.exists(webm_path):
            file_path = webm_path
            download_name = f"converted_sticker_{file_id[:8]}.webm"
            mimetype = 'video/webm'
        elif os.path.exists(gif_path):
            file_path = gif_path
            download_name = f"trimmed_gif_{file_id[:8]}.gif"
            mimetype = 'image/gif'
        else:
            return jsonify({'error': 'File not found or expired'}), 404

        def _cleanup():
            try: os.remove(file_path)
            except: pass

        resp = send_file(file_path, as_attachment=True, download_name=download_name, mimetype=mimetype)
        threading.Timer(10, _cleanup).start()
        return resp

    except Exception as e:
        print("Download error:", e)
        return jsonify({'error': 'Download failed'}), 500

# ---- Error handlers ----
@app.errorhandler(413)
def too_large(e):
    return jsonify({'error': f'File too large. Maximum size: {MAX_FILE_SIZE // (1024*1024)}MB'}), 413

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Endpoint not found'}), 404

@app.errorhandler(500)
def internal_error(e):
    return jsonify({'error': 'Internal server error'}), 500

# ---- Bulk convert ----
@app.route('/api/convert-bulk', methods=['POST', 'OPTIONS'])
def convert_bulk():

    cleanup_old_files()
    try:
        if not HAS_CONVERTER:
            return jsonify({'error': 'Conversion module not available'}), 500
        if not check_ffmpeg():
            return jsonify({'error': 'FFmpeg not found on server'}), 500

        files = request.files.getlist('files')
        if not files:
            return jsonify({'error': 'No files provided'}), 400

        max_size_kb = int(request.form.get('max_size', 256))
        mode = request.form.get('mode', 'sticker')

        if max_size_kb < 64 or max_size_kb > 2048:
            return jsonify({'error': 'Invalid max_size. Must be between 64 and 2048 KB'}), 400
        if mode not in ['sticker', 'emoji', 'preview']:
            return jsonify({'error': 'Invalid mode. Must be "sticker", "emoji", or "preview"'}), 400

        results, successful, failed = [], 0, 0

        for file in files:
            if not file.filename:
                continue
            if not allowed_file(file.filename):
                results.append({'filename': file.filename, 'success': False, 'error': 'Not a GIF file'})
                failed += 1
                continue

            file_id = str(uuid.uuid4())
            secure_name = secure_filename(file.filename)
            in_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_{secure_name}")
            out_path = os.path.join(UPLOAD_FOLDER, f"{file_id}_output.webm")
            file.save(in_path)

            orig_size = os.path.getsize(in_path)
            ok = convert_gif_to_webm(
                input_path=in_path,
                output_path=out_path,
                mode=mode,
                max_size_kb=max_size_kb
            )

            if ok and os.path.exists(out_path):
                out_size = os.path.getsize(out_path)
                results.append({
                    'filename': secure_name,
                    'success': True,
                    'output_filename': f"{Path(secure_name).stem}_{mode}.webm",
                    'original_size_kb': round(orig_size / 1024, 1),
                    'output_size_kb': round(out_size / 1024, 1),
                    'compression_ratio': round((1 - out_size / orig_size) * 100, 1),
                    'download_id': file_id
                })
                successful += 1
                try: os.remove(in_path)
                except: pass
            else:
                results.append({
                    'filename': secure_name,
                    'success': False,
                    'error': f'Could not compress under {max_size_kb}KB'
                })
                failed += 1
                try:
                    os.remove(in_path)
                    if os.path.exists(out_path): os.remove(out_path)
                except:
                    pass

        return jsonify({'total': len(files), 'successful': successful, 'failed': failed, 'results': results})

    except Exception as e:
        print("Bulk conversion error:", e)
        return jsonify({'error': 'Internal server error'}), 500

# ---- Main ----
if __name__ == '__main__':
    print("🚀 Starting GIF to WebM Converter + Editor + Icon Converter Server...")
    print(f"📁 Upload folder: {os.path.abspath(UPLOAD_FOLDER)}")
    print(f"📊 Max file size: {MAX_FILE_SIZE // (1024*1024)}MB")
    print(f"🔧 FFmpeg available: {check_ffmpeg() if HAS_CONVERTER else 'Unknown'}")
    print(f"🔄 Converter available: {HAS_CONVERTER}")
    print()
    print("🌐 Public blob endpoints:")
    print("    POST https://api.piogino.ch/convert/gif-to-webm")
    print("    POST https://api.piogino.ch/edit/trim-gif")
    print("    POST https://api.piogino.ch/convert/image-to-icon")
    print("🌐 JSON endpoints:")
    print("    POST https://api.piogino.ch/api/convert")
    print("    POST https://api.piogino.ch/api/trim-gif")
    print("    POST https://api.piogino.ch/api/convert-bulk")
    print("    GET  https://api.piogino.ch/api/download/<id>")
    print("🔒 CORS: https://converter.piogino.ch (via nginx)")
    print()
    app.run(debug=False, host='127.0.0.1', port=5000)