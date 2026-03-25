#!/usr/bin/env node
// claude-code-agent.mjs
// 接收一段指令文字，通过 Claude Agent SDK 调用 Claude Code 执行任务
// 用法: node claude-code-agent.mjs "<任务描述>" "<工作目录>"

import { query } from '@anthropic-ai/claude-agent-sdk';

const prompt = process.argv[2];
const cwd    = process.argv[3] || '/Users/tricia';

if (!prompt) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'no_prompt' }));
  process.exit(1);
}

try {
  let finalResult = '';

  for await (const msg of query({
    prompt,
    options: {
      cwd,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      permissionMode: 'acceptEdits',
      maxTurns: 10,
    }
  })) {
    // 捕获最终结果
    if ('result' in msg && msg.result) {
      finalResult = msg.result;
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    result: finalResult || '任务完成。',
  }));

} catch (err) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: err.message || 'agent_failed',
  }));
  process.exit(1);
}
