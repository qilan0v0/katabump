#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reCAPTCHA 音频识别脚本 (GoogleRecaptchaBypass 移植版)

用法:
    python3 recaptcha_solver.py <音频文件路径>

工作流程:
    1. 读取输入音频文件 (MP3 或 WAV)
    2. 用 pydub 转换为 WAV (如果输入是 MP3)
    3. 用 SpeechRecognition 调用 Google 免费 Web Speech API 识别
    4. 将识别文本输出到 stdout (小写)

依赖: pydub, SpeechRecognition, ffmpeg (系统级)

这是 sarperavci/GoogleRecaptchaBypass 的轻量子进程版本，
专为 Node.js 子进程调用设计 —— 只负责语音识别部分，
浏览器自动化 (点击 checkbox、切换音频模式、下载 mp3、填入答案)
由 Node.js 侧的 freegamehost_renew.js 完成。
"""
import os
import sys
import random

def main():
    if len(sys.argv) < 2:
        print("ERROR: 缺少音频文件路径参数", file=sys.stderr)
        sys.exit(2)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"ERROR: 文件不存在: {audio_path}", file=sys.stderr)
        sys.exit(2)

    # 延迟导入，避免缺少依赖时给出清晰错误
    try:
        import pydub
        import speech_recognition
    except ImportError as e:
        print(f"ERROR: 缺少 Python 依赖 ({e})。请安装: pip3 install pydub SpeechRecognition", file=sys.stderr)
        sys.exit(3)

    temp_dir = os.getenv("TEMP") if os.name == "nt" else "/tmp"
    wav_path = os.path.join(temp_dir, f"recaptcha_{random.randrange(100000, 999999)}.wav")

    try:
        # 如果输入已经是 WAV，直接用；否则用 pydub 从 MP3 转换
        ext = os.path.splitext(audio_path)[1].lower()
        if ext == ".wav":
            wav_to_use = audio_path
        else:
            sound = pydub.AudioSegment.from_file(audio_path)
            sound.export(wav_path, format="wav")
            wav_to_use = wav_path

        recognizer = speech_recognition.Recognizer()
        with speech_recognition.AudioFile(wav_to_use) as source:
            audio = recognizer.record(source)

        # recognize_google 调用 Google 免费 Web Speech API，无需 API Key
        text = recognizer.recognize_google(audio)
        # 输出小写文本 (与原项目保持一致，reCAPTCHA 答案不区分大小写但输入框通常小写)
        sys.stdout.write(text.lower())
        sys.stdout.flush()
        sys.exit(0)
    except speech_recognition.UnknownValueError:
        print("ERROR: 无法识别音频内容", file=sys.stderr)
        sys.exit(1)
    except speech_recognition.RequestError as e:
        print(f"ERROR: 请求 Google 语音识别 API 失败: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except OSError:
                pass

if __name__ == "__main__":
    main()
