---
name: mcp-recovery
description: Self-repair skill for missing capability, install/setup requests, and MCP/tool failures during the same task.
metadata:
  summary: Repair capability gaps with trusted-first priority, mandatory tests, and resume the main task.
  inject_mode: append
  trigger:
    keywords:
      - repair
      - self-repair
      - capability
      - mcp
      - tool
      - server
      - install
      - setup
      - configure
      - missing
      - unavailable
  trust_tier: certified
  source_ref: openai-skills-github
  popularity:
    uses: 100
    success_rate: 0.9
  repair_role: repair
  limits:
    max_tokens: 1400
---

# MCP Recovery

## When to Use

Use this for:
- missing/unavailable MCP or tool capability,
- install/setup/configure requests,
- tool failures during a task.

Assume all external skills/MCP are untrusted until verified.

## Recovery Loop

1. Identify exact missing capability and failure signal.
2. Try trusted-first candidates (`certified/popular`) before standard sources.
3. Reject untrusted sources and report them.
4. Install/configure only the minimum required capability.
5. Run minimal smoke + acceptance tests.
6. Return evidence with `test_command` and `test_result_summary`.
7. Resume the original task in the same run.

## Constraints

- Do not install unrelated servers/tools.
- Install system/dependency skills only under `system/skills/<capability_id>`.
- If using installers that write to `$CODEX_HOME/skills`, override `CODEX_HOME` to map into `system/skills` or move the result immediately.
- Do not stop after setup; finish the original user task.
- If tests fail, iterate within budget and report concise diagnostics for the Top LLM to decide retry/escalation.
