# Output Schema

当用户要求输出 JSON / 可视化页面数据时，必须输出以下结构：

```json
{
  "summary": {
    "goal": "",
    "target_users": [],
    "core_scenarios": [],
    "main_modules": [],
    "risk_count": {
      "p0": 0,
      "p1": 0,
      "p2": 0
    },
    "issue_count": 0,
    "open_question_count": 0
  },
  "flow": {
    "pages": [],
    "main_path": [],
    "unclear_steps": []
  },
  "score": {
    "total": 0,
    "dimensions": {
      "completeness": { "score": 0, "label": "完整性", "desc": "" },
      "flow_clarity": { "score": 0, "label": "流程清晰", "desc": "" },
      "state_coverage": { "score": 0, "label": "状态覆盖", "desc": "" },
      "rule_consistency": { "score": 0, "label": "规则一致", "desc": "" },
      "risk_level": { "score": 0, "label": "风险程度", "desc": "" }
    }
  },
  "issues": [],
  "design_focus": {}
}
```

评分规则（满分 100，5 个维度各 20 分）：

- **完整性 (completeness)**：页面描述是否完整、核心模块是否清晰定义
- **流程清晰 (flow_clarity)**：主流程是否完整、用户路径是否清晰无歧义
- **状态覆盖 (state_coverage)**：空态/加载态/错误态/异常反馈/权限态等是否覆盖
- **规则一致 (rule_consistency)**：交互规则、文案、按钮行为是否前后一致
- **风险程度 (risk_level)**：根据 P0/P1/P2 数量扣分（无P0=20，P0=1→15，P0>=2→10；每多2个P1扣2分）

总分等级参考：
- 85-100：优秀，可直接进入设计
- 70-84：良好，有小问题需修正
- 55-69：及格，有中等问题需确认
- 40-54：较差，有明显逻辑/流程缺陷
- 0-39：不合格，需大幅重写
