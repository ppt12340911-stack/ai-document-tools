import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = BASE_DIR / "backend"
DEFAULT_PORT = 1700


def find_available_port(start_port=DEFAULT_PORT, attempts=20):
    for port in range(start_port, start_port + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到可用連接埠，請先關閉其他本機服務後再試。")


def main():
    print("=" * 52)
    print("AI 文件工具平台 - 本機啟動")
    print("=" * 52)

    if not BACKEND_DIR.exists():
        raise RuntimeError(f"找不到 backend 資料夾：{BACKEND_DIR}")

    port = find_available_port()
    url = f"http://127.0.0.1:{port}"

    print(f"專案位置：{BASE_DIR}")
    print(f"啟動網址：{url}")
    print("正在啟動服務，請稍候...")

    env = os.environ.copy()
    process = subprocess.Popen(
        [
            sys.executable,
            "main.py",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=BACKEND_DIR,
        env=env,
    )

    time.sleep(3)
    webbrowser.open(url)

    print("\n系統已啟動。")
    print("關閉此視窗或按 Ctrl+C 可停止服務。")

    try:
        process.wait()
    except KeyboardInterrupt:
        process.terminate()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\n啟動失敗：{exc}")
        input("按 Enter 關閉視窗...")

