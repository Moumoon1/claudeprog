const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const app = express();
const PORT = 3000;
const PROJECT_DIR = path.resolve(__dirname);
const INPUTS_DIR = path.join(PROJECT_DIR, 'inputs');
const PARENT_DIR = path.resolve(PROJECT_DIR, '..');
const CROP_DIR = path.join(INPUTS_DIR, '_crops');

// Ensure directories exist
fs.mkdirSync(INPUTS_DIR, { recursive: true });
fs.mkdirSync(CROP_DIR, { recursive: true });

// Each upload type gets its own sub-directory to prevent cross-contamination
function getInputsDir(type) {
  const dir = path.join(INPUTS_DIR, type);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Clean crop directory before each analysis
function cleanCrops() {
  if (!fs.existsSync(CROP_DIR)) return;
  const files = fs.readdirSync(CROP_DIR);
  for (const f of files) fs.unlinkSync(path.join(CROP_DIR, f));
}

// Parse region marker into crop ratios (y ratio, height ratio) of image height
function parseRegionMarker(marker) {
  const m = marker.toLowerCase().trim();
  // Exact marker matching for reliability
  switch (m) {
    case 'top':       return { y: 0.0,  h: 0.20 };  // 顶部20%
    case 'mid':       return { y: 0.25, h: 0.50 };  // 中部50%
    case 'midtop':    return { y: 0.0,  h: 0.45 };  // 中上部45%
    case 'midbottom': return { y: 0.40, h: 0.45 };  // 中下部45%
    case 'bottom':    return { y: 0.75, h: 0.25 };  // 底部25%
    case 'header':    return { y: 0.0,  h: 0.15 };  // 表头/导航15%
    case 'tab':       return { y: 0.0,  h: 0.12 };  // 标签区12%
    case 'footer':    return { y: 0.80, h: 0.20 };  // 页脚/操作区20%
    default:
      // Fallback: try to extract known keywords
      if (/顶部|top/.test(m)) return { y: 0.0, h: 0.20 };
      if (/底部|bottom|footer/.test(m)) return { y: 0.75, h: 0.25 };
      if (/中下/.test(m)) return { y: 0.40, h: 0.45 };
      if (/中上/.test(m)) return { y: 0.0, h: 0.45 };
      if (/中部|mid/.test(m)) return { y: 0.25, h: 0.50 };
      if (/表头|header/.test(m)) return { y: 0.0, h: 0.15 };
      if (/标签|tab/.test(m)) return { y: 0.0, h: 0.12 };
      // Default: middle of the image
      return { y: 0.25, h: 0.50 };
  }
}

// Crop image region and return data URL
async function cropRegion(imgPath, regionMarker, imgHeight) {
  if (!fs.existsSync(imgPath)) return null;
  const { y, h } = parseRegionMarker(regionMarker);
  const meta = await sharp(imgPath).metadata();

  if (meta.width <= 0 || meta.height <= 0) return null;

  // Convert ratios to pixel coordinates
  let cropY = Math.round(y * meta.height);
  let cropH = Math.round(h * meta.height);

  // Ensure cropH is at least 10% of image height and fits within bounds
  const minH = Math.round(meta.height * 0.1);
  cropH = Math.max(minH, cropH);
  cropH = Math.min(cropH, meta.height - cropY);
  cropY = Math.max(0, Math.min(cropY, meta.height - cropH));

  console.log(`[cropRegion] marker="${regionMarker}" => y=${cropY} h=${cropH} (image ${meta.width}x${meta.height})`);

  return sharp(imgPath)
    .extract({ left: 0, top: cropY, width: meta.width, height: cropH })
    // Keep original width (don't downscale), only limit max height for lightbox
    .resize({ height: 3000, fit: 'inside' })
    .png()
    .toBuffer()
    .then(buf => 'data:image/png;base64,' + buf.toString('base64'))
    .catch(err => {
      console.log(`[cropRegion] error for "${regionMarker}":`, err.message);
      return null;
    });
}

// Parse JSON array from Claude's text output
function parseIssuesFromOutput(text) {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch {}
  }
  const arrMatch = text.match(/\[[\s\S]*"issue"[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }
  return null;
}

// Convert dev_y (0-100 percentage) to crop parameters (y ratio, height ratio)
// Centers a 20% crop window around the given position
function devYToCrop(devY) {
  const y = Math.max(0, Math.min(100, devY || 50));
  const halfH = 12; // crop window is ~24% of image height
  const cropY = Math.max(0, y - halfH);
  return { y: cropY / 100, h: (halfH * 2) / 100 };
}

// Crop from dev_y position — returns a tighter region around the issue
async function cropByDevY(imgPath, devY) {
  if (!fs.existsSync(imgPath) || devY === undefined || devY === null) return null;
  const { y, h } = devYToCrop(devY);
  const meta = await sharp(imgPath).metadata();
  if (meta.width <= 0 || meta.height <= 0) return null;

  const cropY = Math.round(y * meta.height);
  const cropH = Math.max(Math.round(h * meta.height), Math.round(meta.height * 0.1));

  return sharp(imgPath)
    .extract({ left: 0, top: cropY, width: meta.width, height: cropH })
    .resize({ height: 800, fit: 'inside' })
    .png()
    .toBuffer()
    .then(buf => 'data:image/png;base64,' + buf.toString('base64'))
    .catch(() => null);
}

// Parse design spec JSON from step 1 output
function parseDesignSpecFromOutput(text) {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch {}
  }
  const arrMatch = text.match(/\[[\s\S]*"name"[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }
  // Fallback: find any JSON-looking array
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}

// Build step 2 prompt for single-page uicheck (dev comparison against design spec)
function buildUICheckStep2Prompt(designSpec, devPath, bgPath) {
  const specText = designSpec.map(m =>
    (m.order || '') + '. ' + (m.name || '') + '：' + (m.content || '') + '，视觉特征：' + (m.visual || '')
  ).join('\n');

  let prompt = `你是一个资深的设计走查助手。你收到了一份**设计稿的页面结构清单**和一张**开发稿的截图**。

你的任务：拿着设计稿清单，逐项核对开发稿是否还原到位。

## 设计稿的页面结构清单（设计目标）
${specText}

## 开发稿截图（代码实现产物）
图片：@${devPath}

${bgPath ? '## 背景信息\n读取文件：' + bgPath + '\n' : ''}

## 核对维度（只看结构和UI，不看文案）

**A. 模块是否存在**：设计稿中的模块，开发稿中是否缺失或多出？
**B. 模块顺序**：从上到下顺序是否一致？
**C. 视觉重点**：设计稿最想强调的内容，在开发稿中是否还是第一重点？
**D. 模块内部结构**：元素排列（左右/上下/等分）是否一致？
**E. 样式还原**：背景色/卡片色/圆角/阴影/光晕是否有明显偏差？
**F. 按钮/操作元素**：按钮是否存在？大小、圆角、位置是否正确？
**G. 图标**：图标风格是否一致？有无缺失？
**H. 页面节奏**：开发稿是否明显更挤或更散？

## 【铁则】
1. 只基于开发稿截图中实际可见的内容分析，严禁编造不存在的元素
2. **忽略纯文案/文字/数字差异**（按钮文字不同、标题文案不同、数据不同等不报）—— 只看结构、布局、样式
3. 不推测，不要因为"这种页面通常有XX"就报告XX缺失
4. 每个问题必须说明：设计稿期望的是什么、开发稿实际是什么
5. 对问题要具体描述，不能只说"样式不一致"
6. **只报告结构和UI问题**：模块缺失/错位、布局变化、颜色偏差、圆角/阴影差异、按钮大小/位置变化等

## 输出格式
**只输出一个 JSON 数组**，不要任何文字。数组包含所有发现的问题，按严重程度排序（P0→P1→P2）。

\`\`\`json
[
  {"issue": "核心卡片区缺少圆角", "severity": "high", "description": "设计稿期望：圆角16px卡片。开发稿实际：直角卡片。", "dev_y": 45}
]
\`\`\`

字段说明：
- issue: 问题标题（15字以内）
- severity: "high"（P0 严重）/"medium"（P1 中等）/"low"（P2 轻微）
- description: 具体描述，必须同时包含设计稿期望和开发稿实际
- dev_y: 问题在开发稿中的垂直位置，0=顶部，50=正中间，100=底部（根据问题描述的位置估算百分比）

如果没有问题，输出空数组 []。

现在请输出 JSON 数组：`;

  return prompt;
}

// Generate issue table from Claude output (for both single-page step 2 and folder mode)
async function generateIssueTable(fullOutput, files, typeDir, isFolderMode, res) {
  try {
    const issues = parseIssuesFromOutput(fullOutput);
    if (issues && issues.length > 0) {
      // Build file path lookup
      const fileMap = {};
      if (isFolderMode) {
        for (const f of files) fileMap[f] = path.join(typeDir, f);
      } else {
        const devFile = files.find(f => /dev_screenshot/i.test(f));
        const designFile = files.find(f => /design_mockup/i.test(f));
        fileMap._dev = path.join(typeDir, devFile);
        fileMap._design = path.join(typeDir, designFile);
      }

      // Cache image metadata
      const metaCache = {};
      const getMeta = async (filePath) => {
        if (!metaCache[filePath]) {
          metaCache[filePath] = await sharp(filePath).metadata();
        }
        return metaCache[filePath];
      };

      const tableRows = [];
      for (const issue of issues) {
        let devPath, designPath;
        if (isFolderMode) {
          const pageName = issue.page || '';
          const devFile = files.find(f => f === `dev_${pageName}`);
          const designFile = files.find(f => f === `design_${pageName}`);
          devPath = devFile ? fileMap[devFile] : null;
          designPath = designFile ? fileMap[designFile] : null;
        } else {
          devPath = fileMap._dev;
          designPath = fileMap._design;
        }

        let devImg = null, designImg = null;
        // Use dev_y/design_y (numeric 0-100) for precise cropping, fallback to dev_region/design_region
        if (devPath) {
          if (issue.dev_y !== undefined && issue.dev_y !== null) {
            devImg = await cropByDevY(devPath, issue.dev_y);
          } else if (issue.dev_region) {
            const meta = await getMeta(devPath);
            devImg = await cropRegion(devPath, issue.dev_region, meta.height);
          }
        }
        if (designPath) {
          if (issue.design_y !== undefined && issue.design_y !== null) {
            designImg = await cropByDevY(designPath, issue.design_y);
          } else if (issue.dev_y !== undefined && issue.dev_y !== null) {
            // Fallback: use same position as dev side
            designImg = await cropByDevY(designPath, issue.dev_y);
          } else if (issue.design_region) {
            const meta = await getMeta(designPath);
            designImg = await cropRegion(designPath, issue.design_region, meta.height);
          }
        }

        tableRows.push({
          page: issue.page || '',
          issue: issue.issue || '',
          location: issue.location || '',
          severity: issue.severity || 'medium',
          description: issue.description || '',
          suggestion: issue.suggestion || '',
          devImg,
          designImg
        });
      }

      res.write(`data: ${JSON.stringify({ type: 'table', rows: tableRows })}\n\n`);
      console.log(`[uicheck] generated ${tableRows.length} table rows with cropped images`);
    }
  } catch (err) {
    console.log('[uicheck] table generation error:', err.message);
  }
}

// Configure multer - destination is set per-request in the upload handler
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = getInputsDir(req.params.type || 'default');
    console.log(`[storage] type=${req.params.type}, dir=${dir}`);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// Figma-specific upload storage (fixed directory)
const figmaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = getInputsDir('figma');
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    cb(null, unique + '-' + file.originalname);
  }
});
const uploadFigma = multer({ storage: figmaStorage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.static(PROJECT_DIR));

// 全局 CORS - Figma iframe 需要跨域访问 localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));

// Upload endpoint - clean old files BEFORE multer writes
app.post('/api/upload/:type', (req, res, next) => {
  const type = req.params.type;
  const typeDir = getInputsDir(type);
  // Clean old files before multer writes new ones
  const existingFiles = fs.readdirSync(typeDir);
  for (const file of existingFiles) {
    fs.unlinkSync(path.join(typeDir, file));
  }
  console.log(`[${type}] cleaned ${existingFiles.length} old files from ${typeDir}`);
  next();
}, upload.array('files', 10), (req, res) => {
  const { type } = req.params;
  const content = req.body.content || '';
  const persona = req.body.persona || '';
  const taskDesc = req.body.taskDesc || '';
  const newFiles = (req.files || []).map(f => ({ path: f.path, originalname: f.originalname }));

  res.json({ ok: true, type, content, persona, taskDesc, files: newFiles });
});

// Analyze endpoint (SSE streaming)
app.get('/api/analyze/:type', (req, res) => {
  const { type } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const prompts = {
    prd: buildPRDPrompt,
    uicheck: buildUICheckPrompt,
    edgecase: buildEdgecasePrompt,
    colortry: buildColortryPrompt,
    lowfi: buildLowfiPrompt,
    builder: buildBuilderPrompt
  };

  const buildPrompt = prompts[type];
  if (!buildPrompt) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'Unknown type: ' + type })}\n\n`);
    return res.end();
  }

  const typeDir = getInputsDir(type);
  const files = fs.readdirSync(typeDir);
  if (files.length === 0) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: '请先上传文件后再开始分析' })}\n\n`);
    return res.end();
  }

  console.log(`[${type}] analyzing files:`, files);
  const prompt = buildPrompt(files, type);

  res.write(`data: ${JSON.stringify({ type: 'status', content: 'Claude Code 启动中...' })}\n\n`);

  // For uicheck single-page mode: two-step flow to prevent dev/design confusion
  // Step 1 (already done above): design-only analysis → module spec
  // Step 2: compare dev screenshot against the text spec
  let finalPrompt = prompt;
  if (type === 'uicheck') {
    const devFiles = files.filter(f => /^dev_/.test(f));
    const designFilesList = files.filter(f => /^design_/.test(f));
    const isFolderMode = devFiles.length > 0 && designFilesList.length > 0;

    if (!isFolderMode) {
      // Single-page mode: step 1 just finished (design analysis), now build step 2
      res.write(`data: ${JSON.stringify({ type: 'status', content: '正在分析设计稿结构...' })}\n\n`);
    }
  }

  // colortry uses interactive mode (needs to run bash for color analysis script)
  // lowfi/builder use interactive mode (need to read skills and generate figma plugin code)
  // Other types use --print mode
  const isInteractive = type === 'colortry' || type === 'lowfi' || type === 'builder';
  const claudeArgs = isInteractive
    ? [prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'text']
    : ['--print', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'text'];
  const claude = spawn('claude', claudeArgs, {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  // Collect full output for uicheck post-processing
  let fullOutput = '';

  // For uicheck single-page mode, hide step 1 output from frontend
  const uicheckSinglePage = type === 'uicheck' && (() => {
    const df = files.filter(f => /^dev_/.test(f));
    const dsf = files.filter(f => /^design_/.test(f));
    return !(df.length > 0 && dsf.length > 0);
  })();

  claude.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullOutput += text;
    if (!uicheckSinglePage) {
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }
  });

  claude.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    res.write(`data: ${JSON.stringify({ type: 'stderr', content: text })}\n\n`);
  });

  claude.on('close', async (code) => {
    // Debug: save full output
    fs.writeFileSync('/tmp/claude-uicheck-output.txt', fullOutput);
    console.log('[uicheck] full output length:', fullOutput.length);

    // For uicheck: two-step flow for single-page mode
    if (type === 'uicheck') {
      const devFiles = files.filter(f => /^dev_/.test(f));
      const designFilesList = files.filter(f => /^design_/.test(f));
      const isFolderMode = devFiles.length > 0 && designFilesList.length > 0;

      if (!isFolderMode) {
        // Single-page mode: step 1 output is the design spec JSON
        // Now run step 2: compare dev screenshot against the spec
        const designSpec = parseDesignSpecFromOutput(fullOutput);
        const devFile = files.find(f => /dev_screenshot/i.test(f));
        const bgFile = files.find(f => /background\.txt$/i.test(f));
        const bgPath = bgFile ? path.join(typeDir, bgFile) : '';

        if (devFile && designSpec && designSpec.length > 0) {
          console.log('[uicheck step 2] design spec modules:', designSpec.length);
          res.write(`data: ${JSON.stringify({ type: 'status', content: '正在对比开发稿...' })}\n\n`);

          const devPath = path.join(typeDir, devFile);
          const step2Prompt = buildUICheckStep2Prompt(designSpec, devPath, bgPath);

          const claude2 = spawn('claude', [
            '--print', step2Prompt,
            '--permission-mode', 'bypassPermissions',
            '--output-format', 'text'
          ], {
            cwd: PARENT_DIR,
            env: { ...process.env }
          });

          let step2Output = '';
          claude2.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            step2Output += text;
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
          });
          claude2.stderr.on('data', (chunk) => {
            res.write(`data: ${JSON.stringify({ type: 'stderr', content: chunk.toString() })}\n\n`);
          });

          claude2.on('close', async (code2) => {
            // Parse issues from step 2 output and generate table
            await generateIssueTable(step2Output, files, typeDir, isFolderMode, res);
            res.write(`data: ${JSON.stringify({ type: 'done', code: code2 })}\n\n`);
            res.end();
          });

          claude2.on('error', (err) => {
            res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
            res.end();
          });
          return; // Don't send done yet — step 2 will
        } else {
          console.log('[uicheck step 2] missing dev file or empty design spec');
        }
      }
    }

    // For lowfi/builder: extract figma plugin code
    if (type === 'lowfi' || type === 'builder') {
      try {
        const pluginMatch = fullOutput.match(/```figma-plugin\s*([\s\S]*?)```/);
        if (pluginMatch) {
          res.write(`data: ${JSON.stringify({ type: 'figma-code', content: pluginMatch[1].trim() })}\n\n`);
          console.log(`[${type}] extracted figma plugin code`);
        }
      } catch (err) {
        console.log(`[${type}] plugin code extraction error:`, err.message);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', code })}\n\n`);
    res.end();
  });

  claude.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    res.end();
  });
});

// Build prompts for each type
function buildPRDPrompt(files, type) {
  const fileList = files.join(', ');
  return `你是一名资深 UX 设计评审助手。请按以下步骤执行：

Step 1：使用 Read 工具读取 .claude/skills/prdcheck/SKILL.md，了解评审规则。
Step 2：使用 Read 工具逐一读取 designer-platform/inputs/${type}/ 目录下的文件：${fileList}
Step 3：按照 SKILL.md 中的规则进行分析。

核心原则：
1. 只基于已给信息分析，不做过度发散，不要强行补一大堆通用问题
2. 重点检查"是否合理"：前后逻辑一致、页面和操作说得通、用户能顺畅完成任务、无明显断层歧义冲突
3. 优先指出真正影响设计落地的问题：会导致页面返工、交互方案改变、原型难以自圆其说、用户操作疑惑的问题

检查角度：
A. 页面结构：信息层级是否清楚、模块划分是否合理、主次内容是否明确
B. 用户操作链路：用户从哪里进入、第一步看到什么、是否支持自然完成目标、是否有跳步/重复/打断
C. 交互逻辑：操作前提是否成立、结果是否符合预期、页面衔接是否自然、规则前后是否一致
D. 原型表达：是否表达清楚主流程、关键动作是否缺反馈、是否只画了正常情况
E. 状态和反馈：默认态/选中态/禁用态/成功失败/空态/加载态是否够用
F. 规则和文案：同一个动作在不同页面说法是否一致、按钮文案是否匹配用户预期

输出格式：
1. 当前需求在做什么（2-4句话）
2. 页面与流程理解
3. 合理点
4. 我看到的问题（每条包含：问题点、为什么不合理、会影响什么、建议怎么确认或调整）
5. 建议优先确认的问题（按重要程度排序）`;
}

function buildUICheckPrompt(files, type) {
  const txtFiles = files.filter(f => /background\.txt$/i.test(f));

  // Detect folder mode: files start with dev_ and design_ prefixes
  const devFiles = files.filter(f => /^dev_/.test(f));
  const designFiles = files.filter(f => /^design_/.test(f));
  const isFolderMode = devFiles.length > 0 && designFiles.length > 0;

  if (isFolderMode) {
    // Pair files by common name: dev_首页.png ↔ design_首页.png
    const pairs = [];
    for (const devFile of devFiles) {
      const baseName = devFile.replace(/^dev_/, '');
      const matchingDesign = designFiles.find(f => f.replace(/^design_/, '') === baseName);
      if (matchingDesign) {
        pairs.push({ name: baseName, dev: devFile, design: matchingDesign });
      }
    }

    const unpairedDev = devFiles.filter(f => !pairs.some(p => p.dev === f));
    const unpairedDesign = designFiles.filter(f => !pairs.some(p => p.design === f));

    let prompt = `你是一名资深的设计走查助手，专门用于 APP 页面第一轮走查。\n\n`;
    prompt += `请按以下步骤执行：\n\n`;
    prompt += `Step 1：使用 Read 工具读取 .claude/skills/uicheck/SKILL.md，了解走查规则。\n`;
    prompt += `Step 2：逐一读取以下配对的图片进行走查：\n\n`;

    for (const pair of pairs) {
      prompt += `【页面：${pair.name}】\n`;
      prompt += `  - 【开发页】（代码实现产物，文件名 dev_ 开头）：designer-platform/inputs/${type}/${pair.dev}\n`;
      prompt += `  - 【设计稿】（设计目标效果图，文件名 design_ 开头）：designer-platform/inputs/${type}/${pair.design}\n\n`;
    }

    if (txtFiles.length > 0) {
      prompt += `  - 背景信息：designer-platform/inputs/${type}/${txtFiles[0]}\n\n`;
    }

    if (unpairedDev.length > 0) {
      prompt += `未配对的开发文件（无法对比）：${unpairedDev.join(', ')}\n`;
    }
    if (unpairedDesign.length > 0) {
      prompt += `未配对的设计文件（无法对比）：${unpairedDesign.join(', ')}\n`;
    }
    if (unpairedDev.length > 0 || unpairedDesign.length > 0) {
      prompt += `\n`;
    }

    prompt += `Step 3：按照 SKILL.md 中的规则对每一个配对页面进行走查分析。\n\n`;

    prompt += `【图片身份铁则】\n`;
    prompt += `文件名 dev_ 开头的是【开发页】= 代码实现产物\n`;
    prompt += `文件名 design_ 开头的是【设计稿】= 设计目标\n`;
    prompt += `两者绝对不能混淆，全程不得交换身份。\n`;
    prompt += `在分析每个页面时，必须先分别描述开发页和设计稿中可见的关键元素，再进行对比。\n`;
    prompt += `如果不确定某张图是开发页还是设计稿，查看文件名前缀：dev_ = 开发，design_ = 设计。\n\n`;
    prompt += `【证据驱动铁则】\n`;
    prompt += `- 只能基于截图中明确可见的内容进行分析，严禁编造未出现的元素（如Tab、按钮、文案等）\n`;
    prompt += `- 如果不确定某个元素是否存在，明确说明"从截图中无法确认"\n`;
    prompt += `- 每个问题都要先确认该元素在开发页和设计稿中分别是什么样子，再描述差异\n`;
    prompt += `- 描述问题时先说"设计稿中XX是YY样式"，再说"开发稿中XX是ZZ样式"\n\n`;
    prompt += `【检查重点】—— 请逐项检查，不要遗漏：\n`;
    prompt += `A. 页面骨架：整体结构是否一致、是否明显缺区块或缺模块\n`;
    prompt += `B. 模块顺序：从上到下的模块顺序是否基本一致、主模块是否放错位置\n`;
    prompt += `C. 视觉重点：设计稿中最想强调的内容在开发页是否还是第一重点\n`;
    prompt += `D. 关键区域样式：顶部导航区、核心卡片区、列表区、关键按钮区、底部操作区是否明显偏差\n`;
    prompt += `E. 页面节奏：页面是否明显更挤/更散、模块间留白关系是否明显跑偏\n`;
    prompt += `F. 明显样式偏差：按钮/卡片/标题层级/图标风格/配色重点/圆角背景描边阴影等整体气质不一致\n`;
    prompt += `G. 操作元素：设计稿中的按钮、输入框、Tab、提示语是否在开发页中存在\n\n`;
    prompt += `注意：请按 A-G 的顺序逐项检查，每一项都要给出结论。不要跳过任何一项。\n\n`;

    prompt += `【忽略噪音】以下不作为正式问题：长截图起始位置不同、滚动位置不同、截图长度不同、动态数据内容不同、纯文案/文字/数字差异、文案长度不同但结构仍成立、小范围上下偏移、轻微字体渲染差异、极小间距误差。\n`;
    prompt += `本次走查只看结构和UI还原度，不看文案是否一致。\n\n`;

    prompt += `【输出格式】\n\n`;
    prompt += `## 多页面走查总览\n`;
    prompt += `简要总结本次走查的页面总数、整体差异程度、问题集中区域。\n\n`;

    for (const pair of pairs) {
      prompt += `---\n\n`;
      prompt += `## 【${pair.name}】走查结果\n\n`;
      prompt += `### 走查结论\n2-4句话总结该页面的差异程度和问题集中区域。\n\n`;
      prompt += `### 图片映射\n明确该页面的开发长截图和设计稿长图对应关系。\n\n`;
      prompt += `### 整体观察\n简要说明页面结构、模块顺序、视觉重点是否一致。\n\n`;
      prompt += `### 开发问题清单\n按严重程度排序的连续编号问题清单。\n`;
      prompt += `每条格式：**1. [P1] 问题标题**\n- **位置**：\n- **问题**：\n- **影响**：\n- **建议**：\n\n`;
      prompt += `### 疑似问题/待确认项\n\n`;
    }

    prompt += `---\n\n`;
    prompt += `## 全局优先修改建议\n`;
    prompt += `3-5条最值得先处理的问题，引用上方页面和问题编号。\n\n`;

    prompt += `## 问题表格\n`;
    prompt += `最后输出一个 JSON 数组，包含所有页面的问题。每个对象包含以下字段：\n`;
    prompt += `- page: 页面名称（如"首页"）\n`;
    prompt += `- issue: 问题点简述（10字以内）\n`;
    prompt += `- location: 问题在页面中的位置描述\n`;
    prompt += `- severity: 严重程度（high/medium/low）\n`;
    prompt += `- description: 详细描述问题及影响\n`;
    prompt += `- suggestion: 修改建议\n`;
    prompt += `- dev_y: 问题在开发稿中的垂直位置（0=顶部，50=中间，100=底部，估算百分比）\n`;
    prompt += `- design_y: 问题在设计稿中的垂直位置（同上）\n\n`;
    prompt += `输出格式：\n`;
    prompt += `\`\`\`json\n`;
    prompt += `[{"page": "首页", "issue": "底部操作区缺失", "location": "底部操作区", "severity": "high", "description": "...", "suggestion": "...", "dev_y": 85, "design_y": 82}]\n`;
    prompt += `\`\`\`\n`;

    return prompt;
  }

  // Single page mode — Step 1: analyze design ONLY, output module spec
  const devFile = files.find(f => /dev_screenshot/i.test(f));
  const designFile = files.find(f => /design_mockup/i.test(f));

  let prompt = `你是一名资深 UI 设计师。请仔细观察这张**设计稿**图片（设计目标/效果图）。\n\n`;
  prompt += `图片：designer-platform/inputs/${type}/${designFile}\n`;
  if (txtFiles.length > 0) {
    prompt += `背景信息：designer-platform/inputs/${type}/${txtFiles[0]}\n`;
  }
  prompt += `\n从上到下逐一列出页面中的所有模块。\n\n`;
  prompt += `## 输出格式\n`;
  prompt += `只输出 JSON 数组，不要任何文字：\n`;
  prompt += `\`\`\`json\n`;
  prompt += `[\n`;
  prompt += `  {"order": 1, "name": "顶部导航栏", "content": "返回按钮、页面标题、分享图标", "visual": "白色背景，居中标题18px，左右各一个图标"},\n`;
  prompt += `  {"order": 2, "name": "Banner区域", "content": "活动标题、倒计时、主按钮", "visual": "渐变紫色背景，圆角卡片"}\n`;
  prompt += `]\n`;
  prompt += `\`\`\`\n`;

  return prompt;
}

function buildUsertestPrompt(files, type) {
  const txtFiles = files.filter(f => /\.(txt|md)$/i.test(f));
  const imgFiles = files.filter(f => /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(f));
  let msg = `你是一名资深移动端UI/UX可用性评测专家，具备用户行为心理分析能力。请按以下步骤执行：\n\n`;
  msg += `Step 1：使用 Read 工具读取 .claude/skills/usertest/SKILL.md，了解评测规则。\n`;
  msg += `Step 2：使用 Read 工具读取以下文件：\n`;
  if (txtFiles.length > 0) msg += `  - 用户画像文件：designer-platform/inputs/${type}/${txtFiles[0]}\n`;
  for (const img of imgFiles) msg += `  - UI截图文件：designer-platform/inputs/${type}/${img}\n`;
  msg += `Step 3：按照 SKILL.md 中的规则进行可用性评测。\n\n`;

  msg += `评测目标：不是判断"好不好看"，而是判断是否降低认知成本、提升操作效率、促进用户转化、符合用户心理预期。\n`;
  msg += `强制规则：\n`;
  msg += `1. 【画像锚定】所有分析100%溯源用户画像，每一条观察/问题/影响/建议都必须绑定画像特征（年龄、身份、认知水平、使用动机、操作习惯、耐心阈值），禁止脱离画像做通用泛化点评\n`;
  msg += `2. 【视觉锚定】所有评测必须锚定界面具体元素（色块、文字、按钮、卡片、间距、图标、Tab），描述问题时明确指出元素位置（顶部/中部/底部、标题区、数据区、按钮区）\n`;
  msg += `3. 【证据驱动】只能基于截图中明确可见的信息分析，严禁编造未出现的模块、假设页面功能、虚构用户路径。信息不足时必须说"从当前截图无法判断"\n`;
  msg += `4. 【置信度标记】所有结论标记：高置信度（界面明确可见）、中置信度（合理推断）、低置信度（信息不足的猜测）\n`;

  msg += `\n分析结构（每条问题必须四段式）：\n`;
  msg += `1. 【观察】客观描述界面元素和视觉事实\n`;
  msg += `2. 【问题】结合画像说明为何构成体验问题\n`;
  msg += `3. 【影响】对该画像用户的行为和心理影响\n`;
  msg += `4. 【建议】对应元素的可落地修改方案\n`;

  msg += `\n输出格式：\n`;
  msg += `1. 目标用户画像还原\n`;
  msg += `2. 页面整体初印象（3秒扫描）\n`;
  msg += `3. 全维度详细评测（所有问题严格四段式+置信度）\n`;
  msg += `4. 隐藏体验隐患\n`;
  msg += `5. 分级优化建议：【必改项】【建议优化】【进阶优化】\n`;

  return msg;
}

function buildEdgecasePrompt(files, type) {
  const txtFiles = files.filter(f => /\.(txt|md)$/i.test(f));
  const imgFiles = files.filter(f => /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(f));
  let msg = `你是轻量化UX原型隐患分析师。请按以下步骤执行：\n\n`;
  msg += `Step 1：使用 Read 工具读取 .claude/skills/edgecase/SKILL.md，了解分析规则。\n`;
  msg += `Step 2：使用 Read 工具读取以下文件：\n`;
  if (txtFiles.length > 0) msg += `  - 用户画像文件：designer-platform/inputs/${type}/${txtFiles[0]}\n`;
  for (const img of imgFiles) msg += `  - 原型截图文件：designer-platform/inputs/${type}/${img}\n`;
  msg += `Step 3：按照 SKILL.md 中的规则进行原型隐患分析。\n\n`;

  msg += `核心唯一任务：结合原型画面、业务逻辑、用户行为常识，挖掘产品构思里没考虑到的边界/例外/极端场景，重点指出这些未考虑到的情况会直接造成后续UI设计无法承接、布局摆不下、交互逻辑断层、页面无法完整适配。\n`;
  msg += `约束：\n`;
  msg += `1. 不输出UI方案、不做视觉美化、不替代设计工作\n`;
  msg += `2. 不做冗余理论、不套UX大框架、不严肃挑刺\n`;
  msg += `3. 严格基于原型可见信息，不脑补额外业务功能\n`;
  msg += `4. 绑定用户画像，结合人群行为判断潜在场景\n`;
  msg += `5. 语言直白简洁，只讲隐患、不讲空话\n`;

  msg += `\n只排查4类会影响设计落地的隐藏缺口：\n`;
  msg += `1. 操作边界限制（次数上限、领取完毕、权限限制）\n`;
  msg += `2. 异常/空数据场景（暂无内容、无记录、未参与、超长数据、超短数据）\n`;
  msg += `3. 用户中途行为（中途退出、重复进入、反复操作）\n`;
  msg += `4. 前后逻辑冲突点（流程衔接、跳转闭环、反馈缺失）\n`;

  msg += `\n输出格式：\n`;
  msg += `1. 原型基础流程还原（简要概括产品原本的设计构思、主流程逻辑）\n`;
  msg += `2. 未考虑到的隐藏边界&场景（逐条列出产品遗漏的例外情况、潜在场景）\n`;
  msg += `3. 对应设计落地影响（直接说明该场景缺失会导致UI设计遇到什么问题、哪里摆不下、逻辑怎么卡死）\n`;
  msg += `4. 极简设计前置提醒（仅给出做设计时需要预留的适配空间）\n`;

  return msg;
}

function buildColortryPrompt(files, type) {
  const imgFiles = files.filter(f => /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(f));
  let msg = `你是资深 UI 色彩系统设计师兼前端开发专家。请按以下步骤执行：\n\n`;
  msg += `Step 1：使用 Read 工具读取 .claude/skills/colortry/SKILL.md，了解配色规则。\n`;
  msg += `Step 2：运行颜色分析脚本提取主色调。\n`;
  msg += `  在终端执行：node designer-platform/color-analyze.js designer-platform/inputs/${type}/${imgFiles[0]}\n`;
  msg += `  该脚本会输出精确的 JSON 颜色数据（包含 themeHue、isDark、bg、card、primary 等所有色值）。\n`;
  msg += `Step 3：读取脚本输出的 JSON，提取所有颜色参数。\n`;
  msg += `Step 4：按照 SKILL.md 中的配色规则和上述颜色值，生成完整的 HTML 页面（内联 CSS）。\n\n`;

  msg += `【铁则】\n`;
  msg += `1. 必须运行 Step 2 的脚本获取精确颜色，禁止自行猜测或目测\n`;
  msg += `2. 脚本输出的 JSON 颜色值必须直接使用，不得修改任何数值\n`;
  msg += `3. 明亮图片必须用浅色模式(isDark=false)，深色图片用深色模式(isDark=true)\n\n`;

  msg += `【布局规则 - 严格遵守】\n`;
  msg += `- 页面宽度 414px，外层容器 padding: 16px\n`;
  msg += `- Banner 区域：高度 450px，使用上传的视觉参考图作为背景（用 <img> 或 background-image），底部渐变透明到 bg 色\n`;
  msg += `- 卡片顺序：我的收益 → 我的任务 → 我的作品\n`;
  msg += `- 卡片：宽度 100%，圆角 16px，背景 card 色，外边距 0 0 16px 0，内边距 0\n`;
  msg += `- 卡片标题区：高度 64px，内边距 0 16px，背景与卡片一致，叠加顶部向内径向柔光（主色系比卡片底色浅）\n`;
  msg += `- 卡片内容区：margin 16px，padding 16px，背景 cardContent，圆角 12px\n`;
  msg += `- 我的收益卡片：无内容底色、无外边距、无内边距，直接在卡片内展示，左右等分排列\n`;
  msg += `- 按钮：72×36px，圆角 64px，背景 primary 色，文字自动黑白适配\n`;
  msg += `- 列表项间距 24px，70% 内容 + 30% 按钮左右布局\n`;
  msg += `- 图标：强制内联纯 SVG 矢量，禁用 emoji\n`;
  msg += `- 全局禁止分割线、边框线\n\n`;

  msg += `【默认数据】\n`;
  msg += `- 收益：当前收益 2340元 / 本期最高收益 9234元（36px 加粗 primary 色）\n`;
  msg += `- 任务：发布10个有效视频 / 发布10个爆款视频 / 收到100个点赞（均为已完成1/10）\n`;
  msg += `- 作品：如诗如画的烟雨江南 / 元中心灯火辉煌 / 哗啦啦啦啦啦天在下雨（90×120px 圆角图片占位）\n\n`;

  msg += `【输出格式】\n`;
  msg += `只输出 \`\`\`html ... \`\`\` 代码块，包含完整 DOCTYPE、meta、内联 CSS。\n`;
  msg += `不要输出任何解释文字。\n`;

  return msg;
}

function buildLowfiPrompt(files, type) {
  let msg = `你是资深中文UX交互设计师，同时是 Figma 插件开发工程师。请按以下步骤执行：\n\n`;
  msg += `Step 1：使用 Read 工具读取 .claude/skills/lowfi/SKILL.md，了解完整规则和规范。\n`;
  msg += `Step 2：读取以下需求内容，理解业务目标、用户场景和核心流程。\n`;

  const typeDir = getInputsDir(type);
  const typeFiles = fs.readdirSync(typeDir);
  const txtFiles = typeFiles.filter(f => /\.(txt|md)$/i.test(f));
  for (const txt of txtFiles) msg += `  - 需求文件：designer-platform/inputs/${type}/${txt}\n`;
  msg += `\n`;

  msg += `Step 3：按照 lowfi SKILL.md 中的规则，生成完整的中文交互低保真方案。\n\n`;
  msg += `Step 4：生成可执行的 Figma 插件代码。\n`;
  msg += `  你必须生成一段完整的 JavaScript 代码，用户可以直接粘贴到 Figma 插件编辑器中运行。\n`;
  msg += `  代码要求：\n`;
  msg += `  - 使用 Figma Plugin API（figma.createFrame、figma.createRectangle、figma.createText 等）\n`;
  msg += `  - 创建一个新 Page 命名为 "AI低保真_需求"\n`;
  msg += `  - 在 Page 中为每个页面创建独立的 Frame\n`;
  msg += `  - 使用基础矩形、文本、线条等元素绘制低保真线框\n`;
  msg += `  - 所有元素命名清晰（frame.name = "01_首页" 等）\n`;
  msg += `  - 页面之间水平排列，间距 200px\n`;
  msg += `  - 使用灰阶配色（#000、#333、#666、#999、#ccc、#eee、#fff）\n`;
  msg += `  - 按钮用 #999 填充，输入框用 #eee 填充 + #999 描边\n`;
  msg += `  - 代码必须是完整的，可以直接运行，不要省略关键步骤\n\n`;

  msg += `【Figma 插件代码规范】\n`;
  msg += `- 使用 async/await 处理字体加载\n`;
  msg += `- 在修改文本前必须 await figma.loadFontAsync(...)\n`;
  msg += `- 使用 top-level await，不要包裹 IIFE\n`;
  msg += `- 使用 return 返回创建结果\n`;
  msg += `- 新 Frame 放在页面右侧已有内容的右侧（x = 已有最大 x + 200）\n`;
  msg += `- 默认移动端 Frame 尺寸 390x844，桌面端 1440x1024\n\n`;

  msg += `【代码输出格式】\n`;
  msg += `将 Figma 插件代码放在 \`\`\`figma-plugin ... \`\`\` 代码块中。\n`;
  msg += `代码块之外不要包含任何解释文字。\n\n`;

  msg += `【输出要求】\n`;
  msg += `1. 需求摘要（目标、用户、核心任务）\n`;
  msg += `2. 页面清单（每个页面的主要模块、关键CTA）\n`;
  msg += `3. 核心流程（主路径+关键分支）\n`;
  msg += `4. 状态补充（重点页面的空态、加载态、错误态等）\n`;
  msg += `5. Figma 插件代码（完整可运行的 JavaScript）\n`;

  return msg;
}

function buildBuilderPrompt(files, type) {
  let msg = `你是资深 B端 UI 设计师，同时是 Figma 插件开发工程师。请按以下步骤执行：\n\n`;
  msg += `Step 1：使用 Read 工具读取 .claude/skills/builder/SKILL.md，了解完整规则和组件规范。\n`;
  msg += `Step 2：读取以下需求内容，理解业务目标和页面结构。\n`;

  const typeDir = getInputsDir(type);
  const typeFiles = fs.readdirSync(typeDir);
  const txtFiles = typeFiles.filter(f => /\.(txt|md)$/i.test(f));
  for (const txt of txtFiles) msg += `  - 需求文件：designer-platform/inputs/${type}/${txt}\n`;
  msg += `\n`;

  msg += `Step 3：按照 builder SKILL.md 中的规则，生成完整的 B端看板页面搭建方案。\n\n`;
  msg += `Step 4：生成可执行的 Figma 插件代码。\n`;
  msg += `  你必须生成一段完整的 JavaScript 代码，用户可以直接粘贴到 Figma 插件编辑器中运行。\n`;
  msg += `  代码要求：\n`;
  msg += `  - 使用 Figma Plugin API（figma.createFrame、figma.createRectangle、figma.createText 等）\n`;
  msg += `  - 创建一个新 Frame 命名为 "AI看板搭建"，尺寸 1440×900\n`;
  msg += `  - 搭建顶部导航栏（56px 深色）、左侧菜单（200px 深色）、内容区域（1200px 宽）\n`;
  msg += `  - 根据需求放置数据卡片、图表区域、数据表格、搜索筛选栏\n`;
  msg += `  - 所有颜色使用 {r: 0-1, g: 0-1, b: 0-1} 格式（255 归一化）\n`;
  msg += `  - 所有元素命名清晰（header, sidebar, content, card-1, chart-area, data-table 等）\n`;
  msg += `  - 代码必须是完整的，可以直接运行，不要省略关键步骤\n\n`;

  msg += `【Figma 插件代码规范】\n`;
  msg += `- 使用 async/await 处理字体加载\n`;
  msg += `- 在修改文本前必须 await figma.loadFontAsync(...)\n`;
  msg += `- 使用 top-level await，不要包裹 IIFE\n`;
  msg += `- 使用 return 返回创建结果\n`;
  msg += `- 提供 hexToRgb 辅助函数用于颜色转换\n\n`;

  msg += `【代码输出格式】\n`;
  msg += `将 Figma 插件代码放在 \`\`\`figma-plugin ... \`\`\` 代码块中。\n`;
  msg += `代码块之外不要包含任何解释文字。\n\n`;

  msg += `【输出要求】\n`;
  msg += `1. 页面结构说明（3-5句话概括布局和内容）\n`;
  msg += `2. 组件清单（列出搭建了哪些模块）\n`;
  msg += `3. Figma 插件代码（完整可运行的 JavaScript）\n`;

  return msg;
}

// Debug endpoint - 直接查看 Claude 是否被调用
app.get('/api/figma-check-debug', async (req, res) => {
  const typeDir = getInputsDir('figma');
  const files = fs.readdirSync(typeDir);
  console.log('[figma-check-debug] files in directory:', files);

  if (files.length < 2) {
    return res.json({ error: '没有图片，请先从插件上传', files: files });
  }

  const devFile = files.find(f => /dev_screenshot/i.test(f));
  const designFile = files.find(f => /design_mockup/i.test(f));

  if (!devFile || !designFile) {
    return res.json({ error: '缺少开发稿或设计稿', files: files });
  }

  const devPath = path.join(typeDir, devFile);
  const designPath = path.join(typeDir, designFile);

  // 把 prompt 和图片路径直接作为 CLI 参数传入
  // 关键：@路径 必须在 prompt 文本中，并且整个 prompt 作为单个参数传给 --print
  const fullPrompt = `你是一个专业的 UI 走查助手。请仔细观察并对比以下两张图片，找出开发稿与设计稿之间的视觉差异。

开发稿截图：@${devPath}
设计稿截图：@${designPath}

## 走查要求
1. 页面整体结构是否一致
2. 内容是否缺失
3. 样式是否一致

## 输出格式
最后必须输出一个 JSON 数组：
\`\`\`json
[{"issue": "问题描述", "severity": "high", "description": "详情", "dev_region": "mid"}]
\`\`\`

现在请开始走查。`;

  const claude = spawn('claude', [
    '--print', fullPrompt,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'text'
  ], {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  let fullOutput = '';
  claude.stdout.on('data', (chunk) => { fullOutput += chunk.toString(); });
  claude.stderr.on('data', (chunk) => { console.log('[figma-debug stderr]:', chunk.toString().substring(0, 500)); });

  claude.on('close', (code) => {
    console.log('[figma-check-debug] Claude output length:', fullOutput.length);
    console.log('[figma-check-debug] Claude output preview:', fullOutput.substring(0, 500));

    let issues = [];
    try {
      const jsonMatch = fullOutput.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try { issues = JSON.parse(jsonMatch[1]); } catch(e) { console.log('[debug] JSON parse error:', e.message); }
      }
      if (!issues || issues.length === 0) {
        const arrMatch = fullOutput.match(/\[[\s\S]*"issue"[\s\S]*\]/);
        if (arrMatch) {
          try { issues = JSON.parse(arrMatch[0]); } catch(e) {}
        }
      }
    } catch (err) {
      console.log('[figma-check-debug] parse error:', err.message);
    }

    // Save full output for inspection
    fs.writeFileSync('/tmp/figma-check-debug-output.txt', fullOutput, 'utf-8');

    res.json({
      claudeCode: code,
      outputLength: fullOutput.length,
      outputPreview: fullOutput.substring(0, 1000),
      issuesCount: issues.length,
      issues: issues,
      files: files,
      devPath: devPath,
      designPath: designPath
    });
  });

  claude.on('error', (err) => {
    res.json({ error: err.message, files: files });
  });
});

// Step 1: Analyze design mockup ONLY - output page structure list
app.post('/api/figma/design', uploadFigma.array('files', 1), async (req, res) => {
  const typeDir = getInputsDir('figma');
  const bgText = req.body.content || '';

  const actualFilenames = (req.files || []).map(f => f.filename);
  const designFile = actualFilenames.find(f => /DESIGN_/i.test(f));
  if (!designFile) {
    return res.status(400).json({ error: '缺少设计稿图片' });
  }

  const designPath = path.join(typeDir, designFile);
  console.log('[figma-design] designPath:', designPath);

  const prompt = `你是一个资深 UI 设计师。请仔细观察这张设计稿图片，从上到下逐一列出页面中的所有模块。

图片：@${designPath}

## 分析要求
按从上到下的顺序，列出每个模块：
1. 模块名称
2. 该模块包含哪些内容（简要）
3. 关键视觉特征（颜色、形状、布局、图标风格）

## 输出格式
\`\`\`json
[
  {"order": 1, "name": "顶部导航栏", "content": "返回按钮、页面标题、分享图标", "visual": "白色背景，居中标题18px，左右各一个图标"},
  {"order": 2, "name": "Banner区域", "content": "活动标题、倒计时、主按钮", "visual": "渐变紫色背景，圆角卡片"}
]
\`\`\`

只需输出 JSON 数组，不要其他文字。`;

  const claude = spawn('claude', [
    '--print', prompt,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'text'
  ], {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  let fullOutput = '';
  claude.stdout.on('data', (chunk) => { fullOutput += chunk.toString(); });

  const timeout = setTimeout(() => { claude.kill(); }, 3 * 60 * 1000);

  claude.on('close', () => {
    clearTimeout(timeout);
    console.log('[figma-design] output length:', fullOutput.length);

    let modules = [];
    try {
      const jsonMatch = fullOutput.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) modules = JSON.parse(jsonMatch[1]);
      else {
        const arrMatch = fullOutput.match(/\[[\s\S]*"name"[\s\S]*\]/);
        if (arrMatch) modules = JSON.parse(arrMatch[0]);
      }
    } catch (e) {
      console.log('[figma-design] JSON parse error:', e.message);
    }

    res.json({ modules, designPath, fullOutput: fullOutput.substring(0, 500) });
  });

  claude.on('error', (err) => {
    clearTimeout(timeout);
    res.status(500).json({ error: err.message });
  });
});

// Step 2: Compare dev implementation against design spec (text-based)
app.post('/api/figma/dev', uploadFigma.array('files', 1), async (req, res) => {
  const typeDir = getInputsDir('figma');
  const designSpec = req.body.designSpec || '';
  const bgText = req.body.content || '';

  const actualFilenames = (req.files || []).map(f => f.filename);
  const devFile = actualFilenames.find(f => /DEV_/i.test(f));
  if (!devFile) {
    return res.status(400).json({ error: '缺少开发稿图片' });
  }

  const devPath = path.join(typeDir, devFile);
  console.log('[figma-dev] devPath:', devPath);
  console.log('[figma-dev] designSpec length:', designSpec.length);

  const prompt = `你是一个资深的设计走查助手。你收到了一份**设计稿的页面结构清单**和一张**开发稿的截图**。

你的任务：拿着设计稿清单，逐项核对开发稿是否还原到位。

## 设计稿的页面结构清单（设计目标）
${designSpec}

## 开发稿截图（代码实现产物）
图片：@${devPath}

${bgText ? '## 背景信息\n' + bgText + '\n' : ''}

## 核对维度

**A. 模块是否存在**：设计稿中的模块，开发稿中是否缺失或多出？
**B. 模块顺序**：从上到下顺序是否一致？
**C. 视觉重点**：设计稿最想强调的内容，在开发稿中是否还是第一重点？
**D. 模块内部结构**：元素排列（左右/上下/等分）是否一致？
**E. 样式还原**：背景色/卡片色/圆角/阴影/光晕是否有明显偏差？
**F. 按钮/操作元素**：按钮是否存在？大小、圆角、位置是否正确？
**G. 图标**：图标风格是否一致？有无缺失？
**H. 页面节奏**：开发稿是否明显更挤或更散？

## 【铁则】
1. 只基于开发稿截图中实际可见的内容分析，严禁编造不存在的元素
2. 忽略纯文案/文字/数字的差异（按钮文字不同、标题文案不同、数据不同等不报）
3. 不推测，不要因为"这种页面通常有XX"就报告XX缺失
4. 每个问题必须说明：设计稿期望的是什么、开发稿实际是什么
5. 对问题要具体描述，不能只说"样式不一致"

## 输出格式
**只输出一个 JSON 数组**，不要任何文字。数组包含所有发现的问题，按严重程度排序（P0→P1→P2）。

\`\`\`json
[
  {"issue": "简短问题标题", "severity": "high", "description": "设计稿期望：xxx。开发稿实际：yyy。", "dev_y": 45}
]
\`\`\`

字段说明：
- issue: 问题标题（15字以内）
- severity: "high"（P0 严重）/"medium"（P1 中等）/"low"（P2 轻微）
- description: 具体描述，必须同时包含设计稿期望和开发稿实际
- dev_y: 问题在开发稿中的垂直位置，0=顶部，100=底部（根据问题描述的位置估算）

如果没有问题，输出空数组 []。

现在请输出 JSON 数组：`;

  const claude = spawn('claude', [
    '--print', prompt,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'text'
  ], {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  let fullOutput = '';
  claude.stdout.on('data', (chunk) => { fullOutput += chunk.toString(); });
  claude.stderr.on('data', (chunk) => { console.log('[figma-dev stderr]:', chunk.toString().substring(0, 200)); });

  const timeout = setTimeout(() => {
    claude.kill();
    if (!res.headersSent) {
      res.status(504).json({ error: '走查超时' });
    }
  }, 5 * 60 * 1000);

  claude.on('close', () => {
    clearTimeout(timeout);
    console.log('[figma-dev] output length:', fullOutput.length);
    console.log('[figma-dev] preview:', fullOutput.substring(0, 300));

    let issues = [];
    try {
      // Strategy 1: ```json ... ```
      const jsonMatch = fullOutput.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) issues = JSON.parse(jsonMatch[1]);

      // Strategy 2: raw [...] array
      if (!issues || issues.length === 0) {
        const arrMatch = fullOutput.match(/\[[\s\S]*"issue"[\s\S]*\]/);
        if (arrMatch) issues = JSON.parse(arrMatch[0]);
      }

      // Strategy 3: find first [ and last ]
      if (!issues || issues.length === 0) {
        const first = fullOutput.indexOf('[');
        const last = fullOutput.lastIndexOf(']');
        if (first !== -1 && last > first) {
          issues = JSON.parse(fullOutput.slice(first, last + 1));
        }
      }
    } catch (e) {
      console.log('[figma-dev] JSON parse error:', e.message);
    }
    console.log('[figma-dev] issues count:', issues.length);

    const reportPath = path.join(INPUTS_DIR, '_report_figma_' + Date.now() + '.md');
    fs.writeFileSync(reportPath, fullOutput, 'utf-8');

    if (res.headersSent) return;
    res.json({ issues, fullOutput, reportPath });
  });

  claude.on('error', (err) => {
    clearTimeout(timeout);
    console.log('[figma-dev] spawn error:', err.message);
    if (res.headersSent) return;
    res.status(500).json({ issues: [], error: '走查启动失败: ' + err.message });
  });
});

// (old buildUICheckPromptFromTrees removed - replaced by image-based approach)

app.listen(PORT, () => {
  console.log(`设计师平台运行中: http://localhost:${PORT}/`);
});
