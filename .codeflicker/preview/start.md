# claudeprog 启动指南

## 项目概述
该仓库当前可直接启动的服务位于 `designer-platform/`，是一个基于 Express 的本地设计师平台。
服务启动后会以 `designer-platform` 目录作为静态资源目录，对外提供页面访问与相关接口能力。

## designer-platform - designer-platform

### 快速启动

```bash
cd designer-platform
npm start
```

**启动后访问**：http://localhost:3000

可直接访问的页面示例：
- http://localhost:3000/
- http://localhost:3000/uicheck.html
- http://localhost:3000/prd.html
- http://localhost:3000/edgecase.html
- http://localhost:3000/lowfi.html
- http://localhost:3000/builder.html

```yaml
subProjectPath: designer-platform
command: npm start
cwd: designer-platform
port: 3000
previewUrl: http://localhost:3000
description: 基于 Express 的本地设计师平台，启动后提供多个静态页面和分析接口。
```
