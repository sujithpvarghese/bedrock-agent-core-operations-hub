import { Agent, BedrockModel, FunctionTool } from '@strands-agents/sdk';

/**
 * Bedrock AgentCore Operations Hub
 * Official Strands SDK Implementation v1.0.0-rc.1
 */

// 1. Define Model
const model = new BedrockModel({
  modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  region: process.env.AWS_REGION || "us-east-1"
});

// Environment toggle to demonstrate how this transitions to production
const IS_MOCK = process.env.USE_MOCKS !== 'false';

// 2. Define Tools
const checkWebTool = new FunctionTool({
  name: "checkWebDatabase",
  description: "Checks the live web system for the current sellability status of a product. Returns webInventory, webPrice, and status (SELLABLE or NOT_SELLABLE). Always call this FIRST before querying any upstream system.",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string", description: "The product or style ID to check on the web." }
    },
    required: ["productId"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "checkWebDatabase", target: input.productId }));
    
    if (!IS_MOCK) {
      // return await webSystemApi.getProductStatus(input.productId);
    }

    const isTarget = input.productId === "prod000" || input.productId === "prod_9982";
    return {
      productId: input.productId,
      status: isTarget ? "NOT_SELLABLE" : "SELLABLE",
      webInventory: isTarget ? 0 : 150,
      webPrice: isTarget ? 0.00 : 24.99,
      reason: isTarget ? ["webInventory is 0", "webPrice is $0.00"] : []
    };
  }
});

const inventoryTool = new FunctionTool({
  name: "checkInventory",
  description: "Checks global SKU inventory across all fulfillment centers.",
  inputSchema: {
    type: "object",
    properties: {
      skuId: { type: "string" }
    },
    required: ["skuId"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "checkInventory", skuId: input.skuId }));
    if (!IS_MOCK) {
      // return await inventoryService.getStock(input.skuId);
    }
    return { status: "SUCCESS", count: 150, location: "EastCoast_WH", skuId: input.skuId };
  }
});

const pricingTool = new FunctionTool({
  name: "checkPricing",
  description: "Checks the Pricing Engine for current item price and promo status.",
  inputSchema: {
    type: "object",
    properties: {
      skuId: { type: "string" }
    },
    required: ["skuId"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "checkPricing", skuId: input.skuId }));
    if (!IS_MOCK) {
      // return await pricingEngine.getPrice(input.skuId);
    }
    return { status: "SUCCESS", price: 24.99, promoActive: false, skuId: input.skuId };
  }
});

const troubleshootingTool = new FunctionTool({
  name: "queryGuide",
  description: "Consults the technical troubleshooting guide for error codes.",
  inputSchema: {
    type: "object",
    properties: {
      errorCode: { type: "string" }
    },
    required: ["errorCode"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "queryGuide", errorCode: input.errorCode }));
    
    if (!IS_MOCK) {
      // ACTUAL RAG IMPLEMENTATION: 
      // Query an Amazon Bedrock Knowledge Base (e.g., vector store of runbooks)
      // const response = await bedrockAgentRuntime.send(new RetrieveCommand({
      //   knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
      //   retrievalQuery: { text: \`How to resolve error code: \${input.errorCode}\` }
      // }));
      // return { resolution: response.retrievalResults[0].content.text };
    }
    
    const guide: Record<string, string> = {
      "ERR_INV_404": "SKU is missing from Upstream Inventory. RESOLUTION: Check PIM sync status.",
      "TIMEOUT": "Transient database lock. RESOLUTION: Trigger an autonomous sync.",
      "CONSUMERDATABASETIMEOUTEXCEPTION": "Transient database lock. RESOLUTION: Trigger an autonomous sync."
    };
    return { resolution: guide[input.errorCode] || "Escalate to L2." };
  }
});

const syncTool = new FunctionTool({
  name: "triggerAutoSync",
  description: "Initiates an autonomous synchronization event for a specific system (inventory or price). Call once per discrepancy found. Returns SYNC_TRIGGERED on success or SYNC_FAILED with an errorCode on failure.",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string" },
      skuId: { type: "string" },
      syncType: {
        type: "string",
        enum: ["inventory", "price", "pim"],
        description: "The specific upstream system to synchronize."
      }
    },
    required: ["syncType"]
  },
  callback: async (input: any) => {
    const target = input.productId || input.skuId || '';
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "triggerAutoSync", system: input.syncType, target }));

    if (!IS_MOCK) {
       // return await triggerEventBridgeSync(input.syncType, target);
    }

    // Simulate a sync failure for prod_dlq to test the error recovery path
    if (target === "prod_dlq" && input.syncType === "inventory") {
      console.warn(JSON.stringify({ event: "TOOL_ERROR", tool: "triggerAutoSync", reason: "CONSUMERDATABASETIMEOUTEXCEPTION" }));
      return {
        status: "SYNC_FAILED",
        system: input.syncType as string,
        target,
        errorCode: "CONSUMERDATABASETIMEOUTEXCEPTION",
        message: "Sync failed: could not acquire DB lock. Consult the troubleshooting guide.",
        timestamp: ""
      };
    }
    
    console.log(JSON.stringify({ event: "TOOL_SUCCESS", tool: "triggerAutoSync", target }));
    return {
      status: "SYNC_TRIGGERED",
      system: input.syncType as string,
      target,
      errorCode: "",
      message: "",
      timestamp: new Date().toISOString()
    };
  }
});

const pimTool = new FunctionTool({
  name: "checkPimService",
  description: "Checks the PIM (Product Information Management) Service for the upstream source-of-truth metadata: product name, publish flags, and display attributes. Use this when metadata or product visibility is suspect.",
  inputSchema: {
    type: "object",
    properties: {
      styleId: { type: "string", description: "The style or product ID to look up in PIM." }
    },
    required: ["styleId"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "checkPimService", styleId: input.styleId }));
    if (!IS_MOCK) {
      // return await pimApi.getProductMetadata(input.styleId);
    }
    return {
      source: "PIM Service",
      styleId: input.styleId,
      productName: "Premium Cotton Graphic Tee",
      publishFlag: true,
      imageComplete: true,
      launchDate: "2024-01-15"
    };
  }
});

const dlqTool = new FunctionTool({
  name: "checkDeadLetterQueue",
  description: "Checks if a previous sync job for this product failed and left a message stuck in the Dead Letter Queue (DLQ). Call this when a disparity is found between upstream and web data — the DLQ may explain WHY the web data is stale.",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string", description: "The product ID to check in the DLQ." }
    },
    required: ["productId"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "checkDeadLetterQueue", productId: input.productId }));
    if (!IS_MOCK) {
      // return await sqsClient.send(new ReceiveMessageCommand({ QueueUrl: process.env.DLQ_URL, ... }));
    }

    if (input.productId === "prod_dlq" || input.productId === "prod_9982") {
      return {
        productId: input.productId as string,
        inDLQ: true,
        dlqSize: 1,
        lastError: "ConsumerDatabaseTimeoutException - Failed to acquire DB lock after 3 retries",
        errorCode: "CONSUMERDATABASETIMEOUTEXCEPTION",
        status: "CRITICAL_FAILURE"
      };
    }
    return {
      productId: input.productId as string,
      inDLQ: false,
      dlqSize: 0,
      lastError: "",
      errorCode: "",
      status: "CLEAR"
    };
  }
});

const verifyTool = new FunctionTool({
  name: "verifyWebState",
  description: "Re-checks the live web database AFTER a sync to confirm the product is now SELLABLE. Always call this after triggering any sync to close the loop.",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string", description: "The product ID to verify on the web." }
    },
    required: ["productId"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "TOOL_CALL", tool: "verifyWebState", productId: input.productId }));
    if (!IS_MOCK) {
      // return await webSystemApi.getProductStatus(input.productId);
    }
    return {
      productId: input.productId,
      status: "SELLABLE",
      webInventory: 150,
      webPrice: 24.99,
      lastUpdated: new Date().toISOString()
    };
  }
});

/**
 * 3. Define the L2 Detective Sub-Agent (A2A Showcase)
 */
const checkCloudTrailLogs = new FunctionTool({
  name: "checkCloudTrailLogs",
  description: "Queries AWS CloudTrail for infrastructure API errors.",
  inputSchema: { type: "object", properties: { targetId: { type: "string" } } },
  callback: async () => { return { logs: "WARNING: DynamoDB write throttling detected on Table WebSystemProd." }; }
});

const checkJiraCommits = new FunctionTool({
  name: "checkJiraCommits",
  description: "Queries Jira for recent deployments or config changes.",
  inputSchema: { type: "object", properties: { component: { type: "string" } } },
  callback: async () => { return { recentCommits: "PR #404 merged: Lowered DynamoDB WCU limits to save costs." }; }
});

const l2DetectiveAgent = new Agent({
  name: "L2Detective",
  model,
  tools: [checkCloudTrailLogs, checkJiraCommits],
  systemPrompt: `You are an L2 Cloud Infrastructure Detective. You find the root cause of systemic outages. 
  Check CloudTrail for infrastructure errors, then check Jira for recent code changes that might explain them. 
  Return a 2-sentence definitive root-cause diagnosis.`
});

const delegateToL2Detective = new FunctionTool({
  name: "delegateToL2Detective",
  description: "Call this tool to hand off a systemic error (e.g., repeated sync failures) to the advanced L2 Infrastructure Detective agent.",
  inputSchema: {
    type: "object",
    properties: {
      errorCode: { type: "string" },
      targetProduct: { type: "string" }
    },
    required: ["errorCode"]
  },
  callback: async (input: any) => {
    console.log(JSON.stringify({ event: "A2A_HANDOFF", to: "L2Detective", reason: input.errorCode }));
    // 💥 A2A MAGIC: Pause the main agent, spin up the sub-agent with its own prompt/tools!
    const investigation = await l2DetectiveAgent.invoke(`Find root cause for error: ${input.errorCode} on ${input.targetProduct || 'system'}`);
    return { l2Verdict: investigation.toString() };
  }
});

/**
 * 4. Initialize the Main Orchestrator Agent
 */
const coreAgent = new Agent({
  name: "OpsHubAgent",
  model,
  tools: [checkWebTool, inventoryTool, pricingTool, pimTool, troubleshootingTool, dlqTool, syncTool, verifyTool, delegateToL2Detective],
  systemPrompt: `
    You are an autonomous e-commerce operations hub. Your goal is to diagnose and self-heal product data issues.
    Follow this strict reasoning cycle:

    0. EXTRACT INTENT: Before calling any tool, classify the user's complaint as either GENERIC or SPECIFIC.

       GENERIC complaints (vague availability issues — any system could be the cause):
       - e.g. "not showing on site", "not online", "can't find product", "not visible on web"
       - Action: Do NOT pre-mark any system. Proceed to Step 1 and let checkWebDatabase + its reason array fully drive the investigation.

       SPECIFIC complaints (user has identified a particular data problem):
       - "price is wrong" or "price looks off"     → pre-mark 'pricing' as suspect.
       - "out of stock" or "inventory looks wrong"  → pre-mark 'inventory' as suspect.
       - "wrong name", "wrong image", "wrong description", "not published" → pre-mark 'pim' as suspect.
       - Action: Pre-marked systems MUST be investigated in Step 2, even if checkWebDatabase returns SELLABLE.

    1. CHECK WEB STATE: Call checkWebDatabase to get the current site state (webInventory, webPrice, status, reason).
       - If status is SELLABLE AND the user has NOT stated a specific concern → stop and inform the user, no fix needed.
       - If status is NOT_SELLABLE → use the 'reason' array to identify which systems to investigate.
       - If status is SELLABLE BUT the user stated a specific concern (e.g. "price is wrong") → proceed to step 2 using the user's stated concern as the triage signal instead of the reason array.

    2. INVESTIGATE UPSTREAM: Only call upstream systems that are flagged — either from the 'reason' array OR from the user's stated intent in step 0.
       - inventory flagged → call checkInventory and compare upstream stock vs webInventory.
       - pricing flagged   → call checkPricing and compare upstream price vs webPrice.
       - pim flagged       → call checkPimService and compare upstream metadata vs web metadata.
       - If multiple systems are flagged, call them in parallel.
       - After confirming a disparity, ALSO call checkDeadLetterQueue — a stuck DLQ message may explain WHY the web data is stale.
       - If checkDeadLetterQueue returns inDLQ=true with an errorCode, call queryGuide(errorCode) BEFORE attempting any sync.

    3. REMEDIATE: For each confirmed discrepancy, call triggerAutoSync with the specific syncType ('inventory', 'price', or 'pim'). Make a separate call per system.
       - If triggerAutoSync returns SYNC_FAILED with an errorCode: call queryGuide(errorCode) to get the resolution, then retry triggerAutoSync once.
       - If it fails a second time, do NOT retry again. Instead, call the delegateToL2Detective tool to find the infrastructure root cause, then report the Detective's findings to the user.

    4. VERIFY: After ALL syncs are complete, ALWAYS call verifyWebState to confirm the fix worked.

    5. SUMMARIZE: Report what the web showed, what the user flagged, what upstream confirmed, what was synced, and the final verified state.

    - Special case: For SKU 1029, episodic memory indicates it was recently fixed. Call triggerAutoSync(syncType='inventory') immediately, then go to step 4.
  `
});

// 4. Export interface
export const agent = {
  run: async ({ userPrompt }: { userPrompt: string }) => {
    const result = await coreAgent.invoke(userPrompt);
    return {
      summary: result.toString(),
      steps: coreAgent.messages.length > 2 ? [{ tool: "called" }] : []
    };
  }
};

export const handler = async (event: any) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  const result = await agent.run({ userPrompt: body.textMessage });
  return { statusCode: 200, body: JSON.stringify(result) };
};
