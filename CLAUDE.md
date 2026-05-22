# ClaudeProg - 设计师 AI 工具集

## 设计师平台

当用户说"启动设计师平台"、"打开走查"、"我要用UI走查"等意图时，按以下步骤操作：

1. **检测依赖**：依次检查 `node`、`python -c "from PIL import Image"`
2. **如果任何依赖缺失**：运行 `cd designer-platform && npm install`
3. **启动服务**：在 `designer-platform/` 目录下运行 `node server.js`
4. **告知用户**：浏览器访问 http://localhost:3000

如果用户说"安装依赖"、"初始化环境"等，直接运行 `cd designer-platform && npm install`

### 页面地址

| 功能 | 地址 |
|------|------|
| UI 走查 | http://localhost:3000 （自动跳转 uicheck.html） |