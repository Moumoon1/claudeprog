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
const UICHECK_RUNTIME_DEBUG_PATH = '/tmp/uicheck-runtime-debug.json';
const UICHECK_UPLOAD_STATE_PATH = '/tmp/uicheck-latest-upload.json';
const UICHECK_PROMPT_DEBUG_DIR = '/tmp/uicheck-prompts';
const UICHECK_ANALYSIS_IMAGES_DIR = path.join(PROJECT_DIR, 'runtime_images');

// ── uicheck skill directory (唯一运行时目录，无 fallback) ──
const SERVER_VERSION = '2026.05.10-v1';
const SKILL_DIR = path.join(PARENT_DIR, '.codeflicker/skills/uicheck_pro');
const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md');
const REF_DIR = path.join(SKILL_DIR, 'reference');
const OUTPUTS_DIR = path.join(SKILL_DIR, 'outputs');

function readTextFileIfExists(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  } catch (e) {
    console.log('[readTextFileIfExists] error:', e.message);
    return '';
  }
}

function loadUICheckSkillMarkdown() {
  return readTextFileIfExists(SKILL_MD_PATH);
}

function toCodeFlickerFileRef(filePath) {
  if (!filePath) return '';
  return `@${path.resolve(filePath)}`;
}

function toCodeFlickerImageRefs(typeDir, files = []) {
  return files
    .map(file => toCodeFlickerFileRef(path.join(typeDir, file)))
    .filter(Boolean);
}

function loadSkillContext(stage) {
  // stage: 'analysis' → issue_rules + false_positives + output_schema + runtime_guardrails
  // stage: 'screenshot' → screenshot_rules
  // stage: 'doc' → doc_rules
  const files = [];
  try {
    if (stage === 'analysis') {
      for (const name of ['issue_rules.md', 'false_positives.md', 'output_schema.md', 'runtime_guardrails.md']) {
        const fp = path.join(REF_DIR, name);
        const content = readTextFileIfExists(fp);
        if (content) files.push({ name, path: fp, content });
      }
    } else if (stage === 'screenshot') {
      const fp = path.join(REF_DIR, 'screenshot_rules.md');
      const content = readTextFileIfExists(fp);
      if (content) files.push({ name: 'screenshot_rules.md', path: fp, content });
    } else if (stage === 'doc') {
      const fp = path.join(REF_DIR, 'doc_rules.md');
      const content = readTextFileIfExists(fp);
      if (content) files.push({ name: 'doc_rules.md', path: fp, content });
    }
  } catch (e) {
    console.log('[loadSkillContext] error:', e.message);
  }
  return files;
}

// ── 启动时打印关键路径和加载信息 ──
const loadedRefs = loadSkillContext('analysis');
console.log(`[uicheck] server version: ${SERVER_VERSION}`);
console.log(`[uicheck] SKILL_DIR = .codeflicker/skills/uicheck_pro (${SKILL_DIR})`);
console.log(`[uicheck] SKILL_MD_PATH = ${SKILL_MD_PATH} (exists: ${fs.existsSync(SKILL_MD_PATH)})`);
console.log(`[uicheck] REF_DIR = ${REF_DIR}`);
console.log(`[uicheck] analysis reference files loaded: ${loadedRefs.map(f => f.name).join(', ')}`);
console.log(`[uicheck] OUTPUTS_DIR = ${OUTPUTS_DIR} (exists: ${fs.existsSync(OUTPUTS_DIR)})`);

function writeUICheckPromptDebugFile(stage, prompt) {
  fs.mkdirSync(UICHECK_PROMPT_DEBUG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(UICHECK_PROMPT_DEBUG_DIR, `${ts}-${stage}.md`);
  fs.writeFileSync(filePath, prompt, 'utf-8');
  return filePath;
}

function resolveUICheckFlow(files, latestUploadState = null) {
  const requestedMode = latestUploadState?.mode || 'single';
  const devFiles = files.filter(f => /^dev_/.test(f));
  const designFiles = files.filter(f => /^design_/.test(f));
  const hasFolderPairs = devFiles.length > 0 && designFiles.length > 0;

  if (requestedMode === 'folder') {
    return {
      mode: 'folder',
      flowName: 'folder-mode-disabled',
      flowFunction: 'buildUICheckPrompt(folder-mode)',
      isFolderMode: true,
      devFiles,
      designFiles,
      reason: 'upload-mode-folder'
    };
  }

  return {
    mode: 'single',
    flowName: 'single-page-uicheck-pro',
    flowFunction: 'buildUICheckPrompt(single-page) -> buildUICheckStep2AnalysisPrompt -> executeScreenshotScript',
    isFolderMode: false,
    devFiles,
    designFiles,
    reason: requestedMode === 'single' ? 'upload-mode-single' : (hasFolderPairs ? 'fallback-force-single' : 'default-single')
  };
}

function logUICheckRunMeta(stage, payload) {
  console.log(`[uicheck ${stage}] flow: ${payload.flowFunction || payload.flowName || ''}`);
  console.log(`[uicheck ${stage}] prompt file: ${payload.promptFilePath || ''}`);
  console.log(`[uicheck ${stage}] image refs: ${JSON.stringify(payload.imageRefs || [])}`);
  console.log(`[uicheck ${stage}] loaded refs: ${JSON.stringify(payload.referenceFiles || [])}`);
}


// Ensure directories exist
fs.mkdirSync(INPUTS_DIR, { recursive: true });
fs.mkdirSync(UICHECK_ANALYSIS_IMAGES_DIR, { recursive: true });

// Each upload type gets its own sub-directory to prevent cross-contamination
function getInputsDir(type) {
  const dir = path.join(INPUTS_DIR, type);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Parse JSON from FlickCLI's text output
function parseIssuesFromOutput(text) {
  // Try code block first
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed && (parsed.confirmed || parsed.suspected)) return parsed;
    } catch {}
  }
  // Try bare JSON object with confirmed/suspected keys
  const objMatch = text.match(/\{[\s\S]*"confirmed"[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && (parsed.confirmed || parsed.suspected)) return parsed;
    } catch {}
  }
  // Fallback: flat array (legacy format)
  const arrMatch = text.match(/\[[\s\S]*"issue"[\s\S]*\]/);
  if (arrMatch) {
    try { return { confirmed: JSON.parse(arrMatch[0]), suspected: [] }; } catch {}
  }
  return null;
}

// Convert dev_y (0-100 percentage) to crop parameters (y ratio, height ratio)
function devYToCrop(devY, cropPercent) {
  const y = Math.max(0, Math.min(100, devY || 50));
  const halfH = cropPercent || 12;
  const cropY = Math.max(0, y - halfH);
  return { y: cropY / 100, h: (halfH * 2) / 100 };
}

// Crop a region around dev_y and draw a red box around the problem area
async function cropByDevY(imgPath, devY, box) {
  if (!fs.existsSync(imgPath) || devY === undefined || devY === null) return null;
  const meta = await sharp(imgPath).metadata();
  if (meta.width <= 0 || meta.height <= 0) return null;

  // Crop window: ~24% of image height centered on dev_y
  const { y: cropRatio, h: cropHRatio } = devYToCrop(devY, 12);
  const cropTop = Math.round(cropRatio * meta.height);
  const cropH = Math.max(Math.round(cropHRatio * meta.height), Math.round(meta.height * 0.1));

  // Build red box SVG overlay
  let overlaySvg = null;
  if (box && box.x !== undefined && box.y !== undefined && box.w !== undefined && box.h !== undefined) {
    // box values are percentages relative to the full image
    const bx = Math.round((box.x / 100) * meta.width);
    const by = Math.round((box.y / 100) * meta.height);
    const bw = Math.round((box.w / 100) * meta.width);
    const bh = Math.round((box.h / 100) * meta.height);
    // Box position relative to the cropped image
    const relX = bx;
    const relY = by - cropTop;
    if (relY + bh > 0 && relY < meta.height && relX + bw > 0 && relX < meta.width) {
      overlaySvg = Buffer.from(
        `<svg width="${meta.width}" height="${cropH}">
          <rect x="${Math.max(0, relX)}" y="${Math.max(0, relY)}"
                width="${Math.min(bw, meta.width - relX)}" height="${Math.min(bh, cropH - relY)}"
                fill="none" stroke="#ef4444" stroke-width="4" rx="4"/>
        </svg>`
      );
    }
  } else {
    // Fallback: draw a subtle red outline around the entire cropped image
    overlaySvg = Buffer.from(
      `<svg width="${meta.width}" height="${cropH}">
        <rect x="2" y="2" width="${meta.width - 4}" height="${cropH - 4}"
              fill="none" stroke="#fca5a5" stroke-width="2" stroke-dasharray="8,4" rx="4"/>
      </svg>`
    );
  }

  return sharp(imgPath)
    .extract({ left: 0, top: cropTop, width: meta.width, height: cropH })
    .resize({ height: 800, fit: 'inside' })
    .png()
    .toBuffer()
    .then(async (buf) => {
      const resizedMeta = await sharp(buf).metadata();
      // Scale the overlay to match the resized image
      const scaledSvg = overlaySvg.toString().replace(
        `<svg width="${meta.width}" height="${cropH}"`,
        `<svg width="${resizedMeta.width}" height="${resizedMeta.height}"`
      );
      return sharp(buf)
        .composite([{ input: Buffer.from(scaledSvg), top: 0, left: 0 }])
        .toBuffer()
        .then(b => 'data:image/png;base64,' + b.toString('base64'));
    })
    .catch(() => null);
}

// Extract final assistant text from codeflicker stream-json NDJSON output
function extractTextFromStreamJson(rawLines) {
  let resultText = '';
  let assistantText = '';
  const lines = rawLines.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.type === 'result' && typeof obj.content === 'string' && obj.content.trim()) {
        resultText = obj.content.trim();
      }
      if (obj.role === 'assistant' && Array.isArray(obj.content)) {
        for (const c of obj.content) {
          if (c.type === 'text' && c.text) {
            assistantText += c.text;
          }
        }
      }
    } catch {}
  }
  return resultText || assistantText;
}

function extractReadVerificationSection(text) {
  const content = String(text || '').trim();
  if (!content) return '';
  const lines = content.split(/\r?\n/);
  const collected = [];
  let inJsonBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```json/i.test(trimmed)) {
      inJsonBlock = true;
      break;
    }
    if (/^```/.test(trimmed)) continue;
    if (!trimmed) {
      if (collected.length > 0) collected.push('');
      continue;
    }
    collected.push(line);
  }
  return collected.join('\n').trim();
}

function isReadVerificationFailed(text) {
  return /读图验证失败[：:]/.test(String(text || ''));
}

// step: 'step1' (single design image) or 'step2' (dual image comparison)
function hasMeaningfulReadVerification(text, step) {
  const verification = extractReadVerificationSection(text);
  if (!verification || verification.length < 20) return false;
  if (step === 'step1') {
    // step1: single design image — just needs ANY meaningful image content description
    // Model should describe title/color/module visible in the image
    const signals = [
      /[\u4e00-\u9fa5]{2,}/, // at least some Chinese characters (page content)
    ];
    // Must have at least 30 chars of real content description
    return verification.length >= 30 && signals.every(regex => regex.test(verification));
  }
  // step2: dual image comparison
  const signals = [
    /开发稿|dev/i,
    /设计稿|design/i,
    /标题|顶部文字|顶部模块|文字|模块/,
    /主色|背景色|色调|颜色/,
  ];
  return signals.every(regex => regex.test(verification));
}

function ensureUICheckReadVerificationOrThrow(analysisOutput, step) {
  if (isReadVerificationFailed(analysisOutput)) {
    const failReason = analysisOutput.match(/读图验证失败[：:]\s*(.+)/)?.[1] || '未知原因';
    return { ok: false, reason: failReason, verification: extractReadVerificationSection(analysisOutput) };
  }
  if (!hasMeaningfulReadVerification(analysisOutput, step)) {
    return { ok: false, reason: '模型未返回完整读图验证信息，无法确认图片已被真实读取', verification: extractReadVerificationSection(analysisOutput) };
  }
  return { ok: true, reason: '', verification: extractReadVerificationSection(analysisOutput) };
}

// Parse design spec JSON from step 1 output
function parseDesignSpecFromOutput(text) {
  // Helper to clean JSON content that may have unescaped quotes inside string values
  function sanitizeJson(jsonStr) {
    // Replace Chinese curly quotes with straight ones
    return jsonStr
      .replace(/“/g, '"')
      .replace(/”/g, '"')
      .replace(/‘/g, "'")
      .replace(/’/g, "'");
  }

  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try { return JSON.parse(sanitizeJson(jsonMatch[1])); } catch {}
    // Fallback: try to parse despite errors using a lenient approach
    try {
      // Fix unescaped double quotes inside string values with a regex
      const fixed = jsonMatch[1]
        .replace(/“/g, '')
        .replace(/”/g, '')
        .replace(/[\u4e00-\u9fa5][\u201c\u201d]/g, (m) => m[0]);
      return JSON.parse(fixed);
    } catch {}
  }
  const arrMatch = text.match(/\[[\s\S]*"name"[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(sanitizeJson(arrMatch[0])); } catch {}
  }
  // Fallback: find any JSON-looking array
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last > first) {
    try { return JSON.parse(sanitizeJson(text.slice(first, last + 1))); } catch {}
  }
  return null;
}

async function createAnalysisImage(srcPath, suffix) {
  if (!srcPath || !fs.existsSync(srcPath)) return srcPath;
  const outDir = UICHECK_ANALYSIS_IMAGES_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(srcPath, path.extname(srcPath));
  const targetPath = path.join(outDir, `${base}-${suffix}.png`);
  try {
    const meta = await sharp(srcPath).metadata();
    const needResize = (meta.width || 0) > 1400 || (meta.height || 0) > 2200;
    if (!needResize) {
      await sharp(srcPath).png().toFile(targetPath);
      return targetPath;
    }
    await sharp(srcPath)
      .resize({ width: 1400, height: 2200, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(targetPath);
    return targetPath;
  } catch (err) {
    console.log('[uicheck analysis image] fallback to original:', err.message);
    return srcPath;
  }
}

function isUICheckImageFile(file) {
  return /\.(png|jpg|jpeg|webp|bmp|gif)$/i.test(file || '');
}

async function selectSinglePageUICheckFiles(files, typeDir, preferState = null) {
  const imageFiles = (files || []).filter(isUICheckImageFile);
  const withStats = await Promise.all(imageFiles.map(async (file) => {
    const fullPath = path.join(typeDir, file);
    try {
      const stat = await fs.promises.stat(fullPath);
      return { file, fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return { file, fullPath, mtimeMs: 0, size: 0 };
    }
  }));

  const sortedDesc = withStats.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const findByRegexNewest = (regex) => sortedDesc.find(item => regex.test(item.file));
  const devCandidates = sortedDesc.filter(item => /^dev[_-]/i.test(item.file) || /(^|[_-])dev([_-]|\.|$)/i.test(item.file));
  const designCandidates = sortedDesc.filter(item => /^design[_-]/i.test(item.file) || /(^|[_-])design([_-]|\.|$)/i.test(item.file));

  const preferDev = preferState?.devPath ? path.basename(preferState.devPath) : '';
  const preferDesign = preferState?.designPath ? path.basename(preferState.designPath) : '';

  let devPick = sortedDesc.find(item => item.file === preferDev)
    || findByRegexNewest(/^dev_screenshot\./i)
    || findByRegexNewest(/dev_screenshot/i)
    || devCandidates[0]
    || sortedDesc[0]
    || null;

  let designPick = sortedDesc.find(item => item.file === preferDesign)
    || findByRegexNewest(/^design_mockup\./i)
    || findByRegexNewest(/design_mockup/i)
    || designCandidates.find(item => item.file !== (devPick?.file || ''))
    || sortedDesc.find(item => item.file !== (devPick?.file || ''))
    || null;

  if (devPick && !designPick) {
    designPick = sortedDesc.find(item => item.file !== devPick.file) || null;
  }

  return {
    devFile: devPick?.file || '',
    designFile: designPick?.file || '',
    imageFiles,
    devFiles: devCandidates.map(item => item.file),
    designFiles: designCandidates.map(item => item.file),
    sortedByMtimeDesc: sortedDesc.map(item => ({
      file: item.file,
      path: item.fullPath,
      mtimeMs: item.mtimeMs,
      size: item.size
    }))
  };
}

async function getImageInfo(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return null;
  try {
    const [meta, stat] = await Promise.all([sharp(imgPath).metadata(), fs.promises.stat(imgPath)]);
    return {
      path: imgPath,
      width: meta.width || 0,
      height: meta.height || 0,
      size: stat.size
    };
  } catch (err) {
    return {
      path: imgPath,
      width: 0,
      height: 0,
      size: 0,
      error: err.message
    };
  }
}

async function appendUICheckRuntimeDebug(data) {
  const record = {
    ts: new Date().toISOString(),
    ...data
  };
  let existing = [];
  try {
    if (fs.existsSync(UICHECK_RUNTIME_DEBUG_PATH)) {
      const raw = fs.readFileSync(UICHECK_RUNTIME_DEBUG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed;
    }
  } catch {}
  existing.push(record);
  if (existing.length > 200) existing = existing.slice(-200);
  fs.writeFileSync(UICHECK_RUNTIME_DEBUG_PATH, JSON.stringify(existing, null, 2));
}

async function writeUICheckLatestUploadState(payload) {
  fs.writeFileSync(UICHECK_UPLOAD_STATE_PATH, JSON.stringify(payload, null, 2));
}

function readUICheckLatestUploadState() {
  try {
    if (!fs.existsSync(UICHECK_UPLOAD_STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(UICHECK_UPLOAD_STATE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

async function logImageInfo(label, imgPath) {
  if (!imgPath) {
    console.log(`[uicheck image] ${label}: empty path`);
    return null;
  }
  if (!fs.existsSync(imgPath)) {
    console.log(`[uicheck image] ${label}: missing file path=${imgPath}`);
    return null;
  }
  const info = await getImageInfo(imgPath);
  if (info?.error) {
    console.log(`[uicheck image] ${label}: metadata error path=${imgPath} error=${info.error}`);
  } else {
    console.log(`[uicheck image] ${label}: path=${imgPath} width=${info?.width || 0} height=${info?.height || 0} size=${info?.size || 0}`);
  }
  return info;
}

// Build step 2 analysis prompt for single-page uicheck (issue detection only)
// Backend reads skill reference files and injects into prompt — model does NOT need to Read skill files
function buildUICheckStep2AnalysisPrompt(designSpec, devPath, designPath, bgPath) {
  const specText = designSpec.map(m =>
    (m.order || '') + '. ' + String(m.name || '').slice(0, 40) + '：' + String(m.content || '').slice(0, 120) + '，视觉特征：' + String(m.visual || '').slice(0, 80)
  ).join('\n');

  const skillMarkdown = loadUICheckSkillMarkdown();
  const skillCtx = loadSkillContext('analysis');
  const inlineSkill = skillMarkdown ? `\n## uicheck_pro SKILL.md（已内嵌，无需额外读取）\n${skillMarkdown}\n` : '';
  let inlineRules = '';
  for (const f of skillCtx) {
    inlineRules += `\n### ${f.name}\n${f.content}\n`;
  }

  return `你是一个资深的设计走查助手，负责对比开发稿截图和设计稿截图的视觉差异。

## 图片输入（必须按附件读取，不要把路径当普通文本）
开发稿：
${toCodeFlickerFileRef(devPath)}

设计稿：
${toCodeFlickerFileRef(designPath)}

## ⚠️ 必须先完成硬读图验证（严格执行）
- 先分别读取上面的两张图片
- 如果任意一张图片没有被当成真实视觉输入读取，立即输出“读图验证失败：[原因]”并停止
- 禁止在读图失败时继续输出问题 JSON、issue table 或任何问题列表

### 硬读图验证输出要求
请先输出“读图验证”小节，并严格包含以下内容：
1. 开发稿真实可见的页面标题/顶部文字（逐字引用）
2. 开发稿顶部主色、页面主背景色、顶部第一个模块名称
3. 设计稿真实可见的页面标题/顶部文字（逐字引用）
4. 设计稿顶部主色、页面主背景色、顶部第一个模块名称
5. 回答“开发稿和设计稿是否为两张不同图片：是/否”
6. 回答“这两张图是否描述同一个页面或同一组模块：是/否 + 理由”

如果任意一项无法基于图片直接回答，输出：
“读图验证失败：[具体原因]”
然后停止，不要输出 JSON。

## 图片身份铁则
- 开发稿截图 = 代码实现产物（路径：${devPath}）
- 设计稿截图 = 设计目标效果图（路径：${designPath}）
- 两张图禁止交换身份，先分别识别两张图中的同一对象，再比较差异
- 只基于这两张图做判断，不要引入其他图片或历史上下文
- 开发稿中的文字/模块名称必须从开发稿图片中实际读取，不要从设计稿推测
- 设计稿中的文字/模块名称必须从设计稿图片中实际读取，不要从开发稿推测

## 走查规则（已内嵌，无需额外读取）
${inlineSkill}
## reference 规则补充（已内嵌，无需额外读取）
${inlineRules}

### 输出限制
- 最多输出 8 条问题（confirmed + suspected 合计）
- 坐标使用 0.0-1.0 比例
- 先识别同一个对象，再分别给 dev/design 坐标，禁止位置投影
- 不得框整图、不得框错对象、不得把 design 的位置投影到 dev
- 每条问题的 problem 必须描述你在两张图中分别看到的具体差异，不允许模糊描述

## 设计稿的页面结构清单（设计目标）
${specText}

${bgPath ? '## 背景信息\n' + bgPath + '\n' : ''}

## 最终输出

先输出读图验证文字，然后输出一个 JSON 代码块：

\`\`\`json
{
  "confirmed": [],
  "suspected": []
}
\`\`\`

confirmed 和 suspected 每条问题必须包含以下字段：
- id, problem, suggestion, priority(P0/P1/P2), status, location
- devCropRegion: {top, bottom, left, right}（0.0-1.0比例）
- devBox: {top, bottom, left, right}（0.0-1.0比例）
- designCropRegion: {top, bottom, left, right}（0.0-1.0比例）
- designBox: {top, bottom, left, right}（0.0-1.0比例）

suspected 还需要：reason, basis, whyNotConfirmed, verifySuggestion`;
}

// Generate Python script for cropping and drawing red boxes on screenshots
// Uses CropRegion (context window for screenshot) and Box (exact element red box) separately
function generateScreenshotScript(issueData, devPath, designPath) {
  const outputDir = OUTPUTS_DIR;
  
  // Load screenshot rules from disk and embed as comment for reference
  const screenshotRules = loadSkillContext('screenshot');
  let rulesComment = '';
  for (const f of screenshotRules) {
    rulesComment += `# --- ${f.name} ---\n# ${f.content.replace(/\n/g, '\n# ')}\n`;
  }

  const script = `import os, json
from PIL import Image, ImageDraw

os.makedirs("${outputDir}", exist_ok=True)

dev_img = Image.open("${devPath}")
design_img = Image.open("${designPath}")
dev_w, dev_h = dev_img.size
design_w, design_h = design_img.size

issues = ${JSON.stringify(issueData)}

RED = "#ef4444"
PAD_BOX = 8   # padding inside crop for box drawing
LINE_W = 3    # red box stroke width

${rulesComment}

for issue in issues:
    id = issue["id"]
    
    # ── CropRegion: larger context window for the screenshot ──
    dev_crop_r = issue.get("devCropRegion") or issue.get("devRegion") or {"top": 0.0, "bottom": 1.0, "left": 0.0, "right": 1.0}
    design_crop_r = issue.get("designCropRegion") or issue.get("designRegion") or {"top": 0.0, "bottom": 1.0, "left": 0.0, "right": 1.0}
    
    # ── BoxRegion: exact element location for the red box ──
    # If no separate box, use cropRegion as fallback (means entire crop is the problem area)
    dev_box_r = issue.get("devBox") or dev_crop_r
    design_box_r = issue.get("designBox") or design_crop_r
    
    # ── Dev screenshot: crop context + draw red box ──
    dc_top = int(dev_h * dev_crop_r["top"])
    dc_bottom = int(dev_h * dev_crop_r["bottom"])
    dc_left = int(dev_w * dev_crop_r["left"])
    dc_right = int(dev_w * dev_crop_r["right"])
    dev_crop = dev_img.crop((dc_left, dc_top, dc_right, dc_bottom))
    dev_draw = ImageDraw.Draw(dev_crop)
    
    # Box position relative to the cropped image
    db_top_px = int(dev_h * dev_box_r["top"]) - dc_top
    db_bottom_px = int(dev_h * dev_box_r["bottom"]) - dc_top
    db_left_px = int(dev_w * dev_box_r["left"]) - dc_left
    db_right_px = int(dev_w * dev_box_r["right"]) - dc_left
    # Clamp to crop bounds
    db_top_px = max(0, db_top_px)
    db_left_px = max(0, db_left_px)
    db_bottom_px = min(dc_bottom - dc_top, db_bottom_px)
    db_right_px = min(dc_right - dc_left, db_right_px)
    
    # Only draw box if it's not the entire crop (i.e., box != cropRegion)
    if dev_box_r != dev_crop_r:
        dev_draw.rounded_rectangle(
            [db_left_px + PAD_BOX, db_top_px + PAD_BOX, db_right_px - PAD_BOX, db_bottom_px - PAD_BOX],
            radius=4, outline=RED, width=LINE_W
        )
    else:
        # Full-area box: just draw a subtle dashed border around entire crop
        cw, ch = dc_right - dc_left, dc_bottom - dc_top
        dev_draw.rounded_rectangle(
            [4, 4, cw - 4, ch - 4],
            radius=6, outline="#fca5a5", width=2
        )
    dev_crop.save("${outputDir}/issue_" + str(id) + "_dev.png")
    
    # ── Design screenshot: crop context + draw red box ──
    ds_top = int(design_h * design_crop_r["top"])
    ds_bottom = int(design_h * design_crop_r["bottom"])
    ds_left = int(design_w * design_crop_r["left"])
    ds_right = int(design_w * design_crop_r["right"])
    design_crop = design_img.crop((ds_left, ds_top, ds_right, ds_bottom))
    design_draw = ImageDraw.Draw(design_crop)
    
    # Box position relative to the cropped image
    dsb_top_px = int(design_h * design_box_r["top"]) - ds_top
    dsb_bottom_px = int(design_h * design_box_r["bottom"]) - ds_top
    dsb_left_px = int(design_w * design_box_r["left"]) - ds_left
    dsb_right_px = int(design_w * design_box_r["right"]) - ds_left
    dsb_top_px = max(0, dsb_top_px)
    dsb_left_px = max(0, dsb_left_px)
    dsb_bottom_px = min(ds_bottom - ds_top, dsb_bottom_px)
    dsb_right_px = min(ds_right - ds_left, dsb_right_px)
    
    if design_box_r != design_crop_r:
        design_draw.rounded_rectangle(
            [dsb_left_px + PAD_BOX, dsb_top_px + PAD_BOX, dsb_right_px - PAD_BOX, dsb_bottom_px - PAD_BOX],
            radius=4, outline=RED, width=LINE_W
        )
    else:
        cw, ch = ds_right - ds_left, ds_bottom - ds_top
        design_draw.rounded_rectangle(
            [4, 4, cw - 4, ch - 4],
            radius=6, outline="#fca5a5", width=2
        )
    design_crop.save("${outputDir}/issue_" + str(id) + "_design.png")

print("DONE")
`;
  return script;
}

// Flatten issues from both confirmed and suspected into a flat array for Python
function flattenIssueData(issueData) {
  return [...(issueData.confirmed || []), ...(issueData.suspected || [])];
}

// Execute Python screenshot script directly (fallback if codeflicker fails)
async function executeScreenshotScript(scriptContent) {
  const scriptPath = '/tmp/uicheck-screenshot-script.py';
  fs.writeFileSync(scriptPath, scriptContent);
  
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [scriptPath], {
      cwd: PARENT_DIR,
      env: { ...process.env }
    });
    
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    py.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    
    const timer = setTimeout(() => {
      py.kill('SIGKILL');
      reject(new Error('Screenshot script timeout (60s)'));
    }, 60000);
    
    py.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.includes('DONE')) {
        resolve({ success: true, stdout, stderr });
      } else {
        reject(new Error(`Screenshot script failed (code ${code}): ${stderr.slice(0, 500)}`));
      }
    });
    
    py.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}


// [REMOVED] buildUICheckStep2ScreenshotPrompt — Phase B now uses local Python directly
// No longer spawn codeflicker for screenshots; Node generates Python script and runs it


function attachGeneratedIssueImages(issueData) {
  const enrich = (items = []) => items.map((issue) => {
    const id = String(issue.id || '').trim();
    const devPath = path.join(OUTPUTS_DIR, `issue_${id}_dev.png`);
    const designPath = path.join(OUTPUTS_DIR, `issue_${id}_design.png`);
    const devImage = path.relative(PARENT_DIR, devPath);
    const designImage = path.relative(PARENT_DIR, designPath);
    const images = fs.existsSync(devPath) && fs.existsSync(designPath)
      ? [devImage, designImage]
      : (issue.images || []);
    return { ...issue, images };
  });

  return {
    confirmed: enrich(issueData?.confirmed),
    suspected: enrich(issueData?.suspected)
  };
}


// Generate issue table from FlickCLI output (for both single-page step 2 and folder mode)
async function generateIssueTable(fullOutput, files, typeDir, isFolderMode, res) {
  try {
    const data = parseIssuesFromOutput(fullOutput);
    if (!data) return;

    async function imageToBase64(imgPath) {
      // Resolve relative paths from PARENT_DIR (server cwd may be designer-platform)
      const resolvedPath = imgPath.startsWith('/') ? imgPath : path.join(PARENT_DIR, imgPath);
      if (!resolvedPath || !fs.existsSync(resolvedPath)) return null;
      try {
        const buf = fs.readFileSync(resolvedPath);
        return 'data:image/png;base64,' + buf.toString('base64');
      } catch { return null; }
    }

    async function buildRows(items) {
      const rows = [];
      for (const issue of items) {
        let devImg = null, designImg = null;

        // New SKILL format: images array of paths (Claude (kimi-k2.5) already cropped + boxed)
        if (issue.images && issue.images.length >= 2) {
          devImg = await imageToBase64(issue.images[0]);
          designImg = await imageToBase64(issue.images[1]);
          console.log(`[uicheck buildRows] ${issue.id}: images=${JSON.stringify(issue.images)} devImg=${devImg ? 'YES('+devImg.length+')' : 'NULL'} designImg=${designImg ? 'YES('+designImg.length+')' : 'NULL'}`);
        }
        // Fallback: legacy format with dev_y coordinate
        else if (!isFolderMode) {
          const devFile = files.find(f => /dev_screenshot/i.test(f));
          const designFile = files.find(f => /design_mockup/i.test(f));
          if (devFile && issue.dev_y !== undefined) {
            devImg = await cropByDevY(path.join(typeDir, devFile), issue.dev_y);
          }
          if (designFile && issue.dev_y !== undefined) {
            designImg = await cropByDevY(path.join(typeDir, designFile), issue.dev_y);
          }
        }

        // Map both formats to unified row schema
        rows.push({
          id: issue.id || '',
          page: issue.page || '',
          issue: issue.issue || '',
          problem: issue.problem || issue.issue || '',
          location: issue.location || '',
          severity: issue.severity || 'medium',
          priority: issue.priority || (issue.severity === 'high' ? 'P0' : issue.severity === 'low' ? 'P2' : 'P1'),
          status: issue.status || (isFolderMode ? '待修改' : '待修改'),
          confidence: issue.confidence || '',
          suspectLevel: issue.suspectLevel || '',
          description: issue.description || issue.problem || '',
          suggestion: issue.suggestion || '',
          reason: issue.reason || '',
          basis: issue.basis || '',
          whyNotConfirmed: issue.whyNotConfirmed || '',
          impact: issue.impact || '',
          verifySuggestion: issue.verifySuggestion || '',
          devImg,
          designImg
        });
      }
      return rows;
    }

    // Send confirmed issues table
    if (data.confirmed && data.confirmed.length > 0) {
      const confirmedRows = await buildRows(data.confirmed);
      res.write(`data: ${JSON.stringify({ type: 'table', tableType: 'confirmed', rows: confirmedRows })}\n\n`);
      console.log(`[uicheck] generated ${confirmedRows.length} confirmed rows`);
    }

    // Send suspected issues table
    if (data.suspected && data.suspected.length > 0) {
      const suspectedRows = await buildRows(data.suspected);
      res.write(`data: ${JSON.stringify({ type: 'table', tableType: 'suspected', rows: suspectedRows })}\n\n`);
      console.log(`[uicheck] generated ${suspectedRows.length} suspected rows`);
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
const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024,
    fieldSize: 120 * 1024 * 1024
  }
});

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

// Upload endpoint - supports both file upload and URL content fetching
app.post('/api/upload/:type', async (req, _res, next) => {
  const type = req.params.type;
  const typeDir = getInputsDir(type);
  // Clean old input files before multer writes new ones
  const existingFiles = fs.readdirSync(typeDir);
  for (const file of existingFiles) {
    fs.unlinkSync(path.join(typeDir, file));
  }
  console.log(`[${type}] cleaned ${existingFiles.length} old files from ${typeDir}`);
  // Also clean old screenshot outputs (all files in outputs directory)
  if (type === 'uicheck') {
    const outputsDir = OUTPUTS_DIR;
    if (fs.existsSync(outputsDir)) {
      const oldFiles = fs.readdirSync(outputsDir);
      for (const f of oldFiles) {
        fs.unlinkSync(path.join(outputsDir, f));
      }
      console.log(`[uicheck] cleaned ${oldFiles.length} old files from ${outputsDir}`);
    }
  }
  next();
}, upload.array('files', 10), async (req, res) => {
  const { type } = req.params;
  const typeDir = getInputsDir(type);
  let content = req.body.content || '';
  const persona = req.body.persona || '';
  const taskDesc = req.body.taskDesc || '';
  let newFiles = (req.files || []).map(f => ({ path: f.path, originalname: f.originalname }));

  // Handle URL input: fetch content and save as text file
  const isUrl = req.body.isUrl === 'true' || req.body.isUrl === true;
  if (content && newFiles.length === 0) {
    if (isUrl) {
      const pageContent = await fetchUrlContent(content);
      if (pageContent) {
        const fileName = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-prd.txt';
        const filePath = path.join(typeDir, fileName);
        fs.writeFileSync(filePath, `Source URL: ${content}\n\n${pageContent}`, 'utf-8');
        newFiles = [{ path: filePath, originalname: fileName }];
        console.log(`[${type}] fetched URL and saved as ${fileName}`);
      } else {
        return res.status(400).json({ ok: false, error: '无法获取该 URL 的内容，请尝试直接粘贴文本' });
      }
    } else {
      // Browser fetched or direct paste
      const sourceUrl = req.body.sourceUrl || '';
      const fileName = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-prd.txt';
      const filePath = path.join(typeDir, fileName);
      const header = sourceUrl ? `Source URL: ${sourceUrl}\n\n` : '';
      fs.writeFileSync(filePath, `${header}${content}`, 'utf-8');
      newFiles = [{ path: filePath, originalname: fileName }];
      console.log(`[${type}] saved fetched/pasted text as ${fileName} (${content.length} bytes)`);
    }
  }

  // Save PRD images from extension extraction
  const prdImagesRaw = req.body.prdImages || '';
  let savedImages = [];
  if (prdImagesRaw) {
    try {
      const images = typeof prdImagesRaw === 'string' ? JSON.parse(prdImagesRaw) : prdImagesRaw;
      for (const img of (Array.isArray(images) ? images : [images])) {
        if (img.dataUrl && img.dataUrl.startsWith('data:image')) {
          const base64 = img.dataUrl.split(',')[1];
          const imgBuffer = Buffer.from(base64, 'base64');
          let meta = null;
          try {
            meta = await sharp(imgBuffer).metadata();
          } catch {}
          if (!isLikelyPRDImage(meta, img)) {
            console.log(`[${type}] skipped non-prd image: ${img.src || img.alt || '(unknown)'}`);
            continue;
          }
          const mimeMatch = img.dataUrl.match(/data:image\/(\w+);/);
          const ext = mimeMatch ? (mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1]) : 'jpg';
          const imgName = img.name || ('prd_img_' + savedImages.length);
          const imgPath = path.join(typeDir, imgName + '.' + ext);
          fs.writeFileSync(imgPath, imgBuffer);
          savedImages.push({
            path: imgPath,
            originalname: imgName + '.' + ext,
            caption: cleanPRDImageText(img.caption || ''),
            alt: cleanPRDImageText(img.alt || '')
          });
          console.log(`[${type}] saved prd image: ${imgName}.${ext} (${imgBuffer.length} bytes)`);
        }
      }
    } catch (e) {
      console.log(`[${type}] image parse error:`, e.message);
    }
  }

  newFiles = newFiles.concat(savedImages);

  if (type === 'uicheck') {
    const fileNames = fs.readdirSync(typeDir);
    const selection = await selectSinglePageUICheckFiles(fileNames, typeDir, null);
    const devPath = selection.devFile ? path.join(typeDir, selection.devFile) : '';
    const designPath = selection.designFile ? path.join(typeDir, selection.designFile) : '';
    const devInfo = await getImageInfo(devPath);
    const designInfo = await getImageInfo(designPath);

    await writeUICheckLatestUploadState({
      ts: new Date().toISOString(),
      type,
      mode: req.body.mode || 'single',
      typeDir,
      files: fileNames,
      selection,
      devPath,
      designPath,
      devInfo,
      designInfo
    });

    await appendUICheckRuntimeDebug({
      phase: 'upload-complete',
      files: fileNames,
      devFiles: selection.devFiles,
      designFiles: selection.designFiles,
      selected: {
        devFile: selection.devFile,
        designFile: selection.designFile,
        devPath,
        designPath
      },
      imageInfo: {
        dev: devInfo,
        design: designInfo
      }
    });
  }

  res.json({ ok: true, type, content, persona, taskDesc, files: newFiles, imageCount: savedImages.length });
});

function isLikelyPRDImage(meta, img) {
  const w = Math.max(meta?.width || 0, img.width || 0, img.displayWidth || 0);
  const h = Math.max(meta?.height || 0, img.height || 0, img.displayHeight || 0);
  if (w < 260 || h < 160 || w * h < 90000) return false;
  const ratio = w / Math.max(h, 1);
  if (w <= 320 && h <= 320 && ratio > 0.7 && ratio < 1.45) return false;
  const text = `${img.src || ''} ${img.alt || ''} ${img.caption || ''}`.toLowerCase();
  if (/(avatar|portrait|profile|head|user|face|emoji|icon|logo|badge|comment|like|reaction|default|头像|用户|评论|点赞)/i.test(text)) return false;
  return true;
}

function cleanPRDImageText(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (/vodka-|embeddedobject|image-container|image-wrapper|goog-inline-block/i.test(text)) return '';
  return text.slice(0, 80);
}

// Analyze endpoint (SSE streaming)
// Allowed vision models for uicheck
const UICHECK_VISION_MODELS = {
  'kimi-k2.5': 'kimi-k2.5',
  'claude': 'claude',       // alias → claude-4.6-sonnet
  '5': '5',                 // alias → gpt-5.4
  'gemini': 'gemini'        // alias → gemini-3.1-pro-preview
};
const UICHECK_DEFAULT_MODEL = 'kimi-k2.5';

app.get('/api/analyze/:type', async (req, res) => {
  const { type } = req.params;
  const visionModel = req.query.model && UICHECK_VISION_MODELS[req.query.model]
    ? req.query.model
    : UICHECK_DEFAULT_MODEL;
  console.log('[analyze] type:', type, 'vision model:', visionModel);
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

  // Validate content length - only for PRD type to prevent analyzing empty/fetch-failed content
  if (type === 'prd') {
    const mainFile = files.find(f => /prd\.txt$/i.test(f)) || files[0];
    const filePath = path.join(typeDir, mainFile);
    let fileContent = fs.readFileSync(filePath, 'utf-8');
    // Strip URL header to check actual content
    const actualContent = fileContent.replace(/^Source URL:.*?\n\n?/s, '').trim();
    if (actualContent.length < 500) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'PRD 内容过短（' + actualContent.length + ' 字符，链接无法访问或抓取内容不足），请切换到文本粘贴模式手动复制内容' })}\n\n`);
      return res.end();
    }
  }

  console.log(`[${type}] analyzing files:`, files);

  let uicheckStep1Context = null;
  let uicheckFlow = null;
  if (type === 'uicheck') {
    const latestUploadState = readUICheckLatestUploadState();
    uicheckFlow = resolveUICheckFlow(files, latestUploadState);
    console.log('[uicheck] selected flow:', JSON.stringify(uicheckFlow, null, 2));

    if (uicheckFlow.mode === 'folder') {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'uicheck 当前已禁用旧 folder-mode 流程，请切回单页面上传，两张图会走 single-page uicheck_pro 流程。' })}\n\n`);
      return res.end();
    }

    const selection = await selectSinglePageUICheckFiles(files, typeDir, latestUploadState);
    const devFile = selection.devFile;
    const designFile = selection.designFile;
    const devPath = devFile ? path.join(typeDir, devFile) : '';
    const designPath = designFile ? path.join(typeDir, designFile) : '';
    const devInfo = await logImageInfo('step1-dev-selected', devPath);
    const designInfo = await logImageInfo('step1-design-selected', designPath);

    console.log('[uicheck step1] files:', files);
    console.log('[uicheck step1] devFiles:', uicheckFlow.devFiles);
    console.log('[uicheck step1] designFiles:', uicheckFlow.designFiles);
    console.log('[uicheck step1] selected devFile:', devFile);
    console.log('[uicheck step1] selected designFile:', designFile);
    console.log('[uicheck step1] devPath:', devPath);
    console.log('[uicheck step1] designPath:', designPath);

    uicheckStep1Context = {
      latestUploadState,
      flow: uicheckFlow,
      selection,
      devFiles: uicheckFlow.devFiles,
      designFiles: uicheckFlow.designFiles,
      devFile,
      designFile,
      devPath,
      designPath,
      devInfo,
      designInfo
    };
  }

  const prompt = buildPrompt(files, type, uicheckStep1Context);
  if (type === 'uicheck') {
    const step1PromptPath = writeUICheckPromptDebugFile('step1', prompt);
    const step1ReferenceFiles = [SKILL_MD_PATH].filter(fp => fs.existsSync(fp));
    const step1BgFile = files.find(f => /background\.txt$/i.test(f));
    if (step1BgFile) step1ReferenceFiles.push(path.join(typeDir, step1BgFile));
    logUICheckRunMeta('step1', {
      flowName: uicheckStep1Context?.flow?.flowName,
      flowFunction: uicheckStep1Context?.flow?.flowFunction,
      promptFilePath: step1PromptPath,
      imageRefs: [uicheckStep1Context?.designPath].filter(Boolean).map(p => toCodeFlickerFileRef(p)),
      referenceFiles: step1ReferenceFiles
    });
    console.log('[uicheck step1] final prompt:\n' + prompt);
    await appendUICheckRuntimeDebug({
      phase: 'step1-before-model',
      flow: uicheckStep1Context?.flow || null,
      promptFilePath: step1PromptPath,
      files,
      devFiles: uicheckStep1Context?.devFiles || [],
      designFiles: uicheckStep1Context?.designFiles || [],
      selected: {
        devFile: uicheckStep1Context?.devFile || '',
        designFile: uicheckStep1Context?.designFile || '',
        devPath: uicheckStep1Context?.devPath || '',
        designPath: uicheckStep1Context?.designPath || ''
      },
      imageInfo: {
        dev: uicheckStep1Context?.devInfo || null,
        design: uicheckStep1Context?.designInfo || null
      },
      referenceFiles: step1ReferenceFiles,
      imageRefs: [uicheckStep1Context?.designPath].filter(Boolean).map(p => toCodeFlickerFileRef(p)),
      prompt
    });
  }

  res.write(`data: ${JSON.stringify({ type: 'status', content: 'CodeFlicker 启动中...' })}\n\n`);

  // uicheck only keeps the single-page uicheck_pro main flow
  let finalPrompt = prompt;
  if (type === 'uicheck') {
    res.write(`data: ${JSON.stringify({ type: 'status', content: '正在分析设计稿结构...' })}\n\n`);
  }

  // uicheck step1 uses flickcli -q mode with vision model (kimi-k2.5) and @absolute-path image
  const uicheckVisionModel = visionModel;  // from query param
  const isInteractive = type === 'colortry' || type === 'lowfi' || type === 'builder';
  const useStreamJson = type === 'uicheck';
  const outputFormat = useStreamJson ? 'stream-json' : 'text';
  const modelArgs = type === 'uicheck' ? ['--model', uicheckVisionModel] : [];
  const cliCmd = type === 'uicheck' ? 'flickcli' : 'codeflicker';
  const cliArgs = isInteractive
    ? [...modelArgs, '--approval-mode', 'yolo', '--output-format', outputFormat, prompt]
    : [...modelArgs, '-q', '--approval-mode', 'yolo', '--output-format', outputFormat, prompt];
  console.log('[uicheck] CLI:', cliCmd, 'args:', JSON.stringify(cliArgs));
  const flickcli = spawn(cliCmd, cliArgs, {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  // Collect full output for uicheck post-processing
  let fullRawOutput = '';  // raw stream-json or text
  let fullTextOutput = ''; // extracted text (for stream-json mode)

  // For uicheck single-page mode, hide step 1 output from frontend
  const uicheckSinglePage = type === 'uicheck';

  flickcli.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullRawOutput += text;
    if (!uicheckSinglePage && !useStreamJson) {
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
    }
  });

  flickcli.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!useStreamJson) {
      res.write(`data: ${JSON.stringify({ type: 'stderr', content: text })}\n\n`);
    }
    console.log(`[${type} stderr]`, text.slice(0, 200));
  });

  flickcli.on('close', async (code) => {
    // For stream-json mode, extract the text content
    if (useStreamJson) {
      fullTextOutput = extractTextFromStreamJson(fullRawOutput);
    } else {
      fullTextOutput = fullRawOutput;
    }
    // Debug: save full output
    fs.writeFileSync('/tmp/flickcli-uicheck-output.txt', fullTextOutput);
    fs.writeFileSync('/tmp/flickcli-uicheck-output-raw.txt', fullRawOutput);
    console.log('[uicheck] full text output length:', fullTextOutput.length, 'raw length:', fullRawOutput.length);

    if (code !== 0) {
      const quotaErr = /quota|authenticate|403|token-plan/i.test(fullTextOutput + fullRawOutput);
      const errMsg = quotaErr
        ? 'CodeFlicker 调用失败：账号额度或鉴权异常（403/token-plan）。请先恢复 CodeFlicker 可用额度后重试。'
        : `CodeFlicker 调用失败（退出码 ${code}）。请查看服务端日志和 /tmp/flickcli-uicheck-output.txt。`;
      res.write(`data: ${JSON.stringify({ type: 'error', content: errMsg })}\n\n`);
      res.end();
      return;
    }

    // For uicheck: detect vision model quota exhaustion or GLM fallback
    if (type === 'uicheck') {
      const quotaExhausted = /额度上限|已达到使用额度|fallback to wanqing/i.test(fullRawOutput);
      if (quotaExhausted) {
        console.log('[uicheck step1] ERROR: vision model quota exhausted or fell back to GLM (no vision)');
        res.write(`data: ${JSON.stringify({ type: 'error', content: '视觉模型（claude-sonnet）额度已用完，系统 fallback 到无视觉能力的 GLM 模型，无法读图。请等待额度刷新（约12小时）后重试。' })}\n\n`);
        res.end();
        return;
      }
    }

    // For uicheck: fixed single-page main flow
    if (type === 'uicheck') {
      const designSpec = parseDesignSpecFromOutput(fullTextOutput);
      const latestUploadState = readUICheckLatestUploadState();
      const flow = resolveUICheckFlow(files, latestUploadState);
      console.log('[uicheck step1] parsed JSON:', JSON.stringify(designSpec, null, 2));
      console.log('[uicheck step1] verification text:', fullTextOutput.slice(0, 500));

      const step1Verification = ensureUICheckReadVerificationOrThrow(fullTextOutput, 'step1');
      if (!step1Verification.ok) {
        console.log('[uicheck step1] verification failed:', step1Verification.reason);
        res.write(`data: ${JSON.stringify({ type: 'error', content: '设计稿读图验证失败：' + step1Verification.reason + '。请检查上传的设计稿图片是否正确。' })}\n\n`);
        res.end();
        return;
      }

      const selection = await selectSinglePageUICheckFiles(files, typeDir, latestUploadState);
      const devFile = selection.devFile;
      const designFile = selection.designFile;
      const bgFile = files.find(f => /background\.txt$/i.test(f));
      const bgPath = bgFile ? path.join(typeDir, bgFile) : '';
      const bgContent = bgPath && fs.existsSync(bgPath)
        ? fs.readFileSync(bgPath, 'utf-8').trim().slice(0, 2000)
        : '';

      if (devFile && designFile && Array.isArray(designSpec) && designSpec.length > 0) {
        console.log('[uicheck step 2] design spec modules:', designSpec.length);
        res.write(`data: ${JSON.stringify({ type: 'status', content: '正在对比开发稿...' })}\n\n`);

        const devPath = path.join(typeDir, devFile);
        const designFilePath = path.join(typeDir, designFile);
        console.log('[uicheck step 2] files:', files);
        console.log('[uicheck step 2] devFiles:', selection.devFiles);
        console.log('[uicheck step 2] designFiles:', selection.designFiles);
        console.log('[uicheck step 2] devFile:', devFile);
        console.log('[uicheck step 2] designFile:', designFile);
        console.log('[uicheck step 2] devPath:', devPath);
        console.log('[uicheck step 2] designFilePath:', designFilePath);
        const step2DevInfo = await logImageInfo('step2-dev-original', devPath);
        const step2DesignInfo = await logImageInfo('step2-design-original', designFilePath);
        // Use original uploaded files directly — skip intermediate sharp conversion
        // (sharp re-encode was causing model to read wrong image content)
        const analysisDevPath = devPath;
        const analysisDesignPath = designFilePath;
        const step2AnalysisDevInfo = step2DevInfo;
        const step2AnalysisDesignInfo = step2DesignInfo;
        const step2AnalysisPrompt = buildUICheckStep2AnalysisPrompt(designSpec, analysisDevPath, analysisDesignPath, bgContent);
        const step2PromptPath = writeUICheckPromptDebugFile('step2-analysis', step2AnalysisPrompt);
        const step2References = [SKILL_MD_PATH, ...loadSkillContext('analysis').map(f => f.path)].filter(fp => fs.existsSync(fp));
        logUICheckRunMeta('step2', {
          flowName: flow.flowName,
          flowFunction: flow.flowFunction,
          promptFilePath: step2PromptPath,
          imageRefs: [toCodeFlickerFileRef(analysisDevPath), toCodeFlickerFileRef(analysisDesignPath)],
          referenceFiles: step2References
        });
        console.log('[uicheck step2] final prompt:\n' + step2AnalysisPrompt);
        console.log('[uicheck step2] prompt image refs:', JSON.stringify([
          toCodeFlickerFileRef(analysisDevPath),
          toCodeFlickerFileRef(analysisDesignPath)
        ]));
        await appendUICheckRuntimeDebug({
          phase: 'step2-before-model',
          flow,
          promptFilePath: step2PromptPath,
          files,
          devFiles: selection.devFiles,
          designFiles: selection.designFiles,
          selected: {
            devFile,
            designFile,
            devPath,
            designPath: designFilePath,
            analysisDevPath,
            analysisDesignPath
          },
          imageInfo: {
            dev: step2DevInfo,
            design: step2DesignInfo,
            analysisDev: step2AnalysisDevInfo,
            analysisDesign: step2AnalysisDesignInfo
          },
          referenceFiles: step2References,
          imageRefs: [toCodeFlickerFileRef(analysisDevPath), toCodeFlickerFileRef(analysisDesignPath)],
          prompt: step2AnalysisPrompt,
          parsedJson: designSpec
        });

        // Phase A: issue detection only (stream-json for raw debug + final text extraction)
        const step2Args = [
          '--model', visionModel,
          '-q', '--approval-mode', 'yolo',
          '--output-format', 'stream-json',
          step2AnalysisPrompt
        ];
        console.log('[uicheck step2] flickcli args:', JSON.stringify(step2Args));
        const flickcli2 = spawn('flickcli', step2Args, {
          cwd: PARENT_DIR,
          env: { ...process.env }
        });

        const STEP2_ANALYSIS_TIMEOUT_MS = 8 * 60 * 1000;
        let step2AnalysisTimedOut = false;
        const step2AnalysisTimer = setTimeout(() => {
          step2AnalysisTimedOut = true;
          console.log('[uicheck step2 analysis] timeout - killing process');
          flickcli2.kill('SIGTERM');
          setTimeout(() => { try { flickcli2.kill('SIGKILL'); } catch {} }, 3000);
        }, STEP2_ANALYSIS_TIMEOUT_MS);

        let step2StartTime = Date.now();
        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - step2StartTime) / 1000);
          res.write(`data: ${JSON.stringify({ type: 'status', content: `正在对比开发稿...（已运行 ${elapsed} 秒）` })}\n\n`);
        }, 15000);

        let step2RawLines = '';
        flickcli2.stdout.on('data', (chunk) => {
          step2RawLines += chunk.toString();
        });
        flickcli2.stderr.on('data', (chunk) => {
          console.log('[uicheck step2 analysis stderr]', chunk.toString().slice(0, 200));
        });

        flickcli2.on('close', async (code2) => {
          clearTimeout(step2AnalysisTimer);
          const rawOutput = step2RawLines;
          const analysisOutput = extractTextFromStreamJson(step2RawLines).trim();
          fs.writeFileSync('/tmp/codeflicker-uicheck-step2-analysis-raw.txt', rawOutput);
          fs.writeFileSync('/tmp/codeflicker-uicheck-step2-analysis.txt', analysisOutput);
          console.log('[uicheck step2 analysis] closed, code:', code2, 'output length:', analysisOutput.length);

          if (step2AnalysisTimedOut) {
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ type: 'error', content: '开发稿问题识别超时（8分钟），请查看 /tmp/codeflicker-uicheck-step2-analysis.txt' })}\n\n`);
            res.end();
            return;
          }

          if (code2 !== 0) {
            clearInterval(heartbeat);
            const quotaErr2 = /quota|authenticate|403|token-plan/i.test(analysisOutput);
            const errMsg2 = quotaErr2
              ? '开发稿对比失败：CodeFlicker 额度或鉴权异常（403/token-plan）。请先恢复可用额度后重试。'
              : `开发稿对比失败（退出码 ${code2}）。请查看服务端日志和 /tmp/codeflicker-uicheck-step2-analysis.txt`;
            res.write(`data: ${JSON.stringify({ type: 'error', content: errMsg2 })}\n\n`);
            res.end();
            return;
          }

          // Detect vision model quota exhaustion for step2
          const step2QuotaExhausted = /额度上限|已达到使用额度|fallback to wanqing/i.test(rawOutput);
          if (step2QuotaExhausted) {
            clearInterval(heartbeat);
            console.log('[uicheck step2] ERROR: vision model quota exhausted');
            res.write(`data: ${JSON.stringify({ type: 'error', content: '对比阶段视觉模型额度已用完，无法读图。请等待额度刷新（约12小时）后重试。' })}\n\n`);
            res.end();
            return;
          }

          const issueData = parseIssuesFromOutput(analysisOutput);
          console.log('[uicheck step2] parsed JSON:', JSON.stringify(issueData, null, 2));

          const verificationGate = ensureUICheckReadVerificationOrThrow(analysisOutput, 'step2');
          if (!verificationGate.ok) {
            clearInterval(heartbeat);
            console.log('[uicheck step2] verification failed:', verificationGate.reason);
            await appendUICheckRuntimeDebug({
              phase: 'step2-verification-failed',
              flow,
              verification: verificationGate.verification,
              reason: verificationGate.reason,
              rawOutput,
              analysisOutput
            });
            res.write(`data: ${JSON.stringify({ type: 'error', content: '读图验证失败：' + verificationGate.reason + '。请检查上传的开发截图和设计稿是否正确。' })}\n\n`);
            res.end();
            return;
          }

          if (!issueData) {
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ type: 'error', content: '开发稿问题识别完成，但未解析到有效 JSON。请查看 /tmp/codeflicker-uicheck-step2-analysis.txt' })}\n\n`);
            res.end();
            return;
          }

          res.write(`data: ${JSON.stringify({ type: 'status', content: '正在生成问题截图...' })}\n\n`);

          // Phase B: Local Python crop + draw box (no codeflicker spawn)
          // Model outputs CropRegion + Box coordinates in Phase A; Python uses them directly
          const flatIssues = flattenIssueData(issueData);
          const screenshotScript = generateScreenshotScript(flatIssues, devPath, designFilePath);
          try {
            const scriptResult = await executeScreenshotScript(screenshotScript);
            console.log('[uicheck step2 screenshot] Python done:', scriptResult.stdout.trim());
          } catch (screenshotErr) {
            console.log('[uicheck step2 screenshot] Python error:', screenshotErr.message);
          }

          const mergedData = attachGeneratedIssueImages(issueData);
          clearInterval(heartbeat);
          const mergedJsonStr = '```json\n' + JSON.stringify(mergedData, null, 2) + '\n```';
          await appendUICheckRuntimeDebug({
            phase: 'step2-after-model',
            flow,
            parsedJson: issueData,
            mergedJson: mergedData
          });
          await generateIssueTable(mergedJsonStr, files, typeDir, false, res);
          res.write(`data: ${JSON.stringify({ type: 'done', code: 0 })}\n\n`);
          res.end();
        });
        flickcli2.on('error', (err) => {
          clearTimeout(step2AnalysisTimer);
          clearInterval(heartbeat);
          res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
          res.end();
        });
        return;
      }

      console.log('[uicheck step 2] missing dev file or empty design spec');
      res.write(`data: ${JSON.stringify({ type: 'error', content: '设计稿结构解析失败，请检查设计稿是否可读，或查看 /tmp/flickcli-uicheck-output.txt 排查 FlickCLI 输出。' })}\n\n`);
      res.end();
      return;
    }

    // For lowfi/builder: extract figma plugin code
    if (type === 'lowfi' || type === 'builder') {
      try {
        const pluginMatch = fullTextOutput.match(/```figma-plugin\s*([\s\S]*?)```/);
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

  flickcli.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    res.end();
  });
});

// Fetch URL content
async function fetchUrlContent(url) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return null;
    const html = await response.text();
    // Strip HTML tags to get text content
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/&nbsp;/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();
    if (text.length < 500 || /^(login|登录|sign in)$/i.test(text)) return null;
    return text.substring(0, 30000);
  } catch {
    return null;
  }
}

// Build prompts for each type
function buildPRDPrompt(files, type) {
  const txtFiles = files.filter(f => /\.txt$|\.md$/i.test(f));
  const imgFiles = files.filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  const typeDir = getInputsDir(type);
  const imageRefs = toCodeFlickerImageRefs(typeDir, imgFiles);

  let imgStep = '';
  if (imageRefs.length > 0) {
    imgStep = 'Step 3（图片）：以下上传了 ' + imageRefs.length + ' 张图片。注意：其中可能混有非设计相关截图（用户信息、表格数据、背景资料等），请只关注与产品设计相关的图片（原型图、流程图、界面线框图、交互示意），忽略其他无关截图：\n';
    imageRefs.forEach(ref => {
      imgStep += '- ' + ref + '\n';
    });
    imgStep += '\n';
  }

  return `你是一名资深 UX 设计评审助手。请按以下步骤执行：

Step 1：使用 Read 工具读取 .codeflicker/skills/prdcheck/SKILL.md，了解评审规则。
Step 2：使用 Read 工具逐一读取 designer-platform/inputs/${type}/ 目录下的文本文件：${txtFiles.join(', ') || '无'}
${imgStep}Step 4：按照 SKILL.md 中的规则进行分析。

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

## 输出要求

请先用 Markdown 输出分析内容（格式自由），然后在最后**必须输出一个 JSON 代码块**，包含结构化数据，格式如下：

\`\`\`json
{
  "summary": {
    "goal": "一句话概括需求目标",
    "target_users": ["目标用户群体1", "目标用户群体2"],
    "core_scenarios": ["核心场景1", "核心场景2"],
    "main_modules": ["模块1", "模块2", "模块3"],
    "risk_count": {
      "p0": 0,
      "p1": 0,
      "p2": 0
    },
    "issue_count": 0,
    "open_question_count": 0
  },
  "flow": {
    "pages": ["页面1", "页面2"],
    "main_path": ["入口", "页面A", "页面B", "结果页"],
    "unclear_steps": ["不清楚的步骤"]
  },
  "issues": [
    {
      "id": 1,
      "type": "formal",
      "priority": "P0",
      "module": "所属模块",
      "problem": "问题标题",
      "reason": "为什么不合理",
      "impact": "会影响什么",
      "suggestion": "建议怎么调整",
      "pm_question": "需要向 PM 确认的问题（可选，无则空字符串）"
    }
  ],
  "design_focus": {
    "关键决策点1": "说明",
    "关键决策点2": "说明"
  },
  "score": {
    "total": 0,
    "dimensions": {
      "completeness": { "score": 0, "label": "完整性", "desc": "评分理由" },
      "flow_clarity": { "score": 0, "label": "流程清晰", "desc": "评分理由" },
      "state_coverage": { "score": 0, "label": "状态覆盖", "desc": "评分理由" },
      "rule_consistency": { "score": 0, "label": "规则一致", "desc": "评分理由" }
    }
  }
}
\`\`\`

每个维度的 desc 字段必须填写一句简短的评分理由（20字以内）。
issues 数组包含所有发现的问题。priority 为 "P0"（严重）、"P1"（中等）、"P2"（轻微）或 "待确认"。
design_focus 是一个对象，key 为关注点名称，value 为详细说明。

## 评分规则（满分 80，4 个维度各 20 分）

以下规则必须严格按公式计算，确保相同内容每次评分结果一致：

1. **完整性 (completeness)** — 按页面和模块覆盖度计分：
   - 满分 20。如果文档包含 ≥4 个页面且每页有 ≥2 个模块描述，给 20 分。
   - 3 个页面或模块描述基本完整 → 17 分。
   - 2 个页面或模块描述清晰但有遗漏 → 14 分。
   - 1-2 个页面且多处遗漏 → 10 分。
   - 只有 1 个页面且描述不充分 → 5 分。

2. **流程清晰 (flow_clarity)** — 按主流程步骤数和不清晰步骤数计分：
   - 满分 20。主流程步骤 ≥3 且不清晰步骤 = 0，给 20 分。
   - 主流程 ≥3 步且不清晰步骤 ≤1 → 17 分。
   - 主流程 ≥2 步且不清晰步骤 ≤2 → 14 分。
   - 主流程 1 步或不清晰步骤 ≥3 → 8 分。
   - 无主流程 → 5 分。

3. **状态覆盖 (state_coverage)** — 按文档中是否提及各类状态反馈计分：
   - 满分 20。明确提及空态、加载态、异常态、成功反馈、权限态中 ≥4 种 → 20 分。
   - 提及 3 种状态 → 15 分。
   - 提及 2 种状态 → 10 分。
   - 提及 1 种状态 → 5 分。
   - 完全未提及任何状态 → 0 分。

4. **规则一致 (rule_consistency)** — 按文档中是否存在规则/文案/行为矛盾计分：
   - 满分 20。无前后矛盾、文案一致、按钮行为统一 → 20 分。
   - 有 1 处小矛盾 → 15 分。
   - 有 2 处矛盾 → 10 分。
   - 有 ≥3 处矛盾 → 5 分。
   - 文档未提供任何规则 → 0 分。

计算总分 = completeness + flow_clarity + state_coverage + rule_consistency。

总分等级：
- 85-100：优秀，可直接进入设计
- 70-84：良好，有小问题需修正
- 55-69：及格，有中等问题需确认
- 40-54：较差，有明显逻辑/流程缺陷
- 0-39：不合格，需大幅重写`;
}

function buildUICheckPrompt(files, type, uicheckContext = null) {
  const txtFiles = files.filter(f => /background\.txt$/i.test(f));
  const typeDir = getInputsDir(type);
  const flow = uicheckContext?.flow || resolveUICheckFlow(files, uicheckContext?.latestUploadState || null);

  if (flow.mode === 'folder') {
    throw new Error('uicheck folder-mode is disabled for current requests');
  }

  // Single page mode — Step 1: analyze design ONLY, output module spec
  const designFile = files.find(f => /design_mockup/i.test(f)) || files.find(f => /^design[_-]/i.test(f)) || files.find(f => isUICheckImageFile(f));
  const designAbsPath = path.resolve(path.join(typeDir, designFile));

  const bgContent = txtFiles.length > 0
    ? readTextFileIfExists(path.resolve(path.join(typeDir, txtFiles[0]))).trim().slice(0, 2000)
    : '';

  let prompt = `你是一名资深 UI 设计师。分析下面这张**设计稿**图片，从上到下列出页面模块。

## 设计稿图片

@${designAbsPath}

## 读图验证（必须先执行）

先输出“读图验证”段落，严格包含：
1. 图片中真实可见的标题/页面名称（逐字引用）
2. 图片顶部主色、主背景色
3. 从上到下第一个主要模块名称

如果无法看到图片内容，输出“读图验证失败：[reason]” 并停止。

禁止凭想象编造内容，只输出图片中实际可见的。
JSON 字段值中禁止出现中文引号（""），只用英文双引号，如需引用含引号的文字用单引号替代。
`;
  if (bgContent) {
    prompt += `\n## 背景信息\n${bgContent}\n`;
  }
  prompt += `\n## 输出格式\n`;
  prompt += `先输出读图验证，然后输出 JSON 数组：\n`;
  prompt += `\`\`\`json\n`;
  prompt += `[\n`;
  prompt += `  {"order": 1, "name": "模块名称", "content": "模块内容概述", "visual": "视觉特征概述"},\n`;
  prompt += `  {"order": 2, "name": "模块名称", "content": "模块内容概述", "visual": "视觉特征概述"}\n`;
  prompt += `]\n`;
  prompt += `\`\`\`\n`;

  return prompt;
}

function buildUsertestPrompt(files, type) {
  const txtFiles = files.filter(f => /\.(txt|md)$/i.test(f));
  const imgFiles = files.filter(f => /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(f));
  const typeDir = getInputsDir(type);
  const imageRefs = toCodeFlickerImageRefs(typeDir, imgFiles);
  let msg = `你是一名资深移动端UI/UX可用性评测专家，具备用户行为心理分析能力。请按以下步骤执行：\n\n`;
  msg += `Step 1：使用 Read 工具读取 .codeflicker/skills/usertest/SKILL.md，了解评测规则。\n`;
  msg += `Step 2：使用 Read 工具读取以下文件：\n`;
  if (txtFiles.length > 0) msg += `  - 用户画像文件：designer-platform/inputs/${type}/${txtFiles[0]}\n`;
  if (imageRefs.length > 0) {
    msg += `Step 2.1：读取以下 UI 截图：\n`;
    for (const ref of imageRefs) msg += `  - ${ref}\n`;
  }
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
  const typeDir = getInputsDir(type);
  const imageRefs = toCodeFlickerImageRefs(typeDir, imgFiles);
  let msg = `你是轻量化UX原型隐患分析师。请按以下步骤执行：\n\n`;
  msg += `Step 1：使用 Read 工具读取 .codeflicker/skills/edgecase/SKILL.md，了解分析规则。\n`;
  msg += `Step 2：使用 Read 工具读取以下文件：\n`;
  if (txtFiles.length > 0) msg += `  - 用户画像文件：designer-platform/inputs/${type}/${txtFiles[0]}\n`;
  if (imageRefs.length > 0) {
    msg += `Step 2.1：读取以下原型截图：\n`;
    for (const ref of imageRefs) msg += `  - ${ref}\n`;
  }
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
  msg += `Step 1：使用 Read 工具读取 .codeflicker/skills/colortry/SKILL.md，了解配色规则。\n`;
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
  msg += `Step 1：使用 Read 工具读取 .codeflicker/skills/lowfi/SKILL.md，了解完整规则和规范。\n`;
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
  msg += `Step 1：使用 Read 工具读取 .codeflicker/skills/builder/SKILL.md，了解完整规则和组件规范。\n`;
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

// Debug endpoint - 直接查看 FlickCLI 是否被调用
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

开发稿截图：${toCodeFlickerFileRef(devPath)}
设计稿截图：${toCodeFlickerFileRef(designPath)}

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

  const flickcli = spawn('flickcli', [
    '-q', '--approval-mode', 'yolo', '--output-format', 'text', fullPrompt
  ], {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  let fullOutput = '';
  flickcli.stdout.on('data', (chunk) => { fullOutput += chunk.toString(); });
  flickcli.stderr.on('data', (chunk) => { console.log('[figma-debug stderr]:', chunk.toString().substring(0, 500)); });

  flickcli.on('close', (code) => {
    console.log('[figma-check-debug] FlickCLI output length:', fullOutput.length);
    console.log('[figma-check-debug] FlickCLI output preview:', fullOutput.substring(0, 500));

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
      flickcliExitCode: code,
      outputLength: fullOutput.length,
      outputPreview: fullOutput.substring(0, 1000),
      issuesCount: issues.length,
      issues: issues,
      files: files,
      devPath: devPath,
      designPath: designPath
    });
  });

  flickcli.on('error', (err) => {
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

图片：${toCodeFlickerFileRef(designPath)}

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

  const flickcli = spawn('flickcli', [
    '-q', '--approval-mode', 'yolo', '--output-format', 'text', prompt
  ], {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  let fullOutput = '';
  flickcli.stdout.on('data', (chunk) => { fullOutput += chunk.toString(); });

  const timeout = setTimeout(() => { flickcli.kill(); }, 3 * 60 * 1000);

  flickcli.on('close', () => {
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

  flickcli.on('error', (err) => {
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
图片：${toCodeFlickerFileRef(devPath)}

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

  const flickcli = spawn('flickcli', [
    '-q', '--approval-mode', 'yolo', '--output-format', 'text', prompt
  ], {
    cwd: PARENT_DIR,
    env: { ...process.env }
  });

  let fullOutput = '';
  flickcli.stdout.on('data', (chunk) => { fullOutput += chunk.toString(); });
  flickcli.stderr.on('data', (chunk) => { console.log('[figma-dev stderr]:', chunk.toString().substring(0, 200)); });

  const timeout = setTimeout(() => {
    flickcli.kill();
    if (!res.headersSent) {
      res.status(504).json({ error: '走查超时' });
    }
  }, 5 * 60 * 1000);

  flickcli.on('close', () => {
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

  flickcli.on('error', (err) => {
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
