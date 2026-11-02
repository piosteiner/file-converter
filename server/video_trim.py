#!/usr/bin/env python3
"""
Video trimming for screen recordings (e.g. OBS .mkv): cut a part out and save it as MP4.
By default the result keeps the source's resolution, frame rate and bitrate; each can be lowered.
"""

import os
import subprocess
import tempfile

from gif_to_webm import get_video_info

DEFAULT_AUDIO_KBPS = 160
COPY_VIDEO_CODECS = {'h264', 'hevc', 'av1'}   # fit an MP4 as they are
COPY_AUDIO_CODECS = {'aac', 'mp3'}


def _fps(rate):
    try:
        num, den = rate.split('/')
        return float(num) / float(den) if float(den) else 0.0
    except (AttributeError, ValueError):
        return 0.0


def describe(path):
    """Summary of a video for the trimmer's settings, or None if it can't be read.
    Matroska files from OBS have no per-stream bit rate, so the video's is the total minus the audio's."""
    info = get_video_info(path)
    if not info:
        return None
    video = next((s for s in info.get('streams', []) if s.get('codec_type') == 'video'), None)
    audio = next((s for s in info.get('streams', []) if s.get('codec_type') == 'audio'), None)
    if not video:
        return None
    fmt = info.get('format', {})
    duration = float(fmt.get('duration') or 0)
    total_kbps = int(fmt.get('bit_rate') or 0) // 1000
    if not total_kbps and duration:
        total_kbps = int(os.path.getsize(path) * 8 / duration / 1000)
    audio_kbps = (int(audio.get('bit_rate') or 0) // 1000 or DEFAULT_AUDIO_KBPS) if audio else 0
    video_kbps = int(video.get('bit_rate') or 0) // 1000 or max(total_kbps - audio_kbps, 100)
    return {
        'width': video.get('width'),
        'height': video.get('height'),
        'fps': round(_fps(video.get('avg_frame_rate')) or _fps(video.get('r_frame_rate')), 3),
        'duration': duration,
        'video_kbps': video_kbps,
        'audio_kbps': audio_kbps,
        'video_codec': video.get('codec_name'),
        'audio_codec': audio.get('codec_name') if audio else None,
    }


def trim_video(input_path, output_base, start, end, copy=False, height=None, fps=None, bitrate_kbps=None,
               keep_audio=True, progress=None):
    """
    Cut start…end (seconds) out of input_path.

    copy=True keeps the encoded streams untouched (no quality loss, fast), but the cut can only begin on a
    keyframe, so it may start up to a few seconds early. Otherwise the part is re-encoded with H.264:
    at the source's bit rate and size by default, or smaller with height / fps / bitrate_kbps.
    Only the first audio track is kept.

    Returns the output path (output_base + '.mp4', or '.mkv' for a copy MP4 can't hold), or None.
    progress(attempt, attempts, fraction) is called while encoding, like convert_gif_to_webm's.
    """
    src = describe(input_path)
    if not src:
        print(f"Error: Could not read video information from '{input_path}'")
        return None
    end = min(end, src['duration']) if src['duration'] else end
    length = end - start
    if length <= 0:
        print(f"Error: selection {start:.2f}-{end:.2f}s is outside the {src['duration']:.2f}s video")
        return None
    audio = keep_audio and src['audio_codec'] is not None
    cmd = ['ffmpeg', '-y', '-ss', f"{start:.3f}", '-i', input_path, '-t', f"{length:.3f}",
           '-map', '0:v:0', *(['-map', '0:a:0'] if audio else [])]

    if copy:
        fits_mp4 = src['video_codec'] in COPY_VIDEO_CODECS and (not audio or src['audio_codec'] in COPY_AUDIO_CODECS)
        output_path = output_base + ('.mp4' if fits_mp4 else '.mkv')
        cmd += ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
        if src['video_codec'] == 'hevc' and fits_mp4:
            cmd += ['-tag:v', 'hvc1']  # Apple players want this tag for HEVC in MP4
    else:
        output_path = output_base + '.mp4'
        filters = []
        if height and src['height'] and height < src['height']:
            filters.append(f"scale=-2:{height}")
        if fps and src['fps'] and fps < src['fps']:
            filters.append(f"fps={fps}")
        cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
        if bitrate_kbps and bitrate_kbps < src['video_kbps']:
            cmd += ['-b:v', f"{bitrate_kbps}k", '-maxrate', f"{bitrate_kbps * 3 // 2}k", '-bufsize', f"{bitrate_kbps * 2}k"]
        else:
            # Same quality as the source: near-transparent CRF, never above the source's bit rate
            cmd += ['-crf', '18', '-maxrate', f"{src['video_kbps']}k", '-bufsize', f"{src['video_kbps']}k"]
        if filters:
            cmd += ['-vf', ','.join(filters)]
        if audio:
            cmd += ['-c:a', 'aac', '-b:a', f"{min(max(src['audio_kbps'], 64), 320)}k"]

    if not audio:
        cmd += ['-an']
    cmd += ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output_path]

    print("Running FFmpeg:", " ".join(cmd))
    if progress:
        progress(1, 1, 0.0)
    try:
        with tempfile.TemporaryFile(mode='w+') as err:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
            for line in proc.stdout:
                if progress and line.startswith('out_time_us='):
                    try:
                        done = int(line.split('=', 1)[1]) / 1_000_000 / length
                    except ValueError:
                        continue
                    progress(1, 1, max(0.0, min(1.0, done)))
            if proc.wait() != 0:
                err.seek(0)
                print(f"FFmpeg error: {err.read()}")
                return None
    except Exception as e:
        print(f"Error during trimming: {e}")
        return None
    return output_path if os.path.exists(output_path) else None
