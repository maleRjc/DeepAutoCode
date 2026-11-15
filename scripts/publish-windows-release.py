#!/usr/bin/env python3
import os
import sys
import glob
import json
import time
import subprocess
import urllib.request
import urllib.error
import paramiko

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HOST = "47.120.26.227"
USER = "root"
PASS = "Rjc_lihui0817"

GITHUB_REPO = "maleRjc/DeepAutoCode"
TAG_NAME = "v1.1.0"
RELEASE_NAME = "DeepAutoCode v1.1.0 — Signed Windows Release"

LOCAL_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE_DIR = os.path.join(LOCAL_BASE, "release", "bundle", "nsis")

REMOTE_DOWNLOADS = "/var/www/aireadcode/server/static/downloads"
REMOTE_BUILD_DOWNLOADS = "/var/www/aireadcode/build/static/downloads"


def progress_callback(transferred, total):
    percent = (transferred / total) * 100 if total else 100
    mb_transferred = transferred / (1024 * 1024)
    mb_total = total / (1024 * 1024)
    sys.stdout.write(f"\r    Uploading: {mb_transferred:.2f}MB / {mb_total:.2f}MB ({percent:.1f}%)")
    sys.stdout.flush()


def get_github_token():
    env_tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env_tok:
        return env_tok.strip()
    try:
        proc = subprocess.run(
            ["git", "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True,
            text=True,
            timeout=10,
        )
        for line in proc.stdout.splitlines():
            if line.startswith("password="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def publish_to_github_release(files_to_upload):
    token = get_github_token()
    if not token:
        print("[!] 未检测到 GitHub 凭据，跳过 GitHub Releases 上传。")
        return None

    print(f"\n[*] 正在发布至 GitHub Releases ({GITHUB_REPO} @ {TAG_NAME})...")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "DeepAutoCode-Release-Publisher",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # Ensure tag is pushed or release exists
    release_obj = None
    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{TAG_NAME}",
        headers=headers,
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            release_obj = json.loads(resp.read().decode("utf-8"))
            print(f"[+] 找到已存在的 GitHub Release: {release_obj.get('html_url')}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            body_md = (
                "### DeepAutoCode v1.1.0 — 开源 AI 自动编码 IDE (Signed Windows Release)\n\n"
                "- **Windows 安装包 (Authenticode 数字签名)**:\n"
                "  - `DeepAutoCode-Setup-v1.1.0.exe` (NSIS 安装程序，含桌面与开始菜单快捷方式)\n"
                "  - `DeepAutoCode_1.1.0_x64-setup.exe`\n"
                "- **数字签名信息**:\n"
                "  - Signer: `CN=武汉定点网络技术有限责任公司, O=武汉定点网络技术有限责任公司, L=武汉市, S=湖北省, C=CN`\n"
                "  - Timestamp: `Sectigo RSA Time Stamping Signer`\n"
                "- **核心特性**:\n"
                "  - 多模型能力矩阵 (DeepSeek V3/R1 128K、GLM-4 工具描述自适应、OpenAI o1/o3/o4)\n"
                "  - 4 层渐进式容错 Patch & 智能编辑引擎\n"
                "  - CodeMode Node VM 内存沙箱 & 持久化 PTY 终端\n"
                "  - Git Worktree 沙箱隔离 & WAL 追加式会话存储\n"
                "  - SSH 远程开发与隧道管理\n"
                "  - Repro-first TDD 自主闭环、Reflexion 回溯剪枝、崩溃轨迹诊断器\n"
            )
            payload = json.dumps({
                "tag_name": TAG_NAME,
                "target_commitish": "main",
                "name": RELEASE_NAME,
                "body": body_md,
                "draft": False,
                "prerelease": False,
            }).encode("utf-8")
            create_req = urllib.request.Request(
                f"https://api.github.com/repos/{GITHUB_REPO}/releases",
                data=payload,
                headers={**headers, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(create_req, timeout=30) as resp:
                release_obj = json.loads(resp.read().decode("utf-8"))
                print(f"[+] 已创建 GitHub Release: {release_obj.get('html_url')}")
        else:
            raise

    release_id = release_obj["id"]
    existing_assets = {a["name"]: a["id"] for a in release_obj.get("assets", [])}

    for file_path in files_to_upload:
        fname = os.path.basename(file_path)
        if fname in existing_assets:
            del_req = urllib.request.Request(
                f"https://api.github.com/repos/{GITHUB_REPO}/releases/assets/{existing_assets[fname]}",
                headers=headers,
                method="DELETE",
            )
            try:
                urllib.request.urlopen(del_req, timeout=20).close()
            except Exception:
                pass

        fsize = os.path.getsize(file_path)
        print(f"[*] 正在上传资产到 GitHub Release: {fname} ({fsize / (1024*1024):.2f} MB)...")
        upload_url = f"https://uploads.github.com/repos/{GITHUB_REPO}/releases/{release_id}/assets?name={fname}"
        with open(file_path, "rb") as f:
            data = f.read()
        up_req = urllib.request.Request(
            upload_url,
            data=data,
            headers={
                **headers,
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(data)),
            },
            method="POST",
        )
        with urllib.request.urlopen(up_req, timeout=300) as resp:
            asset_info = json.loads(resp.read().decode("utf-8"))
            print(f"[+] GitHub Release 资产上传成功: {asset_info.get('browser_download_url')}")

    return release_obj.get("html_url")


def publish_release():
    print("=" * 65)
    print("  DeepAutoCode 官方发布：已签名 Windows 客户端安装包")
    print("=" * 65)

    exe_v1 = os.path.join(BUNDLE_DIR, "DeepAutoCode-Setup-v1.1.0.exe")
    exe_std = os.path.join(BUNDLE_DIR, "DeepAutoCode_1.1.0_x64-setup.exe")

    if not os.path.exists(exe_v1):
        print(f"[!] 错误: 未找到本地 EXE 安装包: {exe_v1}")
        sys.exit(1)

    exe_size = os.path.getsize(exe_v1)
    print(f"[+] 本地已签名安装包: {os.path.basename(exe_v1)} ({exe_size / (1024*1024):.2f} MB)")

    # 1. 发布到 GitHub Releases
    files_for_gh = [exe_v1]
    if os.path.exists(exe_std):
        files_for_gh.append(exe_std)
    try:
        gh_url = publish_to_github_release(files_for_gh)
    except Exception as e:
        print(f"[!] GitHub Releases 上传告警: {e}")
        gh_url = None

    # 2. 上传到官方下载服务器
    print(f"\n[*] 正在连接远端下载服务器 {HOST}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=25)
    sftp = client.open_sftp()
    print("[+] 远端服务器连接成功！")

    for d in [REMOTE_DOWNLOADS, REMOTE_BUILD_DOWNLOADS]:
        try:
            sftp.stat(d)
        except IOError:
            sftp.mkdir(d)

    remote_exe_v1 = f"{REMOTE_DOWNLOADS}/DeepAutoCode-Setup-v1.1.0.exe"
    remote_exe_std = f"{REMOTE_DOWNLOADS}/DeepAutoCode_1.1.0_x64-setup.exe"
    remote_exe_latest = f"{REMOTE_DOWNLOADS}/DeepAutoCode-Setup-latest.exe"

    print(f"\n[*] 正在上传签名后的 EXE 安装包 -> {remote_exe_v1}")
    sftp.put(exe_v1, remote_exe_v1, callback=progress_callback)
    print("\n[+] EXE (v1.1.0) 上传完毕！")

    print("\n[*] 创建标准化别名软链接与 latest 链接...")
    cmds = [
        f"ln -sf {remote_exe_v1} {remote_exe_std}",
        f"ln -sf {remote_exe_v1} {remote_exe_latest}",
        f"cp -f {remote_exe_v1} {REMOTE_BUILD_DOWNLOADS}/DeepAutoCode-Setup-v1.1.0.exe 2>/dev/null || true",
        f"ln -sf {REMOTE_BUILD_DOWNLOADS}/DeepAutoCode-Setup-v1.1.0.exe {REMOTE_BUILD_DOWNLOADS}/DeepAutoCode-Setup-latest.exe 2>/dev/null || true",
        f"chmod 644 {REMOTE_DOWNLOADS}/DeepAutoCode*",
    ]
    for cmd in cmds:
        _stdin, stdout, _stderr = client.exec_command(cmd)
        stdout.channel.recv_exit_status()

    sftp.close()

    print("\n[*] 进行线上真实 HTTP 校验...")
    endpoints = [
        "/downloads/DeepAutoCode-Setup-v1.1.0.exe",
        "/downloads/DeepAutoCode-Setup-latest.exe",
        "/downloads/DeepAutoCode_1.1.0_x64-setup.exe",
    ]
    for ep in endpoints:
        stdin, stdout, stderr = client.exec_command(
            f"curl -sI https://www.aireadcode.com{ep} | grep -E 'HTTP/|content-length|last-modified'"
        )
        info = stdout.read().decode("utf-8", errors="replace").strip()
        print(f"\n  -> 验证 https://www.aireadcode.com{ep} :\n     " + "\n     ".join(info.splitlines()))

    client.close()
    print("\n" + "=" * 65)
    print("[SUCCESS] 签名版 DeepAutoCode Windows 客户端已成功打包、签名并上传！")
    if gh_url:
        print(f"  GitHub Release: {gh_url}")
    print("  直达下载链接:   https://www.aireadcode.com/downloads/DeepAutoCode-Setup-v1.1.0.exe")
    print("=" * 65)


if __name__ == "__main__":
    publish_release()

