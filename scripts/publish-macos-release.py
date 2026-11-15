#!/usr/bin/env python3
import os
import sys
import glob
import paramiko

HOST = "47.120.26.227"
USER = "root"
PASS = "Rjc_lihui0817"

LOCAL_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MACOS_BUNDLE_DIR = os.path.join(LOCAL_BASE, "release", "macos")
REMOTE_DOWNLOADS = "/var/www/aireadcode/server/static/downloads"


def progress_callback(transferred, total):
    percent = (transferred / total) * 100 if total else 100
    mb_trans = transferred / (1024 * 1024)
    mb_tot = total / (1024 * 1024)
    sys.stdout.write(f"\r    Uploading DMG: {mb_trans:.2f}MB / {mb_tot:.2f}MB ({percent:.1f}%)")
    sys.stdout.flush()


def main():
    print("=" * 60)
    print("  DeepAutoCode 官方发布：已签名 & 公证 macOS 客户端安装包")
    print("=" * 60)

    dmg_files = glob.glob(os.path.join(MACOS_BUNDLE_DIR, "*.dmg"))
    if not dmg_files:
        print("[!] 错误: 未找到本地生成的 DMG 安装包!")
        sys.exit(1)

    local_dmg = dmg_files[0]
    dmg_size_mb = os.path.getsize(local_dmg) / (1024 * 1024)
    print(f"[+] 找到本地安装包: {local_dmg} ({dmg_size_mb:.2f} MB)")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=20)
    sftp = client.open_sftp()

    dmg_name = os.path.basename(local_dmg)
    remote_dmg = f"{REMOTE_DOWNLOADS}/{dmg_name}"
    sftp.put(local_dmg, remote_dmg, callback=progress_callback)
    print("\n[+] DMG 上传完毕！")

    client.exec_command(f"cd {REMOTE_DOWNLOADS} && ln -sf {dmg_name} DeepAutoCode.dmg && chmod 644 DeepAutoCode*")
    sftp.close()
    client.close()
    print("  下载直达链接: https://www.aireadcode.com/downloads/DeepAutoCode.dmg")


if __name__ == "__main__":
    main()

