# Design Pilot - 设计走查平台

AI 驱动的 UI 走查工具，对比开发截图和设计稿截图，输出正式问题和疑似问题。

## 启动步骤

### 1. 安装依赖

```bash
cd designer-platform
npm install
```

### 2. 启动服务

```bash
npm start
```

启动成功后会看到：`设计师平台运行中: http://localhost:3000/`

### 3. 打开浏览器

访问 http://localhost:3000/uicheck.html 即可开始走查。

## 功能说明

- **uicheck** — UI 走查（对比开发稿和设计稿）
- **pageType** — 可选 C端/B端模式，B端针对管理后台、数据看板等页面
- **视觉模型** — 支持 Kimi K2.5、Claude、GPT 5.4、Gemini

## 注意事项

- 需要本地安装 CodeFlicker（或兼容 CLI）来调用 AI 模型
- `node_modules/` 不要手动复制，请用 `npm install` 安装
- 上传的截图文件在 `inputs/` 目录，每次走查会自动清理旧文件