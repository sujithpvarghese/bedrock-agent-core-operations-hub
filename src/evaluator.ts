import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { agent } from './agent';
import * as fs from 'fs';
import * as path from 'path';

const bedrockRuntime = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

const JUDGE_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const PASS_THRESHOLD = 70;

/**
 * LLM-as-Judge: Sends the agent output + ground truth to Claude
 * and gets back a semantic accuracy score (0-100) with reasoning.
 * This is far more reliable than keyword matching.
 */
async function judgeWithClaude(
  scenarioName: string,
  agentOutput: string,
  groundTruth: string
): Promise<{ score: number; reasoning: string }> {

  const judgePrompt = `You are a strict evaluation judge for an autonomous AI agent system that diagnoses and fixes e-commerce product data issues.

Scenario being evaluated: "${scenarioName}"

The agent produced this output:
<agent_output>
${agentOutput}
</agent_output>

The expected ground truth is:
<ground_truth>
${groundTruth}
</ground_truth>

Evaluate the agent's output against the ground truth. Score based on:
1. Did the agent correctly identify the root cause of the issue?
2. Did the agent investigate the right upstream systems?
3. Did the agent take the correct remediation actions?
4. Did the agent verify the fix was successful?
5. Is the overall response accurate, complete, and coherent?

Respond ONLY with valid JSON in this exact format — no other text:
{"score": <integer 0-100>, "reasoning": "<one concise sentence explaining the score>"}`;

  const response = await bedrockRuntime.send(new InvokeModelCommand({
    modelId: JUDGE_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 256,
      messages: [{ role: 'user', content: judgePrompt }]
    })
  }));

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const rawText = responseBody.content[0].text.trim();

  try {
    const rawText = responseBody.content[0].text.trim();
    // Claude often wraps JSON in markdown blocks (e.g. ```json ... ```)
    const cleanedText = rawText.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleanedText);
  } catch (err: any) {
    // Fallback if judge response is completely malformed or unparseable
    const rawText = JSON.parse(new TextDecoder().decode(response.body))?.content?.[0]?.text?.trim() || "No response";
    return { score: 0, reasoning: `Judge response could not be parsed: ${rawText}` };
  }
}

async function runEvals() {
  const evalPath = path.join(__dirname, '../config/eval.json');
  const { test_suite, scenarios } = JSON.parse(fs.readFileSync(evalPath, 'utf8'));

  console.log('\n============================================');
  console.log('  🧑‍⚖️  LLM-as-Judge Evaluation Suite');
  console.log(`  📋 Suite   : ${test_suite}`);
  console.log(`  🤖 Judge   : Claude 3.5 Sonnet v2 (Bedrock)`);
  console.log(`  ✅ Threshold: ${PASS_THRESHOLD}/100`);
  console.log('============================================\n');

  let totalScore = 0;
  let passedCount = 0;

  for (const scenario of scenarios) {
    console.log(`📝 [${scenario.name}]`);
    if (scenario.description) {
      console.log(`   ${scenario.description}`);
    }

    try {
      // Step 1: Run the agent against the scenario input
      const result = await agent.run({ userPrompt: scenario.input });

      // Step 2: Send to Claude judge for semantic evaluation
      const judgment = await judgeWithClaude(scenario.name, result.summary, scenario.ground_truth);

      const passed = judgment.score >= PASS_THRESHOLD;
      if (passed) passedCount++;
      totalScore += judgment.score;

      console.log(passed ? '✅ PASS' : '❌ FAIL');
      console.log(`📊 Score    : ${judgment.score}/100`);
      console.log(`🧑‍⚖️  Judgment : ${judgment.reasoning}`);
      if (!passed) {
        console.log(`   Agent Output : "${result.summary}"`);
        console.log(`   Ground Truth : "${scenario.ground_truth}"`);
      }
    } catch (err: any) {
      console.log('❌ FAIL (Execution Error)');
      console.log(`🛑 Error: ${err.message}`);
      console.log(`   Ground Truth : "${scenario.ground_truth}"`);
    }
    console.log('--------------------------------------------\n');
  }

  const avgScore = (totalScore / scenarios.length).toFixed(0);
  const passRate = ((passedCount / scenarios.length) * 100).toFixed(0);

  console.log('============================================');
  console.log('  🏆 FINAL RESULTS');
  console.log(`  Pass Rate  : ${passRate}%  (${passedCount}/${scenarios.length} scenarios)`);
  console.log(`  Avg Score  : ${avgScore}/100`);
  console.log('============================================\n');
}

runEvals().catch(err => {
  console.error('❌ Evaluation Suite Error:', err.message);
  process.exit(1);
});
