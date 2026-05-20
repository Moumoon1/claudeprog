# 设计师平台

本地 Web 平台，提供 UI 走查功能。

## 启动前必做

**首次使用必须先安装依赖**，运行：

```bash
bash install.sh
```

脚本全程无交互，自动安装 Node.js、Python3、Pillow、mfcli。node_modules 已预装，通常不需要 npm install。

安装完成后 mfcli 需要登录（交互式），运行 `mfcli` 按提示操作。

## 启动

```bash
node server.js
```

启动后浏览器访问 http://localhost:3000 （自动跳转走查页面）

## 依赖

- Node.js >= 18（install.sh 自动安装）
- Python3 + Pillow（install.sh 自动安装）
- mfcli（install.sh 自动安装，需手动登录）
- npm 依赖: express, multer, sharp（预装在 node_modules）

## 项目结构

```
designer-platform/
├── server.js           # Express 后端，走查 API 和 mfcli 调用
├── uicheck.html        # UI 走查页面
├── install.sh          # 一键安装脚本（全程无交互）
├── node_modules/       # 预装依赖，含双平台 sharp 二进制
├── bundled/.codeflicker/skills/  # 随项目分发的 skills 文件
├── inputs/             # 用户上传文件
├── outputs/            # 输出文件
└── runtime_images/     # 运行时截图
```

## AI 助手行为

当用户说"启动设计师平台"、"我要走查"、"打开走查"时：
1. 先检测依赖：`node -v`、`python3 -c "from PIL import Image"`、`which mfcli`
2. 如果任何依赖缺失，运行 `bash install.sh`（不要跳过、不要手动装）
3. 依赖就绪后，运行 `node server.js` 启动服务
4. 告知用户访问 http://localhost:3000
5. 如果 mfcli 未登录，提示用户另开终端运行 `mfcli` 登录
