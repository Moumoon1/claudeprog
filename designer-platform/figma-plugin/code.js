// DesignPilot 走查助手
// 插件内部导出 PNG，UI 直接发给服务器做视觉识别

figma.showUI(__html__, { width: 420, height: 560 });

function getExportableNode(node) {
  var types = ["FRAME", "PAGE", "COMPONENT", "COMPONENT_SET", "SECTION"];
  return types.indexOf(node.type) >= 0;
}

// 根据帧名称判断是开发稿还是设计稿
function detectFrameType(node) {
  var name = node.name.toLowerCase();
  if (/dev|开发|实现/.test(name)) return "dev";
  if (/design|设计|效果图/.test(name)) return "design";
  return "unknown";
}

function makeNodeInfo(node) {
  return { name: node.name, id: node.id, valid: getExportableNode(node), count: countChildren(node) };
}

function updateSelection() {
  var sel = figma.currentPage.selection;
  var devNode = null;
  var designNode = null;

  if (sel.length === 0) {
    figma.ui.postMessage({ type: "selection", dev: null, design: null });
    return;
  }

  // 先按名称自动分类
  for (var i = 0; i < sel.length; i++) {
    var type = detectFrameType(sel[i]);
    if (type === "dev") devNode = makeNodeInfo(sel[i]);
    else if (type === "design") designNode = makeNodeInfo(sel[i]);
  }

  // 如果名称无法区分，用选中顺序兜底
  if (!devNode && !designNode && sel.length >= 2) {
    devNode = makeNodeInfo(sel[0]);
    designNode = makeNodeInfo(sel[1]);
  } else if (!devNode && sel.length === 1 && !designNode) {
    designNode = makeNodeInfo(sel[0]);
  } else if (!devNode && sel.length >= 1 && designNode) {
    // 有 design 但没有 dev，第一个未知类型当作 dev
    for (var j = 0; j < sel.length; j++) {
      if (detectFrameType(sel[j]) === "unknown") {
        devNode = makeNodeInfo(sel[j]);
        break;
      }
    }
  } else if (devNode && !designNode && sel.length >= 2) {
    // 有 dev 但没有 design，第二个未知类型当作 design
    for (var k = 0; k < sel.length; k++) {
      if (detectFrameType(sel[k]) === "unknown") {
        designNode = makeNodeInfo(sel[k]);
        break;
      }
    }
  }

  figma.ui.postMessage({ type: "selection", dev: devNode, design: designNode });
}

function countChildren(node) {
  var c = node.children ? node.children.length : 0;
  return c;
}

// 将图片 buffer 转为 base64（手动实现 base64 编码，不依赖 btoa）
function safeToBase64(buf) {
  var bytes;
  if (buf instanceof Uint8Array) {
    bytes = buf;
  } else if (buf instanceof ArrayBuffer) {
    bytes = new Uint8Array(buf);
  } else if (buf && typeof buf.buffer === "object" && buf.buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } else {
    var arr = new Uint8Array(buf.length);
    for (var i = 0; i < buf.length; i++) arr[i] = buf[i];
    bytes = arr;
  }

  var base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var result = "";
  var len = bytes.length;
  for (var i = 0; i < len; i += 3) {
    var a = bytes[i];
    var b = i + 1 < len ? bytes[i + 1] : 0;
    var c = i + 2 < len ? bytes[i + 2] : 0;
    result += base64Chars.charAt(a >> 2);
    result += base64Chars.charAt(((a & 3) << 4) | (b >> 4));
    result += base64Chars.charAt(i + 1 < len ? (((b & 15) << 2) | (c >> 6)) : 64);
    result += base64Chars.charAt(i + 2 < len ? (c & 63) : 64);
  }
  return result;
}

figma.ui.onmessage = function(msg) {
  if (msg.type === "start-review") {
    var sel = figma.currentPage.selection;
    if (sel.length < 2) {
      figma.ui.postMessage({ type: "error", message: "请先选中两个 Frame" });
      return;
    }

    // 自动识别开发稿和设计稿
    var devNode = null;
    var designNode = null;
    var unknowns = [];

    for (var i = 0; i < sel.length; i++) {
      var frameType = detectFrameType(sel[i]);
      if (frameType === "dev") devNode = sel[i];
      else if (frameType === "design") designNode = sel[i];
      else unknowns.push(sel[i]);
    }

    // 名称无法区分时，用前两个 Frame
    if (!devNode && !designNode && unknowns.length >= 2) {
      devNode = unknowns[0];
      designNode = unknowns[1];
    } else if (!devNode && unknowns.length >= 1) {
      devNode = unknowns[0];
    } else if (!designNode && unknowns.length >= 1) {
      designNode = unknowns[0];
    }

    if (!devNode || !designNode) {
      figma.ui.postMessage({ type: "error", message: "无法区分开发稿和设计稿，请在帧名称中包含'开发/dev'或'设计/design'" });
      return;
    }

    if (!getExportableNode(devNode) || !getExportableNode(designNode)) {
      figma.ui.postMessage({ type: "error", message: "请确保选中的是两个 Frame" });
      return;
    }

    figma.ui.postMessage({ type: "status", message: "正在导出图片..." });

    setTimeout(function() {
      if (typeof devNode.exportAsync !== "function") {
        figma.ui.postMessage({ type: "error", message: "node.exportAsync 不存在 (devNode.type=" + devNode.type + ")" });
        return;
      }

      var promise1 = devNode.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
      if (!promise1 || typeof promise1.then !== "function") {
        figma.ui.postMessage({ type: "error", message: "exportAsync 返回的不是 Promise (返回类型: " + typeof promise1 + ")" });
        return;
      }

      promise1.then(
        function(buf1) {
          figma.ui.postMessage({ type: "debug", message: "dev exported, size=" + buf1.length });

          var promise2 = designNode.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
          if (!promise2 || typeof promise2.then !== "function") {
            figma.ui.postMessage({ type: "error", message: "设计稿 exportAsync 返回的不是 Promise" });
            return;
          }

          promise2.then(
            function(buf2) {
              figma.ui.postMessage({ type: "debug", message: "design exported, size=" + buf2.length });

              try {
                var devB64 = safeToBase64(buf1);
                figma.ui.postMessage({ type: "debug", message: "dev base64 done, length=" + devB64.length });
              } catch (e) {
                figma.ui.postMessage({ type: "error", message: "开发稿 base64 失败: " + (e && e.message || String(e)) });
                return;
              }

              try {
                var designB64 = safeToBase64(buf2);
                figma.ui.postMessage({ type: "debug", message: "design base64 done, length=" + designB64.length });
              } catch (e) {
                figma.ui.postMessage({ type: "error", message: "设计稿 base64 失败: " + (e && e.message || String(e)) });
                return;
              }

              figma.ui.postMessage({
                type: "send-to-server",
                devB64: devB64,
                designB64: designB64,
                bgText: msg.bgText || "",
                devName: devNode.name,
                designName: designNode.name,
                devCount: countChildren(devNode),
                designCount: countChildren(designNode)
              });
            },
            function(e2) {
              figma.ui.postMessage({ type: "error", message: "设计稿导出失败: " + (e2 && e2.message || String(e2)) });
            }
          );
        },
        function(e1) {
          figma.ui.postMessage({ type: "error", message: "开发稿导出失败: " + (e1 && e1.message || String(e1)) });
        }
      );
    }, 100);
  }

  if (msg.type === "review-result") {
    var sel = figma.currentPage.selection;
    // 用名称识别开发稿，不再依赖 sel[0]
    var devNode = null;
    for (var n = 0; n < sel.length; n++) {
      if (detectFrameType(sel[n]) === "dev") {
        devNode = sel[n];
        break;
      }
    }
    if (!devNode && sel.length >= 1) devNode = sel[0];

    var issues = msg.issues || [];
    if (issues.length > 0) {
      drawIssues(devNode, issues);
      figma.notify("走查完成：发现 " + issues.length + " 个问题", { timeout: 3000 });
    } else {
      figma.notify("走查完成：未发现明显问题", { timeout: 3000 });
    }
  }

  if (msg.type === "review-error") {
    figma.notify("走查失败: " + String(msg.message || ""), { error: true });
  }
};

function drawIssues(devNode, issues) {
  var devX = devNode.x;
  var devY = devNode.y;
  var devW = devNode.width;
  var devH = devNode.height;

  var colors = {
    high: { r: 0.84, g: 0.12, b: 0.12 },
    medium: { r: 0.91, g: 0.59, b: 0.07 },
    low: { r: 0.13, g: 0.59, b: 0.95 }
  };

  var count = 0;
  for (var i = 0; i < issues.length; i++) {
    var issue = issues[i];
    var yPercent = issue.dev_y;
    // 兼容旧的 dev_region 字段
    if (yPercent === undefined && issue.dev_region) {
      var map = { top: 10, midtop: 25, mid: 50, midbottom: 65, bottom: 85, header: 8, tab: 6, footer: 88 };
      yPercent = map[issue.dev_region] || 50;
    }
    if (yPercent === undefined) continue;

    var sev = issue.severity || "medium";
    var sevColor = colors[sev] || colors.medium;

    var boxH = Math.max(20, devH * 0.08);
    var boxY = devY + (yPercent / 100) * devH - boxH / 2;
    boxY = Math.max(devY, Math.min(boxY, devY + devH - boxH));

    var hl = figma.createRectangle();
    hl.name = "标注_" + (sev === "high" ? "P0" : sev === "medium" ? "P1" : "P2") + "_" + (i + 1);
    hl.x = devX + 5;
    hl.y = boxY;
    hl.resize(devW - 10, boxH);
    hl.fills = [{ type: "SOLID", color: sevColor, opacity: 0.10 }];
    hl.strokes = [{ type: "SOLID", color: sevColor, opacity: 0.8 }];
    hl.strokeWeight = 2;
    hl.dashPattern = [6, 4];
    hl.locked = true;

    try {
      devNode.parent.appendChild(hl);
    } catch (e) {}

    count++;
  }

}

figma.on("selectionchange", function() { updateSelection(); });
updateSelection();
